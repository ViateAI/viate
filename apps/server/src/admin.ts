import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { timingSafeEqual } from "node:crypto";
import {
  redactInstallerOutput,
  redactSource,
  type ListedPlugin,
  type PluginLoadFailure,
} from "@viateai/plugin-manager";
import type {
  CredentialField,
  OAuthStartResult,
  ProviderHandler,
} from "@viateai/sdk";
import {
  CSRF_COOKIE,
  SESSION_COOKIE,
  SessionStore,
  clearCookieHeader,
  cookieHeader,
  csrfEqual,
  parseCookies,
} from "./sessions.js";
import { LoginRateLimiter } from "./rate-limit.js";
import type { AdminStore, OperationLog } from "./store.js";

export type PluginOperator = {
  list(): Promise<ListedPlugin[]>;
  add(source: string): Promise<ListedPlugin[]>;
  update(name: string): Promise<ListedPlugin[]>;
  remove(name: string): Promise<ListedPlugin[]>;
};

export type AdminPluginView = {
  name: string;
  version: string;
  source: string;
  id: string | null;
  status: "active" | "pending";
  restartRequired: boolean;
  error: string | null;
  capabilities: Array<"chatCompletions" | "listModels" | "embeddings" | "responses">;
  credentialsForm: CredentialField[];
  hasParseCredentials: boolean;
  hasOAuth: boolean;
  hasKeepalive: boolean;
};

export type PluginOperationResult = {
  plugins: AdminPluginView[];
  log: OperationLog;
};

export type AdminRouteOptions = {
  enabled: boolean;
  password: string | null;
  pluginManager: PluginOperator;
  store: AdminStore;
  providers: ProviderHandler[];
  pluginFailures: PluginLoadFailure[];
  sessions?: SessionStore;
};

const SESSION_MAX_AGE = 12 * 60 * 60;
const CORE_TIMEOUT_MS = 10 * 60 * 1_000;
const MUTATING: Record<string, true> = {
  POST: true,
  PUT: true,
  PATCH: true,
  DELETE: true,
};

export async function registerAdminRoutes(app: FastifyInstance, options: AdminRouteOptions): Promise<void> {
  const sessions = options.sessions ?? new SessionStore();
  const limiter = new LoginRateLimiter();
  const providers = new Map(options.providers.map((provider) => [provider.id, provider]));
  const pendingOAuth = new Map<string, {
    providerId: string;
    state: string;
    session?: unknown;
  }>();

  app.addHook("preHandler", async (request, reply) => {
    if (!request.url.startsWith("/api/admin")) {
      return;
    }
    if (!options.enabled || !options.password) {
      return reply.code(503).send({ error: { message: "admin management is disabled", type: "viate_error" } });
    }

    const isLogin = request.method === "POST" && request.url.split("?")[0] === "/api/admin/login";
    if (isLogin) {
      if (!sameOrigin(request)) {
        return reply.code(403).send({ error: { message: "invalid origin", type: "viate_error" } });
      }
      return;
    }

    const isOAuthCallback =
      request.method === "GET" && request.url.split("?")[0] === "/api/admin/oauth/callback";
    if (isOAuthCallback) {
      return;
    }

    const cookies = parseCookies(request.headers.cookie);
    const session = sessions.get(cookies[SESSION_COOKIE]);
    if (!session) {
      return reply.code(401).send({ error: { message: "unauthorized", type: "viate_error" } });
    }
    if (MUTATING[request.method]) {
      if (!sameOrigin(request)) {
        return reply.code(403).send({ error: { message: "invalid origin", type: "viate_error" } });
      }
      const headerToken = headerValue(request.headers["x-viate-csrf"]);
      if (!csrfEqual(session.csrf, headerToken)) {
        return reply.code(403).send({ error: { message: "invalid csrf token", type: "viate_error" } });
      }
    }
    (request as FastifyRequest & { adminSession: typeof session }).adminSession = session;
  });

  app.post("/api/admin/login", async (request, reply) => {
    const key = request.ip || "unknown";
    const limited = limiter.consume(key);
    if (!limited.allowed) {
      reply.header("retry-after", String(limited.retryAfterSeconds));
      return reply.code(429).send({ error: { message: "too many login attempts", type: "viate_error" } });
    }
    const body = asRecord(request.body);
    const password = typeof body.password === "string" ? body.password : "";
    if (!passwordMatches(options.password ?? "", password)) {
      return reply.code(401).send({ error: { message: "invalid password", type: "viate_error" } });
    }
    limiter.reset(key);
    const session = sessions.create();
    setSessionCookies(reply, session.id, session.csrf);
    return { ok: true, csrf: session.csrf };
  });

  app.post("/api/admin/logout", async (request, reply) => {
    const cookies = parseCookies(request.headers.cookie);
    sessions.revoke(cookies[SESSION_COOKIE]);
    reply.header("set-cookie", [clearCookieHeader(SESSION_COOKIE), clearCookieHeader(CSRF_COOKIE)]);
    return { ok: true };
  });

  app.get("/api/admin/session", async (request) => {
    const session = (request as FastifyRequest & { adminSession: { csrf: string } }).adminSession;
    return { authenticated: true, csrf: session.csrf };
  });

  app.get("/api/admin/plugins", async () => {
    const plugins = await options.pluginManager.list();
    return { plugins: toPluginViews(plugins, options.pluginFailures, providers) };
  });

  app.get("/api/admin/logs", async () => {
    return { logs: options.store.listOperationLogs() };
  });

  app.post("/api/admin/plugins/install", async (request, reply) => {
    const body = asRecord(request.body);
    const source = typeof body.source === "string" ? body.source.trim() : "";
    if (!source) {
      return reply.code(400).send({ error: { message: "source is required", type: "viate_error" } });
    }
    return runPluginOp(options, "add", { source });
  });

  app.post("/api/admin/plugins/update", async (request, reply) => {
    const body = asRecord(request.body);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) {
      return reply.code(400).send({ error: { message: "name is required", type: "viate_error" } });
    }
    return runPluginOp(options, "update", { name });
  });

  app.post("/api/admin/plugins/remove", async (request, reply) => {
    const body = asRecord(request.body);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) {
      return reply.code(400).send({ error: { message: "name is required", type: "viate_error" } });
    }
    return runPluginOp(options, "remove", { name });
  });

  app.get("/api/admin/connections", async () => {
    return { connections: options.store.listConnections() };
  });

  app.post("/api/admin/connections", async (request, reply) => {
    const body = asRecord(request.body);
    const providerId = typeof body.providerId === "string" ? body.providerId.trim() : "";
    if (!providerId) {
      return reply.code(400).send({ error: { message: "providerId is required", type: "viate_error" } });
    }
    if (!providers.has(providerId)) {
      return reply.code(400).send({ error: { message: `provider not loaded: ${providerId}`, type: "viate_error" } });
    }
    const connection = options.store.createConnection(providerId);
    return { connection };
  });

  app.put("/api/admin/connections/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const stored = options.store.getConnection(id);
      if (!stored) {
        return reply.code(404).send({ error: { message: "connection not found", type: "viate_error" } });
      }
      const provider = providers.get(stored.providerId);
      if (!provider) {
        return reply.code(400).send({ error: { message: `provider not loaded: ${stored.providerId}`, type: "viate_error" } });
      }
      const body = asRecord(request.body);
      let credentials: unknown;
      if (typeof body.text === "string") {
        if (!provider.parseCredentials) {
          return reply.code(400).send({ error: { message: "provider does not accept pasted credentials", type: "viate_error" } });
        }
        credentials = await provider.parseCredentials(body.text);
      } else if ("credentials" in body) {
        credentials = body.credentials;
      } else {
        return reply.code(400).send({ error: { message: "credentials or text is required", type: "viate_error" } });
      }
      const normalized = provider.normalizeCredentials
        ? await provider.normalizeCredentials(credentials)
        : { credentials };
      const connection = options.store.putCredentials(
        id,
        normalized.credentials,
        normalized.displayLabel,
      );
      return { connection };
    } catch (error) {
      return sendInputError(reply, error);
    }
  });

  app.post("/api/admin/connections/:id/activate", async (request, reply) => {
    const { id } = request.params as { id: string };
    const stored = options.store.getConnection(id);
    if (!stored) {
      return reply.code(404).send({ error: { message: "connection not found", type: "viate_error" } });
    }
    if (!providers.has(stored.providerId)) {
      return reply.code(400).send({ error: { message: `provider not loaded: ${stored.providerId}`, type: "viate_error" } });
    }
    try {
      return { connection: options.store.setActive(id, true) };
    } catch (error) {
      return sendStoreError(reply, error);
    }
  });

  app.post("/api/admin/connections/:id/deactivate", async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return { connection: options.store.setActive(id, false) };
    } catch (error) {
      return sendStoreError(reply, error);
    }
  });

  app.post("/api/admin/connections/:id/oauth/start", async (request, reply) => {
    const { id } = request.params as { id: string };
    const stored = options.store.getConnection(id);
    if (!stored) {
      return reply.code(404).send({ error: { message: "connection not found", type: "viate_error" } });
    }
    const provider = providers.get(stored.providerId);
    if (!provider?.startOAuth) {
      return reply.code(400).send({ error: { message: "provider does not support OAuth", type: "viate_error" } });
    }
    const state = crypto.randomUUID();
    const host = headerValue(request.headers.host);
    if (!host) {
      return reply.code(400).send({ error: { message: "host header is required", type: "viate_error" } });
    }
    const callbackUrl = `${request.protocol}://${host}/api/admin/oauth/callback?state=${encodeURIComponent(state)}`;
    try {
      const started = await provider.startOAuth({
        connectionId: id,
        credentials: options.store.getCredentials(id),
        callbackUrl,
      });
      pendingOAuth.set(id, {
        providerId: stored.providerId,
        state,
        ...(started.session === undefined ? {} : { session: started.session }),
      });
      return publicOAuthStart(started);
    } catch (error) {
      return sendInputError(reply, error);
    }
  });

  app.post("/api/admin/connections/:id/oauth/poll", async (request, reply) => {
    const { id } = request.params as { id: string };
    const pending = pendingOAuth.get(id);
    const stored = options.store.getConnection(id);
    if (!pending || !stored) {
      return reply.code(400).send({ error: { message: "no pending OAuth flow", type: "viate_error" } });
    }
    const provider = providers.get(pending.providerId);
    if (!provider?.pollOAuth) {
      return reply.code(400).send({ error: { message: "provider does not support OAuth polling", type: "viate_error" } });
    }
    try {
      const result = await provider.pollOAuth({
        connectionId: id,
        credentials: options.store.getCredentials(id),
        session: pending.session,
      });
      if (result.type === "complete") {
        pendingOAuth.delete(id);
        const connection = options.store.putCredentials(id, result.credentials, result.displayLabel);
        return { type: "complete", connection };
      }
      if (result.type === "failed") {
        pendingOAuth.delete(id);
      }
      return result;
    } catch (error) {
      return sendInputError(reply, error);
    }
  });

  app.get("/api/admin/oauth/callback", async (request, reply) => {
    const query = request.query as { code?: string; state?: string };
    const match = [...pendingOAuth.entries()].find(([, pending]) => pending.state === query.state);
    if (!query.state || !match) {
      return reply.code(400).send({ error: { message: "invalid OAuth state", type: "viate_error" } });
    }
    const [connectionId, pending] = match;
    const provider = providers.get(pending.providerId);
    if (!provider?.exchangeOAuth) {
      return reply.code(400).send({ error: { message: "provider does not support OAuth callback", type: "viate_error" } });
    }
    try {
      const result = await provider.exchangeOAuth({
        connectionId,
        credentials: options.store.getCredentials(connectionId),
        code: query.code,
        state: query.state,
        session: pending.session,
      });
      pendingOAuth.delete(connectionId);
      options.store.putCredentials(
        connectionId,
        result.credentials,
        result.displayLabel,
      );
      return reply.redirect("/admin/");
    } catch (error) {
      return sendInputError(reply, error);
    }
  });

  app.delete("/api/admin/connections/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      options.store.deleteConnection(id);
      return { ok: true };
    } catch (error) {
      return sendStoreError(reply, error);
    }
  });

  app.get("/api/admin/connections/:id/models", async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return options.store.getConnectionModels(id);
    } catch (error) {
      return sendStoreError(reply, error);
    }
  });

  app.post("/api/admin/connections/:id/models/sync", async (request, reply) => {
    const { id } = request.params as { id: string };
    const stored = options.store.getConnection(id);
    if (!stored) {
      return reply.code(404).send({ error: { message: "connection not found", type: "viate_error" } });
    }
    if (!stored.hasCredentials) {
      return reply.code(400).send({ error: { message: "connection has no credentials", type: "viate_error" } });
    }
    const provider = providers.get(stored.providerId);
    if (!provider) {
      return reply.code(400).send({ error: { message: `provider not loaded: ${stored.providerId}`, type: "viate_error" } });
    }
    if (!provider.listModels) {
      return reply.code(400).send({ error: { message: "provider does not support listModels", type: "viate_error" } });
    }
    try {
      const listed = await provider.listModels(
        { headers: {}, signal: AbortSignal.timeout(CORE_TIMEOUT_MS) },
        {
          connectionId: stored.id,
          providerId: stored.providerId,
          credentials: options.store.getCredentials(id),
        },
      );
      return options.store.replaceConnectionModels(
        id,
        listed.data.map((model) => ({ id: model.id, name: model.name })),
      );
    } catch (error) {
      return sendInputError(reply, error);
    }
  });

  app.put("/api/admin/connections/:id/models/:modelId", async (request, reply) => {
    const { id, modelId } = request.params as { id: string; modelId: string };
    const body = asRecord(request.body);
    if (typeof body.enabled !== "boolean") {
      return reply.code(400).send({ error: { message: "enabled is required", type: "viate_error" } });
    }
    try {
      return options.store.setConnectionModelEnabled(id, decodeURIComponent(modelId), body.enabled);
    } catch (error) {
      return sendStoreError(reply, error);
    }
  });

  app.get("/api/admin/published-models", async () => {
    return { models: options.store.listAdminPublishedModels() };
  });

  app.put("/api/admin/published-models/:modelId/providers", async (request, reply) => {
    const { modelId } = request.params as { modelId: string };
    const body = asRecord(request.body);
    const providerIds = Array.isArray(body.providerIds)
      ? body.providerIds.filter((id): id is string => typeof id === "string").map((id) => id.trim()).filter(Boolean)
      : null;
    if (!providerIds || !Array.isArray(body.providerIds) || providerIds.length !== body.providerIds.length) {
      return reply.code(400).send({ error: { message: "providerIds is required", type: "viate_error" } });
    }
    try {
      return {
        models: options.store.setPublishedModelProviders(
          decodeURIComponent(modelId),
          providerIds,
        ),
      };
    } catch (error) {
      return sendStoreError(reply, error);
    }
  });

  app.get("/api/admin/api-keys", async () => {
    return { apiKeys: options.store.listApiKeys() };
  });

  app.post("/api/admin/api-keys", async (request, reply) => {
    const body = asRecord(request.body);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) {
      return reply.code(400).send({ error: { message: "name is required", type: "viate_error" } });
    }
    try {
      return options.store.createApiKey(name);
    } catch (error) {
      return sendStoreError(reply, error);
    }
  });

  app.delete("/api/admin/api-keys/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      options.store.deleteApiKey(id);
      return { ok: true };
    } catch (error) {
      return sendStoreError(reply, error);
    }
  });
}

async function runPluginOp(
  options: AdminRouteOptions,
  action: "add" | "update" | "remove",
  input: { source?: string; name?: string },
): Promise<PluginOperationResult> {
  const source = input.source ? redactSource(input.source) : null;
  const name = input.name ?? null;
  try {
    const listed =
      action === "add"
        ? await options.pluginManager.add(input.source ?? "")
        : action === "update"
          ? await options.pluginManager.update(input.name ?? "")
          : await options.pluginManager.remove(input.name ?? "");
    const log = options.store.addOperationLog({
      action,
      name,
      source,
      status: "success",
      message: `${action} staged; restart required`,
      restartRequired: true,
    });
    return { plugins: toPluginViews(listed, options.pluginFailures, new Map(options.providers.map((provider) => [provider.id, provider]))), log };
  } catch (error) {
    const message = redactInstallerOutput(error instanceof Error ? error.message : "plugin operation failed");
    const log = options.store.addOperationLog({
      action,
      name,
      source,
      status: "failure",
      message,
      restartRequired: false,
    });
    return { plugins: toPluginViews(await options.pluginManager.list(), options.pluginFailures, new Map(options.providers.map((provider) => [provider.id, provider]))), log };
  }
}

function toPluginViews(
  plugins: ListedPlugin[],
  failures: PluginLoadFailure[],
  providers: Map<string, ProviderHandler>,
): AdminPluginView[] {
  const errors = new Map(failures.map((failure) => [failure.name, failure.error]));
  return plugins.map((plugin) => {
    const provider = plugin.id ? providers.get(plugin.id) : undefined;
    const capabilities: AdminPluginView["capabilities"] = [];
    if (provider?.chatCompletions) capabilities.push("chatCompletions");
    if (provider?.listModels) capabilities.push("listModels");
    if (provider?.embeddings) capabilities.push("embeddings");
    if (provider?.responses) capabilities.push("responses");
    return {
      name: plugin.name,
      version: plugin.version,
      source: redactSource(plugin.source),
      id: plugin.id,
      status: plugin.status,
      restartRequired: plugin.status === "pending",
      error: errors.get(plugin.name) ?? null,
      capabilities,
      credentialsForm: provider?.credentialsForm ?? [],
      hasParseCredentials: Boolean(provider?.parseCredentials),
      hasOAuth: Boolean(provider?.startOAuth),
      hasKeepalive: Boolean(provider?.keepalive),
    };
  });
}

function publicOAuthStart(started: OAuthStartResult): Omit<OAuthStartResult, "session"> {
  const { session: _, ...result } = started;
  return result;
}

function passwordMatches(expected: string, provided: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

function sameOrigin(request: FastifyRequest): boolean {
  const origin = headerValue(request.headers.origin);
  const host = headerValue(request.headers.host);
  if (!host) {
    return false;
  }
  const proto = headerValue(request.headers["x-forwarded-proto"]) ?? (request.protocol || "http");
  const expected = `${proto}://${host}`;
  if (origin) {
    return origin === expected;
  }
  const referer = headerValue(request.headers.referer);
  if (!referer) {
    return false;
  }
  try {
    return new URL(referer).origin === expected;
  } catch {
    return false;
  }
}

function setSessionCookies(reply: FastifyReply, sessionId: string, csrf: string): void {
  reply.header("set-cookie", [
    cookieHeader(SESSION_COOKIE, sessionId, SESSION_MAX_AGE),
    cookieHeader(CSRF_COOKIE, csrf, SESSION_MAX_AGE),
  ]);
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    return {};
  }
  return value as Record<string, unknown>;
}

function sendStoreError(reply: FastifyReply, error: unknown) {
  const status = typeof error === "object" && error !== null && "statusCode" in error ? Number(error.statusCode) : 500;
  const message = error instanceof Error ? error.message : "store error";
  return reply.code(status || 500).send({ error: { message, type: "viate_error" } });
}

function sendInputError(reply: FastifyReply, error: unknown) {
  const status =
    typeof error === "object" && error !== null && "statusCode" in error
      ? Number(error.statusCode)
      : 400;
  const message = error instanceof Error ? error.message : "invalid input";
  return reply.code(status || 400).send({ error: { message, type: "viate_error" } });
}
