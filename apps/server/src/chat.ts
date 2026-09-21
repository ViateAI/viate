import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  INBOUND_HEADER_ALLOWLIST,
  OUTBOUND_HEADER_ALLOWLIST,
  pickAllowedHeaders,
  type HttpExchange,
  type ProviderConnection,
  type ProviderHandler,
} from "@viateai/sdk";
import { pluginLoggerFromFastify } from "./plugin-log.js";
import { dispatchRouted, RouteError } from "./routing.js";
import {
  classifyOutcome,
  endpointForCapability,
  isStreamRequest,
  requestModelFrom,
  type RequestLogRecorder,
} from "./request-logs.js";
import type { AdminStore, StoredApiKey } from "./store.js";
import { tapExchange } from "./usage-frames.js";

export type ClientAuthenticator = (secret: string | undefined) => StoredApiKey | null;

export type ChatRouteOptions = {
  providers: ProviderHandler[];
  authenticateClient?: ClientAuthenticator;
  store?: AdminStore;
  requestLogs?: RequestLogRecorder;
};

type Capability = "chatCompletions" | "listModels" | "embeddings" | "responses" | "responsesCompact";

const CORE_TIMEOUT_MS = 10 * 60 * 1_000;

export async function registerChatRoute(app: FastifyInstance, options: ChatRouteOptions): Promise<void> {
  const providers = new Map(options.providers.map((provider) => [provider.id, provider]));

  app.addHook("onRequest", async (request, reply) => {
    if (request.url.startsWith("/v1/") && !options.authenticateClient?.(clientSecretFrom(request))) {
      return viateError(reply, 401, "invalid api key");
    }
  });

  app.post("/v1/chat/completions", (request, reply) =>
    dispatch(request, reply, "chatCompletions", options, providers),
  );
  app.get("/v1/models", (request, reply) =>
    dispatch(request, reply, "listModels", options, providers),
  );
  app.post("/v1/embeddings", (request, reply) =>
    dispatch(request, reply, "embeddings", options, providers),
  );
  app.post("/v1/responses", (request, reply) =>
    dispatch(request, reply, "responses", options, providers),
  );
  app.post("/v1/responses/compact", (request, reply) =>
    dispatch(request, reply, "responsesCompact", options, providers),
  );

  if (options.store) {
    void startKeepalives(app, options.store, providers).catch((error: unknown) => {
      app.log.error({ err: error }, "keepalive startup failed");
    });
  }
}

async function dispatch(
  request: FastifyRequest,
  reply: FastifyReply,
  capability: Capability,
  options: ChatRouteOptions,
  providers: Map<string, ProviderHandler>,
): Promise<FastifyReply | undefined> {
  const clientAbort = new AbortController();
  const onReplyClose = () => {
    if (!reply.raw.writableFinished) {
      clientAbort.abort();
    }
  };
  const cleanup = () => {
    reply.raw.off("close", onReplyClose);
    reply.raw.off("finish", cleanup);
    reply.raw.off("error", cleanup);
  };
  reply.raw.on("close", onReplyClose);
  reply.raw.on("finish", cleanup);
  reply.raw.on("error", cleanup);

  const signal = AbortSignal.any([clientAbort.signal, AbortSignal.timeout(CORE_TIMEOUT_MS)]);
  const headers = pickAllowedHeaders(request.headers, INBOUND_HEADER_ALLOWLIST);
  const startedAt = Date.now();
  const apiKey = options.authenticateClient?.(clientSecretFrom(request)) ?? null;

  try {
    if (capability === "listModels") {
      cleanup();
      return reply.code(200).send(options.store?.listPublicCatalog() ?? { object: "list", data: [] });
    }
    if (!options.store) {
      cleanup();
      return viateError(reply, 404, "unknown model");
    }
    const routed = await dispatchRouted(
      options.store,
      providers,
      capability,
      { body: request.body, headers, signal },
      clientAbort.signal,
    );
    const { exchange, tap } = tapExchange(routed.exchange, startedAt);
    const sent = sendUpstream(reply, exchange);
    void tap
      .then((result) => {
        options.requestLogs?.record({
          startedAt,
          endedAt: Date.now(),
          endpoint: endpointForCapability(capability),
          stream: isStreamRequest(request.body),
          status: exchange.status,
          outcome: classifyOutcome(
            exchange.status,
            clientAbort.signal.aborted,
            signal.aborted && !clientAbort.signal.aborted,
          ),
          requestModel: routed.requestModel,
          upstreamModel: routed.upstreamModel,
          providerId: routed.providerId,
          connectionId: routed.connectionId,
          apiKeyId: apiKey?.id ?? null,
          apiKeyPrefix: apiKey?.prefix ?? null,
          attempts: routed.attempts,
          usage: result.usage,
          error: exchange.status >= 400 ? `upstream ${exchange.status}` : null,
          ttfbMs: result.ttfbMs,
          requestBody: request.body,
          responseBody: result.responseBody,
          payloadTruncated: result.truncated,
        });
      })
      .catch(() => {});
    return sent;
  } catch (error) {
    cleanup();
    const aborted = clientAbort.signal.aborted || isAbortError(error);
    const timedOut = signal.aborted && !clientAbort.signal.aborted;
    const status = aborted ? 499 : error instanceof RouteError ? error.statusCode : 500;
    const message = error instanceof Error ? error.message : String(error);
    const lastAttempt = error instanceof RouteError ? error.attempts.at(-1) : undefined;
    if (capability !== "listModels") {
      options.requestLogs?.record({
        startedAt,
        endedAt: Date.now(),
        endpoint: endpointForCapability(capability),
        stream: isStreamRequest(request.body),
        status,
        outcome: classifyOutcome(status, aborted, timedOut),
        requestModel: requestModelFrom(request.body),
        upstreamModel: lastAttempt?.upstreamModel ?? null,
        providerId: lastAttempt?.providerId ?? null,
        connectionId: lastAttempt?.connectionId ?? null,
        apiKeyId: apiKey?.id ?? null,
        apiKeyPrefix: apiKey?.prefix ?? null,
        attempts: error instanceof RouteError ? error.attempts : [],
        usage: null,
        error: aborted ? "aborted" : message,
        ttfbMs: null,
        requestBody: request.body,
        responseBody: null,
        payloadTruncated: false,
      });
    }
    if (clientAbort.signal.aborted || isAbortError(error)) {
      if (!reply.sent) {
        return reply.code(499).send();
      }
      return;
    }
    if (error instanceof RouteError) {
      return viateError(reply, error.statusCode, error.message);
    }
    return viateError(reply, 500, error instanceof Error ? error.message : String(error));
  }
}

async function startKeepalives(
  app: FastifyInstance,
  store: AdminStore,
  providers: Map<string, ProviderHandler>,
): Promise<void> {
  const timers = new Map<string, NodeJS.Timeout>();
  const inFlight = new Set<string>();

  const run = async (connection: ProviderConnection): Promise<void> => {
    const provider = providers.get(connection.providerId);
    if (!provider?.keepalive) {
      return;
    }
    if (inFlight.has(connection.connectionId)) {
      return;
    }
    inFlight.add(connection.connectionId);
    clearTimeout(timers.get(connection.connectionId));
    timers.delete(connection.connectionId);
    try {
      const result = await provider.keepalive({
        connectionId: connection.connectionId,
        credentials: connection.credentials,
        signal: AbortSignal.timeout(CORE_TIMEOUT_MS),
        reason: "timer",
        log: pluginLoggerFromFastify(app.log).child({
          plugin: connection.providerId,
          connectionId: connection.connectionId,
        }),
      });
      if (result.credentials !== undefined || result.displayLabel !== undefined) {
        store.putCredentials(
          connection.connectionId,
          result.credentials === undefined ? connection.credentials : result.credentials,
          result.displayLabel,
        );
      }
      store.setKeepalive(connection.connectionId, result.status, result.error);
      if (result.status !== "ok") {
        app.log.warn(
          {
            connectionId: connection.connectionId,
            providerId: connection.providerId,
            status: result.status,
            error: result.error,
          },
          "keepalive failed",
        );
      }
      if (result.nextDueMs !== undefined) {
        clearTimeout(timers.get(connection.connectionId));
        const timer = setTimeout(() => {
          timers.delete(connection.connectionId);
          const stored = store.getConnection(connection.connectionId);
          if (!stored?.hasCredentials) {
            return;
          }
          const credentials = store.getCredentials(connection.connectionId);
          void run({ ...connection, credentials });
        }, result.nextDueMs);
        timer.unref();
        timers.set(connection.connectionId, timer);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      store.setKeepalive(
        connection.connectionId,
        "failed",
        message,
      );
      app.log.error(
        {
          err: error,
          connectionId: connection.connectionId,
          providerId: connection.providerId,
          status: "failed",
          error: message,
        },
        "keepalive failed",
      );
    } finally {
      inFlight.delete(connection.connectionId);
    }
  };

  app.addHook("onClose", async () => {
    for (const timer of timers.values()) {
      clearTimeout(timer);
    }
    timers.clear();
  });

  await Promise.all(store.listResolvedConnections().map(run));
}

function clientSecretFrom(request: FastifyRequest): string | undefined {
  const header = request.headers["x-api-key"];
  const xApiKey = Array.isArray(header) ? header[0] : header;
  if (xApiKey?.trim()) {
    return xApiKey.trim();
  }
  const authorization = request.headers.authorization;
  const value = Array.isArray(authorization) ? authorization[0] : authorization;
  if (!value) {
    return undefined;
  }
  const match = /^Bearer\s+(\S+)/i.exec(value);
  return match?.[1];
}

function sendUpstream(reply: FastifyReply, upstream: HttpExchange): FastifyReply {
  reply.code(upstream.status);
  for (const [name, value] of Object.entries(
    pickAllowedHeaders(upstream.headers, OUTBOUND_HEADER_ALLOWLIST),
  )) {
    reply.header(name, value);
  }
  if (!upstream.body) {
    return reply.send();
  }
  const body: WebReadableStream<Uint8Array> = upstream.body;
  return reply.send(Readable.fromWeb(body));
}

function viateError(reply: FastifyReply, status: number, message: string): FastifyReply {
  return reply.code(status).send({ error: { message, type: "viate_error" } });
}

function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
}
