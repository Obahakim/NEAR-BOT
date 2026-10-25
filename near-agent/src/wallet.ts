import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, keyStores, utils, KeyPair, type ConnectConfig, type Near, type Account } from 'near-api-js';
import { decryptSecret, encryptSecret, type EncryptedBlob } from './cryptoStore.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const KEYSTORE_PATH = resolve(__dirname, '..', 'agent-keystore.json');

/** On-disk format: private key is never stored in plaintext. */
export type StoredWalletFile = {
  networkId: string;
  accountId: string;
  /** hex public key material used for implicit accounts */
  publicKey?: string;
  createdAt: string;
  encryptedPrivateKey: EncryptedBlob;
};

export type UnlockedWallet = {
  networkId: string;
  accountId: string;
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

/**
 * NEAR implicit account id = lowercase hex of the ed25519 public key (64 chars).
 * No on-chain create-account tx required; account activates when first funded.
 */
export function implicitAccountIdFromKeyPair(keyPair: KeyPair): string {
  const pub = keyPair.getPublicKey();
  // publicKey.data is 32 bytes for ed25519
  const data = (pub as { data?: Uint8Array }).data ?? (pub as unknown as { data: Uint8Array }).data;
  if (!data || data.length !== 32) {
    // Fallback: parse from string "ed25519:<base58>" via toString and near utils if needed
    const s = pub.toString();
    if (s.startsWith('ed25519:')) {
      // Decode is handled by near-api-js PublicKey; prefer data field
      throw new Error('could not read public key bytes; update near-api-js');
    }
    throw new Error('unexpected public key format');
  }
  return Buffer.from(data).toString('hex');
}

export function generateNewWallet(password: string): { file: StoredWalletFile; privateKey: string; accountId: string } {
  const network = networkFromEnv();
  const keyPair = KeyPair.fromRandom('ed25519');
  const privateKey = keyPair.toString();
  const accountId = implicitAccountIdFromKeyPair(keyPair);
  const pub = keyPair.getPublicKey();
  const data = (pub as { data?: Uint8Array }).data;
  const file: StoredWalletFile = {
    networkId: network.networkId,
    accountId,
    publicKey: data ? Buffer.from(data).toString('hex') : undefined,
    createdAt: new Date().toISOString(),
    encryptedPrivateKey: encryptSecret(privateKey, password),
  };
  return { file, privateKey, accountId };
}

export function importWallet(
  accountId: string,
  privateKey: string,
  password: string,
): StoredWalletFile {
  const network = networkFromEnv();
  if (!privateKey.startsWith('ed25519:')) {
    throw new Error('private key must start with ed25519:');
  }
  // Validate key parses
  KeyPair.fromString(privateKey as Parameters<typeof KeyPair.fromString>[0]);
  return {
    networkId: network.networkId,
    accountId,
    createdAt: new Date().toISOString(),
    encryptedPrivateKey: encryptSecret(privateKey, password),
  };
}

export function loadWalletFile(): StoredWalletFile | null {
  if (!existsSync(KEYSTORE_PATH)) return null;
  const raw = JSON.parse(readFileSync(KEYSTORE_PATH, 'utf8')) as StoredWalletFile;
  if (!raw.accountId || !raw.encryptedPrivateKey) return null;
  return raw;
}

export function saveWalletFile(file: StoredWalletFile): void {
  writeFileSync(KEYSTORE_PATH, JSON.stringify(file, null, 2), { mode: 0o600 });
}

export function unlockWallet(password: string): UnlockedWallet {
  const file = loadWalletFile();
  if (!file) throw new Error(`No keystore at ${KEYSTORE_PATH}. Run: npm run setup`);
  const privateKey = decryptSecret(file.encryptedPrivateKey, password);
  return {
    networkId: file.networkId,
    accountId: file.accountId,
    privateKey,
  };
}

export async function connectNear(wallet: UnlockedWallet): Promise<{ near: Near; account: Account }> {
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
