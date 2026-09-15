import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { PluginManager } from "./manager.js";
import { activeDir, pendingDir } from "./paths.js";
import { readState } from "./state.js";

const FIXTURES = join(fileURLToPath(new URL("../test/fixtures", import.meta.url)));

describe("PluginManager tarball lifecycle", { timeout: 120_000 }, () => {
  it("installs a local tarball into pending, lists from disk, and does not mutate live node_modules", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "viate-plugins-"));
    const packDir = await mkdtemp(join(tmpdir(), "viate-pack-"));
    try {
      const tarball = await packFixture("ok-plugin", packDir);
      const manager = new PluginManager({ dataDir });

      const afterAdd = await manager.add(tarball);
      assert.equal(afterAdd.length, 1);
      assert.equal(afterAdd[0]?.name, "@viate-test/ok-plugin");
      assert.equal(afterAdd[0]?.version, "1.0.0");
      assert.equal(afterAdd[0]?.id, "fixture-ok");
      assert.equal(afterAdd[0]?.source, tarball);
      assert.equal(afterAdd[0]?.status, "pending");
      assert.equal(await exists(join(activeDir(dataDir), "node_modules", "@viate-test", "ok-plugin")), false);
      assert.equal(
        await exists(join(pendingDir(dataDir), "node_modules", "@viate-test", "ok-plugin")),
        true,
      );
      assert.equal(
        await exists(join(pendingDir(dataDir), "node_modules", "@viate-test", "ok-plugin", "SCRIPT_RAN")),
        false,
      );

      const listed = await manager.list();
      assert.deepEqual(
        listed.map((plugin) => ({ name: plugin.name, status: plugin.status, source: plugin.source })),
        [{ name: "@viate-test/ok-plugin", status: "pending", source: tarball }],
      );

      await manager.applyPendingAtStartup();
      const afterApply = await manager.list();
      assert.equal(afterApply[0]?.status, "active");
      assert.equal(afterApply[0]?.source, tarball);
      assert.equal(
        await exists(join(activeDir(dataDir), "node_modules", "@viate-test", "ok-plugin")),
        true,
      );
      assert.equal(await exists(pendingDir(dataDir)), false);

      const afterRemove = await manager.remove("@viate-test/ok-plugin");
      assert.equal(afterRemove.length, 0);
      await manager.applyPendingAtStartup();
      assert.equal((await manager.list()).length, 0);
      assert.equal(
        await exists(join(activeDir(dataDir), "node_modules", "@viate-test", "ok-plugin")),
        false,
      );
    } finally {
      await rm(dataDir, { recursive: true, force: true });
      await rm(packDir, { recursive: true, force: true });
    }
  });

  it("keeps the previous active install when add fails", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "viate-plugins-fail-"));
    const packDir = await mkdtemp(join(tmpdir(), "viate-pack-fail-"));
    try {
      const tarball = await packFixture("ok-plugin", packDir);
      const manager = new PluginManager({ dataDir });
      await manager.add(tarball);
      await manager.applyPendingAtStartup();
      const before = await manager.list();
      assert.equal(before.length, 1);

      await assert.rejects(() => manager.add(join(packDir, "missing-package.tgz")));

      const afterFail = await manager.list();
      assert.equal(afterFail.length, 1);
      assert.equal(afterFail[0]?.name, "@viate-test/ok-plugin");
      assert.equal(afterFail[0]?.status, "active");
      assert.equal(
        await exists(join(activeDir(dataDir), "node_modules", "@viate-test", "ok-plugin")),
        true,
      );
      const state = await readState(dataDir);
      assert.equal(state.pending, null);
      assert.equal(state.plugins[0]?.name, "@viate-test/ok-plugin");
    } finally {
      await rm(dataDir, { recursive: true, force: true });
      await rm(packDir, { recursive: true, force: true });
    }
  });

  it("rejects a tarball without viate.entry and leaves the previous active install", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "viate-plugins-noentry-"));
    const packDir = await mkdtemp(join(tmpdir(), "viate-pack-noentry-"));
    try {
      const manager = new PluginManager({ dataDir });
      const ok = await packFixture("ok-plugin", packDir);
      await manager.add(ok);
      await manager.applyPendingAtStartup();

      const invalid = await packFixture("no-entry-plugin", packDir);
      await assert.rejects(() => manager.add(invalid), /missing viate.entry/);

      const listed = await manager.list();
      assert.equal(listed.length, 1);
      assert.equal(listed[0]?.name, "@viate-test/ok-plugin");
      assert.equal(listed[0]?.status, "active");
      const state = await readState(dataDir);
      assert.equal(state.pending, null);
      assert.equal(await exists(pendingDir(dataDir)), false);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
      await rm(packDir, { recursive: true, force: true });
    }
  });

  it("rejects leading-dash sources without spawning the installer", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "viate-plugins-dash-"));
    try {
      const manager = new PluginManager({ dataDir });
      await assert.rejects(() => manager.add("--reporter=json"), /must not start with "-"/);
      await assert.rejects(() => manager.remove("-rf"), /must not start with "-"/);
      await assert.rejects(() => manager.update("--config.ignore-scripts=false"), /must not start with "-"/);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

async function packFixture(name: string, destDir: string): Promise<string> {
  const result = await run("npm", ["pack", "--pack-destination", destDir], join(FIXTURES, name));
  const fileName = result.trim().split("\n").at(-1);
  if (!fileName) {
    throw new Error("npm pack produced no tarball name");
  }
  return join(destDir, fileName);
}

function run(command: string, args: string[], cwd: string): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const child = spawn(command, args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.on("error", reject);
  child.on("close", (status) => {
    if (status === 0) {
      resolve(stdout);
      return;
    }
    reject(new Error(`${command} ${args.join(" ")} failed: ${stderr || stdout}`));
  });
  return promise;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
