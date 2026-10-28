import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { randomUUID } from "node:crypto";
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
import type { AdminStore, PublicModel, StoredApiKey } from "./store.js";
import { tapExchange } from "./usage-frames.js";
import { assertAudioRequest, loggedRequestBody, loggedResponseBody } from "./audio.js";

export type ClientAuthenticator = (secret: string | undefined) => StoredApiKey | null;

export type ModelPriceLookup = {
  lookup(modelId: string): { inputNanoPerMillion: number; outputNanoPerMillion: number } | null;
  ready: boolean;
};

export type ChatRouteOptions = {
  providers: ProviderHandler[];
  authenticateClient?: ClientAuthenticator;
  store?: AdminStore;
  requestLogs?: RequestLogRecorder;
  onUpstreamAuthFailure?: (connectionId: string) => void;
  modelPrices?: ModelPriceLookup;
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

type AuthenticatedRequest = FastifyRequest & { viateV1?: { apiKey: StoredApiKey } };

export async function registerChatRoute(app: FastifyInstance, options: ChatRouteOptions): Promise<void> {
  const providers = new Map(options.providers.map((provider) => [provider.id, provider]));

  app.addHook("onRequest", async (request, reply) => {
    const path = request.url.split("?")[0] ?? request.url;
    if (!path.startsWith("/v1/")) {
      return;
    }
    const apiKey = options.authenticateClient?.(clientSecretFrom(request)) ?? null;
    if (!apiKey) {
      return viateError(reply, 401, "invalid api key");
    }
    (request as AuthenticatedRequest).viateV1 = { apiKey };
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
  const apiKey = (request as AuthenticatedRequest).viateV1?.apiKey ?? null;
  const billUserId = apiKey?.userId ?? null;
  let admitted = false;
  let billRequestId: string | null = null;
  let billedRates: { inputNanoPerMillion: number; outputNanoPerMillion: number } | null = null;
  const settle = (inputTokens: number, outputTokens: number) => {
    if (!admitted || !billRequestId || !billUserId || !options.store) {
      return;
    }
    const rates = billedRates;
    options.store.settleUsage({
      userId: billUserId,
      requestId: billRequestId,
      inputTokens,
      outputTokens,
      inputNanoPerMillion: rates?.inputNanoPerMillion ?? 0,
      outputNanoPerMillion: rates?.outputNanoPerMillion ?? 0,
    });
  };

  try {
    if (capability === "listModels") {
      if (billUserId && options.store) {
        options.store.assertUserActive(billUserId);
      }
      cleanup();
      return reply.code(200).send(publicCatalogFor(options.store, billUserId));
    }
    if (!options.store) {
      cleanup();
      return viateError(reply, 404, "unknown model");
    }
    if (capability === "audioTranscriptions" || capability === "audioSpeech") {
      assertAudioRequest(capability, request.body);
    }
    if (billUserId && options.store) {
      const choice = options.store.userModelChoice(billUserId);
      if (choice.mode === "only") {
        const requested = requestModelFrom(request.body);
        if (requested && !choice.modelIds.includes(requested)) {
          throw Object.assign(new Error("model not available"), { statusCode: 403 });
    }
    }
      const model = requestModelFrom(request.body);
      if (model) {
        const catalog = options.modelPrices;
        if (!catalog?.ready) {
          throw Object.assign(new Error("model prices unavailable"), { statusCode: 503 });
        }
        const rate = catalog.lookup(model);
        if (!rate) {
          throw Object.assign(new Error("model price unavailable"), { statusCode: 400 });
        }
        billedRates = {
          inputNanoPerMillion: rate.inputNanoPerMillion,
          outputNanoPerMillion: rate.outputNanoPerMillion,
        };
      }
    }
    if (billUserId && options.store) {
      options.store.admitUser(billUserId);
      admitted = true;
      billRequestId = randomUUID();
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
        settle(result.usage?.inputTokens ?? 0, result.usage?.outputTokens ?? 0);
        options.requestLogs?.record({
          id: billRequestId ?? undefined,
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
          userId: billUserId,
          attempts: routed.attempts,
          usage: result.usage,
          error: exchange.status >= 400 ? `upstream ${exchange.status}` : null,
          ttfbMs: result.ttfbMs,
          requestBody: loggedRequestBody(request.body),
          responseBody: loggedResponseBody(capability, exchange.headers["content-type"], result.responseBody),
          payloadTruncated: result.truncated,
        });
      })
      .catch(() => {
        settle(0, 0);
      });
    return sent;
  } catch (error) {
    cleanup();
    settle(0, 0);
    const aborted = clientAbort.signal.aborted || isAbortError(error);
    const timedOut = signal.aborted && !clientAbort.signal.aborted;
    const statusFromError =
      typeof error === "object" && error !== null && "statusCode" in error && typeof error.statusCode === "number"
        ? error.statusCode
        : undefined;
    const status = aborted ? 499 : statusFromError ?? 500;
    const message = error instanceof Error ? error.message : String(error);
    const lastAttempt = error instanceof RouteError ? error.attempts.at(-1) : undefined;
    if (capability !== "listModels") {
      options.requestLogs?.record({
        id: billRequestId ?? undefined,
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
        userId: billUserId,
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
    if (statusFromError) {
      return viateError(reply, statusFromError, message);
    }
    return viateError(reply, 500, message);
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

function publicCatalogFor(
  store: AdminStore | undefined,
  userId: string | null,
): { object: "list"; data: PublicModel[] } {
  if (!store) {
    return { object: "list", data: [] };
  }
  const catalog = store.listPublicCatalog();
  if (!userId) {
    return catalog;
  }
  const choice = store.userModelChoice(userId);
  if (choice.mode === "all") {
    return catalog;
  }
  const allowed = new Set(choice.modelIds);
  return { object: "list", data: catalog.data.filter((model) => allowed.has(model.id)) };
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
