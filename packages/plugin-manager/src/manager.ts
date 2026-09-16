import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  copyDir,
  pathExists,
  replaceDir,
  writeReadyMarker,
} from "./fs.js";
import { withLock } from "./lock.js";
import { loadManifest } from "./manifest.js";
import {
  activeBackupDir,
  activeDir,
  lockPath,
  pendingDir,
  pendingReadyPath,
  pendingWorkDir,
  pluginRoot,
} from "./paths.js";
import { addPackage, ensureHostSdkPeerRule, initPluginWorkspace, removePackage, updatePackage } from "./pnpm.js";
import { assertSafePackageArg, redactSource } from "./source.js";
import { readState, writeState, type InstalledPluginRecord } from "./state.js";

export type PluginManagerOptions = {
  dataDir: string;
  env?: NodeJS.ProcessEnv;
};

export type ListedPlugin = InstalledPluginRecord & {
  status: "active" | "pending";
};

export class PluginManager {
  readonly dataDir: string;
  private readonly env: NodeJS.ProcessEnv;

  constructor(options: PluginManagerOptions) {
    this.dataDir = options.dataDir;
    this.env = options.env ?? process.env;
  }

  async add(source: string): Promise<ListedPlugin[]> {
    const safeSource = assertSafePackageArg(source, "source");
    return this.mutate("add", (work) => addPackage(work, safeSource, this.env), { source: safeSource });
  }

  async update(name: string): Promise<ListedPlugin[]> {
    const safeName = assertSafePackageArg(name, "name");
    return this.mutate("update", (work) => updatePackage(work, safeName, this.env), { name: safeName });
  }

  async remove(name: string): Promise<ListedPlugin[]> {
    const safeName = assertSafePackageArg(name, "name");
    return this.mutate("remove", (work) => removePackage(work, safeName, this.env), { name: safeName });
  }

  async list(): Promise<ListedPlugin[]> {
    await mkdir(pluginRoot(this.dataDir), { recursive: true });
    return withLock(lockPath(this.dataDir), () => this.readListed());
  }

  async applyPendingAtStartup(): Promise<void> {
    await mkdir(pluginRoot(this.dataDir), { recursive: true });
    await withLock(lockPath(this.dataDir), async () => {
      if (!(await pathExists(pendingReadyPath(this.dataDir)))) {
        return;
      }
      const state = await readState(this.dataDir);
      await replaceDir(pendingDir(this.dataDir), activeDir(this.dataDir), activeBackupDir(this.dataDir));
      const plugins =
        state.pending?.ready && state.pending.plugins.length > 0
          ? state.pending.plugins
          : await this.scanWorkspace(activeDir(this.dataDir), state.pending?.plugins ?? state.plugins);
      await writeState(this.dataDir, { version: 1, plugins, pending: null });
    });
  }

  private async mutate(
    action: "add" | "remove" | "update",
    op: (work: string) => Promise<void>,
    extra: { source?: string; name?: string },
  ): Promise<ListedPlugin[]> {
    await mkdir(pluginRoot(this.dataDir), { recursive: true });
    return withLock(lockPath(this.dataDir), async () => {
      const previous = await readState(this.dataDir);
      await writeState(this.dataDir, {
        version: 1,
        plugins: previous.plugins,
        pending: {
          action,
          source: extra.source,
          name: extra.name,
          startedAt: new Date().toISOString(),
          ready: false,
          plugins: [],
        },
      });

      const work = pendingWorkDir(this.dataDir);
      await rm(work, { recursive: true, force: true });
      try {
        await this.stageWork(work);
        await op(work);
        const known = previous.pending?.plugins ?? previous.plugins;
        const plugins = await this.scanWorkspace(work, known, extra.source);
        await writeReadyMarker(join(work, ".viate-ready"));
        await replaceDir(work, pendingDir(this.dataDir), join(pluginRoot(this.dataDir), "pending.bak"));
        await writeState(this.dataDir, {
          version: 1,
          plugins: previous.plugins,
          pending: {
            action,
            source: extra.source,
            name: extra.name,
            startedAt: new Date().toISOString(),
            ready: true,
            plugins,
          },
        });
      } catch (error) {
        await rm(work, { recursive: true, force: true }).catch(() => undefined);
        await writeState(this.dataDir, previous);
        throw error;
      }

      return this.readListed();
    });
  }

  private async stageWork(work: string): Promise<void> {
    if (await pathExists(pendingReadyPath(this.dataDir))) {
      await copyDir(pendingDir(this.dataDir), work);
      await rm(join(work, ".viate-ready"), { force: true });
      await ensureHostSdkPeerRule(work);
      return;
    }
    if (await pathExists(join(activeDir(this.dataDir), "package.json"))) {
      await copyDir(activeDir(this.dataDir), work);
      await ensureHostSdkPeerRule(work);
      return;
    }
    await initPluginWorkspace(work);
  }

  private async readListed(): Promise<ListedPlugin[]> {
    const pendingReady = await pathExists(pendingReadyPath(this.dataDir));
    const dir = pendingReady ? pendingDir(this.dataDir) : activeDir(this.dataDir);
    const status = pendingReady ? "pending" : "active";
    const state = await readState(this.dataDir);
    const known = pendingReady ? (state.pending?.plugins ?? state.plugins) : state.plugins;
    const records = await this.scanWorkspace(dir, known);
    return records.map((plugin) => ({ ...plugin, status }));
  }

  private async scanWorkspace(
    workspaceDir: string,
    known: InstalledPluginRecord[] = [],
    addedSource?: string,
  ): Promise<InstalledPluginRecord[]> {
    const names = await readWorkspaceDependencies(workspaceDir);
    const previousByName = new Map(known.map((plugin) => [plugin.name, plugin]));
    const records: InstalledPluginRecord[] = [];
    const errors: string[] = [];

    for (const name of names) {
      const packageDir = join(workspaceDir, "node_modules", name);
      try {
        const manifest = await loadManifest(packageDir);
        if (!manifest.entry) {
          errors.push(`${name}: missing viate.entry`);
          continue;
        }
        const prior = previousByName.get(manifest.name);
        records.push({
          name: manifest.name,
          version: manifest.version,
          source: redactSource(prior?.source ?? addedSource ?? name),
          id: manifest.id,
        });
      } catch (error) {
        errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (errors.length > 0) {
      throw new Error(`invalid plugin install: ${errors.join("; ")}`);
    }
    return records.sort((a, b) => a.name.localeCompare(b.name));
  }
}

async function readWorkspaceDependencies(workspaceDir: string): Promise<string[]> {
  let raw: string;
  try {
    raw = await readFile(join(workspaceDir, "package.json"), "utf8");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || !("dependencies" in parsed) || !parsed.dependencies) {
    return [];
  }
  if (typeof parsed.dependencies !== "object") {
    return [];
  }
  return Object.keys(parsed.dependencies).sort();
}
