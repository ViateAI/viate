export type ChannelModelRule =
  | { kind: "all" }
  | {
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

const CHAT_CAPABILITIES: Record<string, true> = {
  chatCompletions: true,
  responses: true,
  responsesCompact: true,
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
  if (record.kind !== "match") {
    throw Object.assign(new Error("rule is invalid"), { statusCode: 400 });
  }
  const providerId = optionalRuleString(record.providerId);
  const prefix = optionalRuleString(record.prefix);
  const excludePrefix = optionalRuleString(record.excludePrefix);
  if (record.chatOnly !== undefined && typeof record.chatOnly !== "boolean") {
    throw Object.assign(new Error("rule is invalid"), { statusCode: 400 });
  }
  const chatOnly = record.chatOnly === true;
  if (!providerId && !prefix && !excludePrefix && !chatOnly) {
    throw Object.assign(new Error("rule is empty"), { statusCode: 400 });
  }
  return { kind: "match", providerId, prefix, excludePrefix, chatOnly };
}

export function channelMatchesModel(
  rule: ChannelModelRule,
  model: { id: string; providerIds: readonly string[]; endpointTypes: readonly string[] },
  capability: string | null,
): boolean {
  if (rule.kind === "all") {
    return true;
  }
  if (rule.chatOnly && capability && !CHAT_CAPABILITIES[capability]) {
    return false;
  }
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

export function channelProviderLimit(rule: ChannelModelRule): readonly string[] | null {
  return rule.kind === "match" && rule.providerId ? [rule.providerId] : null;
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

function optionalRuleString(value: unknown): string | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  if (typeof value !== "string") {
    throw Object.assign(new Error("rule is invalid"), { statusCode: 400 });
  }
  const trimmed = value.trim();
  return trimmed || null;
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
