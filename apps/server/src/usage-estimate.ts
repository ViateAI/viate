const OUTPUT_HOLD_CAP = 4096;
const OUTPUT_HOLD_DEFAULT = 256;
const OUTPUT_HOLD_KEYS = ["max_completion_tokens", "max_tokens", "max_output_tokens"] as const;

export function estimateInputTokens(body: unknown): number {
  return tokensFromTexts(extractInputTexts(body));
}

export function estimateOutputHoldTokens(body: unknown): number {
  if (!isRecord(body)) {
    return OUTPUT_HOLD_DEFAULT;
  }
  for (const key of OUTPUT_HOLD_KEYS) {
    const value = body[key];
    if (typeof value === "number" && Number.isInteger(value) && value > 0) {
      return Math.min(value, OUTPUT_HOLD_CAP);
    }
  }
  return OUTPUT_HOLD_DEFAULT;
}

export function estimateOutputTokens(captured: string, contentType?: string): number {
  if (!captured) {
    return 0;
  }
  const sse = typeof contentType === "string" && contentType.toLowerCase().includes("text/event-stream");
  return tokensFromTexts(sse ? extractSseOutputTexts(captured) : extractJsonOutputTexts(captured));
}

function tokensFromTexts(texts: readonly string[]): number {
  if (texts.length === 0) {
    return 0;
  }
  const bytes = Buffer.byteLength(texts.join("\n"), "utf8");
  if (bytes <= 0) {
    return 0;
  }
  return Math.ceil(bytes / 4);
}

function extractInputTexts(body: unknown): string[] {
  if (!isRecord(body)) {
    return [];
  }
  const texts: string[] = [];
  if (typeof body.prompt === "string" && body.prompt) {
    texts.push(body.prompt);
  }
  texts.push(...textsFromParts(body.system));
  texts.push(...textsFromInput(body.input));
  if (Array.isArray(body.messages)) {
    for (const message of body.messages) {
      if (isRecord(message)) {
        texts.push(...textsFromContent(message.content));
      }
    }
  }
  return texts;
}

function textsFromInput(value: unknown): string[] {
  if (typeof value === "string") {
    return value ? [value] : [];
  }
  if (!Array.isArray(value)) {
    return [];
  }
  const texts: string[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      if (item) {
        texts.push(item);
      }
      continue;
    }
    if (!isRecord(item)) {
      continue;
    }
    if (typeof item.text === "string" && item.text) {
      texts.push(item.text);
      continue;
    }
    if ("content" in item) {
      texts.push(...textsFromContent(item.content));
    }
  }
  return texts;
}

function textsFromContent(value: unknown): string[] {
  if (typeof value === "string") {
    return value ? [value] : [];
  }
  return textsFromParts(value);
}

function textsFromParts(value: unknown): string[] {
  if (typeof value === "string") {
    return value ? [value] : [];
  }
  if (isTextPart(value)) {
    return value.text ? [value.text] : [];
  }
  if (!Array.isArray(value)) {
    return [];
  }
  const texts: string[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      if (item) {
        texts.push(item);
      }
    } else if (isTextPart(item) && item.text) {
      texts.push(item.text);
    }
  }
  return texts;
}

function extractJsonOutputTexts(captured: string): string[] {
  try {
    return outputTextsFromValue(JSON.parse(captured) as unknown);
  } catch {
    return [];
  }
}

function extractSseOutputTexts(captured: string): string[] {
  const texts: string[] = [];
  for (const block of captured.split(/\r?\n\r?\n/)) {
    const dataLines: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
    const data = dataLines.join("\n");
    if (!data || data === "[DONE]") {
      continue;
    }
    try {
      texts.push(...outputTextsFromValue(JSON.parse(data) as unknown));
    } catch {
      // Non-JSON data frames are not billable text.
    }
  }
  return texts;
}

function outputTextsFromValue(value: unknown): string[] {
  if (!isRecord(value)) {
    return [];
  }
  const texts: string[] = [];
  if (Array.isArray(value.choices)) {
    for (const choice of value.choices) {
      if (!isRecord(choice)) {
        continue;
      }
      if (isRecord(choice.message)) {
        texts.push(...textsFromContent(choice.message.content));
      }
      if (typeof choice.text === "string" && choice.text) {
        texts.push(choice.text);
      }
      if (isRecord(choice.delta)) {
        texts.push(...textsFromContent(choice.delta.content));
      }
    }
  }
  const fromOutput: string[] = [];
  if (Array.isArray(value.output)) {
    for (const item of value.output) {
      if (isRecord(item)) {
        fromOutput.push(...textsFromContent(item.content));
      }
    }
  }
  if (fromOutput.length > 0) {
    texts.push(...fromOutput);
  } else if (typeof value.output_text === "string" && value.output_text) {
    texts.push(value.output_text);
  }
  if (Array.isArray(value.content)) {
    texts.push(...textsFromContent(value.content));
  }
  return texts;
}

function isTextPart(value: unknown): value is { text: string } {
  return isRecord(value) && typeof value.text === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
