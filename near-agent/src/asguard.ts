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

export type Transport = 'rest' | 'mcp' | 'auto';

function baseUrl(): string {
  return (process.env.ASGUARD_URL || 'http://localhost:8080').replace(/\/$/, '');
}

function mcpUrl(): string {
  return (process.env.ASGUARD_MCP_URL || `${baseUrl()}/mcp`).replace(/\/$/, '');
}

export function transportFromEnv(): Transport {
  const t = (process.env.ASGUARD_TRANSPORT || 'auto').toLowerCase();
  if (t === 'rest' || t === 'mcp' || t === 'auto') return t;
  return 'auto';
}

function runtimeToken(): string {
  const token = process.env.ASGUARD_RUNTIME_TOKEN || '';
  if (!token) {
    throw new Error(
      'ASGUARD_RUNTIME_TOKEN is not set. Use the token from ASGUARD_API_CREDENTIALS that has role "runtime" (not the dashboard/admin token).',
    );
  }
  return token;
}

export function hashPayload(canonical: unknown): string {
  const body = typeof canonical === 'string' ? canonical : JSON.stringify(canonical);
  return createHash('sha256').update(body).digest('hex');
}

async function restFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${runtimeToken()}`);
  headers.set('Content-Type', 'application/json');
  return fetch(`${baseUrl()}${path}`, { ...init, headers });
}

async function mcpToolCall(name: string, args: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(mcpUrl(), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${runtimeToken()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: randomUUID(),
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  const body = (await res.json()) as {
    result?: { content?: Array<{ type?: string; text?: string }>; isError?: boolean };
    error?: { message?: string };
  };
  if (!res.ok || body.error) {
    throw new Error(body.error?.message || `MCP HTTP ${res.status}`);
  }
  const text = body.result?.content?.find((c) => c.type === 'text')?.text;
  if (text) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }
  return body.result;
}

function normalizeApproval(raw: unknown): ApprovalResponse {
  if (raw && typeof raw === 'object') return raw as ApprovalResponse;
  throw new Error(`unexpected approval payload: ${String(raw)}`);
}

export async function requestSignApproval(req: SignApprovalRequest): Promise<ApprovalResponse> {
  const mode = transportFromEnv();

  const viaRest = async () => {
    const res = await restFetch('/api/approvals/sign-request', {
      method: 'POST',
      body: JSON.stringify(req),
    });
    const data = (await res.json()) as ApprovalResponse;
    if (!res.ok && !data.status) {
      throw new Error(`ASGUARD REST ${res.status}: ${JSON.stringify(data)}`);
    }
    return data;
  };

  const viaMcp = async () => {
    const raw = await mcpToolCall('asguard_request_sign_approval', req as unknown as Record<string, unknown>);
    return normalizeApproval(raw);
  };

  if (mode === 'rest') return viaRest();
  if (mode === 'mcp') return viaMcp();

  try {
    return await viaMcp();
  } catch (mcpErr) {
    process.stderr.write(`[asguard] MCP failed (${String(mcpErr)}); falling back to REST\n`);
    return viaRest();
  }
}

export async function getApprovalStatus(requestId: string): Promise<ApprovalResponse | null> {
  const mode = transportFromEnv();

  const viaRest = async () => {
    const res = await restFetch(`/api/approvals/${encodeURIComponent(requestId)}`, { method: 'GET' });
    if (res.status === 404) return null;
    return (await res.json()) as ApprovalResponse;
  };

  const viaMcp = async () => {
    try {
      const raw = await mcpToolCall('asguard_get_approval_status', { request_id: requestId });
      if (!raw) return null;
      return normalizeApproval(raw);
    } catch {
      return null;
    }
  };

  if (mode === 'rest') return viaRest();
  if (mode === 'mcp') {
    const s = await viaMcp();
    return s ?? viaRest();
  }
  const s = await viaMcp();
  return s ?? viaRest();
}

export async function reportActivity(activity: Record<string, unknown>): Promise<void> {
  if (!asguardEnabled()) return;
  const mode = transportFromEnv();
  try {
    if (mode === 'rest') {
      // Optional: no dedicated REST required; MCP preferred for activity
      return;
    }
    await mcpToolCall('asguard_report_activity', activity);
  } catch (err) {
    process.stderr.write(`[asguard] report_activity failed: ${String(err)}\n`);
  }
}

/**
 * Request approval; on pending_hitl poll until human decides or ASGUARD times out.
 * Fail-closed: only status === approved returns.
 */
export async function requireApproved(
  req: Omit<SignApprovalRequest, 'idempotency_key'> & { idempotency_key?: string },
  opts?: { pollMs?: number; maxWaitMs?: number; shouldAbort?: () => boolean },
): Promise<ApprovalResponse> {
  const pollMs = opts?.pollMs ?? 2000;
  // Wait longer than typical HITL window so human can respond; ASGUARD timeout_deny ends it sooner
  const maxWaitMs = opts?.maxWaitMs ?? 15 * 60_000;

  let response = await requestSignApproval({
    ...req,
    idempotency_key: req.idempotency_key ?? randomUUID(),
  });

  if (response.status === 'approved') return response;

  if (response.status === 'pending_hitl' && response.request_id) {
    const deadline = Date.now() + maxWaitMs;
    process.stderr.write(
      `[asguard] HITL pending (${response.request_id}). Waiting for human decision (Ctrl+C to stop agent)...\n`,
    );
    while (Date.now() < deadline) {
      if (opts?.shouldAbort?.()) throw new Error('aborted while waiting for HITL');
      await new Promise((r) => setTimeout(r, pollMs));
      const status = await getApprovalStatus(response.request_id);
      if (!status) continue;
      if (status.status === 'approved') return status;
      if (status.status === 'rejected' || status.status === 'timeout_deny') {
        throw new Error(
          `ASGUARD blocked: ${status.status}${status.reason ? ` — ${status.reason}` : ''}`,
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
