#!/usr/bin/env node
/**
 * NEAR-BOT — cooperative testnet agent.
 * Holds keys locally; asks ASGUARD for pre-sign approval before any value-moving tx.
 */
import 'dotenv/config';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import chalk from 'chalk';
import {
  KEYSTORE_PATH,
  connectNear,
  formatNear,
  loadWallet,
  networkFromEnv,
  parseNear,
  saveWallet,
  type StoredWallet,
} from './wallet.js';
import {
  agentIdentity,
  asguardEnabled,
  hashPayload,
  requireApproved,
} from './asguard.js';

const rl = createInterface({ input, output });

async function ask(prompt: string, def?: string): Promise<string> {
  const suffix = def ? ` [${def}]` : '';
  const answer = (await rl.question(`${prompt}${suffix}: `)).trim();
  return answer || def || '';
}

async function cmdSetup(): Promise<void> {
  console.log(chalk.cyan('\n=== NEAR agent setup (testnet recommended) ===\n'));
  console.log('Keys stay in', chalk.yellow(KEYSTORE_PATH));
  console.log('Never commit this file. Fund the account via a testnet faucet after setup.\n');

  const network = networkFromEnv();
  const accountId = await ask('NEAR account id', process.env.NEAR_ACCOUNT_ID);
  const privateKey = await ask('Private key (ed25519:...)', process.env.NEAR_PRIVATE_KEY);

  if (!accountId || !privateKey) {
    throw new Error('account id and private key are required');
  }
  if (!privateKey.startsWith('ed25519:')) {
    throw new Error('private key must start with ed25519:');
  }

  const wallet: StoredWallet = {
    networkId: network.networkId,
    accountId,
    privateKey,
  };
  saveWallet(wallet);

  try {
    const { account } = await connectNear(wallet);
    const bal = await account.getAccountBalance();
    console.log(chalk.green('\nWallet saved.'));
    console.log('  account:', wallet.accountId);
    console.log('  network:', wallet.networkId);
    console.log('  balance:', formatNear(bal.available));
  } catch (err) {
    console.log(chalk.yellow('\nWallet saved, but RPC check failed:'));
    console.log(String(err));
    console.log('You can still fund/create the account, then run: npm start → balance');
  }
}

async function requireWallet(): Promise<StoredWallet> {
  const wallet = loadWallet();
  if (!wallet) {
    throw new Error(`No keystore at ${KEYSTORE_PATH}. Run: npm run setup`);
  }
  return wallet;
}

async function cmdBalance(): Promise<void> {
  const wallet = await requireWallet();
  const { account } = await connectNear(wallet);
  const bal = await account.getAccountBalance();
  console.log(chalk.green('Account'), wallet.accountId);
  console.log('  available:', formatNear(bal.available));
  console.log('  total:    ', formatNear(bal.total));
  console.log('  network:  ', networkFromEnv().networkId);
}

async function cmdSend(receiverArg?: string, amountArg?: string): Promise<void> {
  const wallet = await requireWallet();
  const receiver = receiverArg || (await ask('Receiver account id'));
  const amountNear = amountArg || (await ask('Amount in NEAR', '0.01'));

  if (!receiver) throw new Error('receiver required');
  const yocto = parseNear(amountNear);
  if (yocto === '0') throw new Error('invalid amount');

  const network = networkFromEnv();
  const identity = agentIdentity();

  // Canonical intent — payload_hash binds ASGUARD attestation to these exact fields.
  const intent = {
    chain: 'near',
    network: network.networkId,
    action: 'transfer',
    signer_id: wallet.accountId,
    receiver_id: receiver,
    amount_yocto: yocto,
    amount_near: amountNear,
  };
  const payloadHash = hashPayload(intent);

  console.log(chalk.cyan('\nIntent'));
  console.log(JSON.stringify(intent, null, 2));
  console.log('payload_hash:', payloadHash);

  if (asguardEnabled()) {
    console.log(chalk.cyan('\nRequesting ASGUARD pre-sign approval...'));
    const amountUsd = Number(process.env.NEAR_USD_HINT || '0') || undefined;
    const approval = await requireApproved({
      agent_id: identity.agent_id,
      agent_name: identity.agent_name,
      action: 'transfer',
      risk_level: Number(amountNear) >= 1 ? 'high' : 'medium',
      payload_hash: payloadHash,
      chain: 'near',
      network: network.networkId,
      amount_usd: amountUsd,
      wallet_id: wallet.accountId,
      details: intent,
    });

    const attHash = approval.attestation?.payload_hash;
    if (attHash && attHash !== payloadHash) {
      throw new Error('Attestation payload_hash mismatch — refusing to sign');
    }
    console.log(chalk.green('ASGUARD approved'), approval.request_id ?? '');
  } else {
    console.log(chalk.yellow('ASGUARD_ENABLED=false — signing without gate (dev only)'));
  }

  const confirm = (await ask('Broadcast this transfer? (yes/no)', 'no')).toLowerCase();
  if (confirm !== 'yes' && confirm !== 'y') {
    console.log('Aborted.');
    return;
  }

  const { account } = await connectNear(wallet);
  console.log(chalk.cyan('Sending...'));
  const result = await account.sendMoney(receiver, BigInt(yocto));
  const txHash =
    (result as { transaction?: { hash?: string }; transaction_outcome?: { id?: string } })
      ?.transaction?.hash ||
    (result as { transaction_outcome?: { id?: string } })?.transaction_outcome?.id ||
    'submitted';

  console.log(chalk.green('Submitted'));
  console.log('  tx:', txHash);
  console.log(
    '  explorer:',
    network.networkId === 'mainnet'
      ? `https://nearblocks.io/txns/${txHash}`
      : `https://testnet.nearblocks.io/txns/${txHash}`,
  );
}

async function cmdStatus(): Promise<void> {
  const wallet = loadWallet();
  console.log('keystore:', wallet ? chalk.green(wallet.accountId) : chalk.red('missing'));
  console.log('network: ', networkFromEnv().networkId, networkFromEnv().nodeUrl);
  console.log('asguard: ', asguardEnabled() ? chalk.green('enabled') : chalk.yellow('disabled'));
  console.log('asguard url:', process.env.ASGUARD_URL || 'http://localhost:8080');
  console.log('agent id:  ', agentIdentity().agent_id);

  if (asguardEnabled() && process.env.ASGUARD_RUNTIME_TOKEN) {
    try {
      const base = (process.env.ASGUARD_URL || 'http://localhost:8080').replace(/\/$/, '');
      const res = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.ASGUARD_RUNTIME_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'asguard_get_status', arguments: {} },
        }),
      });
      const body = await res.json();
      console.log('asguard status response:', JSON.stringify(body).slice(0, 400));
    } catch (err) {
      console.log(chalk.yellow('could not reach ASGUARD:'), String(err));
    }
  }
}

function printHelp(): void {
  console.log(`
${chalk.bold('NEAR-BOT')} — NEAR testnet agent with optional ASGUARD pre-sign gate

Usage:
  npm run setup              Import account + private key into local keystore
  npm start                  Interactive menu
  npm start -- balance       Show balance
  npm start -- send          Prompt and send NEAR (gated)
  npm start -- send <to> <amountNear>
  npm start -- status        Local + ASGUARD config

Env (near-agent/.env):
  NEAR_NETWORK_ID=testnet
  NEAR_RPC_URL=https://test.rpc.fastnear.com
  ASGUARD_ENABLED=true
  ASGUARD_URL=http://localhost:8080
  ASGUARD_RUNTIME_TOKEN=<runtime token from ASGUARD_API_CREDENTIALS>
  ASGUARD_AGENT_ID=near-bot
`);
}

async function menu(): Promise<void> {
  console.log(chalk.bold('\nNEAR-BOT menu'));
  console.log('  1) balance');
  console.log('  2) send');
  console.log('  3) status');
  console.log('  4) setup');
  console.log('  5) help / quit');
  const choice = await ask('Choose', '1');
  switch (choice) {
    case '1':
      await cmdBalance();
      break;
    case '2':
      await cmdSend();
      break;
    case '3':
      await cmdStatus();
      break;
    case '4':
      await cmdSetup();
      break;
    default:
      printHelp();
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0];

  try {
    if (cmd === 'setup') await cmdSetup();
    else if (cmd === 'balance') await cmdBalance();
    else if (cmd === 'send') await cmdSend(args[1], args[2]);
    else if (cmd === 'status') await cmdStatus();
    else if (cmd === 'help' || cmd === '-h' || cmd === '--help') printHelp();
    else if (!cmd) await menu();
    else {
      printHelp();
      throw new Error(`unknown command: ${cmd}`);
    }
  } finally {
    rl.close();
  }
}

main().catch((err) => {
  console.error(chalk.red(String(err instanceof Error ? err.message : err)));
  process.exitCode = 1;
});
