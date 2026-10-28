import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEYLEN = 32;

const DUMMY_SALT = Buffer.alloc(16, 1);
const DUMMY_HASH = Buffer.alloc(KEYLEN, 2);

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string | null): boolean {
  const parsed = parseStored(stored);
  const actual = scryptSync(password, parsed?.salt ?? DUMMY_SALT, KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  const expected = parsed?.hash ?? DUMMY_HASH;
  const equal = actual.length === expected.length && timingSafeEqual(actual, expected);
  return parsed !== null && equal;
}

function parseStored(stored: string | null): { salt: Buffer; hash: Buffer } | null {
  if (!stored) {
    return null;
  }
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt" || parts[1] !== "16384" || parts[2] !== "8" || parts[3] !== "1") {
    return null;
  }
  const saltHex = parts[4] ?? "";
  const hashHex = parts[5] ?? "";
  if (
    saltHex.length === 0 ||
    saltHex.length % 2 !== 0 ||
    !/^[0-9a-f]+$/i.test(saltHex) ||
    hashHex.length === 0 ||
    hashHex.length % 2 !== 0 ||
    !/^[0-9a-f]+$/i.test(hashHex)
  ) {
    return null;
  }
  const salt = Buffer.from(saltHex, "hex");
  const hash = Buffer.from(hashHex, "hex");
  if (salt.length === 0 || hash.length !== KEYLEN) {
    return null;
  }
  return { salt, hash };
}
