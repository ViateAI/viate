import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyCheckout,
  epaySign,
  epaySignValid,
  formFields,
  loadEpaySetup,
  parseMoneyCents,
  quoteCents,
  readEpayNotify,
} from "./epay.js";

const KEY = "test-key";

describe("epay protocol", () => {
  it("signs sorted decoded fields and rejects a tampered signature", () => {
    const fields = {
      type: "usdt",
      pid: "1001",
      money: "10.00",
      out_trade_no: "12345678901234567890",
      trade_status: "TRADE_SUCCESS",
      name: "USD balance",
      param: "USDT",
    };
    assert.equal(epaySign(fields, KEY), "f569e21f62c1b17524164a4837cac653");
    assert.equal(epaySignValid({ ...fields, sign_type: "MD5", sign: "ignored" }, KEY, epaySign(fields, KEY)), true);
    assert.equal(epaySignValid(fields, KEY, "f569e21f62c1b17524164a4837cac654"), false);
    assert.equal(epaySign({ ...fields, param: "" }, KEY), epaySign({ pid: fields.pid, money: fields.money, out_trade_no: fields.out_trade_no, trade_status: fields.trade_status, name: fields.name, type: fields.type }, KEY));
  });

  it("round-trips a signed form body that contains spaces", () => {
    const fields = {
      pid: "1001",
      type: "usdt",
      money: "10.00",
      name: "USD balance",
      param: "USDT",
      sign_type: "MD5",
      sign: "",
    };
    fields.sign = epaySign(fields, KEY);
    const parsed = formFields(new URLSearchParams(fields).toString());
    assert.ok(parsed);
    assert.equal(parsed.name, "USD balance");
    assert.equal(readEpayNotify(parsed, KEY).ok, false);
    const notify: Record<string, string> = {
      ...parsed,
      trade_no: "T123456",
      out_trade_no: "12345678901234567890",
      trade_status: "TRADE_SUCCESS",
    };
    delete notify.sign;
    notify.sign = epaySign(notify, KEY);
    const read = readEpayNotify(notify, KEY);
    assert.equal(read.ok, true);
    if (read.ok) {
      assert.equal(read.notify.currency, "USDT");
      assert.equal(read.notify.moneyCents, 1000n);
      assert.equal(read.notify.payType, "usdt");
    }
  });

  it("rejects duplicate keys, a missing currency echo, and a mismatched currency field", () => {
    assert.equal(formFields("pid=1&pid=2"), null);
    const fields = signed({
      pid: "1001",
      trade_no: "T123456",
      out_trade_no: "12345678901234567890",
      type: "usdt",
      money: "10.00",
      trade_status: "TRADE_SUCCESS",
      sign_type: "MD5",
    });
    assert.equal(readEpayNotify(fields, KEY).ok, false);
    const mismatched = signed({ ...fields, param: "USDT", currency: "CNY" });
    const read = readEpayNotify(mismatched, KEY);
    assert.deepEqual(read, { ok: false, reason: "bad-request" });
  });

  it("prices quote currency at two decimals and does not assume 1:1", () => {
    assert.equal(quoteCents(10_000_000_000n, "7.3"), 7300n);
    assert.equal(quoteCents(1_000_000_000n, "1.005"), 101n);
    assert.equal(parseMoneyCents("10"), 1000n);
    assert.equal(parseMoneyCents("10.5"), 1050n);
    assert.equal(parseMoneyCents("10.501"), null);
    assert.equal(parseMoneyCents("0.00"), null);
  });

  it("allows only configured checkout hosts", () => {
    const endpoint = new URL("https://pay.example/epay/");
    assert.equal(classifyCheckout({ payurl: "https://pay.example/cashier/1" }, endpoint).kind, "link");
    assert.equal(classifyCheckout({ payurl: "http://pay.example/cashier/1" }, endpoint).kind, "reject");
    assert.equal(classifyCheckout({ payurl: "https://evil.example/phish" }, endpoint).kind, "reject");
    assert.equal(classifyCheckout({ payurl: "https://evil.example/phish" }, endpoint, ["pay.example", "evil.example"]).kind, "link");
    assert.equal(classifyCheckout({ qrcode: "TUSDTADDRESS123" }, endpoint).kind, "payload");
    assert.equal(classifyCheckout({ qrcode: "javascript:alert(1)" }, endpoint).kind, "reject");
    assert.equal(classifyCheckout({ payurl: "https://pay.example/a", qrcode: "TUSDT" }, endpoint).kind, "reject");
    assert.equal(classifyCheckout({}, endpoint).kind, "reject");
  });

  it("stays off until configured and refuses to invent a USDT type", () => {
    assert.deepEqual(loadEpaySetup({}), { state: "off" });
    const invalid = loadEpaySetup({
      VIATE_EPAY_ENDPOINT: "https://pay.example/epay",
      VIATE_EPAY_PID: "1001",
      VIATE_EPAY_KEY: "test-key",
      VIATE_EPAY_PUBLIC_BASE: "https://viate.example",
      VIATE_EPAY_CURRENCY: "USDT",
      VIATE_EPAY_QUOTE_PER_USD: "1",
      VIATE_EPAY_USD_AMOUNTS: "10,25",
    });
    assert.equal(invalid.state, "invalid");
    if (invalid.state === "invalid") {
      assert.equal(invalid.problems.some((problem) => problem.includes("VIATE_EPAY_TYPE")), true);
      assert.equal(invalid.problems.some((problem) => problem.toLowerCase().includes("alipay")), false);
    }
    const ready = loadEpaySetup({
      VIATE_EPAY_ENDPOINT: "https://pay.example/epay",
      VIATE_EPAY_PID: "1001",
      VIATE_EPAY_KEY: "test-key",
      VIATE_EPAY_PUBLIC_BASE: "https://viate.example",
      VIATE_EPAY_TYPE: "usdt",
      VIATE_EPAY_CURRENCY: "USDT",
      VIATE_EPAY_QUOTE_PER_USD: "7.3",
      VIATE_EPAY_USD_AMOUNTS: "10,25.50",
      VIATE_EPAY_PAY_HOSTS: "cashier.example",
    });
    assert.equal(ready.state, "ready");
    if (ready.state === "ready") {
      assert.equal(ready.settings.payType, "usdt");
      assert.equal(ready.settings.currency, "USDT");
      assert.deepEqual(ready.settings.payHosts, ["pay.example", "cashier.example"]);
      assert.equal(ready.settings.endpoint.href, "https://pay.example/epay/");
    }
  });
});

function signed(fields: Record<string, string>): Record<string, string> {
  const next = { ...fields };
  delete next.sign;
  next.sign = epaySign(next, KEY);
  return next;
}
