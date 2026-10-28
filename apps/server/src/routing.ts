import { createHash } from "node:crypto";
import type { HttpExchange, ProviderConnection, ProviderHandler } from "@viateai/sdk";
import { resolvePublishedMembers } from "./catalog.js";
import { redactLogError } from "./request-logs.js";
import type { AdminStore, PublishedMember, RequestAttemptRecord } from "./store.js";

const STICKY_TTL_MS = 15 * 60 * 1000;
const STICKY_MAX_ENTRIES = 500;

type StickyEntry = {
  connectionId: string;
  expiresAt: number;
};

const stickyMap = new Map<string, StickyEntry>();

export type RoutedCapability =
  | "chatCompletions"
  | "embeddings"
  | "responses"
  | "responsesCompact"
  | "imageGenerations"
  | "imageEdits"
  | "audioTranscriptions"
  | "audioSpeech";

export type RoutedResult = {
  exchange: HttpExchange;
  requestModel: string;
  upstreamModel: string | null;
  providerId: string | null;
  connectionId: string | null;
  attempts: RequestAttemptRecord[];
};

export class RouteError extends Error {
  statusCode: number;
  attempts: RequestAttemptRecord[];

  constructor(statusCode: number, message: string, attempts: RequestAttemptRecord[] = []) {
    super(message);
    this.statusCode = statusCode;
    this.attempts = attempts;
  }
}

export function resetRoutingStateForTests(): void {
  stickyMap.clear();
}

export function deriveMessageHash(body: unknown): string | null {
  const turns = normalizeTurns(body);
  let text = "";
  if (turns) {
    const first = turns.find((turn) => turn?.role === "user");
    if (typeof first?.content === "string") {
      text = first.content;
    } else if (Array.isArray(first?.content)) {
      text = first.content
        .filter((part): part is { text?: unknown } => Boolean(part) && typeof part === "object")
        .map((part) => (typeof part.text === "string" ? part.text : ""))
        .join("");
    }
  } else if (body && typeof body === "object" && "prompt" in body && typeof body.prompt === "string") {
    text = body.prompt;
  }
  return text ? createHash("sha256").update(text).digest("hex").slice(0, 16) : null;
}

export function orderPool(
  members: PublishedMember[],
  options: { lkgpConnectionId?: string; stickyConnectionId?: string },
): PublishedMember[] {
  return promote(promote(members, options.lkgpConnectionId), options.stickyConnectionId);
}

export async function dispatchRouted(
  store: AdminStore,
  providers: Map<string, ProviderHandler>,
  capability: RoutedCapability,
  request: { body: unknown; headers: Record<string, string>; signal: AbortSignal },
  clientAbort: AbortSignal,
  onAuthFailure?: (connectionId: string) => void,
): Promise<RoutedResult> {
  const requestModel = requestModelFromBody(request.body);
  const members = resolvePublishedMembers(store, requestModel, providers.keys());
  if (members.length === 0) {
    throw new RouteError(404, `unknown model: ${requestModel}`);
  }

  const hash = deriveMessageHash(request.body);
  const sticky = hash ? stickyMap.get(hash) : undefined;
  const stickyConnectionId =
    sticky && sticky.expiresAt > Date.now() && members.some((member) => member.connectionId === sticky.connectionId)
      ? sticky.connectionId
      : undefined;
  const lkgp = store.getLkgp(requestModel);
  const ordered = orderPool(members, {
    lkgpConnectionId: lkgp?.connectionId,
    stickyConnectionId,
  }).filter((member) => member.keepaliveStatus !== "needs_reauth");
  if (ordered.length === 0) {
    throw new RouteError(404, `unknown model: ${requestModel}`);
  }

  let lastError = "no healthy connection served the model";
  let attempted = 0;
  let lastExchange: HttpExchange | undefined;
  let lastMember: PublishedMember | undefined;
  const attempts: RequestAttemptRecord[] = [];
  for (const member of ordered) {
    if (clientAbort.aborted) {
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    }
    const handler = providers.get(member.providerId)?.[capability];
    if (!handler) {
      lastError = "capability not supported";
      continue;
    }
    attempted += 1;
    const connection: ProviderConnection = {
      connectionId: member.connectionId,
      providerId: member.providerId,
      credentials: member.credentials,
    };
    const attemptStarted = Date.now();
    try {
      const upstream = await handler(
        {
          body: rewriteBody(request.body, member.modelId),
          headers: request.headers,
          signal: request.signal,
        },
        connection,
      );
      attempts.push({
        seq: attempts.length + 1,
        providerId: member.providerId,
        connectionId: member.connectionId,
        upstreamModel: reportedUpstreamModel(upstream, member.modelId),
        status: upstream.status,
        durationMs: Date.now() - attemptStarted,
        error: upstream.status >= 400 ? `upstream ${upstream.status}` : null,
      });
      if (isTerminalClientError(upstream.status)) {
        return routed(upstream, requestModel, member, attempts);
      }
      if (isRetryableStatus(upstream.status)) {
        if (upstream.status === 401 || upstream.status === 403) {
          onAuthFailure?.(member.connectionId);
        }
        lastError = `upstream ${upstream.status}`;
        lastExchange = upstream;
        lastMember = member;
        if (hash && stickyConnectionId === member.connectionId) {
          clearStickyBinding(hash);
        }
        continue;
      }
      if (upstream.status >= 200 && upstream.status < 300) {
        store.setLkgp(requestModel, member.providerId, member.connectionId);
        if (hash) {
          recordStickyBinding(hash, member.connectionId);
        }
        return routed(upstream, requestModel, member, attempts);
      }
      return routed(upstream, requestModel, member, attempts);
    } catch (error) {
      if (clientAbort.aborted || (isAbortError(error) && clientAbort.aborted)) {
        throw error;
      }
      lastError = error instanceof Error ? error.message : String(error);
      attempts.push({
        seq: attempts.length + 1,
        providerId: member.providerId,
        connectionId: member.connectionId,
        upstreamModel: member.modelId,
        status: null,
        durationMs: Date.now() - attemptStarted,
        error: redactLogError(lastError),
      });
      if (hash && stickyConnectionId === member.connectionId) {
        clearStickyBinding(hash);
      }
    }
  }
  if (attempted === 0) {
    throw new RouteError(404, lastError, attempts);
  }
  if (lastExchange) {
    return routed(lastExchange, requestModel, lastMember, attempts);
  }
  throw new RouteError(503, `no healthy connection served the model: ${lastError}`, attempts);
}

function routed(
  exchange: HttpExchange,
  requestModel: string,
  member: PublishedMember | undefined,
  attempts: RequestAttemptRecord[],
): RoutedResult {
  return {
    exchange,
    requestModel,
    upstreamModel: reportedUpstreamModel(exchange, member?.modelId) ?? attempts.at(-1)?.upstreamModel ?? null,
    providerId: member?.providerId ?? attempts.at(-1)?.providerId ?? null,
    connectionId: member?.connectionId ?? attempts.at(-1)?.connectionId ?? null,
    attempts,
  };
}

function reportedUpstreamModel(exchange: HttpExchange, catalogModelId: string | undefined): string | null {
  const reported = exchange.upstreamModel?.trim();
  if (reported) return reported;
  return catalogModelId ?? null;
}

function requestModelFromBody(body: unknown): string {
  if (!body || typeof body !== "object" || !("model" in body)) {
    throw new RouteError(400, "model is required");
  }
  const model = body.model;
  if (typeof model !== "string" || !model.trim()) {
    throw new RouteError(400, "model is required");
  }
  return model.trim();
}

function rewriteBody(body: unknown, upstreamModelId: string): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { model: upstreamModelId };
  }
  return { ...body, model: upstreamModelId };
}

function promote(members: PublishedMember[], connectionId: string | undefined): PublishedMember[] {
  if (!connectionId) {
    return members;
  }
  const index = members.findIndex((member) => member.connectionId === connectionId);
  if (index <= 0) {
    return members;
  }
  const next = members.slice();
  const [hit] = next.splice(index, 1);
  if (hit) {
    next.unshift(hit);
  }
  return next;
}

function normalizeTurns(body: unknown): Array<{ role?: string; content?: unknown }> | null {
  if (!body || typeof body !== "object") {
    return null;
  }
  const record = body as { messages?: unknown; input?: unknown };
  if (Array.isArray(record.messages) && record.messages.length > 0) {
    return record.messages as Array<{ role?: string; content?: unknown }>;
  }
  if (typeof record.input === "string" && record.input.length > 0) {
    return [{ role: "user", content: record.input }];
  }
  if (Array.isArray(record.input) && record.input.length > 0) {
    return record.input.map((item) =>
      typeof item === "string" ? { role: "user", content: item } : (item as { role?: string; content?: unknown }),
    );
  }
  return null;
}

function recordStickyBinding(hash: string, connectionId: string): void {
  evictSticky();
  stickyMap.set(hash, { connectionId, expiresAt: Date.now() + STICKY_TTL_MS });
}

function clearStickyBinding(hash: string): void {
  stickyMap.delete(hash);
}

function evictSticky(): void {
  const now = Date.now();
  for (const [key, entry] of stickyMap) {
    if (entry.expiresAt <= now) {
      stickyMap.delete(key);
    }
  }
  while (stickyMap.size > STICKY_MAX_ENTRIES) {
    const oldest = stickyMap.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    stickyMap.delete(oldest);
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 401 || status === 403 || status === 408 || status === 409 || status === 429 || status >= 500;
}

function isTerminalClientError(status: number): boolean {
  return status === 400 || status === 404;
}

function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
}
