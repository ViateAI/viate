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
  };
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
