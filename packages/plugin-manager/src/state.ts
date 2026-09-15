import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { statePath } from "./paths.js";

export type InstalledPluginRecord = {
  name: string;
  version: string;
  source: string;
  id: string | null;
};

export type PendingOperation = {
  action: "add" | "remove" | "update";
  source?: string;
  name?: string;
  startedAt: string;
  ready: boolean;
  plugins: InstalledPluginRecord[];
};

export type PluginState = {
  version: 1;
  plugins: InstalledPluginRecord[];
  pending: PendingOperation | null;
};

export async function readState(dataDir: string): Promise<PluginState> {
  try {
    const raw = await readFile(statePath(dataDir), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!isPluginState(parsed)) {
      throw new Error("invalid plugin state");
    }
    return normalizeState(parsed);
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return { version: 1, plugins: [], pending: null };
    }
    throw error;
  }
}

export async function writeState(dataDir: string, state: PluginState): Promise<void> {
  const path = statePath(dataDir);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(tmp, path);
}

function normalizeState(state: PluginState): PluginState {
  if (!state.pending) {
    return state;
  }
  return {
    ...state,
    pending: {
      ...state.pending,
      ready: state.pending.ready === true,
      plugins: Array.isArray(state.pending.plugins) ? state.pending.plugins : [],
    },
  };
}

function isPluginState(value: unknown): value is PluginState {
  if (!value || typeof value !== "object") {
    return false;
  }
  if (!("version" in value) || value.version !== 1) {
    return false;
  }
  if (!("plugins" in value) || !Array.isArray(value.plugins)) {
    return false;
  }
  if (!("pending" in value) || value.pending === null) {
    return true;
  }
  return isPendingOperation(value.pending);
}

function isPendingOperation(value: unknown): value is PendingOperation {
  if (!value || typeof value !== "object") {
    return false;
  }
  if (!("action" in value)) {
    return false;
  }
  if (value.action !== "add" && value.action !== "remove" && value.action !== "update") {
    return false;
  }
  return "startedAt" in value && typeof value.startedAt === "string";
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
