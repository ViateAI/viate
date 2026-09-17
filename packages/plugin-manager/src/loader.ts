import { join } from "node:path";
import {
  silentPluginLogger,
  type PluginContext,
  type PluginLogger,
  type ProviderHandler,
  type ViatePlugin,
} from "@viateai/sdk";
import { loadManifest, resolveEntryUrl } from "./manifest.js";
import { PluginManager } from "./manager.js";
import { activeDir } from "./paths.js";
import { registerHostSdk } from "./host-sdk.js";

export type LoadedPlugin = {
  name: string;
  version: string;
  id: string;
  provider: ProviderHandler;
};

export type PluginLoadFailure = {
  name: string;
  error: string;
};

export type PluginLoadResult = {
  plugins: LoadedPlugin[];
  failures: PluginLoadFailure[];
};

export type LoadActivePluginsOptions = {
  log?: PluginLogger;
};

export async function loadActivePlugins(
  manager: PluginManager,
  options: LoadActivePluginsOptions = {},
): Promise<PluginLoadResult> {
  registerHostSdk();
  await manager.applyPendingAtStartup();
  const listed = await manager.list();
  const plugins: LoadedPlugin[] = [];
  const failures: PluginLoadFailure[] = [];
  const seenIds = new Map<string, string>();
  const workspace = activeDir(manager.dataDir);
  const hostLog = options.log ?? silentPluginLogger();

  for (const record of listed) {
    if (record.status !== "active") {
      continue;
    }
    const packageDir = join(workspace, "node_modules", record.name);
    try {
      const manifest = await loadManifest(packageDir);
      if (!manifest.entry) {
        throw new Error(`missing viate.entry in ${record.name}`);
      }
      // Entry path comes from the installed plugin package at runtime.
      const imported: unknown = await import(resolveEntryUrl(packageDir, manifest.entry));
      const plugin = unwrapPlugin(imported, record.name);
      const existing = seenIds.get(plugin.id);
      if (existing) {
        throw new Error(`plugin id conflict: ${plugin.id} already registered by ${existing}`);
      }
      const providers: ProviderHandler[] = [];
      const ctx: PluginContext = {
        registerProvider(handler) {
          providers.push(handler);
        },
        log: hostLog.child({ plugin: plugin.id, package: record.name }),
      };
      await plugin.register(ctx);
      if (providers.length !== 1) {
        throw new Error(`plugin ${plugin.id} must register exactly one provider`);
      }
      if (providers[0]!.id !== plugin.id) {
        throw new Error(`plugin id ${plugin.id} must match provider id ${providers[0]!.id}`);
      }
      seenIds.set(plugin.id, record.name);
      plugins.push({
        name: record.name,
        version: record.version,
        id: plugin.id,
        provider: providers[0]!,
      });
    } catch (error) {
      failures.push({
        name: record.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { plugins, failures };
}

function unwrapPlugin(imported: unknown, name: string): ViatePlugin {
  if (!imported || typeof imported !== "object") {
    throw new Error(`${name} did not export a plugin`);
  }
  const candidate =
    "default" in imported ? imported.default : "plugin" in imported ? imported.plugin : imported;
  if (!isViatePlugin(candidate)) {
    throw new Error(`${name} did not export a plugin`);
  }
  return candidate;
}

function isViatePlugin(value: unknown): value is ViatePlugin {
  if (!value || typeof value !== "object") {
    return false;
  }
  if (!("id" in value) || typeof value.id !== "string" || value.id.trim().length === 0) {
    return false;
  }
  return "register" in value && typeof value.register === "function";
}
