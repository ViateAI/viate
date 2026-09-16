import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { loadActivePlugins } from "./loader.js";
import { PluginManager } from "./manager.js";

const FIXTURES = join(fileURLToPath(new URL("../test/fixtures", import.meta.url)));

describe("loadActivePlugins", { timeout: 120_000 }, () => {
  it("loads a valid plugin and isolates a failing plugin error", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "viate-load-"));
    const packDir = await mkdtemp(join(tmpdir(), "viate-load-pack-"));
    try {
      const manager = new PluginManager({ dataDir });
      await manager.add(await packFixture("ok-plugin", packDir));
      await manager.add(await packFixture("broken-plugin", packDir));
      const loaded = await loadActivePlugins(manager);
      const ids = loaded.plugins.map((plugin) => plugin.id).sort();
      assert.deepEqual(ids, ["fixture-ok"]);
      assert.equal(loaded.failures.length, 1);
      assert.equal(loaded.failures[0]?.name, "@viate-test/broken-plugin");
      assert.match(loaded.failures[0]?.error ?? "", /broken plugin exploded/);
      assert.equal(loaded.plugins[0]?.provider.id, "fixture-ok");
    } finally {
      await rm(dataDir, { recursive: true, force: true });
      await rm(packDir, { recursive: true, force: true });
    }
  });

  it("rejects a duplicate plugin id without dropping the first registrant", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "viate-dup-"));
    const packDir = await mkdtemp(join(tmpdir(), "viate-dup-pack-"));
    try {
      const manager = new PluginManager({ dataDir });
      await manager.add(await packFixture("ok-plugin", packDir));
      await manager.add(await packFixture("dup-plugin", packDir));
      const loaded = await loadActivePlugins(manager);
      assert.equal(loaded.plugins.length, 1);
      assert.equal(loaded.failures.length, 1);
      assert.match(loaded.failures[0]?.error ?? "", /plugin id conflict: fixture-ok/);
      assert.equal(loaded.plugins[0]?.id, "fixture-ok");
    } finally {
      await rm(dataDir, { recursive: true, force: true });
      await rm(packDir, { recursive: true, force: true });
    }
  });

  for (const [fixture, expectedError] of [
    ["no-provider-plugin", /must register exactly one provider/],
    ["multi-provider-plugin", /must register exactly one provider/],
    ["mismatched-provider-plugin", /plugin id fixture-mismatch must match provider id other-provider/],
  ] as const) {
    it(`rejects ${fixture}`, async () => {
      const dataDir = await mkdtemp(join(tmpdir(), "viate-provider-contract-"));
      const packDir = await mkdtemp(join(tmpdir(), "viate-provider-contract-pack-"));
      try {
        const manager = new PluginManager({ dataDir });
        await manager.add(await packFixture(fixture, packDir));
        const loaded = await loadActivePlugins(manager);
        assert.equal(loaded.plugins.length, 0);
        assert.equal(loaded.failures.length, 1);
        assert.match(loaded.failures[0]?.error ?? "", expectedError);
      } finally {
        await rm(dataDir, { recursive: true, force: true });
        await rm(packDir, { recursive: true, force: true });
      }
    });
  }

  it("loads a plugin that imports @viateai/sdk at runtime", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "viate-load-sdk-"));
    const packDir = await mkdtemp(join(tmpdir(), "viate-load-sdk-pack-"));
    try {
      const manager = new PluginManager({ dataDir });
      await manager.add(await packFixture("sdk-plugin", packDir));
      const loaded = await loadActivePlugins(manager);
      assert.deepEqual(loaded.failures, []);
      assert.equal(loaded.plugins.length, 1);
      assert.equal(loaded.plugins[0]?.id, "fixture-sdk");
      assert.equal(loaded.plugins[0]?.provider.id, "fixture-sdk");
    } finally {
      await rm(dataDir, { recursive: true, force: true });
      await rm(packDir, { recursive: true, force: true });
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
