import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { sameOrigin } from "./admin.js";
import { LoginRateLimiter } from "./rate-limit.js";
import {
  SessionStore,
  type SessionRecord,
  clearCookieHeader,
  cookieHeader,
  csrfEqual,
  parseCookies,
} from "./sessions.js";
import type { AdminStore, GatewayUser } from "./store.js";

export const USER_COOKIE = "viate_user";
export const USER_CSRF_COOKIE = "viate_user_csrf";

const SESSION_MAX_AGE = 12 * 60 * 60;
const MUTATING: Record<string, true> = {
  POST: true,
  PUT: true,
  PATCH: true,
  DELETE: true,
};

export type PortalRouteOptions = {
  store: AdminStore;
  sessions?: SessionStore;
};

type PortalRequest = FastifyRequest & {
  portalUser?: GatewayUser;
  portalSession?: SessionRecord;
};

export async function registerPortalRoutes(app: FastifyInstance, options: PortalRouteOptions): Promise<void> {
  const sessions = options.sessions ?? new SessionStore();
  const limiter = new LoginRateLimiter();

  app.addHook("preHandler", async (request, reply) => {
    const path = request.url.split("?")[0] ?? request.url;
    if (!path.startsWith("/api/portal")) {
      return;
    }
    const isLogin = request.method === "POST" && path === "/api/portal/login";
    if (isLogin) {
      if (!sameOrigin(request)) {
        return reply.code(403).send({ error: { message: "invalid origin", type: "viate_error" } });
      }
      return;
    }

    const cookies = parseCookies(request.headers.cookie);
    const session = sessions.get(cookies[USER_COOKIE]);
    if (!session?.subject) {
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
    const user = options.store.getUser(session.subject);
    if (!user) {
      return reply.code(401).send({ error: { message: "unauthorized", type: "viate_error" } });
    }
    const isLogout = request.method === "POST" && path === "/api/portal/logout";
    if (!isLogout && user.status !== "active") {
      return reply.code(403).send({ error: { message: "user disabled", type: "viate_error" } });
    }
    const portalRequest = request as PortalRequest;
    portalRequest.portalUser = user;
    portalRequest.portalSession = session;
  });

  app.post("/api/portal/login", async (request, reply) => {
    const key = request.ip || "unknown";
    const limited = limiter.consume(key);
    if (!limited.allowed) {
      reply.header("retry-after", String(limited.retryAfterSeconds));
      return reply.code(429).send({ error: { message: "too many login attempts", type: "viate_error" } });
    }
    const body = asRecord(request.body);
    const email = typeof body.email === "string" ? body.email : "";
    const password = typeof body.password === "string" ? body.password : "";
    try {
      const user = options.store.authenticateUser(email, password);
      limiter.reset(key);
      const session = sessions.create(user.id);
      setUserCookies(reply, session.id, session.csrf);
      return { ok: true, csrf: session.csrf, user };
    } catch (error) {
      return sendStoreError(reply, error);
    }
  });

  app.post("/api/portal/logout", async (request, reply) => {
    const cookies = parseCookies(request.headers.cookie);
    sessions.revoke(cookies[USER_COOKIE]);
    reply.header("set-cookie", [clearCookieHeader(USER_COOKIE), clearCookieHeader(USER_CSRF_COOKIE)]);
    return { ok: true };
  });

  app.get("/api/portal/session", async (request) => {
    const portalRequest = request as PortalRequest;
    return { authenticated: true, csrf: portalRequest.portalSession?.csrf, user: portalRequest.portalUser };
  });

  app.post("/api/portal/password", async (request, reply) => {
    const user = (request as PortalRequest).portalUser;
    if (!user) {
      return reply.code(401).send({ error: { message: "unauthorized", type: "viate_error" } });
    }
    const body = asRecord(request.body);
    const currentPassword = typeof body.currentPassword === "string" ? body.currentPassword : "";
    const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";
    try {
      options.store.changeUserPassword(user.id, currentPassword, newPassword);
      return { ok: true };
    } catch (error) {
      return sendStoreError(reply, error);
    }
  });

  app.get("/api/portal/keys", async (request) => {
    const user = (request as PortalRequest).portalUser;
    return { apiKeys: user ? options.store.listApiKeys(user.id) : [] };
  });

  app.post("/api/portal/keys", async (request, reply) => {
    const user = (request as PortalRequest).portalUser;
    if (!user) {
      return reply.code(401).send({ error: { message: "unauthorized", type: "viate_error" } });
    }
    const body = asRecord(request.body);
    const name = typeof body.name === "string" ? body.name : "";
    try {
      return options.store.createApiKey(name, user.id);
    } catch (error) {
      return sendStoreError(reply, error);
    }
  });

  app.delete("/api/portal/keys/:id", async (request, reply) => {
    const user = (request as PortalRequest).portalUser;
    if (!user) {
      return reply.code(401).send({ error: { message: "unauthorized", type: "viate_error" } });
    }
    const { id } = request.params as { id: string };
    if (!options.store.listApiKeys(user.id).some((key) => key.id === id)) {
      return reply.code(404).send({ error: { message: "api key not found", type: "viate_error" } });
    }
    try {
      options.store.deleteApiKey(id);
      return { ok: true };
    } catch (error) {
      return sendStoreError(reply, error);
    }
  });

  app.get("/api/portal/usage", async (request, reply) => {
    const user = (request as PortalRequest).portalUser;
    if (!user) {
      return reply.code(401).send({ error: { message: "unauthorized", type: "viate_error" } });
    }
    try {
      return options.store.usageForUser(user.id);
    } catch (error) {
      return sendStoreError(reply, error);
    }
  });

  app.get("/api/portal/models", async (request) => {
    const user = (request as PortalRequest).portalUser;
    if (!user) {
      return { mode: "all" as const, published: [], modelIds: [] };
    }
    return portalModelView(options.store, user.id);
  });

  app.put("/api/portal/models", async (request, reply) => {
    const user = (request as PortalRequest).portalUser;
    if (!user) {
      return reply.code(401).send({ error: { message: "unauthorized", type: "viate_error" } });
    }
    const body = asRecord(request.body);
    if (!Object.hasOwn(body, "modelIds") || (body.modelIds !== null && !Array.isArray(body.modelIds))) {
      return reply.code(400).send({ error: { message: "modelIds is required", type: "viate_error" } });
    }
    try {
      options.store.setUserModels(user.id, body.modelIds as string[] | null);
      return portalModelView(options.store, user.id);
    } catch (error) {
      return sendStoreError(reply, error);
    }
  });
}

function setUserCookies(reply: FastifyReply, sessionId: string, csrf: string): void {
  reply.header("set-cookie", [
    cookieHeader(USER_COOKIE, sessionId, SESSION_MAX_AGE),
    cookieHeader(USER_CSRF_COOKIE, csrf, SESSION_MAX_AGE),
  ]);
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
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

function portalModelView(store: AdminStore, userId: string) {
  const choice = store.userModelChoice(userId);
  const providers = store.userProviderChoice(userId);
  return {
    mode: choice.mode,
    published: store.listPublicCatalog(providers.mode === "only" ? providers.providerIds : null).data.map((model) => ({
      id: model.id,
      name: model.name?.trim() || model.id,
    })),
    modelIds: choice.mode === "only" ? choice.modelIds : [],
  };
}
