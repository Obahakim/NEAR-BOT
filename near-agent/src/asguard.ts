import { createHash, randomUUID } from 'node:crypto';

export type SignApprovalRequest = {
  agent_id: string;
  agent_name: string;
  action: string;
  risk_level?: 'low' | 'medium' | 'high' | 'critical';
  payload_hash: string;
  chain: string;
  network: string;
  amount_usd?: number;
  wallet_id?: string;
  idempotency_key: string;
  details?: Record<string, unknown>;
};

export type ApprovalResponse = {
  status: 'approved' | 'pending_hitl' | 'rejected' | 'timeout_deny' | string;
  request_id?: string;
  reason?: string;
  attestation?: {
    payload_hash: string;
    agent_id: string;
    action?: string;
    chain?: string;
    network?: string;
    expires_at?: string;
    signature?: string;
    [key: string]: unknown;
  };
  score?: number;
  rules?: string[];
  [key: string]: unknown;
};

function baseUrl(): string {
  return (process.env.ASGUARD_URL || 'http://localhost:8080').replace(/\/$/, '');
}

function runtimeToken(): string {
  const token = process.env.ASGUARD_RUNTIME_TOKEN || '';
  if (!token) {
    throw new Error(
      'ASGUARD_RUNTIME_TOKEN is not set. Copy near-agent/.env.example to .env and set a runtime token from ASGUARD_API_CREDENTIALS.',
    );
  }
  return token;
}

export function hashPayload(canonical: unknown): string {
  const body = typeof canonical === 'string' ? canonical : JSON.stringify(canonical);
  return createHash('sha256').update(body).digest('hex');
}

async function asguardFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${runtimeToken()}`);
  headers.set('Content-Type', 'application/json');
  return fetch(`${baseUrl()}${path}`, { ...init, headers });
}

/** REST: POST /api/approvals/sign-request */
export async function requestSignApproval(req: SignApprovalRequest): Promise<ApprovalResponse> {
  const res = await asguardFetch('/api/approvals/sign-request', {
    method: 'POST',
    body: JSON.stringify(req),
  });
  const data = (await res.json()) as ApprovalResponse;
  if (!res.ok && !data.status) {
    throw new Error(`ASGUARD approval HTTP ${res.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

export async function getApprovalStatus(requestId: string): Promise<ApprovalResponse | null> {
  const res = await asguardFetch(`/api/approvals/${encodeURIComponent(requestId)}`, {
    method: 'GET',
  });
  if (res.status === 404) return null;
  return (await res.json()) as ApprovalResponse;
}

/**
 * Request approval and, if pending_hitl, poll until approved / rejected / timeout.
 * Fail-closed: anything other than approved throws.
 */
export async function requireApproved(
  req: Omit<SignApprovalRequest, 'idempotency_key'> & { idempotency_key?: string },
  opts?: { pollMs?: number; maxWaitMs?: number },
): Promise<ApprovalResponse> {
  const pollMs = opts?.pollMs ?? 2000;
  const maxWaitMs = opts?.maxWaitMs ?? 5 * 60_000;

  let response = await requestSignApproval({
    ...req,
    idempotency_key: req.idempotency_key ?? randomUUID(),
  });

  if (response.status === 'approved') return response;

  if (response.status === 'pending_hitl' && response.request_id) {
    const deadline = Date.now() + maxWaitMs;
    process.stderr.write(
      `[asguard] HITL pending (${response.request_id}). Waiting for human decision...\n`,
    );
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, pollMs));
      const status = await getApprovalStatus(response.request_id);
      if (!status) continue;
      if (status.status === 'approved') return status;
      if (status.status === 'rejected' || status.status === 'timeout_deny') {
        throw new Error(
          `ASGUARD blocked transfer: ${status.status}${status.reason ? ` — ${status.reason}` : ''}`,
        );
      }
    }
    throw new Error('ASGUARD HITL wait timed out (fail closed)');
  }

  throw new Error(
    `ASGUARD did not approve: ${response.status}${response.reason ? ` — ${response.reason}` : ''}`,
  );
}

export function asguardEnabled(): boolean {
  const v = (process.env.ASGUARD_ENABLED ?? 'true').toLowerCase();
  return v !== 'false' && v !== '0' && v !== 'off';
}

export function agentIdentity(): { agent_id: string; agent_name: string } {
  return {
    agent_id: process.env.ASGUARD_AGENT_ID || 'near-bot',
    agent_name: process.env.ASGUARD_AGENT_NAME || 'NEAR-BOT',
  };
}
