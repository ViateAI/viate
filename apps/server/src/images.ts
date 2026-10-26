export function multipartImageBody(contentType: string | undefined, raw: Buffer): Record<string, unknown> {
  const boundary = boundaryFrom(contentType ?? "");
  if (!boundary) {
    throw Object.assign(new Error("multipart boundary is required"), { statusCode: 400 });
  }
  const fields: Record<string, unknown> = {};
  const images: Array<{ b64_json: string; media_type: string }> = [];
  let mask: { b64_json: string; media_type: string } | undefined;
  for (const part of splitMultipart(raw, boundary)) {
    if (!part.name) {
      continue;
    }
    if (part.name === "image" || part.name === "image[]" || part.name === "images" || part.name === "images[]") {
      images.push({ b64_json: part.body.toString("base64"), media_type: part.mediaType });
      continue;
    }
    if (part.name === "mask" || part.name === "mask[]") {
      mask = { b64_json: part.body.toString("base64"), media_type: part.mediaType };
      continue;
    }
    const text = part.body.toString("utf8");
    const numeric = Number(text);
    fields[part.name] =
      (part.name === "n" || part.name === "output_compression") && text.trim() !== "" && Number.isFinite(numeric)
        ? numeric
        : text;
  }
  if (images.length > 0) {
    fields.images = images;
  }
  if (mask) {
    fields.mask = mask;
  }
  return fields;
}

export function redactImagePayload(value: unknown): unknown {
  if (typeof value === "string") {
    return value.startsWith("data:") ? `«${value.length} chars»` : value;
  }
  if (Array.isArray(value)) {
    return value.map(redactImagePayload);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (typeof nested === "string" && (key === "b64_json" || ((key === "url" || key === "image_url") && nested.startsWith("data:")))) {
      out[key] = `«${nested.length} chars»`;
      continue;
    }
    out[key] = redactImagePayload(nested);
  }
  return out;
}

type MultipartPart = { name: string; mediaType: string; body: Buffer };

function boundaryFrom(contentType: string): string | null {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const value = (match?.[1] ?? match?.[2])?.trim();
  return value || null;
}

function splitMultipart(raw: Buffer, boundary: string): MultipartPart[] {
  const delimiter = Buffer.from(`--${boundary}`);
  const parts: MultipartPart[] = [];
  let start = raw.indexOf(delimiter, 0);
  while (start !== -1) {
    let cursor = start + delimiter.length;
    if (raw[cursor] === 45 && raw[cursor + 1] === 45) {
      break;
    }
    if (raw[cursor] === 13 && raw[cursor + 1] === 10) {
      cursor += 2;
    } else if (raw[cursor] === 10) {
      cursor += 1;
    }
    const next = raw.indexOf(delimiter, cursor);
    if (next === -1) {
      break;
    }
    let end = next;
    if (raw[end - 2] === 13 && raw[end - 1] === 10) {
      end -= 2;
    } else if (raw[end - 1] === 10) {
      end -= 1;
    }
    const parsed = parsePart(raw.subarray(cursor, end));
    if (parsed) {
      parts.push(parsed);
    }
    start = next;
  }
  return parts;
}

function parsePart(chunk: Buffer): MultipartPart | null {
  const separated = headerEnd(chunk);
  if (!separated) {
    return null;
  }
  const header = chunk.subarray(0, separated.header).toString("utf8");
  const name = /(?:^|;)\s*name="([^"]*)"|name=([^;\s]+)/i.exec(header)?.[1] ?? /(?:^|;)\s*name="([^"]*)"|name=([^;\s]+)/i.exec(header)?.[2] ?? "";
  const mediaType = /content-type:\s*([^;\r\n]+)/i.exec(header)?.[1]?.trim() || "application/octet-stream";
  return { name, mediaType, body: chunk.subarray(separated.body) };
}

function headerEnd(chunk: Buffer): { header: number; body: number } | null {
  const crlf = chunk.indexOf("\r\n\r\n");
  if (crlf !== -1) {
    return { header: crlf, body: crlf + 4 };
  }
  const lf = chunk.indexOf("\n\n");
  if (lf !== -1) {
    return { header: lf, body: lf + 2 };
  }
  return null;
}
