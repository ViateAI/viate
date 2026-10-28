import { redactImagePayload, readMultipart } from "./images.js";
import { RouteError } from "./routing.js";

export function multipartAudioBody(contentType: string | undefined, raw: Buffer): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  let file: { b64_json: string; media_type: string } | undefined;
  for (const part of readMultipart(contentType, raw)) {
    if (!part.name) {
      continue;
    }
    if (part.name === "file") {
      file = { b64_json: part.body.toString("base64"), media_type: part.mediaType };
      continue;
    }
    fields[part.name] = part.body.toString("utf8");
  }
  if (file) {
    fields.file = file;
  }
  return fields;
}

export function assertAudioRequest(capability: "audioTranscriptions" | "audioSpeech", body: unknown): void {
  const record = asObject(body);
  if (!record || typeof record.model !== "string" || record.model.trim() === "") {
    throw new RouteError(400, "model is required");
  }
  if (capability === "audioSpeech") {
    if (typeof record.input !== "string" || record.input.trim() === "") {
      throw new RouteError(400, "input is required");
    }
    if (typeof record.voice !== "string" || record.voice.trim() === "") {
      throw new RouteError(400, "voice is required");
    }
    return;
  }
  if (!hasAudioFile(record.file)) {
    throw new RouteError(400, "file is required");
  }
}

export function loggedRequestBody(body: unknown): unknown {
  return redactImagePayload(body);
}

export function loggedResponseBody(capability: string, contentType: string | undefined, body: unknown): unknown {
  if (isAudioResponse(capability, contentType)) {
    return audioPlaceholder(body);
  }
  return redactImagePayload(body);
}

function asObject(value: unknown): { model?: unknown; input?: unknown; voice?: unknown; file?: unknown } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as { model?: unknown; input?: unknown; voice?: unknown; file?: unknown };
}

function hasAudioFile(file: unknown): boolean {
  if (!file || typeof file !== "object" || Array.isArray(file)) {
    return false;
  }
  const b64 = "b64_json" in file ? file.b64_json : undefined;
  return typeof b64 === "string" && b64.length > 0;
}

function isAudioResponse(capability: string, contentType: string | undefined): boolean {
  const type = contentType?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (type.startsWith("audio/")) {
    return true;
  }
  return capability === "audioSpeech" && type !== "application/json" && !type.startsWith("text/");
}

function audioPlaceholder(body: unknown): string {
  if (typeof body === "string") {
    return `«${Buffer.byteLength(body)} bytes»`;
  }
  return "«audio»";
}
