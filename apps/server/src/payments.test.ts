import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { buildApp, type App } from "./app.js";
import { epaySign, type EpayGateway, type EpaySettings, type EpaySetup } from "./epay.js";
import type { PaymentRuntime } from "./payments.js";
import { AdminStore } from "./store.js";

const ORIGIN = "http://localhost:80";
const HOST = "localhost:80";
const KEY = "test-key";
const state: { submitted: string[]; gatewayResult: unknown; clock: number } = {
  submitted: [],
  gatewayResult: { code: 1, payurl: "http://127.0.0.1:9/epay/cashier/1", trade_no: "G1" },
  clock: Date.parse("2026-01-01T00:00:00.000Z"),
};

describe("epay payments", { concurrency: false }, () => {
  let dataDir = "";
  let store: AdminStore;
  let app: App;

  before(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "viate-epay-"));
    store = await AdminStore.open(dataDir);
    app = await buildApp({ logger: false, store, payments: runtime() });
  });

  after(async () => {
    await app.close();
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("charges the configured quote, ignores client money, and credits once on a signed notify", async () => {
    const user = store.createUser({ email: "pay@example.com", name: "Pay", password: "password1" });
    const session = await login(app, "pay@example.com");
    const created = await portal(app, session, {
      method: "POST",
      url: "/api/portal/payments",
      payload: { usd: "10", money: "0.01", currency: "CNY", type: "alipay", return_url: "https://evil.example/steal" },
    });
    assert.equal(created.statusCode, 200);
    const body = created.json() as { order: OrderView; next: { kind: string; url: string } };
    assert.equal(body.order.money, "10.00");
    assert.equal(body.order.currency, "USDT");
    assert.equal(body.order.payType, "usdt");
    assert.equal(body.order.creditUsd, "10.00");
    assert.equal(body.order.displayStatus, "pending");
    assert.equal(body.next.kind, "link");
    assert.equal(body.next.url, "http://127.0.0.1:9/epay/cashier/1");
    const form = new URLSearchParams(state.submitted[0]);
    assert.equal(form.get("money"), "10.00");
    assert.equal(form.get("type"), "usdt");
    assert.equal(form.get("param"), "USDT");
    assert.equal(form.get("pid"), "1001");
    assert.equal(form.get("name"), "USD balance");
    const publicOrigin = new URL(ORIGIN).origin;
    assert.equal(form.get("return_url")?.startsWith(`${publicOrigin}/portal/account?payment=`), true);
    assert.equal(form.get("return_url")?.includes("evil.example"), false);
    assert.equal(form.get("notify_url"), `${publicOrigin}/api/payments/epay/notify`);
    assert.equal(state.submitted[0]?.includes(KEY), false);

    const pending = await portal(app, session, { method: "GET", url: `/api/portal/payments/${body.order.id}` });
    assert.equal(pending.statusCode, 200);
    assert.equal(store.getUser(user.id)?.balanceUsd, "0.00");

    const notify = await notifyOrder(app, form.get("out_trade_no") ?? "", { money: "10.00" });
    assert.equal(notify.statusCode, 200);
    assert.equal(notify.body, "success");
    assert.equal(store.getUser(user.id)?.balanceUsd, "10.00");
    const ledger = store.listLedger(user.id);
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0]?.reason, "topup");
    assert.equal(ledger[0]?.deltaUsd, "10.00");
    assert.equal(ledger[0]?.requestId, `pay:${body.order.id}`);

    const again = await notifyOrder(app, form.get("out_trade_no") ?? "", { money: "10.00" });
    assert.equal(again.statusCode, 200);
    assert.equal(again.body, "success");
    const conflicting = await notifyOrder(app, form.get("out_trade_no") ?? "", { money: "10.00", trade_no: "T-other" });
    assert.equal(conflicting.statusCode, 400);
    assert.equal(store.getUser(user.id)?.balanceUsd, "10.00");
    assert.equal(store.listLedger(user.id).length, 1);
    const paid = await portal(app, session, { method: "GET", url: `/api/portal/payments/${body.order.id}` });
    assert.equal(paid.json().order.displayStatus, "paid");
    assert.equal(paid.json().order.payUrl, null);
  });

  it("rejects an invalid signature, a mismatched amount, currency, or merchant, and a missing currency echo", async () => {
    const user = store.createUser({ email: "bad@example.com", name: "Bad", password: "password1" });
    const session = await login(app, "bad@example.com");
    const created = await portal(app, session, { method: "POST", url: "/api/portal/payments", payload: { usd: "10.00" } });
    const outTradeNo = new URLSearchParams(state.submitted.at(-1)).get("out_trade_no") ?? "";
    const forgedFields = signedFields(outTradeNo, {});
    forgedFields.sign = "0123456789abcdef0123456789abcdef";
    const forged = await app.inject({
      method: "GET",
      url: `/api/payments/epay/notify?${new URLSearchParams(forgedFields).toString()}`,
    });
    assert.equal(forged.statusCode, 400);
    assert.equal(forged.body, "fail");

    const amount = await notifyOrder(app, outTradeNo, { money: "9.99" });
    assert.equal(amount.statusCode, 400);
    assert.equal(amount.body, "fail");
    const currency = await notifyOrder(app, outTradeNo, { param: "CNY" });
    assert.equal(currency.statusCode, 400);
    const merchant = await notifyOrder(app, outTradeNo, { pid: "1002" });
    assert.equal(merchant.statusCode, 400);
    const echoed = signedFields(outTradeNo, { param: "" });
    delete echoed.param;
    echoed.sign = epaySign(echoed, KEY);
    const missing = await app.inject({ method: "GET", url: `/api/payments/epay/notify?${new URLSearchParams(echoed).toString()}` });
    assert.equal(missing.statusCode, 400);
    assert.equal(store.getUser(user.id)?.balanceUsd, "0.00");
    assert.equal(created.json().order.displayStatus, "pending");
    const still = await portal(app, session, { method: "GET", url: `/api/portal/payments/${created.json().order.id}` });
    assert.equal(still.json().order.status, "pending");
  });

  it("accepts a success after a non-success, ignores a later failure, and credits parallel retries once", async () => {
    const user = store.createUser({ email: "order@example.com", name: "Order", password: "password1" });
    const session = await login(app, "order@example.com");
    await portal(app, session, { method: "POST", url: "/api/portal/payments", payload: { usd: "25" } });
    const outTradeNo = new URLSearchParams(state.submitted.at(-1)).get("out_trade_no") ?? "";
    const waiting = await notifyOrder(app, outTradeNo, { trade_status: "WAIT_BUYER_PAY", money: "25.00" });
    assert.equal(waiting.statusCode, 200);
    assert.equal(waiting.body, "success");
    assert.equal(store.getUser(user.id)?.balanceUsd, "0.00");
    const stillWaiting = await portal(app, session, { method: "GET", url: "/api/portal/payments" });
    const waitingOrder = stillWaiting.json().orders[0];
    assert.equal(waitingOrder.status, "pending");
    assert.equal(waitingOrder.displayStatus, "pending");

    const paid = await notifyOrder(app, outTradeNo, { money: "25.00", trade_no: "T-paid" });
    assert.equal(paid.statusCode, 200);
    assert.equal(store.getUser(user.id)?.balanceUsd, "25.00");
    const afterPay = await portal(app, session, { method: "GET", url: `/api/portal/payments/${waitingOrder.id}` });
    assert.equal(afterPay.json().order.displayStatus, "paid");
    const closed = await notifyOrder(app, outTradeNo, { trade_status: "TRADE_CLOSED", money: "25.00", trade_no: "T-paid" });
    assert.equal(closed.statusCode, 200);
    assert.equal(store.getUser(user.id)?.balanceUsd, "25.00");
    assert.equal(store.listLedger(user.id).filter((entry) => entry.reason === "topup").length, 1);

    await portal(app, session, { method: "POST", url: "/api/portal/payments", payload: { usd: "10.00" } });
    const parallelNo = new URLSearchParams(state.submitted.at(-1)).get("out_trade_no") ?? "";
    const [first, second] = await Promise.all([
      notifyOrder(app, parallelNo, { money: "10.00", trade_no: "T-parallel" }),
      notifyOrder(app, parallelNo, { money: "10.00", trade_no: "T-parallel" }),
    ]);
    assert.equal(first.body === "success" || second.body === "success", true);
    assert.equal([first.statusCode, second.statusCode].includes(400), false);
    assert.equal(store.getUser(user.id)?.balanceUsd, "35.00");
    assert.equal(store.listLedger(user.id).filter((entry) => entry.reason === "topup").length, 2);
  });

  it("posts the same notify, hides orders from other customers, and still credits a valid notify after the display timeout", async () => {
    const owner = store.createUser({ email: "owner@example.com", name: "Owner", password: "password1" });
    const other = await login(app, "pay@example.com");
    const session = await login(app, "owner@example.com");
    const created = await portal(app, session, { method: "POST", url: "/api/portal/payments", payload: { usd: "10.00" } });
    const orderId = created.json().order.id as string;
    const outTradeNo = new URLSearchParams(state.submitted.at(-1)).get("out_trade_no") ?? "";
    const foreign = await portal(app, other, { method: "GET", url: `/api/portal/payments/${orderId}` });
    assert.equal(foreign.statusCode, 404);

    state.clock += 2 * 60 * 60 * 1000;
    const expired = await portal(app, session, { method: "GET", url: `/api/portal/payments/${orderId}` });
    assert.equal(expired.json().order.displayStatus, "expired");
    assert.equal(expired.json().order.status, "pending");
    assert.equal(store.getUser(owner.id)?.balanceUsd, "0.00");

    const posted = await app.inject({
      method: "POST",
      url: "/api/payments/epay/notify",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: notifyQuery(outTradeNo, { money: "10.00", trade_no: "T-late" }),
    });
    assert.equal(posted.statusCode, 200);
    assert.equal(posted.body, "success");
    assert.equal(store.getUser(owner.id)?.balanceUsd, "10.00");
    const shown = await portal(app, session, { method: "GET", url: `/api/portal/payments/${orderId}` });
    assert.equal(shown.json().order.displayStatus, "paid");
  });

  it("rejects an off-host checkout url and a gateway error without crediting or echoing the key", async () => {
    const user = store.createUser({ email: "unsafe@example.com", name: "Unsafe", password: "password1" });
    const session = await login(app, "unsafe@example.com");
    state.gatewayResult = { code: 1, payurl: "https://evil.example/phish" };
    const unsafe = await portal(app, session, { method: "POST", url: "/api/portal/payments", payload: { usd: "10.00" } });
    assert.equal(unsafe.statusCode, 502);
    assert.equal(unsafe.json().error.message, "payment gateway returned an unsafe redirect");
    assert.equal(JSON.stringify(unsafe.json()).includes("evil.example"), false);
    const outTradeNo = new URLSearchParams(state.submitted.at(-1)).get("out_trade_no") ?? "";
    const paid = await notifyOrder(app, outTradeNo, { money: "10.00", trade_no: "T-after-unsafe" });
    assert.equal(paid.statusCode, 200);
    assert.equal(store.getUser(user.id)?.balanceUsd, "10.00");

    state.gatewayResult = { code: 0, msg: `bad key ${KEY}` };
    const rejected = await portal(app, session, { method: "POST", url: "/api/portal/payments", payload: { usd: "10.00" } });
    assert.equal(rejected.statusCode, 502);
    assert.equal(rejected.json().error.message, "payment gateway rejected the order");
    assert.equal(JSON.stringify(rejected.json()).includes(KEY), false);
    assert.equal(store.getUser(user.id)?.balanceUsd, "10.00");

    state.gatewayResult = { code: 0, msg: "type usdt is not enabled" };
    const unsupported = await portal(app, session, { method: "POST", url: "/api/portal/payments", payload: { usd: "10.00" } });
    assert.equal(unsupported.statusCode, 502);
    assert.equal(unsupported.json().error.message, "type usdt is not enabled");
    assert.equal(store.listLedger(user.id).length, 1);

    state.gatewayResult = { code: 1, qrcode: "tron:TUSDTADDRESS123" };
    const payload = await portal(app, session, { method: "POST", url: "/api/portal/payments", payload: { usd: "10.00" } });
    assert.equal(payload.statusCode, 200);
    assert.equal(payload.json().next.kind, "payload");
    assert.equal(payload.json().next.value, "tron:TUSDTADDRESS123");
    assert.equal(payload.json().order.payUrl, null);
    state.gatewayResult = { code: 1, payurl: "http://127.0.0.1:9/epay/cashier/1", trade_no: "G1" };
  });

  it("uses the configured rate and reports an unconfigured gateway without calling it", async () => {
    const rated = await buildApp({
      logger: false,
      store,
      payments: runtime({
        quotePerUsd: "7.3",
        gateway: async () => ({ code: 1, payurl: "http://127.0.0.1:9/epay/cashier/7" }),
      }),
    });
    const session = await login(rated, "pay@example.com");
    const created = await portal(rated, session, { method: "POST", url: "/api/portal/payments", payload: { usd: "10.00" } });
    assert.equal(created.statusCode, 200);
    assert.equal(created.json().order.money, "73.00");
    assert.equal(created.json().order.currency, "USDT");
    assert.equal(created.json().order.creditUsd, "10.00");
    await rated.close();

    const disabled = await buildApp({ logger: false, store });
    const catalog = await portal(disabled, session, { method: "GET", url: "/api/portal/payments" });
    assert.equal(catalog.statusCode, 401);
    const again = await login(disabled, "pay@example.com");
    const listed = await portal(disabled, again, { method: "GET", url: "/api/portal/payments" });
    assert.equal(listed.json().enabled, false);
    const blocked = await portal(disabled, again, { method: "POST", url: "/api/portal/payments", payload: { usd: "10.00" } });
    assert.equal(blocked.statusCode, 503);
    assert.equal(blocked.json().error.message, "payments are not configured");
    await disabled.close();
  });
});

type OrderView = {
  id: string;
  money: string;
  currency: string;
  payType: string;
  creditUsd: string;
  displayStatus: string;
};

function runtime(options: { quotePerUsd?: string; gateway?: EpayGateway["submit"] } = {}): PaymentRuntime {
  const settings = settingsFor(options.quotePerUsd ?? "1");
  const setup: EpaySetup = { state: "ready", settings };
  const gateway: EpayGateway = {
    async submit(url, body) {
      assert.equal(url.href, "http://127.0.0.1:9/epay/mapi.php");
      state.submitted.push(body);
      if (options.gateway) {
        return options.gateway(url, body, settings.timeoutMs);
      }
      return state.gatewayResult;
    },
  };
  return { setup, gateway, now: () => new Date(state.clock) };
}

function settingsFor(quotePerUsd: string): EpaySettings {
  return {
    endpoint: new URL("http://127.0.0.1:9/epay/"),
    pid: "1001",
    key: KEY,
    publicBase: new URL(ORIGIN),
    payType: "usdt",
    currency: "USDT",
    quotePerUsd,
    amountsNano: [10_000_000_000n, 25_000_000_000n],
    orderTtlMs: 30 * 60 * 1000,
    timeoutMs: 1000,
    device: "jump",
    payHosts: ["127.0.0.1:9"],
  };
}

function signedFields(outTradeNo: string, extra: Record<string, string>): Record<string, string> {
  const fields: Record<string, string> = {
    pid: "1001",
    trade_no: extra.trade_no ?? "T1000",
    out_trade_no: outTradeNo,
    type: extra.type ?? "usdt",
    name: "USD balance",
    money: extra.money ?? "10.00",
    trade_status: extra.trade_status ?? "TRADE_SUCCESS",
    param: extra.param ?? "USDT",
    sign_type: "MD5",
  };
  if (extra.param === "") {
    delete fields.param;
  }
  for (const [key, value] of Object.entries(extra)) {
    if (key !== "param" || value !== "") {
      fields[key] = value;
    }
  }
  delete fields.sign;
  fields.sign = epaySign(fields, KEY);
  return fields;
}

function notifyQuery(outTradeNo: string, extra: Record<string, string> = {}): string {
  return new URLSearchParams(signedFields(outTradeNo, extra)).toString();
}

async function notifyOrder(app: App, outTradeNo: string, extra: Record<string, string> = {}) {
  return app.inject({ method: "GET", url: `/api/payments/epay/notify?${notifyQuery(outTradeNo, extra)}` });
}

function originHeaders(): Record<string, string> {
  return { host: HOST, origin: ORIGIN };
}

type Session = { cookie: string; csrf: string };

async function login(app: App, email: string): Promise<Session> {
  const response = await app.inject({
    method: "POST",
    url: "/api/portal/login",
    headers: originHeaders(),
    payload: { email, password: "password1" },
  });
  assert.equal(response.statusCode, 200);
  const cookies = response.headers["set-cookie"];
  const list = Array.isArray(cookies) ? cookies : cookies ? [cookies] : [];
  return {
    cookie: list.map((part) => String(part).split(";")[0]).join("; "),
    csrf: response.json().csrf as string,
  };
}

async function portal(
  app: App,
  session: Session,
  options: { method: "GET" | "POST"; url: string; payload?: Record<string, unknown> },
) {
  return app.inject({
    method: options.method,
    url: options.url,
    headers: {
      ...originHeaders(),
      cookie: session.cookie,
      ...(options.method === "GET" ? {} : { "x-viate-csrf": session.csrf }),
    },
    payload: options.payload,
  });
}
