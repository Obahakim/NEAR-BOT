import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 32;

export type EncryptedBlob = {
  v: 1;
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
};

function deriveKey(password: string, salt: Buffer): Buffer {
  return scryptSync(password, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
}

/** Encrypt a UTF-8 secret with a password (AES-256-GCM + scrypt). */
export function encryptSecret(plaintext: string, password: string): EncryptedBlob {
  if (!password || password.length < 8) {
    throw new Error('password must be at least 8 characters');\n  }
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = deriveKey(password, salt);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: 1,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

/** Decrypt; wrong password throws. */
export function decryptSecret(blob: EncryptedBlob, password: string): string {
  if (!blob || blob.v !== 1) throw new Error('unsupported keystore version');
  const salt = Buffer.from(blob.salt, 'base64');
  const iv = Buffer.from(blob.iv, 'base64');
  const tag = Buffer.from(blob.tag, 'base64');
  const ciphertext = Buffer.from(blob.ciphertext, 'base64');
  const key = deriveKey(password, salt);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('incorrect password or corrupted keystore');
  }
}
