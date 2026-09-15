import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { withLock } from "./lock.js";

for (const payload of ["", "invalid", JSON.stringify({ pid: process.pid, at: 0 })]) {
  test(`does not reclaim an existing lock: ${JSON.stringify(payload)}`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "viate-lock-"));
    const path = join(dir, "lock");
    try {
      await writeFile(path, payload);
      await assert.rejects(withLock(path, async () => assert.fail("entered occupied lock"), { timeoutMs: 10, retryMs: 1 }), /timed out/);
      assert.equal(await readFile(path, "utf8"), payload);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
}

test("releases the lock when the callback fails", async () => {
  const dir = await mkdtemp(join(tmpdir(), "viate-lock-"));
  try {
    const path = join(dir, "lock");
    await assert.rejects(withLock(path, async () => { throw new Error("callback failure"); }), /callback failure/);
    assert.equal(await withLock(path, async () => 42), 42);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("serializes independent processes", { timeout: 15000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "viate-lock-"));
  const path = join(dir, "lock");
  const counter = join(dir, "counter");
  try {
    await writeFile(counter, "0");
    const code = `import { withLock } from ${JSON.stringify(new URL("./lock.ts", import.meta.url).href)};
      import { readFile, writeFile } from 'node:fs/promises';
      for (let i = 0; i < 5; i++) await withLock(${JSON.stringify(path)}, async () => {
        const n = Number(await readFile(${JSON.stringify(counter)}, 'utf8'));
        await writeFile(${JSON.stringify(counter)}, String(n + 1));
      });`;
    await Promise.all(Array.from({ length: 4 }, () => {
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      child.stderr.on("data", chunk => { stderr += chunk; });
      child.once("error", reject);
      child.once("exit", status => status === 0 ? resolve() : reject(new Error(stderr || `child exit ${status}`)));
      return promise;
    }));
    assert.equal(await readFile(counter, "utf8"), "20");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
