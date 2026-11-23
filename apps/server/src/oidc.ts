import {
  createHash,
  createPrivateKey,
  createPublicKey,
  createSign,
  generateKeyPairSync,
  type KeyObject,
} from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const KEY_FILE = "oidc-signing.key";

export type OidcPublicJwk = {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
  use: "sig";
  alg: "ES256";
  kid: string;
};

export type IdTokenClaims = {
  iss: string;
  sub: string;
  aud: string;
  exp: number;
  iat: number;
  auth_time: number;
  nonce?: string;
  email?: string;
  email_verified?: false;
  name?: string;
};

export type OidcSigner = {
  jwks(): { keys: OidcPublicJwk[] };
  sign(claims: IdTokenClaims): string;
};

type SigningKey = {
  kid: string;
  privateKey: KeyObject;
  publicJwk: OidcPublicJwk;
};

export async function loadOidcSigner(dataDir: string): Promise<OidcSigner> {
  const path = join(dataDir, KEY_FILE);
  await mkdir(dataDir, { recursive: true });
  let pem: string | undefined;
  try {
    pem = await readFile(path, "utf8");
  } catch (error) {
    if (!isErrno(error, "ENOENT")) {
      throw error;
    }
  }
  if (pem === undefined) {
    pem = generateEs256Pem();
    await writeFile(path, pem, { mode: 0o600 });
    await chmod(path, 0o600);
  }
  const keys = pemBlocks(pem).map(importSigningKey);
  const signing = keys[0];
  if (!signing) {
    throw new Error("oidc signing key must be ES256");
  }
  const published = keys.map((key) => key.publicJwk);
  return {
    jwks() {
      return { keys: published.map((key) => ({ ...key })) };
    },
    sign(claims) {
      return signEs256(signing, claims);
    },
  };
}

function pemBlocks(text: string): string[] {
  return text.match(/-----BEGIN [A-Z0-9 ]+-----[\s\S]*?-----END [A-Z0-9 ]+-----/g) ?? [];
}

function generateEs256Pem(): string {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const exported = privateKey.export({ type: "pkcs8", format: "pem" });
  return typeof exported === "string" ? exported : exported.toString("utf8");
}

function importSigningKey(pem: string): SigningKey {
  const privateKey = createPrivateKey(pem);
  const exported = createPublicKey(privateKey).export({ format: "jwk" });
  if (typeof exported === "string" || Buffer.isBuffer(exported)) {
    throw new Error("oidc signing key must be ES256");
  }
  if (exported.kty !== "EC" || exported.crv !== "P-256" || typeof exported.x !== "string" || typeof exported.y !== "string") {
    throw new Error("oidc signing key must be ES256");
  }
  const kid = jwkThumbprint(exported.x, exported.y);
  return {
    kid,
    privateKey,
    publicJwk: {
      kty: "EC",
      crv: "P-256",
      x: exported.x,
      y: exported.y,
      use: "sig",
      alg: "ES256",
      kid,
    },
  };
}

function jwkThumbprint(x: string, y: string): string {
  const canonical = JSON.stringify({ crv: "P-256", kty: "EC", x, y });
  return createHash("sha256").update(canonical).digest("base64url");
}

function signEs256(key: SigningKey, claims: IdTokenClaims): string {
  const header = { alg: "ES256", typ: "JWT", kid: key.kid };
  const signingInput = `${base64UrlJson(header)}.${base64UrlJson(claims)}`;
  const signer = createSign("SHA256");
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign({ key: key.privateKey, dsaEncoding: "ieee-p1363" });
  return `${signingInput}.${signature.toString("base64url")}`;
}

function base64UrlJson(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
