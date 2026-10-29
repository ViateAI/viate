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
import { parseRequestModel, resolvePublishedMembers } from "./catalog.js";
import { channelMatchesModel, channelProviderLimit, type Channel } from "./channels.js";
import {
  classifyOutcome,
  endpointForCapability,
  isStreamRequest,
  requestModelFrom,
  type RequestLogRecorder,
} from "./request-logs.js";
import { createKeepaliveScheduler } from "./keepalive.js";
import type { AdminStore, StoredApiKey, StoredVideoRequest } from "./store.js";
import { tapExchange } from "./usage-frames.js";
import { assertAudioRequest, loggedRequestBody, loggedResponseBody } from "./audio.js";
import { captureVideoJob } from "./videos.js";

export type ClientAuthenticator = (secret: string | undefined) => StoredApiKey | null;

export type ModelPriceLookup = {
  lookup(modelId: string): {
    inputNanoPerMillion: number;
    outputNanoPerMillion: number;
    perRequestNano?: number;
  } | null;
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
  | "audioSpeech"
  | "videoGenerations"
  | "videoEdits"
  | "videoExtensions";

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
  app.post("/v1/videos/generations", (request, reply) =>
    dispatch(request, reply, "videoGenerations", options, providers),
  );
  app.post("/v1/videos/edits", (request, reply) =>
    dispatch(request, reply, "videoEdits", options, providers),
  );
  app.post("/v1/videos/extensions", (request, reply) =>
    dispatch(request, reply, "videoExtensions", options, providers),
  );
  app.get<{ Params: { requestId: string } }>("/v1/videos/:requestId", (request, reply) =>
    pollVideo(request, reply, options, providers),
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
  let billedPerRequestNano = 0;
  let billedRatioNumerator = 1;
  let billedRatioDenominator = 1;
  const settle = (inputTokens: number, outputTokens: number, includePerRequest = false) => {
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
      perRequestNano: includePerRequest ? billedPerRequestNano : 0,
      ratioNumerator: billedRatioNumerator,
      ratioDenominator: billedRatioDenominator,
    });
  };

  try {
    if (capability === "listModels") {
      if (billUserId && options.store) {
        options.store.assertUserActive(billUserId);
      }
      const channel = keyChannel(options.store, apiKey);
      if (channel === "denied") {
        cleanup();
        return viateError(reply, 403, "channel not available");
      }
      cleanup();
      return reply.code(200).send(publicCatalogFor(options.store, channel));
    }
    if (!options.store) {
      cleanup();
      return viateError(reply, 404, "unknown model");
    }
    if (capability === "audioTranscriptions" || capability === "audioSpeech") {
      assertAudioRequest(capability, request.body);
    }
    const channel = keyChannel(options.store, apiKey);
    if (channel === "denied") {
      throw Object.assign(new Error("channel not available"), { statusCode: 403 });
    }
    const routeProviders = channel ? channelProviderLimit(channel.rule) : null;
    if (channel && options.store) {
      const requested = requestModelFrom(request.body);
      if (requested && !modelAllowedByChannel(options.store, channel, requested, providers.keys(), capability)) {
        throw Object.assign(new Error("model not available"), { statusCode: 403 });
      }
    }
    if (channel && billUserId) {
      billedRatioNumerator = channel.ratioNumerator;
      billedRatioDenominator = channel.ratioDenominator;
    }
    if (billUserId && options.store) {
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
        billedPerRequestNano = rate.perRequestNano ?? 0;
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
      routeProviders ? new Set(routeProviders) : null,
    );
    const captured = isVideoSubmit(capability)
      ? await captureVideoJob(routed.exchange, routed, options.store, apiKey)
      : routed.exchange;
    const { exchange, tap } = tapExchange(captured, startedAt);
    const sent = sendUpstream(reply, exchange);
    void tap
      .then((result) => {
        const succeeded = exchange.status >= 200 && exchange.status < 300;
        settle(result.usage?.inputTokens ?? 0, result.usage?.outputTokens ?? 0, succeeded);
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

function isVideoSubmit(capability: Capability): boolean {
  return capability === "videoGenerations" || capability === "videoEdits" || capability === "videoExtensions";
}

async function pollVideo(
  request: FastifyRequest<{ Params: { requestId: string } }>,
  reply: FastifyReply,
  options: ChatRouteOptions,
  providers: Map<string, ProviderHandler>,
): Promise<FastifyReply | undefined> {
  const startedAt = Date.now();
  const apiKey = (request as AuthenticatedRequest).viateV1?.apiKey ?? null;
  const job = options.store?.getVideoRequest(request.params.requestId) ?? null;
  if (!job) {
    return viateError(reply, 404, "unknown video request");
  }
  if (job.userId ? job.userId !== apiKey?.userId : job.apiKeyId !== apiKey?.id) {
    return viateError(reply, 403, "forbidden");
  }
  const store = options.store;
  if (!store || !store.getConnection(job.connectionId)) {
    return viateError(reply, 404, "unknown video request");
  }
  const credentials = store.getCredentials(job.connectionId);
  if (credentials === null) {
    return viateError(reply, 404, "unknown video request");
  }
  const handler = providers.get(job.providerId)?.videoResult;
  if (!handler) {
    return viateError(reply, 404, "capability not supported");
  }

  const body = { request_id: job.requestId };
  const signal = AbortSignal.timeout(CORE_TIMEOUT_MS);
  try {
    const upstream = await handler(
      { body, headers: pickAllowedHeaders(request.headers, INBOUND_HEADER_ALLOWLIST), signal },
      { connectionId: job.connectionId, providerId: job.providerId, credentials },
    );
    const { exchange, tap } = tapExchange(upstream, startedAt);
    const sent = sendUpstream(reply, exchange);
    void tap
      .then((result) => {
        recordVideoResult(options, job, apiKey, {
          startedAt,
          status: exchange.status,
          error: exchange.status >= 400 ? `upstream ${exchange.status}` : null,
          ttfbMs: result.ttfbMs,
          requestBody: body,
          responseBody: loggedResponseBody("videoResult", exchange.headers["content-type"], result.responseBody),
          payloadTruncated: result.truncated,
        });
      })
      .catch(() => {});
    return sent;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status =
      typeof error === "object" && error !== null && "statusCode" in error && typeof error.statusCode === "number"
        ? error.statusCode
        : 500;
    recordVideoResult(options, job, apiKey, {
      startedAt,
      status,
      error: message,
      ttfbMs: null,
      requestBody: body,
      responseBody: null,
      payloadTruncated: false,
    });
    return viateError(reply, status, message);
  }
}

function recordVideoResult(
  options: ChatRouteOptions,
  job: StoredVideoRequest,
  apiKey: StoredApiKey | null,
  event: {
    startedAt: number;
    status: number;
    error: string | null;
    ttfbMs: number | null;
    requestBody: unknown;
    responseBody: unknown;
    payloadTruncated: boolean;
  },
): void {
  options.requestLogs?.record({
    startedAt: event.startedAt,
    endedAt: Date.now(),
    endpoint: "videos.result",
    stream: false,
    status: event.status,
    outcome: classifyOutcome(event.status, false, false),
    requestModel: job.modelId,
    upstreamModel: job.modelId,
    providerId: job.providerId,
    connectionId: job.connectionId,
    apiKeyId: apiKey?.id ?? null,
    apiKeyPrefix: apiKey?.prefix ?? null,
    userId: apiKey?.userId ?? null,
    attempts: [],
    usage: null,
    error: event.error,
    ttfbMs: event.ttfbMs,
    requestBody: loggedRequestBody(event.requestBody),
    responseBody: event.responseBody,
    payloadTruncated: event.payloadTruncated,
  });
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

function keyChannel(store: AdminStore | undefined, apiKey: StoredApiKey | null): Channel | null | "denied" {
  if (!store || !apiKey?.channelId) {
    return null;
  }
  const channel = store.getChannel(apiKey.channelId);
  if (!channel) {
    return "denied";
  }
  if (apiKey.userId && !store.userHasChannel(apiKey.userId, channel.id)) {
    return "denied";
  }
  return channel;
}

function publicCatalogFor(store: AdminStore | undefined, channel: Channel | null) {
  if (!store) {
    return { object: "list", data: [] };
  }
  if (!channel) {
    return store.listPublicCatalog();
  }
  return store.listChannelCatalog(channel);
}

function modelAllowedByChannel(
  store: AdminStore,
  channel: Channel,
  requested: string,
  loadedProviderIds: Iterable<string>,
  capability: string,
): boolean {
  const parsed = parseRequestModel(requested, loadedProviderIds);
  const members = resolvePublishedMembers(store, requested, loadedProviderIds);
  const providerIds: string[] = [];
  const seen: Record<string, true> = {};
  for (const member of members) {
    if (seen[member.providerId]) {
      continue;
    }
    seen[member.providerId] = true;
    providerIds.push(member.providerId);
  }
  const endpointTypes = providerIds.flatMap((providerId) => store.getAdvertisedEndpointTypes(providerId));
  return channelMatchesModel(channel.rule, { id: parsed.modelId, providerIds, endpointTypes }, capability);
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
