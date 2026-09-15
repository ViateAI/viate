import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const KEY_FILE = "credential.key";
const ALGO = "aes-256-gcm";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;

export async function loadOrCreateCredentialKey(dataDir: string): Promise<Buffer> {
  const path = join(dataDir, KEY_FILE);
  await mkdir(dirname(path), { recursive: true });
  try {
    const existing = await readFile(path);
    if (existing.length === KEY_LENGTH) {
      return existing;
    }
  } catch (error) {
    if (!isErrno(error, "ENOENT")) {
      throw error;
    }
  }
  const key = randomBytes(KEY_LENGTH);
  await writeFile(path, key, { mode: 0o600 });
  await chmod(path, 0o600);
  return key;
}

export function encryptSecret(key: Buffer, plaintext: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

export function decryptSecret(key: Buffer, payload: string): string {
  const raw = Buffer.from(payload, "base64");
  if (raw.length < IV_LENGTH + TAG_LENGTH + 1) {
    throw new Error("invalid encrypted secret");
  }
  const iv = raw.subarray(0, IV_LENGTH);
  const tag = raw.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const encrypted = raw.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
