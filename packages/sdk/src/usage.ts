export type RequestUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

export type UsageParser = (frames: unknown[]) => RequestUsage | null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function tokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function lastUsage(frames: unknown[]): Record<string, unknown> | null {
  for (let i = frames.length - 1; i >= 0; i -= 1) {
    const frame = frames[i];
    if (isRecord(frame) && isRecord(frame.usage)) {
      return frame.usage;
    }
  }
  return null;
}

export function parseOpenAIChatUsage(frames: unknown[]): RequestUsage | null {
  const usage = lastUsage(frames);
  if (!usage || !("prompt_tokens" in usage || "completion_tokens" in usage)) {
    return null;
  }
  const details = isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details : {};
  return {
    inputTokens: tokenCount(usage.prompt_tokens),
    outputTokens: tokenCount(usage.completion_tokens),
    cacheReadTokens: tokenCount(details.cached_tokens),
    cacheWriteTokens: 0,
  };
}

export function parseOpenAIResponsesUsage(frames: unknown[]): RequestUsage | null {
  const usage = lastUsage(frames);
  if (!usage || !("input_tokens" in usage || "output_tokens" in usage)) {
    return null;
  }
  const details = isRecord(usage.input_tokens_details) ? usage.input_tokens_details : {};
  return {
    inputTokens: tokenCount(usage.input_tokens),
    outputTokens: tokenCount(usage.output_tokens),
    cacheReadTokens: tokenCount(details.cached_tokens),
    cacheWriteTokens: 0,
  };
}

export function parseAnthropicUsage(frames: unknown[]): RequestUsage | null {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let found = false;
  for (const frame of frames) {
    if (!isRecord(frame)) {
      continue;
    }
    const nested = isRecord(frame.message) && isRecord(frame.message.usage) ? frame.message.usage : null;
    const usage = isRecord(frame.usage) ? frame.usage : nested;
    if (!usage) {
      continue;
    }
    found = true;
    inputTokens += tokenCount(usage.input_tokens);
    outputTokens += tokenCount(usage.output_tokens);
    cacheReadTokens += tokenCount(usage.cache_read_input_tokens);
    cacheWriteTokens += tokenCount(usage.cache_creation_input_tokens);
  }
  if (!found) {
    return null;
  }
  return {
    inputTokens: inputTokens + cacheReadTokens + cacheWriteTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
  };
}
