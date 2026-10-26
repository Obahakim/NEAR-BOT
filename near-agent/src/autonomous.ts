import chalk from 'chalk';
import type { Account } from 'near-api-js';
import {
  agentIdentity,
  asguardEnabled,
  hashPayload,
  reportActivity,
  requireApproved,
  transportFromEnv,
} from './asguard.js';
import { connectNear, formatNear, networkFromEnv, parseNear, type UnlockedWallet } from './wallet.js';

export type AutonomousOptions = {
  /** Stop flag shared with signal handlers */
  shouldStop: () => boolean;
};

function envNum(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : fallback;
}

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function sleep(ms: number, shouldStop: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      if (shouldStop() || Date.now() - start >= ms) {
        resolve();
        return;
      }
      setTimeout(tick, Math.min(250, ms - (Date.now() - start)));
    };
    tick();
  });
}

function receiversAllowlist(selfAccount: string): string[] {
  const raw = process.env.AUTO_RECEIVERS || '';
  const list = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (list.length === 0) return [selfAccount]; // self-transfer stress / no external drain
  return list;
}

function pickAmountNear(): string {
  const min = envNum('AUTO_AMOUNT_MIN', 0.01);
  const max = envNum('AUTO_AMOUNT_MAX', 0.1);
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return randomBetween(lo, hi).toFixed(4);
}

function minBalanceNear(): number {
  return envNum('AUTO_MIN_BALANCE', 0.05);
}

async function availableNear(account: Account): Promise<number> {
  const bal = await account.getAccountBalance();
  return Number(formatNear(bal.available).replace(' NEAR', ''));
}

async function gateAndSign(
  wallet: UnlockedWallet,
  action: string,
  intent: Record<string, unknown>,
  amountNear: string,
  shouldStop: () => boolean,
): Promise<void> {
  const network = networkFromEnv();
  const identity = agentIdentity();
  const payloadHash = hashPayload(intent);

  console.log(chalk.cyan(`\n[${new Date().toISOString()}] ${action}`));
  console.log(JSON.stringify(intent, null, 2));
  console.log('payload_hash:', payloadHash);

  if (asguardEnabled()) {
    console.log(chalk.cyan(`ASGUARD approval (${transportFromEnv()})...`));
    const approval = await requireApproved(
      {
        agent_id: identity.agent_id,
        agent_name: identity.agent_name,
        action,
        risk_level: Number(amountNear) >= 0.08 ? 'high' : 'medium',
        payload_hash: payloadHash,
        chain: 'near',
        network: network.networkId,
        amount_usd: Number(process.env.NEAR_USD_HINT || '0') || undefined,
        wallet_id: wallet.accountId,
        details: intent,
      },
      { shouldAbort: shouldStop },
    );
    if (approval.attestation?.payload_hash && approval.attestation.payload_hash !== payloadHash) {
      throw new Error('attestation payload_hash mismatch');
    }
    console.log(chalk.green('approved'), approval.request_id ?? '');
  } else {
    console.log(chalk.yellow('ASGUARD disabled — signing without gate'));
  }
}

async function executeTransfer(
  wallet: UnlockedWallet,
  account: Account,
  receiver: string,
  amountNear: string,
  shouldStop: () => boolean,
): Promise<void> {
  const yocto = parseNear(amountNear);
  const network = networkFromEnv();
  const intent = {
    chain: 'near',
    network: network.networkId,
    action: 'transfer',
    signer_id: wallet.accountId,
    receiver_id: receiver,
    amount_yocto: yocto,
    amount_near: amountNear,
  };
  await gateAndSign(wallet, 'transfer', intent, amountNear, shouldStop);
  if (shouldStop()) return;

  const result = await account.sendMoney(receiver, BigInt(yocto));
  const txHash =
    (result as { transaction?: { hash?: string } })?.transaction?.hash ||
    (result as { transaction_outcome?: { id?: string } })?.transaction_outcome?.id ||
    'ok';
  console.log(chalk.green('transfer tx'), txHash);
  await reportActivity({
    agent_id: agentIdentity().agent_id,
    action: 'transfer',
    status: 'success',
    details: { ...intent, tx: txHash },
  });
}

/** Phase-A "swap": wrap native NEAR into wNEAR via wrap contract (testnet). */
async function executeWrapSwap(
  wallet: UnlockedWallet,
  account: Account,
  amountNear: string,
  shouldStop: () => boolean,
): Promise<void> {
  const network = networkFromEnv();
  const wrapAccount = process.env.NEAR_WRAP_ACCOUNT || (network.networkId === 'mainnet' ? 'wrap.near' : 'wrap.testnet');
  const yocto = parseNear(amountNear);
  const intent = {
    chain: 'near',
    network: network.networkId,
    action: 'swap_wrap',
    signer_id: wallet.accountId,
    token_in: 'near',
    token_out: wrapAccount,
    amount_yocto: yocto,
    amount_near: amountNear,
    method: 'near_deposit',
  };
  await gateAndSign(wallet, 'swap_wrap', intent, amountNear, shouldStop);
  if (shouldStop()) return;

  const result = await account.functionCall({
    contractId: wrapAccount,
    methodName: 'near_deposit',
    args: {},
    gas: BigInt('30000000000000'),
    attachedDeposit: BigInt(yocto),
  });
  const txHash =
    (result as { transaction?: { hash?: string } })?.transaction?.hash ||
    (result as { transaction_outcome?: { id?: string } })?.transaction_outcome?.id ||
    'ok';
  console.log(chalk.green('wrap tx'), txHash);
  await reportActivity({
    agent_id: agentIdentity().agent_id,
    action: 'swap_wrap',
    status: 'success',
    details: { ...intent, tx: txHash },
  });
}

export async function runAutonomous(wallet: UnlockedWallet, opts: AutonomousOptions): Promise<void> {
  const network = networkFromEnv();
  if (network.networkId === 'mainnet' && process.env.ALLOW_MAINNET_AUTO !== '1') {
    throw new Error('Refusing autonomous mode on mainnet. Set ALLOW_MAINNET_AUTO=1 to override (not recommended).');
  }

  const minDelay = envNum('AUTO_INTERVAL_MIN_MS', 5000);
  const maxDelay = envNum('AUTO_INTERVAL_MAX_MS', 30000);
  const transferWeight = envNum('AUTO_TRANSFER_WEIGHT', 0.7); // rest = wrap swap
  const onReject = (process.env.AUTO_ON_HITL_REJECT || 'continue').toLowerCase();

  console.log(chalk.bold('\n=== Autonomous mode ==='));
  console.log('  account:   ', wallet.accountId);
  console.log('  network:   ', network.networkId);
  console.log('  interval:  ', `${minDelay}-${maxDelay} ms`);
  console.log('  amounts:   ', `${process.env.AUTO_AMOUNT_MIN || '0.01'}-${process.env.AUTO_AMOUNT_MAX || '0.1'} NEAR`);
  console.log('  receivers: ', receiversAllowlist(wallet.accountId).join(', '));
  console.log('  asguard:   ', asguardEnabled() ? `on (${transportFromEnv()})` : 'off');
  console.log('  stop:      ', 'Ctrl+C');
  console.log(chalk.dim('No max runtime. HITL pauses the loop until you approve/deny in ASGUARD.\n'));

  let cycle = 0;
  let consecutiveFailures = 0;
  const maxFailures = envNum('AUTO_MAX_CONSECUTIVE_FAILURES', 10);

  while (!opts.shouldStop()) {
    cycle += 1;
    try {
      const { account } = await connectNear(wallet);
      const avail = await availableNear(account);
      if (avail < minBalanceNear() + 0.01) {
        console.log(chalk.yellow(`Balance low (${avail} NEAR). Pausing 60s...`));
        await sleep(60_000, opts.shouldStop);
        consecutiveFailures = 0;
        continue;
      }

      const amountNear = pickAmountNear();
      const doTransfer = Math.random() < transferWeight;

      if (doTransfer) {
        const receivers = receiversAllowlist(wallet.accountId);
        const receiver = receivers[Math.floor(Math.random() * receivers.length)];
        await executeTransfer(wallet, account, receiver, amountNear, opts.shouldStop);
      } else {
        await executeWrapSwap(wallet, account, amountNear, opts.shouldStop);
      }

      consecutiveFailures = 0;
    } catch (err) {
      consecutiveFailures += 1;
      const msg = String(err instanceof Error ? err.message : err);
      console.error(chalk.red(`[cycle ${cycle}]`), msg);

      if (opts.shouldStop()) break;

      if (onReject === 'stop' && /ASGUARD blocked|HITL|rejected|timeout_deny/i.test(msg)) {
        console.log(chalk.yellow('Stopping after ASGUARD reject (AUTO_ON_HITL_REJECT=stop).'));
        break;
      }

      if (consecutiveFailures >= maxFailures) {
        console.error(chalk.red(`Too many consecutive failures (${maxFailures}). Stopping.`));
        break;
      }
    }

    if (opts.shouldStop()) break;

    const delay = Math.floor(randomBetween(Math.min(minDelay, maxDelay), Math.max(minDelay, maxDelay)));
    console.log(chalk.dim(`sleep ${delay}ms (cycle ${cycle})`));
    await sleep(delay, opts.shouldStop);
  }

  console.log(chalk.cyan('\nAutonomous loop stopped.'));
}
