import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AdminStore, GatewayUser } from "./store.js";

const DEFAULT_USER_LIMIT = 50;
const MAX_USER_LIMIT = 200;
const MAX_KEY_IDS = 200;
const MAX_USAGE_SPAN_MS = 7 * 24 * 60 * 60 * 1000;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

export async function registerServiceRoutes(app: FastifyInstance, options: { store: AdminStore }): Promise<void> {
  const store = options.store;

  app.get("/api/service/users", async (request, reply) => {
    const access = serviceAccess(store, request, reply, "users:read");
    if (!access) {
      return;
    }
    const rawLimit = queryString(request.query, "limit");
    let limit = DEFAULT_USER_LIMIT;
    if (rawLimit !== undefined) {
      if (!/^[1-9]\d*$/.test(rawLimit)) {
        return viateError(reply, 400, "limit must be between 1 and 200");
      }
      limit = Number(rawLimit);
      if (limit > MAX_USER_LIMIT) {
        return viateError(reply, 400, "limit must be between 1 and 200");
      }
    }
    const rawCursor = queryString(request.query, "cursor");
    let cursor: { createdAt: string; id: string } | null = null;
    if (rawCursor) {
      cursor = decodeCursor(rawCursor);
      if (!cursor) {
        return viateError(reply, 400, "cursor is invalid");
      }
    }
    const page = store.listUsersPage(limit, cursor);
    return {
      users: page.users.map(publicUser),
      nextCursor: page.nextCursor ? encodeCursor(page.nextCursor) : null,
    };
  });

  app.get("/api/service/users/:id", async (request, reply) => {
    const access = serviceAccess(store, request, reply, "users:read");
    if (!access) {
      return;
    }
    const { id } = request.params as { id: string };
    const user = store.getUser(id);
    if (!user) {
      return viateError(reply, 404, "user not found");
    }
    return publicUser(user);
  });

  app.get("/api/service/channels", async (request, reply) => {
    const access = serviceAccess(store, request, reply, "channels:read");
    if (!access) {
      return;
    }
    return {
      channels: store.listChannels().map((channel) => ({ id: channel.id, name: channel.name })),
    };
  });

  app.get("/api/service/users/:id/channels", async (request, reply) => {
    const access = serviceAccess(store, request, reply, "channels:read");
    if (!access) {
      return;
    }
    const { id } = request.params as { id: string };
    if (!store.getUser(id)) {
      return viateError(reply, 404, "user not found");
    }
    const granted = new Set(store.listUserChannelIds(id));
    return {
      channels: store
        .listChannels()
        .filter((channel) => granted.has(channel.id))
        .map((channel) => ({ id: channel.id, name: channel.name })),
    };
  });

  app.post("/api/service/users/:id/keys", async (request, reply) => {
    const access = serviceAccess(store, request, reply, "keys:write");
    if (!access) {
      return;
    }
    const { id } = request.params as { id: string };
    const body = asRecord(request.body);
    if (body.kind !== "bot") {
      return viateError(reply, 400, "kind must be bot");
    }
    const name = typeof body.name === "string" ? body.name : "";
    const channelId = typeof body.channelId === "string" ? body.channelId : "";
    const externalRef = typeof body.externalRef === "string" ? body.externalRef : "";
    try {
      return store.createBotApiKey({ name, userId: id, channelId, externalRef, ownerClientId: access.clientId });
    } catch (error) {
      return sendStoreError(reply, error);
    }
  });

  app.get("/api/service/keys", async (request, reply) => {
    const access = serviceAccess(store, request, reply, "keys:write");
    if (!access) {
      return;
    }
    const kind = queryString(request.query, "kind");
    if (kind !== undefined && kind !== "bot" && kind !== "client") {
      return viateError(reply, 400, "kind is not allowed");
    }
    const keys = store.listOwnedApiKeys(access.clientId, kind);
    return {
      apiKeys: keys.map((key) => ({
        id: key.id,
        name: key.name,
        prefix: key.prefix,
        createdAt: key.createdAt,
        userId: key.userId,
        channelId: key.channelId,
        kind: key.kind,
        externalRef: key.externalRef,
      })),
    };
  });

  app.delete("/api/service/keys/:id", async (request, reply) => {
    const access = serviceAccess(store, request, reply, "keys:write");
    if (!access) {
      return;
    }
    const { id } = request.params as { id: string };
    try {
      store.deleteOwnedApiKey(id, access.clientId);
      return { ok: true };
    } catch (error) {
      return sendStoreError(reply, error);
    }
  });

  app.get("/api/service/usage", async (request, reply) => {
    const access = serviceAccess(store, request, reply, "usage:read");
    if (!access) {
      return;
    }
    const rawIds = queryString(request.query, "keyIds");
    if (rawIds === undefined) {
      return viateError(reply, 400, "keyIds is required");
    }
    const keyIds = rawIds.split(",").map((item) => item.trim()).filter((item) => item.length > 0);
    if (keyIds.length > MAX_KEY_IDS) {
      return viateError(reply, 400, "keyIds must contain at most 200 ids");
    }
    const from = queryString(request.query, "from");
    const to = queryString(request.query, "to");
    const granularity = queryString(request.query, "granularity");
    if (!from || !to || !ISO_INSTANT.test(from) || !ISO_INSTANT.test(to)) {
      return viateError(reply, 400, "from and to must be ISO times");
    }
    if (granularity !== "hour" && granularity !== "day") {
      return viateError(reply, 400, "granularity must be hour or day");
    }
    const fromMs = Date.parse(from);
    const toMs = Date.parse(to);
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) {
      return viateError(reply, 400, "to must be after from");
    }
    if (toMs - fromMs > MAX_USAGE_SPAN_MS) {
      return viateError(reply, 400, "time span exceeds 7 days");
    }
    const buckets = store.queryOwnedKeyUsage({
      ownerClientId: access.clientId,
      keyIds,
      from: new Date(fromMs).toISOString(),
      to: new Date(toMs).toISOString(),
      granularity,
    });
    return { buckets };
  });
}

function publicUser(user: GatewayUser) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    status: user.status,
    createdAt: user.createdAt,
  };
}

function serviceAccess(
  store: AdminStore,
  request: FastifyRequest,
  reply: FastifyReply,
  required: string,
): { clientId: string; scope: string } | null {
  const header = headerValue(request.headers.authorization);
  const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
  const access = token && !token.includes(" ") ? store.readServiceAccessToken(token) : null;
  if (!access) {
    viateError(reply, 401, "invalid token");
    return null;
  }
  if (!access.scope.split(" ").includes(required)) {
    viateError(reply, 403, "insufficient scope");
    return null;
  }
  return access;
}

function encodeCursor(cursor: { createdAt: string; id: string }): string {
  return Buffer.from(JSON.stringify({ createdAt: cursor.createdAt, id: cursor.id }), "utf8").toString("base64url");
}

function decodeCursor(value: string): { createdAt: string; id: string } | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    const createdAt = "createdAt" in parsed && typeof parsed.createdAt === "string" ? parsed.createdAt : "";
    const id = "id" in parsed && typeof parsed.id === "string" ? parsed.id : "";
    if (!createdAt || !id || createdAt.length > 40 || id.length > 80) {
      return null;
    }
    return { createdAt, id };
  } catch {
    return null;
  }
}

function queryString(query: unknown, key: string): string | undefined {
  if (!query || typeof query !== "object" || !(key in query)) {
    return undefined;
  }
  const value = (query as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function viateError(reply: FastifyReply, status: number, message: string) {
  return reply.code(status).send({ error: { message, type: "viate_error" } });
}

function sendStoreError(reply: FastifyReply, error: unknown) {
  const status =
    error && typeof error === "object" && "statusCode" in error && typeof error.statusCode === "number"
      ? error.statusCode
      : 500;
  const message = error instanceof Error ? error.message : "request failed";
  return reply.code(status).send({ error: { message, type: "viate_error" } });
}
