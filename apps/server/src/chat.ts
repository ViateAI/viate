import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  INBOUND_HEADER_ALLOWLIST,
  OUTBOUND_HEADER_ALLOWLIST,
  pickAllowedHeaders,
  type HttpExchange,
  type ProviderHandler,
} from "@viateai/sdk";
import { dispatchRouted, RouteError } from "./routing.js";
import {
  classifyOutcome,
  endpointForCapability,
  isStreamRequest,
  requestModelFrom,
  type RequestLogRecorder,
} from "./request-logs.js";
import { createKeepaliveScheduler } from "./keepalive.js";
import type { AdminStore, StoredApiKey } from "./store.js";
import { tapExchange } from "./usage-frames.js";
import { assertAudioRequest, loggedRequestBody, loggedResponseBody } from "./audio.js";

export type ClientAuthenticator = (secret: string | undefined) => StoredApiKey | null;

export type ChatRouteOptions = {
  providers: ProviderHandler[];
  authenticateClient?: ClientAuthenticator;
  store?: AdminStore;
  requestLogs?: RequestLogRecorder;
  onUpstreamAuthFailure?: (connectionId: string) => void;
};

type Capability =
  | "chatCompletions"
  | "listModels"
  | "embeddings"
  | "responses"
  | "responsesCompact"
  | "imageGenerations"
  | "imageEdits"
  | "audioTranscriptions"
  | "audioSpeech";

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
  app.post("/v1/images/generations", (request, reply) =>
    dispatch(request, reply, "imageGenerations", options, providers),
  );
  app.post("/v1/images/edits", (request, reply) =>
    dispatch(request, reply, "imageEdits", options, providers),
  );
  app.post("/v1/audio/transcriptions", (request, reply) =>
    dispatch(request, reply, "audioTranscriptions", options, providers),
  );
  app.post("/v1/audio/speech", (request, reply) =>
    dispatch(request, reply, "audioSpeech", options, providers),
  );

  if (options.store) {
    const scheduler = createKeepaliveScheduler({
      store: options.store,
      providers,
      log: app.log,
    });
    options.onUpstreamAuthFailure = (connectionId) => scheduler.nudge(connectionId, "request");
    app.addHook("onClose", async () => {
      scheduler.stop();
    });
    void scheduler.start().catch((error: unknown) => {
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
    if (capability === "audioTranscriptions" || capability === "audioSpeech") {
      assertAudioRequest(capability, request.body);
    }
    const routed = await dispatchRouted(
      options.store,
      providers,
      capability,
      { body: request.body, headers, signal },
      clientAbort.signal,
      options.onUpstreamAuthFailure,
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
          requestBody: loggedRequestBody(request.body),
          responseBody: loggedResponseBody(capability, exchange.headers["content-type"], result.responseBody),
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
        requestBody: loggedRequestBody(request.body),
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
