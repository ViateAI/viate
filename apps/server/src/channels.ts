export type ChannelModelRule =
  | { kind: "all" }
  | {
      kind: "models";
      modelIds: string[];
    };

export type LegacyChannelMatch = {
  kind: "match";
  providerId: string | null;
  prefix: string | null;
  excludePrefix: string | null;
  chatOnly: boolean;
};

export type Channel = {
  id: string;
  name: string;
  ratioNumerator: number;
  ratioDenominator: number;
  rule: ChannelModelRule;
};

const CHAT_ENDPOINTS: Record<string, true> = {
  openai: true,
  "openai-response": true,
};

export function parseChannelRatio(input: string): { numerator: number; denominator: number } {
  const text = input.trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,4})?$/.test(text)) {
    throw Object.assign(new Error("ratio is invalid"), { statusCode: 400 });
  }
  const [whole, fraction = ""] = text.split(".");
  const denominator = 10 ** fraction.length;
  const numerator = Number(whole) * denominator + (fraction ? Number(fraction) : 0);
  if (numerator <= 0) {
    throw Object.assign(new Error("ratio is invalid"), { statusCode: 400 });
  }
  const divisor = gcd(numerator, denominator);
  return { numerator: numerator / divisor, denominator: denominator / divisor };
}

export function formatChannelRatio(numerator: number, denominator: number): string {
  if (!Number.isInteger(numerator) || !Number.isInteger(denominator) || denominator <= 0 || numerator < 0) {
    return "1";
  }
  const scaled = (BigInt(numerator) * 10_000n) / BigInt(denominator);
  const whole = scaled / 10_000n;
  const fraction = (scaled % 10_000n).toString().padStart(4, "0").replace(/0+$/, "");
  return fraction ? `${whole.toString()}.${fraction}` : whole.toString();
}

export function parseChannelRule(value: unknown): ChannelModelRule {
  if (!value || typeof value !== "object") {
    throw Object.assign(new Error("rule is invalid"), { statusCode: 400 });
  }
  const record = value as Record<string, unknown>;
  if (record.kind === "all") {
    return { kind: "all" };
  }
  if (record.kind !== "models") {
    throw Object.assign(new Error("rule is invalid"), { statusCode: 400 });
  }
  if (!Array.isArray(record.modelIds)) {
    throw Object.assign(new Error("rule is invalid"), { statusCode: 400 });
  }
  const modelIds = normalizeModelIds(record.modelIds, true);
  if (modelIds.length === 0) {
    throw Object.assign(new Error("rule is empty"), { statusCode: 400 });
  }
  return { kind: "models", modelIds };
}

export function readLegacyChannelMatch(value: unknown): LegacyChannelMatch | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record.kind !== "match") {
    return null;
  }
  return {
    kind: "match",
    providerId: typeof record.providerId === "string" && record.providerId.trim() ? record.providerId.trim() : null,
    prefix: typeof record.prefix === "string" && record.prefix.trim() ? record.prefix.trim() : null,
    excludePrefix:
      typeof record.excludePrefix === "string" && record.excludePrefix.trim() ? record.excludePrefix.trim() : null,
    chatOnly: record.chatOnly === true,
  };
}

export function legacyMatchModelIds(
  rule: LegacyChannelMatch,
  models: readonly { id: string; providerIds: readonly string[]; endpointTypes: readonly string[] }[],
): string[] {
  return models.filter((model) => legacyChannelMatches(rule, model)).map((model) => model.id).sort();
}

export function channelMatchesModel(rule: ChannelModelRule, modelId: string): boolean {
  return rule.kind === "all" || rule.modelIds.includes(modelId);
}

export function applyChannelRatio(charge: bigint, numerator: number, denominator: number): bigint {
  if (!Number.isInteger(numerator) || !Number.isInteger(denominator) || numerator < 0 || denominator <= 0) {
    return charge;
  }
  if (charge <= 0n || numerator === denominator) {
    return charge;
  }
  const num = BigInt(numerator);
  const den = BigInt(denominator);
  return (charge * num + den / 2n) / den;
}

export function normalizeModelIds(value: readonly unknown[], strict: boolean): string[] {
  const ids: string[] = [];
  const seen: Record<string, true> = {};
  for (const item of value) {
    if (typeof item !== "string") {
      if (strict) {
        throw Object.assign(new Error("rule is invalid"), { statusCode: 400 });
      }
      continue;
    }
    const trimmed = item.trim();
    if (!trimmed || trimmed.length > 200 || /\s/.test(trimmed)) {
      if (strict) {
        throw Object.assign(new Error("rule is invalid"), { statusCode: 400 });
      }
      continue;
    }
    if (seen[trimmed]) {
      continue;
    }
    seen[trimmed] = true;
    ids.push(trimmed);
  }
  ids.sort();
  return ids;
}

function legacyChannelMatches(
  rule: LegacyChannelMatch,
  model: { id: string; providerIds: readonly string[]; endpointTypes: readonly string[] },
): boolean {
  if (rule.prefix && !model.id.startsWith(rule.prefix)) {
    return false;
  }
  if (rule.excludePrefix && model.id.startsWith(rule.excludePrefix)) {
    return false;
  }
  if (rule.providerId && model.providerIds.length > 0 && !model.providerIds.includes(rule.providerId)) {
    return false;
  }
  if (
    rule.chatOnly &&
    model.endpointTypes.length > 0 &&
    !model.endpointTypes.some((endpointType) => CHAT_ENDPOINTS[endpointType])
  ) {
    return false;
  }
  return true;
}

function gcd(left: number, right: number): number {
  let a = left;
  let b = right;
  while (b !== 0) {
    const next = a % b;
    a = b;
    b = next;
  }
  return a;
}
