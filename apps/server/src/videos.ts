import type { HttpExchange } from "@viateai/sdk";
import { readMultipart, type MultipartPart } from "./images.js";
import type { AdminStore, StoredApiKey } from "./store.js";

export const VIDEO_MULTIPART_PATHS: Record<string, true> = {
  "/v1/videos/generations": true,
  "/v1/videos/edits": true,
  "/v1/videos/extensions": true,
};

type InlineMedia = { b64_json: string; media_type: string };

const SINGLE_MEDIA_FIELDS: Record<string, true> = {
  image: true,
  last_frame: true,
  video: true,
};

const ARRAY_MEDIA_FIELDS: Record<string, string> = {
  reference_images: "reference_images",
  "reference_images[]": "reference_images",
  reference_audios: "reference_audios",
  "reference_audios[]": "reference_audios",
};

const NUMERIC_FIELDS: Record<string, true> = { duration: true, seconds: true };

export function multipartVideoBody(contentType: string | undefined, raw: Buffer): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  const single: Record<string, InlineMedia> = {};
  const arrays: Record<string, InlineMedia[]> = {};
  for (const part of readMultipart(contentType, raw)) {
    if (!part.name) {
      continue;
    }
    const arrayField = ARRAY_MEDIA_FIELDS[part.name];
    if (part.filename !== null) {
      if (SINGLE_MEDIA_FIELDS[part.name]) {
        single[part.name] = inlineMedia(part);
        continue;
      }
      if (arrayField) {
        (arrays[arrayField] ??= []).push(inlineMedia(part));
        continue;
      }
    }
    fields[arrayField ?? part.name] = textField(part.name, part.body.toString("utf8"));
  }
  for (const [name, media] of Object.entries(single)) {
    fields[name] = media;
  }
  for (const [name, media] of Object.entries(arrays)) {
    fields[name] = media;
  }
  return fields;
}

/**
 * Buffers a submit response so the job row exists before the client can poll it.
 * Non-JSON bodies stay streamed and are never saved.
 */
export async function captureVideoJob(
  exchange: HttpExchange,
  routed: { requestModel: string; providerId: string | null; connectionId: string | null },
  store: AdminStore,
  apiKey: StoredApiKey | null,
): Promise<HttpExchange> {
  if (exchange.status < 200 || exchange.status >= 300 || !exchange.body) {
    return exchange;
  }
  if (!isJsonContent(exchange.headers["content-type"])) {
    return exchange;
  }
  const bytes = new Uint8Array(await new Response(exchange.body).arrayBuffer());
  const replayed: HttpExchange = { ...exchange, body: bytesStream(bytes) };
  const requestId = videoRequestIdFrom(bytes);
  if (!requestId || !routed.connectionId || !routed.providerId) {
    return replayed;
  }
  store.saveVideoRequest({
    requestId,
    connectionId: routed.connectionId,
    providerId: routed.providerId,
    modelId: routed.requestModel,
    userId: apiKey?.userId ?? null,
    apiKeyId: apiKey?.id ?? null,
  });
  return replayed;
}

function inlineMedia(part: MultipartPart): InlineMedia {
  return { b64_json: part.body.toString("base64"), media_type: part.mediaType };
}

function textField(name: string, text: string): unknown {
  const trimmed = text.trim();
  if (NUMERIC_FIELDS[name] && trimmed !== "" && Number.isFinite(Number(trimmed))) {
    return Number(trimmed);
  }
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      return text;
    }
  }
  return text;
}

function videoRequestIdFrom(bytes: Uint8Array): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || !("request_id" in parsed)) {
    return null;
  }
  const requestId = (parsed as { request_id: unknown }).request_id;
  return typeof requestId === "string" && requestId.trim() ? requestId : null;
}

function isJsonContent(contentType: string | undefined): boolean {
  return (contentType?.split(";")[0]?.trim().toLowerCase() ?? "") === "application/json";
}

function bytesStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}
