#!/usr/bin/env node
/**
 * NEAR-BOT — cooperative testnet agent.
 * Creates its own implicit account, encrypts keys with your password,
 * and asks ASGUARD for pre-sign approval before transfers.
 */
import 'dotenv/config';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import chalk from 'chalk';
import {
  KEYSTORE_PATH,
  connectNear,
  formatNear,
  generateNewWallet,
  importWallet,
  loadWalletFile,
  networkFromEnv,
  parseNear,
  saveWalletFile,
  unlockWallet,
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

async function askSecret(prompt: string): Promise<string> {
  // readline cannot mask easily cross-platform; warn user
  console.log(chalk.dim('(input is visible in this terminal — use a unique password)'));
  return ask(prompt);
}

async function cmdSetup(): Promise<void> {
  console.log(chalk.cyan('\n=== NEAR agent setup ===\n'));
  console.log('Default: generate a new keypair + implicit account, encrypt with your password.');
  console.log('Keys file:', chalk.yellow(KEYSTORE_PATH));
  console.log('The private key is NEVER stored in plaintext.\n');

  const mode = (await ask('Mode: new (generate) or import', 'new')).toLowerCase();

  if (mode === 'import') {
    const accountId = await ask('NEAR account id');
    const privateKey = await askSecret('Private key (ed25519:...)');
    const password = await askSecret('Password to encrypt keystore (min 8 chars)');
    const confirm = await askSecret('Confirm password');
    if (password !== confirm) throw new Error('passwords do not match');
    const file = importWallet(accountId, privateKey, password);
    saveWalletFile(file);
    console.log(chalk.green('\nImported and encrypted.'));
    console.log('  account:', file.accountId);
    return;
  }

  const password = await askSecret('Choose a password (min 8 chars) — needed to unlock / reveal key');
  const confirm = await askSecret('Confirm password');
  if (password !== confirm) throw new Error('passwords do not match');

  if (loadWalletFile()) {
    const overwrite = (await ask('Keystore exists. Overwrite? (yes/no)', 'no')).toLowerCase();
    if (overwrite !== 'yes' && overwrite !== 'y') {
      console.log('Aborted.');
      return;
    }
  }

  const { file, accountId } = generateNewWallet(password);
  saveWalletFile(file);

  console.log(chalk.green('\nNew agent wallet created.'));
  console.log('  account id (implicit):', chalk.bold(accountId));
  console.log('  network:             ', file.networkId);
  console.log('\nThis account activates when it receives funds.');
  console.log('Fund it on testnet, e.g. https://near-faucet.io/ or any testnet faucet,');
  console.log('paste the account id above as the recipient.');
  console.log('\nReveal the private key later with:  npm start -- reveal');
}

async function unlockInteractive(): Promise<ReturnType<typeof unlockWallet>> {
  const password = await askSecret('Keystore password');
  return unlockWallet(password);
}

async function cmdReveal(): Promise<void> {
  const file = loadWalletFile();
  if (!file) throw new Error(`No keystore at ${KEYSTORE_PATH}. Run: npm run setup`);

  console.log(chalk.yellow('\nRevealing the private key. Ensure no one can see your screen.\n'));
  const wallet = await unlockInteractive();

  console.log(chalk.green('Unlocked'));
  console.log('  account:    ', wallet.accountId);
  console.log('  network:    ', wallet.networkId);
  console.log('  private key:', wallet.privateKey);
  console.log(chalk.dim('\nStore this offline if you need a backup. Anyone with this key controls the account.'));
}

async function cmdBalance(): Promise<void> {
  const wallet = await unlockInteractive();
  const { account } = await connectNear(wallet);
  try {
    const bal = await account.getAccountBalance();
    console.log(chalk.green('Account'), wallet.accountId);
    console.log('  available:', formatNear(bal.available));
    console.log('  total:    ', formatNear(bal.total));
    console.log('  network:  ', networkFromEnv().networkId);
  } catch (err) {
    console.log(chalk.yellow('Account may be unfunded (implicit accounts show up after first deposit).'));
    console.log('  account:', wallet.accountId);
    console.log('  error:  ', String(err instanceof Error ? err.message : err));
  }
}

async function cmdSend(receiverArg?: string, amountArg?: string): Promise<void> {
  const wallet = await unlockInteractive();
  const receiver = receiverArg || (await ask('Receiver account id'));
  const amountNear = amountArg || (await ask('Amount in NEAR', '0.01'));

  if (!receiver) throw new Error('receiver required');
  const yocto = parseNear(amountNear);
  if (yocto === '0') throw new Error('invalid amount');

  const network = networkFromEnv();
  const identity = agentIdentity();

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
  const file = loadWalletFile();
  console.log('keystore:', file ? chalk.green(file.accountId) : chalk.red('missing'));
  if (file) {
    console.log('  created:', file.createdAt);
    console.log('  encrypted: yes (password required to unlock)');
  }
  console.log('network: ', networkFromEnv().networkId, networkFromEnv().nodeUrl);
  console.log('asguard: ', asguardEnabled() ? chalk.green('enabled') : chalk.yellow('disabled'));
  console.log('asguard url:', process.env.ASGUARD_URL || 'http://localhost:8080');
  console.log('agent id:  ', agentIdentity().agent_id);
}

function printHelp(): void {
  console.log(`
${chalk.bold('NEAR-BOT')} — creates its own wallet; password unlocks keys; ASGUARD gates sends

Usage:
  npm run setup              Generate new account (or import) + encrypt with password
  npm start -- reveal        Show private key after password check
  npm start -- balance       Unlock + show balance
  npm start -- send [to] [near]
  npm start -- status
  npm start                  Menu

New accounts are NEAR implicit accounts (64-char hex). Fund via a testnet faucet.
`);
}

async function menu(): Promise<void> {
  console.log(chalk.bold('\nNEAR-BOT menu'));
  console.log('  1) balance');
  console.log('  2) send');
  console.log('  3) status');
  console.log('  4) setup (new wallet)');
  console.log('  5) reveal private key');
  console.log('  6) help');
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
    case '5':
      await cmdReveal();
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
    else if (cmd === 'reveal') await cmdReveal();
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
