import { mkdir, open, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { redactInstallerOutput } from "@viateai/plugin-manager";
import type { RequestUsage } from "@viateai/sdk";
import { PAYLOAD_MAX_BYTES } from "./usage-frames.js";
import type {
  AdminStore,
  RequestAttemptRecord,
  RequestLogEndpoint,
  RequestLogOutcome,
  RequestLogRecord,
  RequestLogStats,
} from "./store.js";

export const REQUEST_LOG_EVENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const REQUEST_LOG_FLUSH_SIZE = 32;

export type { RequestAttemptRecord, RequestLogEndpoint, RequestLogOutcome, RequestLogRecord, RequestLogStats };

export type RequestLogEvent = {
  id?: string;
  startedAt: number;
  endedAt?: number;
  endpoint: RequestLogEndpoint;
  stream: boolean;
  status: number;
  outcome: RequestLogOutcome;
  requestModel: string | null;
  upstreamModel: string | null;
  providerId: string | null;
  connectionId: string | null;
  apiKeyId: string | null;
  apiKeyPrefix: string | null;
  attempts: RequestAttemptRecord[];
  usage: RequestUsage | null;
  error: string | null;
  ttfbMs: number | null;
  requestBody: unknown;
  responseBody: unknown;
  payloadTruncated: boolean;
};

type RingBucket = {
  ts: number;
  requests: number;
  errors: number;
  aborted: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

export function endpointForCapability(
  capability:
    | "chatCompletions"
    | "embeddings"
    | "responses"
    | "responsesCompact"
    | "imageGenerations"
    | "imageEdits",
): RequestLogEndpoint {
  if (capability === "chatCompletions") {
    return "chat.completions";
  }
  if (capability === "embeddings") {
    return "embeddings";
  }
  if (capability === "responsesCompact") {
    return "responses.compact";
  }
  if (capability === "imageGenerations") {
    return "images.generations";
  }
  if (capability === "imageEdits") {
    return "images.edits";
  }
  return "responses";
}

export function classifyOutcome(status: number, aborted: boolean, timedOut: boolean): RequestLogOutcome {
  if (aborted) {
    return "aborted";
  }
  if (timedOut) {
    return "timeout";
  }
  if (status >= 200 && status < 300) {
    return "success";
  }
  if (status === 401 || status === 403) {
    return "auth_error";
  }
  if (status >= 400 && status < 500) {
    return "client_error";
  }
  return "upstream_error";
}

export function requestModelFrom(body: unknown): string | null {
  if (!body || typeof body !== "object" || !("model" in body)) {
    return null;
  }
  const model = body.model;
  return typeof model === "string" && model.trim() ? model.trim() : null;
}

export function isStreamRequest(body: unknown): boolean {
  return Boolean(body && typeof body === "object" && "stream" in body && body.stream === true);
}

export function redactLogError(error: string | null | undefined): string | null {
  if (!error) {
    return null;
  }
  const redacted = redactInstallerOutput(error).slice(0, 500);
  return redacted || null;
}

export class RequestLogRecorder {
  private readonly queue: RequestLogEvent[] = [];
  private readonly ring = new SecondRing();
  private scheduled = false;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;
  private writing = false;
  private closed = false;
  private pendingWrite: Promise<void> = Promise.resolve();

  constructor(private readonly store: AdminStore) {
    this.pruneTimer = setInterval(() => {
      void this.prune().catch(() => {});
    }, 60 * 60 * 1000);
    this.pruneTimer.unref();
    void this.prune().catch(() => {});
  }

  record(event: RequestLogEvent): void {
    if (this.closed) {
      return;
    }
    this.ring.add(event);
    this.queue.push(event);
    if (this.queue.length >= REQUEST_LOG_FLUSH_SIZE) {
      void this.flush().catch(() => {});
      return;
    }
    if (!this.scheduled) {
      this.scheduled = true;
      queueMicrotask(() => {
        this.scheduled = false;
        void this.flush().catch(() => {});
      });
    }
  }

  liveStats(): RequestLogStats {
    return this.ring.stats();
  }

  async idle(): Promise<void> {
    try {
      await this.flush();
    } catch {
      // ignore flush failure
    }
    try {
      await this.pendingWrite;
    } catch {
      // ignore
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }
    await this.idle();
  }

  async flush(): Promise<void> {
    if (this.writing) {
      try {
        await this.pendingWrite;
      } catch {
        // previous write error handled; writing is now false
      }
      if (this.queue.length === 0) {
        return;
      }
    }
    const batch = this.queue.splice(0, this.queue.length);
    if (batch.length === 0) {
      return;
    }
    this.writing = true;
    const write = this.writeBatch(batch).finally(() => {
      this.writing = false;
    });
    this.pendingWrite = write;
    await write;
  }

  async prune(now = Date.now()): Promise<void> {
    this.store.pruneRequestLogs(now);
    const dir = join(this.store.dataDir, "request-logs");
    let names: string[] = [];
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    const cutoff = new Date(now - REQUEST_LOG_EVENT_TTL_MS).toISOString().slice(0, 10);
    await Promise.all(
      names
        .filter((name) => name.endsWith(".jsonl") && name.slice(0, 10) < cutoff)
        .map((name) => unlink(join(dir, name)).catch(() => {})),
    );
  }

  private async writeBatch(batch: RequestLogEvent[]): Promise<void> {
    for (let i = 0; i < batch.length; i += 1) {
      const event = batch[i]!;
      try {
        const record = await this.toRecord(event);
        this.store.insertRequestLog(record, event.attempts);
      } catch (error) {
        const remaining = batch.slice(i);
        this.queue.unshift(...remaining);
        if (this.queue.length > 1024) {
          this.queue.splice(0, this.queue.length - 1024);
        }
        throw error;
      }
    }
  }

  private async toRecord(event: RequestLogEvent): Promise<RequestLogRecord> {
    const id = event.id ?? crypto.randomUUID();
    const startedAt = new Date(event.startedAt).toISOString();
    const endedAtMs = event.endedAt ?? Date.now();
    const usage = event.usage;
    let payloadPath: string | null = null;
    let payloadOffset: number | null = null;
    let payloadTruncated = event.payloadTruncated;
    try {
      const payload = await appendPayload(this.store.dataDir, {
        id,
        request: event.requestBody ?? null,
        response: { status: event.status, body: event.responseBody ?? null },
        usage,
      });
      payloadPath = payload.path;
      payloadOffset = payload.offset;
      payloadTruncated = payloadTruncated || payload.truncated;
    } catch {
      payloadPath = null;
      payloadOffset = null;
    }
    return {
      id,
      startedAt,
      endedAt: new Date(endedAtMs).toISOString(),
      durationMs: Math.max(0, endedAtMs - event.startedAt),
      ttfbMs: event.ttfbMs,
      endpoint: event.endpoint,
      stream: event.stream,
      status: event.status,
      outcome: event.outcome,
      requestModel: event.requestModel,
      upstreamModel: event.upstreamModel,
      providerId: event.providerId,
      connectionId: event.connectionId,
      apiKeyId: event.apiKeyId,
      apiKeyPrefix: event.apiKeyPrefix,
      attemptCount: event.attempts.length,
      inputTokens: usage?.inputTokens ?? null,
      outputTokens: usage?.outputTokens ?? null,
      cacheReadTokens: usage?.cacheReadTokens ?? null,
      cacheWriteTokens: usage?.cacheWriteTokens ?? null,
      usageSource: usage ? "parser" : "missing",
      error: redactLogError(event.error),
      payloadPath,
      payloadOffset,
      payloadTruncated,
    };
  }
}

export async function readRequestPayload(
  dataDir: string,
  path: string | null,
  offset: number | null,
): Promise<{ request: unknown; response: unknown } | null> {
  if (!path || offset === null || offset < 0) {
    return null;
  }
  const abs = join(dataDir, path);
  try {
    const fh = await open(abs, "r");
    try {
      const buf = Buffer.alloc(PAYLOAD_MAX_BYTES + 4096);
      const { bytesRead } = await fh.read(buf, 0, buf.length, offset);
      const slice = buf.subarray(0, bytesRead);
      const newline = slice.indexOf(10);
      const line = slice.subarray(0, newline === -1 ? slice.length : newline).toString("utf8");
      if (!line) {
        return null;
      }
      const parsed = JSON.parse(line) as { request?: unknown; response?: unknown };
      return { request: parsed.request ?? null, response: parsed.response ?? null };
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
}

async function appendPayload(
  dataDir: string,
  payload: { id: string; request: unknown; response: unknown; usage: RequestUsage | null },
): Promise<{ path: string; offset: number; truncated: boolean }> {
  const dir = join(dataDir, "request-logs");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const day = new Date().toISOString().slice(0, 10);
  const rel = join("request-logs", `${day}.jsonl`);
  const abs = join(dataDir, rel);
  let line = `${JSON.stringify(payload)}\n`;
  let truncated = false;
  if (Buffer.byteLength(line) > PAYLOAD_MAX_BYTES) {
    truncated = true;
    line = `${JSON.stringify({
      id: payload.id,
      request: truncateJson(payload.request),
      response: truncateJson(payload.response),
      usage: payload.usage,
      truncated: true,
    })}\n`;
    if (Buffer.byteLength(line) > PAYLOAD_MAX_BYTES) {
      line = `${JSON.stringify({
        id: payload.id,
        request: null,
        response: null,
        usage: payload.usage,
        truncated: true,
      })}\n`;
    }
  }
  const fh = await open(abs, "a", 0o600);
  try {
    const stat = await fh.stat();
    await fh.appendFile(line, "utf8");
    return { path: rel, offset: stat.size, truncated };
  } finally {
    await fh.close();
  }
}

function truncateJson(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length > 2048 ? `${value.slice(0, 2048)}…` : value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 20).map(truncateJson);
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>).slice(0, 32)) {
      out[key] = truncateJson(nested);
    }
    return out;
  }
  return value;
}

class SecondRing {
  private readonly buckets: RingBucket[] = Array.from({ length: 60 }, () => emptyBucket(0));

  add(event: RequestLogEvent, now = event.endedAt ?? Date.now()): void {
    const sec = Math.floor(now / 1000);
    const index = ((sec % 60) + 60) % 60;
    let bucket = this.buckets[index];
    if (!bucket || bucket.ts !== sec) {
      bucket = emptyBucket(sec);
      this.buckets[index] = bucket;
    }
    bucket.requests += 1;
    if (event.outcome === "aborted") {
      bucket.aborted += 1;
    } else if (event.outcome !== "success") {
      bucket.errors += 1;
    }
    if (event.usage) {
      bucket.inputTokens += event.usage.inputTokens;
      bucket.outputTokens += event.usage.outputTokens;
      bucket.cacheReadTokens += event.usage.cacheReadTokens;
      bucket.cacheWriteTokens += event.usage.cacheWriteTokens;
    }
  }

  stats(): RequestLogStats {
    const nowSec = Math.floor(Date.now() / 1000);
    const start = nowSec - 59;
    const series: RequestLogStats["series"] = [];
    let requests = 0;
    let errors = 0;
    let aborted = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    for (let ts = start; ts <= nowSec; ts += 1) {
      const bucket = this.buckets[((ts % 60) + 60) % 60];
      const live = bucket && bucket.ts === ts ? bucket : emptyBucket(ts);
      requests += live.requests;
      errors += live.errors;
      aborted += live.aborted;
      inputTokens += live.inputTokens;
      outputTokens += live.outputTokens;
      cacheReadTokens += live.cacheReadTokens;
      cacheWriteTokens += live.cacheWriteTokens;
      series.push({ t: ts * 1000, requests: live.requests, tokens: live.inputTokens + live.outputTokens });
    }
    const completed = Math.max(0, requests - aborted);
    return {
      window: "1m",
      qps: requests / 60,
      tokenTps: (inputTokens + outputTokens) / 60,
      inputTps: inputTokens / 60,
      outputTps: outputTokens / 60,
      cacheReadTps: cacheReadTokens / 60,
      errorRate: completed === 0 ? 0 : errors / completed,
      requests,
      errors,
      aborted,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      series,
    };
  }
}

function emptyBucket(ts: number): RingBucket {
  return {
    ts,
    requests: 0,
    errors: 0,
    aborted: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
}
