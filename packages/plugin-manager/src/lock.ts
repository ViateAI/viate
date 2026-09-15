import { constants } from "node:fs";
import { mkdir, open, unlink, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";

export type LockOptions = {
  timeoutMs?: number;
  retryMs?: number;
};

const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_RETRY_MS = 50;

export async function withLock<T>(
  path: string,
  fn: () => Promise<T>,
  options: LockOptions = {},
): Promise<T> {
  const handle = await acquire(path, options);
  try {
    return await fn();
  } finally {
    await handle.close().catch(() => undefined);
    await unlink(path).catch(() => undefined);
  }
}

async function acquire(path: string, options: LockOptions): Promise<FileHandle> {
  await mkdir(dirname(path), { recursive: true });
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    try {
      const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
      try {
        await handle.writeFile(`${JSON.stringify({ pid: process.pid, at: Date.now() })}\n`);
      } catch (error) {
        await handle.close().catch(() => undefined);
        await unlink(path).catch(() => undefined);
        throw error;
      }
      return handle;
    } catch (error) {
      if (!isErrno(error, "EEXIST")) {
        throw error;
      }
      // Existing lock files — empty, invalid, or owned by a live PID — are
      // busy. Never unlink or steal; a crashed owner leaves an orphan for an
      // administrator to remove after stopping all Viate processes.
      if (Date.now() >= deadline) {
        throw new Error(
          `timed out waiting for plugin lock: ${path}; if its owner crashed, stop all Viate processes before manually removing this lock`,
        );
      }
      await sleep(retryMs);
    }
  }
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}
