import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, keyStores, utils, KeyPair, type ConnectConfig, type Near, type Account } from 'near-api-js';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const KEYSTORE_PATH = resolve(__dirname, '..', 'agent-keystore.json');

export type StoredWallet = {
  networkId: string;
  accountId: string;
  /** ed25519:... private key — never commit this file */
  privateKey: string;
};

export type NearNetwork = {
  networkId: string;
  nodeUrl: string;
  walletUrl: string;
  helperUrl: string;
};

export function networkFromEnv(): NearNetwork {
  const networkId = process.env.NEAR_NETWORK_ID || 'testnet';
  const nodeUrl =
    process.env.NEAR_RPC_URL ||
    (networkId === 'mainnet'
      ? 'https://free.rpc.fastnear.com'
      : 'https://test.rpc.fastnear.com');
  return {
    networkId,
    nodeUrl,
    walletUrl:
      process.env.NEAR_WALLET_URL ||
      (networkId === 'mainnet' ? 'https://app.mynearwallet.com' : 'https://testnet.mynearwallet.com'),
    helperUrl:
      process.env.NEAR_HELPER_URL ||
      (networkId === 'mainnet'
        ? 'https://helper.mainnet.near.org'
        : 'https://helper.testnet.near.org'),
  };
}

export function loadWallet(): StoredWallet | null {
  if (!existsSync(KEYSTORE_PATH)) return null;
  const raw = JSON.parse(readFileSync(KEYSTORE_PATH, 'utf8')) as StoredWallet;
  if (!raw.accountId || !raw.privateKey) return null;
  return raw;
}

export function saveWallet(wallet: StoredWallet): void {
  writeFileSync(KEYSTORE_PATH, JSON.stringify(wallet, null, 2), { mode: 0o600 });
}

export async function connectNear(wallet: StoredWallet): Promise<{ near: Near; account: Account }> {
  const network = networkFromEnv();
  const keyStore = new keyStores.InMemoryKeyStore();
  const keyPair = KeyPair.fromString(wallet.privateKey as Parameters<typeof KeyPair.fromString>[0]);
  await keyStore.setKey(network.networkId, wallet.accountId, keyPair);

  const config: ConnectConfig = {
    networkId: network.networkId,
    nodeUrl: network.nodeUrl,
    walletUrl: network.walletUrl,
    helperUrl: network.helperUrl,
    keyStore,
  };

  const near = await connect(config);
  const account = await near.account(wallet.accountId);
  return { near, account };
}

export function formatNear(yocto: string | bigint): string {
  return `${utils.format.formatNearAmount(yocto.toString())} NEAR`;
}

export function parseNear(amount: string): string {
  return utils.format.parseNearAmount(amount) ?? '0';
}
