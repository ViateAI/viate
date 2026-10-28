const NANO_PER_USD = 1_000_000_000n;
const USD_TEXT = /^-?(?:0|[1-9]\d*)(?:\.\d{1,9})?$/;

export function asNano(value: number | bigint | null | undefined): bigint {
  if (typeof value === "bigint") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return BigInt(Math.trunc(value));
  }
  return 0n;
}

export function sqlInteger(value: bigint): number | bigint {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    return value;
  }
  return Number(value);
}

export function formatUsd(nano: number | bigint): string {
  const value = typeof nano === "bigint" ? nano : BigInt(Math.trunc(nano));
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / NANO_PER_USD;
  let fraction = (absolute % NANO_PER_USD).toString().padStart(9, "0");
  fraction = fraction.replace(/0+$/, "");
  if (fraction.length < 2) {
    fraction = fraction.padEnd(2, "0");
  }
  return `${negative ? "-" : ""}${whole.toString()}.${fraction}`;
}

export function parseUsdToNano(usd: string): bigint {
  if (!USD_TEXT.test(usd)) {
    throw Object.assign(new Error("usd must be a non-zero decimal"), { statusCode: 400 });
  }
  const negative = usd.startsWith("-");
  const [whole, fraction = ""] = (negative ? usd.slice(1) : usd).split(".");
  const nano = BigInt(whole ?? "0") * NANO_PER_USD + BigInt(fraction.padEnd(9, "0"));
  if (nano === 0n) {
    throw Object.assign(new Error("usd must be a non-zero decimal"), { statusCode: 400 });
  }
  const signed = negative ? -nano : nano;
  const max = BigInt(Number.MAX_SAFE_INTEGER);
  if (signed > max || signed < -max) {
    throw Object.assign(new Error("usd amount is too large"), { statusCode: 400 });
  }
  return signed;
}

export function nanoPerMillionFromUsd(usdPerMillion: unknown): number | null {
  if (typeof usdPerMillion !== "number" || !Number.isFinite(usdPerMillion) || usdPerMillion < 0) {
    return null;
  }
  const nano = Math.round(usdPerMillion * 1_000_000_000);
  if (!Number.isSafeInteger(nano)) {
    return null;
  }
  return nano;
}

export function chargeNano(tokens: number, nanoPerMillion: number): bigint {
  if (typeof tokens !== "number" || !Number.isInteger(tokens) || tokens <= 0) {
    return 0n;
  }
  if (typeof nanoPerMillion !== "number" || !Number.isInteger(nanoPerMillion) || nanoPerMillion <= 0) {
    return 0n;
  }
  return (BigInt(tokens) * BigInt(nanoPerMillion) + 500_000n) / 1_000_000n;
}
