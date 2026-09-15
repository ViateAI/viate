import { homedir } from "node:os";
import { join } from "node:path";

export function defaultDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.VIATE_DATA_DIR?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  return join(homedir(), ".viate");
}

export function pluginRoot(dataDir: string): string {
  return join(dataDir, "plugins");
}

export function lockPath(dataDir: string): string {
  return join(pluginRoot(dataDir), "lock");
}

export function statePath(dataDir: string): string {
  return join(pluginRoot(dataDir), "state.json");
}

export function activeDir(dataDir: string): string {
  return join(pluginRoot(dataDir), "active");
}

export function pendingDir(dataDir: string): string {
  return join(pluginRoot(dataDir), "pending");
}

export function pendingWorkDir(dataDir: string): string {
  return join(pluginRoot(dataDir), "pending-work");
}

export function activeBackupDir(dataDir: string): string {
  return join(pluginRoot(dataDir), "active.bak");
}

export function pendingReadyPath(dataDir: string): string {
  return join(pendingDir(dataDir), ".viate-ready");
}
