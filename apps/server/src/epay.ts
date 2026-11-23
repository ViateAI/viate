import { createHash, timingSafeEqual } from "node:crypto";
import { formatUsd, parseUsdToNano } from "./money.js";

const PID_TEXT = /^[1-9][0-9]{0,17}$/;
const TYPE_TEXT = /^[A-Za-z0-9_]{1,32}$/;
const CURRENCY_TEXT = /^[A-Z][A-Z0-9]{1,11}$/;
const DEVICE_TEXT = /^[a-z][a-z0-9_]{0,15}$/;
const RATE_TEXT = /^(?:0|[1-9]\d{0,8})(?:\.\d{1,8})?$/;
const TRADE_NO_TEXT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const OUT_TRADE_NO_TEXT = /^[0-9]{8,32}$/;
const TRADE_STATUS_TEXT = /^[A-Z_]{1,32}$/;
const MONEY_TEXT = /^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/;

export type EpayGateway = {
  submit(url: URL, body: string, timeoutMs: number): Promise<unknown>;
};

export type EpaySettings = {
  endpoint: URL;
  pid: string;
  key: string;
  publicBase: URL;
  payType: string;
  currency: string;
  quotePerUsd: string;
  amountsNano: bigint[];
  orderTtlMs: number;
  timeoutMs: number;
  device: string;
  payHosts: string[];
};

export type EpaySetup =
  | { state: "off" }
  | { state: "invalid"; problems: string[] }
  | { state: "ready"; settings: EpaySettings };

export type EpayOffer = {
  usd: string;
  nano: bigint;
  money: string;
  cents: bigint;
};

export type EpayNotify = {
  pid: string;
  tradeNo: string;
  outTradeNo: string;
  payType: string;
  moneyCents: bigint;
  tradeStatus: string;
  currency: string;
};

const EPAY_ENV = [
  "VIATE_EPAY_ENDPOINT",
  "VIATE_EPAY_PID",
  "VIATE_EPAY_KEY",
  "VIATE_EPAY_PUBLIC_BASE",
  "VIATE_EPAY_TYPE",
  "VIATE_EPAY_CURRENCY",
  "VIATE_EPAY_QUOTE_PER_USD",
  "VIATE_EPAY_USD_AMOUNTS",
  "VIATE_EPAY_DEVICE",
  "VIATE_EPAY_ORDER_TTL_SECONDS",
  "VIATE_EPAY_TIMEOUT_MS",
  "VIATE_EPAY_PAY_HOSTS",
] as const;

export function loadEpaySetup(env: NodeJS.ProcessEnv = process.env): EpaySetup {
  const present = EPAY_ENV.some((name) => (env[name] ?? "").trim() !== "");
  if (!present) {
    return { state: "off" };
  }

  const problems: string[] = [];
  const endpoint = requiredUrl(env, "VIATE_EPAY_ENDPOINT", problems);
  const publicBase = requiredUrl(env, "VIATE_EPAY_PUBLIC_BASE", problems);
  const pid = requiredMatch(env, "VIATE_EPAY_PID", PID_TEXT, problems);
  const key = requiredKey(env, problems);
  const payType = requiredMatch(env, "VIATE_EPAY_TYPE", TYPE_TEXT, problems);
  const currency = requiredMatch(env, "VIATE_EPAY_CURRENCY", CURRENCY_TEXT, problems);
  const quotePerUsd = requiredMatch(env, "VIATE_EPAY_QUOTE_PER_USD", RATE_TEXT, problems);
  const device = optionalMatch(env, "VIATE_EPAY_DEVICE", DEVICE_TEXT, "jump", problems);
  const orderTtlSeconds = optionalInteger(env, "VIATE_EPAY_ORDER_TTL_SECONDS", 1800, 1, 86_400, problems);
  const timeoutMs = optionalInteger(env, "VIATE_EPAY_TIMEOUT_MS", 10_000, 1_000, 30_000, problems);
  const extraHosts = payHosts(env.VIATE_EPAY_PAY_HOSTS, problems);
  const amountsNano = usdAmounts(env.VIATE_EPAY_USD_AMOUNTS, problems);

  if (quotePerUsd && amountsNano.length > 0) {
    for (const nano of amountsNano) {
      const cents = quoteCents(nano, quotePerUsd);
      if (cents <= 0n || cents > 9_000_000_000_000n) {
        problems.push("VIATE_EPAY_QUOTE_PER_USD cannot price the configured USD amounts");
        break;
      }
    }
  }

  if (
    problems.length > 0 ||
    !endpoint ||
    !publicBase ||
    !pid ||
    !key ||
    !payType ||
    !currency ||
    !quotePerUsd ||
    !device ||
    orderTtlSeconds === null ||
    timeoutMs === null ||
    !extraHosts ||
    amountsNano.length === 0
  ) {
    return { state: "invalid", problems: unique(problems) };
  }

  const base = new URL(endpoint.href);
  if (!base.pathname.endsWith("/")) {
    base.pathname = `${base.pathname}/`;
  }
  return {
    state: "ready",
    settings: {
      endpoint: base,
      pid,
      key,
      publicBase,
      payType,
      currency,
      quotePerUsd,
      amountsNano,
      orderTtlMs: orderTtlSeconds * 1000,
      timeoutMs,
      device,
      payHosts: unique([base.host, ...extraHosts]),
    },
  };
}

export function paymentOffers(settings: EpaySettings): EpayOffer[] {
  return settings.amountsNano.map((nano) => {
    const cents = quoteCents(nano, settings.quotePerUsd);
    return { usd: formatUsd(nano), nano, money: formatCents(cents), cents };
  });
}

export function quoteCents(creditNano: bigint, quotePerUsd: string): bigint {
  const [whole, fraction = ""] = quotePerUsd.split(".");
  const scale = 10n ** BigInt(fraction.length);
  const rate = BigInt(whole ?? "0") * scale + BigInt(fraction || "0");
  const denom = 1_000_000_000n * scale;
  const numer = creditNano * rate * 100n;
  return (numer + denom / 2n) / denom;
}

export function formatCents(cents: bigint): string {
  const negative = cents < 0n;
  const absolute = negative ? -cents : cents;
  const whole = absolute / 100n;
  const fraction = (absolute % 100n).toString().padStart(2, "0");
  return `${negative ? "-" : ""}${whole.toString()}.${fraction}`;
}

export function parseMoneyCents(money: string): bigint | null {
  if (!MONEY_TEXT.test(money)) {
    return null;
  }
  const [whole, fraction = ""] = money.split(".");
  const cents = BigInt(whole ?? "0") * 100n + BigInt(fraction.padEnd(2, "0"));
  if (cents <= 0n) {
    return null;
  }
  return cents;
}

// EPay signs the decoded form fields. `sign`, `sign_type`, and empty values are
// left out. The key is concatenated, not added as another field.
export function epaySign(fields: Record<string, string>, key: string): string {
  const serialized = Object.keys(fields)
    .filter((name) => name !== "sign" && name !== "sign_type" && fields[name] !== "")
    .sort()
    .map((name) => `${name}=${fields[name]}`)
    .join("&");
  return createHash("md5").update(serialized + key, "utf8").digest("hex");
}

export function epaySignValid(fields: Record<string, string>, key: string, sign: string): boolean {
  if (!/^[0-9a-f]{32}$/.test(sign)) {
    return false;
  }
  const expected = Buffer.from(epaySign(fields, key), "utf8");
  const actual = Buffer.from(sign, "utf8");
  return timingSafeEqual(expected, actual);
}

export function formFields(serialized: string): Record<string, string> | null {
  const raw = serialized.startsWith("?") ? serialized.slice(1) : serialized;
  const params = new URLSearchParams(raw);
  const fields: Record<string, string> = {};
  for (const [name, value] of params) {
    if (Object.prototype.hasOwnProperty.call(fields, name) || /[\u0000\r\n]/.test(name) || /[\u0000\r\n]/.test(value)) {
      return null;
    }
    fields[name] = value;
  }
  return fields;
}

// Notify payloads have no currency field. The order's `param` is defined to be
// echoed unchanged, so that is the currency check. A gateway-specific `currency`
// field, when present, must match it. `type` is not defaulted: upstream's type
// list has no USDT, and a wrong type must not fall through to another method.
export function readEpayNotify(fields: Record<string, string>, key: string): { ok: true; notify: EpayNotify } | { ok: false; reason: "bad-sign" | "bad-request" } {
  const sign = fields.sign ?? "";
  if (!epaySignValid(fields, key, sign.toLowerCase())) {
    return { ok: false, reason: "bad-sign" };
  }
  if ((fields.sign_type ?? "").toUpperCase() !== "MD5") {
    return { ok: false, reason: "bad-request" };
  }
  const pid = fields.pid ?? "";
  const tradeNo = fields.trade_no ?? "";
  const outTradeNo = fields.out_trade_no ?? "";
  const payType = fields.type ?? "";
  const currency = fields.param ?? "";
  const tradeStatus = fields.trade_status ?? "";
  const moneyCents = parseMoneyCents(fields.money ?? "");
  if (
    !PID_TEXT.test(pid) ||
    !TRADE_NO_TEXT.test(tradeNo) ||
    !OUT_TRADE_NO_TEXT.test(outTradeNo) ||
    !TYPE_TEXT.test(payType) ||
    !CURRENCY_TEXT.test(currency) ||
    !TRADE_STATUS_TEXT.test(tradeStatus) ||
    moneyCents === null
  ) {
    return { ok: false, reason: "bad-request" };
  }
  if (fields.currency !== undefined && fields.currency !== "" && fields.currency !== currency) {
    return { ok: false, reason: "bad-request" };
  }
  return { ok: true, notify: { pid, tradeNo, outTradeNo, payType, moneyCents, tradeStatus, currency } };
}

export type CheckoutTarget =
  | { kind: "link"; url: string }
  | { kind: "payload"; value: string }
  | { kind: "reject"; reason: string };

export function classifyCheckout(
  response: { payurl?: string | null; qrcode?: string | null; urlscheme?: string | null },
  endpoint: URL,
  allowedHosts: readonly string[] = [endpoint.host],
): CheckoutTarget {
  const present = [
    ["payurl", cleanField(response.payurl)],
    ["qrcode", cleanField(response.qrcode)],
    ["urlscheme", cleanField(response.urlscheme)],
  ].filter((entry): entry is [string, string] => entry[1] !== null);
  if (present.length === 0) {
    return { kind: "reject", reason: "payment gateway returned no checkout" };
  }
  if (present.length > 1) {
    return { kind: "reject", reason: "payment gateway returned multiple checkout urls" };
  }
  const [name, value] = present[0]!;
  if (name === "payurl") {
    const url = safeGatewayUrl(value, endpoint, allowedHosts);
    if (!url) {
      return { kind: "reject", reason: "payment gateway returned an unsafe redirect" };
    }
    return { kind: "link", url: url.href };
  }
  const linked = safeGatewayUrl(value, endpoint, allowedHosts);
  if (linked) {
    return { kind: "link", url: linked.href };
  }
  if (isHttpUrl(value) || value.startsWith("//")) {
    return { kind: "reject", reason: "payment gateway returned an unsafe redirect" };
  }
  if (!isDisplayPayload(value)) {
    return { kind: "reject", reason: "payment gateway returned an unsafe checkout payload" };
  }
  return { kind: "payload", value };
}

export function mapiUrl(endpoint: URL): URL {
  return new URL("mapi.php", endpoint);
}

export function publicUrl(base: URL, pathAndQuery: string): string {
  const prefix = base.pathname.replace(/\/+$/, "");
  return `${base.origin}${prefix}${pathAndQuery}`;
}

function safeGatewayUrl(raw: string, endpoint: URL, allowedHosts: readonly string[]): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.username || url.password || url.href.includes("\\")) {
    return null;
  }
  if (endpoint.protocol === "https:" && url.protocol !== "https:") {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return null;
  }
  if (!allowedHosts.includes(url.host)) {
    return null;
  }
  return url;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isDisplayPayload(value: string): boolean {
  if (value.length < 1 || value.length > 2048 || /[\u0000-\u001f\u007f]/.test(value)) {
    return false;
  }
  const lower = value.slice(0, 16).toLowerCase();
  return !lower.startsWith("javascript:") && !lower.startsWith("data:") && !lower.startsWith("vbscript:") && !lower.startsWith("file:");
}

function cleanField(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function requiredKey(env: NodeJS.ProcessEnv, problems: string[]): string | null {
  const value = requiredText(env, "VIATE_EPAY_KEY", problems);
  if (value && value.length < 8) {
    problems.push("VIATE_EPAY_KEY is invalid");
    return null;
  }
  return value;
}

function requiredText(env: NodeJS.ProcessEnv, name: string, problems: string[]): string | null {
  const value = (env[name] ?? "").trim();
  if (!value) {
    problems.push(`${name} is missing`);
    return null;
  }
  if (value.length > 2048) {
    problems.push(`${name} is too long`);
    return null;
  }
  return value;
}

function requiredMatch(env: NodeJS.ProcessEnv, name: string, pattern: RegExp, problems: string[]): string | null {
  const value = requiredText(env, name, problems);
  if (!value) {
    return null;
  }
  if (!pattern.test(value)) {
    problems.push(`${name} is invalid`);
    return null;
  }
  return value;
}

function optionalMatch(env: NodeJS.ProcessEnv, name: string, pattern: RegExp, fallback: string, problems: string[]): string | null {
  const value = (env[name] ?? "").trim();
  if (!value) {
    return fallback;
  }
  if (!pattern.test(value)) {
    problems.push(`${name} is invalid`);
    return null;
  }
  return value;
}

function optionalInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
  problems: string[],
): number | null {
  const value = (env[name] ?? "").trim();
  if (!value) {
    return fallback;
  }
  if (!/^[0-9]+$/.test(value)) {
    problems.push(`${name} is invalid`);
    return null;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    problems.push(`${name} is invalid`);
    return null;
  }
  return parsed;
}

function requiredUrl(env: NodeJS.ProcessEnv, name: string, problems: string[]): URL | null {
  const value = requiredText(env, name, problems);
  if (!value) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    problems.push(`${name} must be an absolute http(s) URL`);
    return null;
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || url.search || url.hash) {
    problems.push(`${name} must be an absolute http(s) URL without credentials or a query`);
    return null;
  }
  return url;
}

function payHosts(raw: string | undefined, problems: string[]): string[] | null {
  const value = (raw ?? "").trim();
  if (!value) {
    return [];
  }
  const hosts = value.split(",").map((part) => part.trim().toLowerCase());
  if (hosts.length > 8 || hosts.some((host) => !/^[a-z0-9.-]+(?::[0-9]{1,5})?$/.test(host) || host.includes(".."))) {
    problems.push("VIATE_EPAY_PAY_HOSTS is invalid");
    return null;
  }
  return hosts;
}

function usdAmounts(raw: string | undefined, problems: string[]): bigint[] {
  const value = (raw ?? "").trim();
  if (!value) {
    problems.push("VIATE_EPAY_USD_AMOUNTS is missing");
    return [];
  }
  const parts = value.split(",").map((part) => part.trim());
  if (parts.length > 12 || parts.some((part) => part === "")) {
    problems.push("VIATE_EPAY_USD_AMOUNTS is invalid");
    return [];
  }
  const amounts: bigint[] = [];
  for (const part of parts) {
    try {
      const nano = parseUsdToNano(part);
      if (nano <= 0n || nano > 100_000n * 1_000_000_000n) {
        problems.push("VIATE_EPAY_USD_AMOUNTS is invalid");
        return [];
      }
      amounts.push(nano);
    } catch {
      problems.push("VIATE_EPAY_USD_AMOUNTS is invalid");
      return [];
    }
  }
  if (new Set(amounts.map((amount) => amount.toString())).size !== amounts.length) {
    problems.push("VIATE_EPAY_USD_AMOUNTS contains duplicates");
    return [];
  }
  return amounts;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
