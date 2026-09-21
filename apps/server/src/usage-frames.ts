import type { HttpExchange, RequestUsage } from "@viateai/sdk";

export const PAYLOAD_MAX_BYTES = 1_048_576;

export type TapResult = {
  text: string;
  usage: RequestUsage | null;
  truncated: boolean;
  ttfbMs: number | null;
  responseBody: unknown;
};

const SSE_FRAME_CAP = 64;

export function frameJson(text: string): unknown[] {
  if (!text.trim()) {
    return [];
  }
  try {
    return [JSON.parse(text) as unknown];
  } catch {
    return [];
  }
}

export function frameSse(text: string): unknown[] {
  const frames: unknown[] = [];
  drainSse(text, frames, true);
  return frames;
}

export function tapExchange(exchange: HttpExchange, startedAt = Date.now()): {
  exchange: HttpExchange;
  tap: Promise<TapResult>;
} {
  if (!exchange.body) {
    return {
      exchange,
      tap: Promise.resolve({
        text: "",
        usage: null,
        truncated: false,
        ttfbMs: null,
        responseBody: null,
      }),
    };
  }
  const [client, probe] = exchange.body.tee();
  return {
    exchange: { ...exchange, body: client },
    tap: consumeTap(probe, exchange, startedAt),
  };
}

async function consumeTap(
  body: ReadableStream<Uint8Array>,
  exchange: HttpExchange,
  startedAt: number,
): Promise<TapResult> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  const stored: Uint8Array[] = [];
  let storedBytes = 0;
  let truncated = false;
  let ttfbMs: number | null = null;
  let decoded = "";
  const sse = isSse(exchange.headers["content-type"]);
  const frames: unknown[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value) {
        continue;
      }
      if (ttfbMs === null) {
        ttfbMs = Date.now() - startedAt;
      }
      if (!truncated) {
        const remaining = PAYLOAD_MAX_BYTES - storedBytes;
        if (value.byteLength <= remaining) {
          stored.push(value);
          storedBytes += value.byteLength;
        } else {
          if (remaining > 0) {
            stored.push(value.slice(0, remaining));
            storedBytes += remaining;
          }
          truncated = true;
        }
      }
      if (sse) {
        decoded += decoder.decode(value, { stream: true });
        decoded = drainSse(decoded, frames);
      }
    }
    if (sse) {
      decoded += decoder.decode();
      drainSse(decoded, frames, true);
    }
  } catch {
    // Client abort or upstream reset: keep whatever was framed.
  }

  const text = Buffer.concat(stored.map((chunk) => Buffer.from(chunk))).toString("utf8");
  const parsedFrames = sse ? frames : frameJson(text);
  let usage: RequestUsage | null = null;
  if (exchange.parseUsage) {
    try {
      usage = exchange.parseUsage(parsedFrames);
    } catch {
      usage = null;
    }
  }
  let responseBody: unknown = text;
  if (!sse) {
    responseBody = parsedFrames[0] ?? text;
  }
  return { text, usage, truncated, ttfbMs, responseBody };
}

function isSse(contentType: string | undefined): boolean {
  return typeof contentType === "string" && contentType.toLowerCase().includes("text/event-stream");
}

function drainSse(buffer: string, frames: unknown[], flush = false): string {
  let remaining = buffer;
  for (;;) {
    const split = remaining.search(/\r?\n\r?\n/);
    if (split === -1) {
      if (flush && remaining.trim()) {
        pushSseFrames(remaining, frames);
      }
      return flush ? "" : remaining;
    }
    const match = remaining.slice(split).match(/^\r?\n\r?\n/);
    const gap = match?.[0].length ?? 2;
    pushSseFrames(remaining.slice(0, split), frames);
    remaining = remaining.slice(split + gap);
  }
}

function hasUsageInfo(frame: unknown): boolean {
  if (!frame || typeof frame !== "object" || Array.isArray(frame)) {
    return false;
  }
  const record = frame as Record<string, unknown>;
  if (record.usage && typeof record.usage === "object") {
    return true;
  }
  if (
    record.message &&
    typeof record.message === "object" &&
    !Array.isArray(record.message) &&
    (record.message as Record<string, unknown>).usage &&
    typeof (record.message as Record<string, unknown>).usage === "object"
  ) {
    return true;
  }
  return false;
}

function pushSseFrames(block: string, frames: unknown[]): void {
  const dataLines: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  const data = dataLines.join("\n");
  if (!data || data === "[DONE]") {
    return;
  }
  try {
    frames.push(JSON.parse(data) as unknown);
    if (frames.length > SSE_FRAME_CAP) {
      const evictIndex = frames.findIndex((frame) => !hasUsageInfo(frame));
      if (evictIndex !== -1) {
        frames.splice(evictIndex, 1);
      } else {
        frames.shift();
      }
    }
  } catch {
    // Non-JSON data frames are ignored for usage parsing.
  }
}
