import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import type { ProviderHandler } from "@viateai/sdk";
import type { PluginLoadFailure } from "@viateai/plugin-manager";
import { registerAdminRoutes, type PluginOperator } from "./admin.js";
import { registerChatRoute } from "./chat.js";
import { registerAdminStatic } from "./static.js";
import { createSubscriptionScheduler } from "./subscription.js";
import type { AdminStore } from "./store.js";
import type { SessionStore } from "./sessions.js";
import { RequestLogRecorder } from "./request-logs.js";
import { multipartAudioBody } from "./audio.js";
import { multipartImageBody } from "./images.js";

export type HealthResponse = {
  status: "ok";
};

export type BuildAppOptions = {
  logger?: FastifyServerOptions["logger"];
  providers?: ProviderHandler[];
  pluginFailures?: PluginLoadFailure[];
  pluginManager?: PluginOperator;
  store?: AdminStore;
  adminPassword?: string | null;
  adminEnabled?: boolean;
  adminUiDist?: string | null;
  sessions?: SessionStore;
};

export type App = FastifyInstance;

const healthResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["status"],
  properties: {
    status: { type: "string", enum: ["ok"] },
  },
} as const;

export function createApp(options: Pick<BuildAppOptions, "logger"> = {}): App {
  const app = Fastify({
    logger: options.logger ?? true,
    bodyLimit: 32 * 1024 * 1024,
  });
  app.addContentTypeParser("text/plain", { parseAs: "string" }, (_request, body, done) => {
    if (body === "") {
      done(null, undefined);
      return;
    }
    done(null, body);
  });
  app.addContentTypeParser("multipart/form-data", { parseAs: "buffer" }, (request, body, done) => {
    try {
      const contentType = request.headers["content-type"];
      const header = Array.isArray(contentType) ? contentType[0] : contentType;
      const path = request.url.split("?")[0] ?? "";
      const parsed =
        path === "/v1/audio/transcriptions"
          ? multipartAudioBody(header, body as Buffer)
          : multipartImageBody(header, body as Buffer);
      done(null, parsed);
    } catch (error) {
      done(error as Error, undefined);
    }
  });
  return app;
}

export async function registerApp(app: App, options: Omit<BuildAppOptions, "logger"> = {}): Promise<App> {
  for (const failure of options.pluginFailures ?? []) {
    app.log.error({ plugin: failure.name, err: failure.error }, "plugin failed to load");
  }

  app.get<{ Reply: HealthResponse }>(
    "/health",
    {
      schema: {
        response: {
          200: healthResponseSchema,
        },
      },
    },
    async () => ({ status: "ok" }),
  );

  const store = options.store;
  const requestLogs = store ? new RequestLogRecorder(store) : undefined;
  const providers = new Map((options.providers ?? []).map((provider) => [provider.id, provider]));
  const subscriptions = store
    ? createSubscriptionScheduler({ store, providers, log: app.log })
    : undefined;
  if (requestLogs) {
    app.addHook("onClose", async () => {
      await requestLogs.close();
    });
  }
  if (subscriptions) {
    app.addHook("onClose", async () => {
      subscriptions.stop();
    });
    subscriptions.start();
  }

  await registerChatRoute(app, {
    providers: options.providers ?? [],
    authenticateClient: store ? (secret) => store.verifyApiKey(secret) : undefined,
    store,
    requestLogs,
  });

  if (options.pluginManager && store) {
    await registerAdminRoutes(app, {
      enabled: options.adminEnabled ?? Boolean(options.adminPassword),
      password: options.adminPassword ?? null,
      pluginManager: options.pluginManager,
      store,
      providers: options.providers ?? [],
      pluginFailures: options.pluginFailures ?? [],
      sessions: options.sessions,
      requestLogs,
      subscriptions,
    });
  }

  await registerAdminStatic(app, options.adminUiDist ?? null);
  return app;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<App> {
  return registerApp(createApp(options), options);
}
