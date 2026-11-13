import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultDataDir } from "@viateai/plugin-manager";

export type ServerConfig = {
  host: string;
  port: number;
  dataDir: string;
  adminPassword: string | null;
  adminEnabled: boolean;
  adminUiDist: string | null;
  trustProxy: boolean | string;
  userMaxInflight: number;
  logPayloads: boolean;
  requestLogRetentionMs: number;
  publicUrl: string | null;
};

const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_PORT = 4317;
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const host = env.HOST?.trim() || DEFAULT_HOST;
  const adminPassword = env.VIATE_ADMIN_PASSWORD?.trim() || null;
  return {
    host,
    port: parsePort(env.PORT),
    dataDir: defaultDataDir(env),
    adminPassword,
    adminEnabled: Boolean(adminPassword),
    adminUiDist: resolveAdminUiDist(env),
    trustProxy: parseTrustProxy(env.VIATE_TRUST_PROXY),
    userMaxInflight: parsePositiveInt(env.VIATE_USER_MAX_INFLIGHT, 8, "VIATE_USER_MAX_INFLIGHT"),
    logPayloads: parseFlag(env.VIATE_LOG_PAYLOADS, false, "VIATE_LOG_PAYLOADS"),
    requestLogRetentionMs:
      parsePositiveInt(env.VIATE_REQUEST_LOG_RETENTION_DAYS, 7, "VIATE_REQUEST_LOG_RETENTION_DAYS") * 24 * 60 * 60 * 1000,
    publicUrl: parsePublicUrl(env.VIATE_PUBLIC_URL),
  };
}

function parsePublicUrl(raw: string | undefined): string | null {
  const trimmed = raw?.trim() ?? "";
  if (!trimmed) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`Invalid VIATE_PUBLIC_URL: ${raw}`);
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || url.search || url.hash) {
    throw new Error(`Invalid VIATE_PUBLIC_URL: ${raw}`);
  }
  const path = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
  return `${url.origin}${path}`;
}

function parsePort(raw: string | undefined): number {
  const value = raw ?? String(DEFAULT_PORT);
  if (!/^[0-9]+$/.test(value)) {
    throw new Error(`Invalid PORT: ${value}`);
  }

  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT: ${value}`);
  }

  return port;
}

const PROXY_KEYWORDS: Record<string, true> = {
  loopback: true,
  linklocal: true,
  uniquelocal: true,
};

function parseTrustProxy(raw: string | undefined): boolean | string {
  if (raw === undefined || raw.trim() === "") {
    return "loopback,uniquelocal";
  }
  const value = raw.trim();
  const lower = value.toLowerCase();
  if (lower === "true" || lower === "yes") {
    return true;
  }
  if (lower === "false" || lower === "no" || lower === "off" || lower === "0") {
    return false;
  }
  const parts = lower.split(",").map((part) => part.trim()).filter(Boolean);
  const invalid = parts.some(
    (part) =>
      !PROXY_KEYWORDS[part] &&
      !/^(?:\d{1,3}\.){3}\d{1,3}(?:\/\d{1,2})?$/.test(part) &&
      !(part.includes(":") && /^[0-9a-f:./]+$/.test(part)),
  );
  if (parts.length === 0 || invalid) {
    throw new Error(`Invalid VIATE_TRUST_PROXY: ${raw}`);
  }
  return parts.join(",");
}

function parsePositiveInt(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  if (!/^[0-9]+$/.test(raw.trim())) {
    throw new Error(`Invalid ${name}: ${raw}`);
  }
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`Invalid ${name}: ${raw}`);
  }
  return value;
}

function parseFlag(raw: string | undefined, fallback: boolean, name: string): boolean {
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const value = raw.trim().toLowerCase();
  if (value === "1" || value === "true" || value === "yes" || value === "on") {
    return true;
  }
  if (value === "0" || value === "false" || value === "no" || value === "off") {
    return false;
  }
  throw new Error(`Invalid ${name}: ${raw}`);
}

function resolveAdminUiDist(env: NodeJS.ProcessEnv): string | null {
  const fromEnv = env.VIATE_ADMIN_UI_DIST?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "../web"),
    join(here, "../../web/dist"),
    join(here, "../../../apps/web/dist"),
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "index.html"))) {
      return candidate;
    }
  }
  return null;
}
