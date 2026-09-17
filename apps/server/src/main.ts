import { loadActivePlugins, PluginManager } from "@viateai/plugin-manager";
import { createApp, registerApp } from "./app.js";
import { loadConfig } from "./config.js";
import { pluginLoggerFromFastify } from "./plugin-log.js";
import { AdminStore } from "./store.js";

const config = loadConfig();
const manager = new PluginManager({ dataDir: config.dataDir });
const app = createApp();
const loaded = await loadActivePlugins(manager, { log: pluginLoggerFromFastify(app.log) });
const store = await AdminStore.open(config.dataDir);
await registerApp(app, {
  providers: loaded.plugins.map((plugin) => plugin.provider),
  pluginFailures: loaded.failures,
  pluginManager: manager,
  store,
  adminPassword: config.adminPassword,
  adminEnabled: config.adminEnabled,
  adminUiDist: config.adminUiDist,
});

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  app.log.info({ signal }, "shutting down");

  try {
    await app.close();
    store.close();
    process.exit(0);
  } catch (error) {
    app.log.error({ err: error }, "shutdown failed");
    process.exit(1);
  }
}

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});
process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

try {
  await app.listen({ host: config.host, port: config.port });
  app.log.info(
    {
      plugins: loaded.plugins.map((plugin) => plugin.id),
      pluginFailures: loaded.failures.map((failure) => failure.name),
      adminEnabled: config.adminEnabled,
    },
    "viate server started",
  );
} catch (error) {
  app.log.error({ err: error }, "failed to listen");
  store.close();
  process.exit(1);
}
