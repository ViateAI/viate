import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  classifyCheckout,
  epaySign,
  formFields,
  loadEpaySetup,
  mapiUrl,
  paymentOffers,
  publicUrl,
  readEpayNotify,
  type EpayGateway,
  type EpayOffer,
  type EpaySettings,
  type EpaySetup,
} from "./epay.js";
import { parseUsdToNano } from "./money.js";
import type { AdminStore, PaymentOrder } from "./store.js";

export type { EpayGateway, EpaySetup };

export type PaymentRuntime = {
  setup: EpaySetup;
  gateway: EpayGateway;
  now?: () => Date;
};

type GatewayResult = {
  code: number;
  msg: string;
  payurl: string | null;
  qrcode: string | null;
  urlscheme: string | null;
  tradeNo: string | null;
};

export class PaymentError extends Error {
  statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = "PaymentError";
    this.statusCode = statusCode;
  }
}

export function createHttpEpayGateway(): EpayGateway {
  return {
    async submit(url: URL, body: string, timeoutMs: number): Promise<unknown> {
      let response: Response;
      try {
        response = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
          body,
          redirect: "error",
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
          throw new PaymentError("payment gateway timed out", 504);
        }
        throw new PaymentError("payment gateway unavailable", 502);
      }
      const text = await response.text();
      if (text.length > 65_536) {
        throw new PaymentError("payment gateway returned an invalid response", 502);
      }
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new PaymentError("payment gateway returned an invalid response", 502);
      }
    },
  };
}

export function loadPaymentRuntime(env: NodeJS.ProcessEnv = process.env, gateway: EpayGateway = createHttpEpayGateway()): PaymentRuntime {
  return { setup: loadEpaySetup(env), gateway };
}

export async function registerPaymentRoutes(app: FastifyInstance, store: AdminStore, runtime: PaymentRuntime): Promise<void> {
  const now = runtime.now ?? (() => new Date());

  app.get("/api/portal/payments", async (request, reply) => {
    const user = portalUser(request);
    if (!user) {
      return reply.code(401).send(errorBody("unauthorized"));
    }
    return catalog(store, runtime.setup, user.id, now());
  });

  app.post("/api/portal/payments", async (request, reply) => {
    const user = portalUser(request);
    if (!user) {
      return reply.code(401).send(errorBody("unauthorized"));
    }
    const settings = readySettings(runtime.setup);
    if (!settings) {
      return reply.code(503).send(errorBody(unavailableMessage(runtime.setup)));
    }
    const body = asRecord(request.body);
    const usd = typeof body.usd === "string" ? body.usd : "";
    try {
      const created = await createPayment(store, runtime.gateway, settings, {
        userId: user.id,
        usd,
        clientIp: clientIp(request.ip),
        now: now(),
      });
      return { order: viewOrder(created.order, now()), next: created.next };
    } catch (error) {
      return sendPaymentError(reply, error);
    }
  });

  app.get("/api/portal/payments/:id", async (request, reply) => {
    const user = portalUser(request);
    if (!user) {
      return reply.code(401).send(errorBody("unauthorized"));
    }
    const { id } = request.params as { id: string };
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      return reply.code(404).send(errorBody("payment not found"));
    }
    const order = store.getPaymentOrderForUser(id, user.id);
    if (!order) {
      return reply.code(404).send(errorBody("payment not found"));
    }
    return { order: viewOrder(order, now()) };
  });

  app.route({
    method: ["GET", "POST"],
    url: "/api/payments/epay/notify",
    handler: async (request, reply) => {
      const settings = readySettings(runtime.setup);
      if (!settings) {
        return notifyReply(reply, false);
      }
      const fields = notifyFields(request);
      if (!fields) {
        request.log.warn("epay notify rejected");
        return notifyReply(reply, false);
      }
      const parsed = readEpayNotify(fields, settings.key);
      if (!parsed.ok) {
        request.log.warn({ reason: parsed.reason }, "epay notify rejected");
        return notifyReply(reply, false);
      }
      if (parsed.notify.pid !== settings.pid) {
        request.log.warn({ outTradeNo: parsed.notify.outTradeNo }, "epay notify merchant mismatch");
        return notifyReply(reply, false);
      }
      const applied = store.applyEpayNotification(parsed.notify);
      request.log.info({ outTradeNo: parsed.notify.outTradeNo, outcome: applied.outcome }, "epay notify");
      const accepted = applied.outcome === "paid" || applied.outcome === "duplicate" || applied.outcome === "failed" || applied.outcome === "ignored";
      return notifyReply(reply, accepted);
    },
  });
}

export async function createPayment(
  store: AdminStore,
  gateway: EpayGateway,
  settings: EpaySettings,
  input: { userId: string; usd: string; clientIp: string; now: Date },
): Promise<{ order: PaymentOrder; next: { kind: "link"; url: string } | { kind: "payload"; value: string } }> {
  const offer = matchOffer(settings, input.usd);
  const order = insertOrder(store, settings, input.userId, offer, input.now);
  const fields: Record<string, string> = {
    pid: settings.pid,
    type: settings.payType,
    out_trade_no: order.outTradeNo,
    notify_url: publicUrl(settings.publicBase, "/api/payments/epay/notify"),
    return_url: publicUrl(settings.publicBase, `/portal/account?payment=${order.id}`),
    name: "USD balance",
    money: offer.money,
    clientip: input.clientIp,
    device: settings.device,
    param: settings.currency,
    sign_type: "MD5",
  };
  fields.sign = epaySign(fields, settings.key);
  let payload: unknown;
  try {
    payload = await gateway.submit(mapiUrl(settings.endpoint), new URLSearchParams(fields).toString(), settings.timeoutMs);
  } catch (error) {
    const message = error instanceof PaymentError ? error.message : "payment gateway unavailable";
    store.failPaymentOrder(order.id, message);
    throw error instanceof PaymentError ? error : new PaymentError(message, 502);
  }
  const result = readGatewayPayload(payload);
  if (result.code !== 1) {
    const message = publicGatewayError(result.msg, settings.key);
    store.failPaymentOrder(order.id, message);
    throw new PaymentError(message, 502);
  }
  const checkout = classifyCheckout(result, settings.endpoint, settings.payHosts);
  if (checkout.kind === "reject") {
    store.failPaymentOrder(order.id, checkout.reason);
    throw new PaymentError(checkout.reason, 502);
  }
  const saved = store.setPaymentCheckout(order.id, {
    payUrl: checkout.kind === "link" ? checkout.url : null,
    payPayload: checkout.kind === "payload" ? checkout.value : null,
    tradeNo: result.tradeNo,
  });
  return { order: saved, next: checkout };
}

function insertOrder(store: AdminStore, settings: EpaySettings, userId: string, offer: EpayOffer, now: Date): PaymentOrder {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return store.createPaymentOrder({
        userId,
        outTradeNo: newOutTradeNo(),
        creditNano: offer.nano,
        moneyCents: offer.cents,
        currency: settings.currency,
        payType: settings.payType,
        pid: settings.pid,
        now: now.toISOString(),
        expiresAt: new Date(now.getTime() + settings.orderTtlMs).toISOString(),
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes("payment_orders.out_trade_no")) {
        continue;
      }
      throw error;
    }
  }
  throw new PaymentError("could not allocate a payment order", 500);
}

function matchOffer(settings: EpaySettings, usd: string): EpayOffer {
  let nano: bigint;
  try {
    nano = parseUsdToNano(usd.trim());
  } catch {
    throw new PaymentError("unknown top-up amount", 400);
  }
  const offer = paymentOffers(settings).find((item) => item.nano === nano);
  if (!offer) {
    throw new PaymentError("unknown top-up amount", 400);
  }
  return offer;
}

function catalog(store: AdminStore, setup: EpaySetup, userId: string, now: Date) {
  const orders = store.listPaymentOrders(userId).map((order) => viewOrder(order, now));
  if (setup.state !== "ready") {
    return {
      enabled: false,
      problems: setup.state === "invalid" ? setup.problems : [],
      currency: null,
      payType: null,
      offers: [],
      orders,
    };
  }
  return {
    enabled: true,
    problems: [],
    currency: setup.settings.currency,
    payType: setup.settings.payType,
    offers: paymentOffers(setup.settings).map((offer) => ({
      usd: offer.usd,
      money: offer.money,
      currency: setup.settings.currency,
      payType: setup.settings.payType,
    })),
    orders,
  };
}

function viewOrder(order: PaymentOrder, now: Date) {
  const open = order.status === "pending";
  return {
    id: order.id,
    status: order.status,
    displayStatus: displayStatus(order, now),
    creditUsd: order.creditUsd,
    money: order.money,
    currency: order.currency,
    payType: order.payType,
    createdAt: order.createdAt,
    expiresAt: order.expiresAt,
    paidAt: order.paidAt,
    lastError: order.lastError,
    payUrl: open ? order.payUrl : null,
    payPayload: open ? order.payPayload : null,
  };
}

function displayStatus(order: PaymentOrder, now: Date): "pending" | "paid" | "failed" | "expired" {
  if (order.status === "paid" || order.status === "failed") {
    return order.status;
  }
  return Date.parse(order.expiresAt) <= now.getTime() ? "expired" : "pending";
}

function readySettings(setup: EpaySetup): EpaySettings | null {
  return setup.state === "ready" ? setup.settings : null;
}

function unavailableMessage(setup: EpaySetup): string {
  if (setup.state === "invalid") {
    return `payments are not configured: ${setup.problems.join("; ")}`;
  }
  return "payments are not configured";
}

function readGatewayPayload(payload: unknown): GatewayResult {
  if (!payload || typeof payload !== "object") {
    throw new PaymentError("payment gateway returned an invalid response", 502);
  }
  const record = payload as Record<string, unknown>;
  const code = record.code === 1 || record.code === "1" ? 1 : typeof record.code === "number" && Number.isFinite(record.code) ? record.code : 0;
  return {
    code,
    msg: typeof record.msg === "string" ? record.msg : "",
    payurl: typeof record.payurl === "string" ? record.payurl : null,
    qrcode: typeof record.qrcode === "string" ? record.qrcode : null,
    urlscheme: typeof record.urlscheme === "string" ? record.urlscheme : null,
    tradeNo: typeof record.trade_no === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(record.trade_no) ? record.trade_no : null,
  };
}

function publicGatewayError(message: string, key: string): string {
  const clean = message.replace(/[\u0000\r\n]+/g, " ").trim();
  if (!clean || clean.includes(key)) {
    return "payment gateway rejected the order";
  }
  return clean.slice(0, 180);
}

function notifyFields(request: FastifyRequest): Record<string, string> | null {
  if (request.method === "GET") {
    const raw = request.raw.url ?? "";
    const index = raw.indexOf("?");
    return formFields(index === -1 ? "" : raw.slice(index + 1));
  }
  if (request.method !== "POST") {
    return null;
  }
  if (typeof request.body === "string") {
    return formFields(request.body);
  }
  if (!request.body || typeof request.body !== "object" || Array.isArray(request.body)) {
    return null;
  }
  const fields: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.body)) {
    if (typeof value !== "string" || /[\u0000\r\n]/.test(name) || /[\u0000\r\n]/.test(value)) {
      return null;
    }
    fields[name] = value;
  }
  return fields;
}

function notifyReply(reply: FastifyReply, accepted: boolean) {
  return reply.code(accepted ? 200 : 400).type("text/plain; charset=utf-8").send(accepted ? "success" : "fail");
}

function newOutTradeNo(): string {
  const bytes = randomBytes(10);
  let digits = "";
  for (const byte of bytes) {
    digits += String(byte % 10);
  }
  return digits;
}

function clientIp(ip: string | undefined): string {
  const value = (ip ?? "").replace(/^::ffff:/, "");
  if (/^[0-9a-fA-F:.]+$/.test(value) && value.length <= 64) {
    return value;
  }
  return "127.0.0.1";
}

function portalUser(request: FastifyRequest): { id: string } | undefined {
  const user = (request as FastifyRequest & { portalUser?: { id: string } }).portalUser;
  return user?.id ? user : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    return {};
  }
  return value as Record<string, unknown>;
}

function errorBody(message: string) {
  return { error: { message, type: "viate_error" } };
}

function sendPaymentError(reply: FastifyReply, error: unknown) {
  if (error instanceof PaymentError) {
    return reply.code(error.statusCode).send(errorBody(error.message));
  }
  const status = typeof error === "object" && error !== null && "statusCode" in error ? Number(error.statusCode) : 500;
  const message = error instanceof Error ? error.message : "payment failed";
  return reply.code(status || 500).send(errorBody(message));
}
