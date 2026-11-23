# EPay top-up

Viate can sell existing USD balance through a gateway that speaks the EPay (易支付) protocol. The gateway, third-party or self-hosted, creates the cashier and watches the chain. Viate does not connect to Binance, a wallet, or a blockchain node, and it does not store a seed phrase or a private key.

A paid order credits the customer's existing USD balance. It does not create a plan, a subscription, or a discount. The amounts and the quote rate are operator configuration. They are not product prices decided in code.

## What is credited

The customer chooses one USD amount from `VIATE_EPAY_USD_AMOUNTS`. The server ignores any amount, currency, or payment type sent by the browser. Quote money is:

`USD amount × VIATE_EPAY_QUOTE_PER_USD`

rounded half-up to two decimals, because EPay's `money` field has two decimals. The ledger credit is the USD amount, not the quote amount. The ledger reason is `topup`.

## Protocol

Checked against the public V1 protocol (page jump / `mapi.php`, MD5, notify):

- Create: `POST {VIATE_EPAY_ENDPOINT}/mapi.php` as `application/x-www-form-urlencoded`.
- Sign: sort non-empty fields except `sign` and `sign_type`, join as `a=b&c=d`, append the merchant key, MD5, lowercase hex. Values are not URL-encoded inside the signature.
- Notify: `GET` or form `POST` `/api/payments/epay/notify`. Viate answers `success` or `fail`.
- Success status is only `TRADE_SUCCESS`.
- The official type list has no USDT. `VIATE_EPAY_TYPE` is sent as configured. If the gateway rejects it, the order fails with the gateway message. Viate does not switch to another type.
- Notify payloads have no currency field. Viate sends the configured currency in `param` and requires the gateway to echo it. A `currency` field, when the gateway adds one, must match `param`. A missing echo is rejected.

The notify must match the stored merchant id, order number, quote amount, currency, and payment type. The browser return to `/portal/account?payment=<id>` only displays the stored order. It does not credit balance.

Checkout redirects are accepted only when the scheme is safe and the host is the gateway host or a host listed in `VIATE_EPAY_PAY_HOSTS`. Any other `http(s)` URL is rejected. A non-URL payload, such as a chain address, is shown as text and is not opened as a link.

The same signed notify can be delivered twice, in parallel, or after a non-success notice. Balance is credited once. A `WAIT_` status leaves the order pending so the portal keeps polling. A later non-success notice does not reverse a credit. A valid success notice still credits an order that the UI has already shown as expired, or that failed before a checkout URL was accepted. An invalid signature, a mismatched amount, a mismatched currency, or a mismatched merchant does not credit and is answered with `fail`.

## Configuration

Set every required variable on the server. Leave them all unset to disable top-up. Do not put the key in the web app, a log line, or this file.

| Variable | Required | Role |
| --- | --- | --- |
| `VIATE_EPAY_ENDPOINT` | yes | Gateway base URL, `http` or `https`, no query and no embedded credentials |
| `VIATE_EPAY_PID` | yes | Merchant id |
| `VIATE_EPAY_KEY` | yes | Merchant key used only to sign and verify. 8 to 2048 characters |
| `VIATE_EPAY_PUBLIC_BASE` | yes | Public origin, for example `https://viate.example.com`. Notify URL is `{base}/api/payments/epay/notify` |
| `VIATE_EPAY_TYPE` | yes | Payment type the gateway documents. Confirm USDT support before launch |
| `VIATE_EPAY_CURRENCY` | yes | Quote currency code, for example `USDT` |
| `VIATE_EPAY_QUOTE_PER_USD` | yes | Quote units for one USD, for example `1` or `7.3` |
| `VIATE_EPAY_USD_AMOUNTS` | yes | Allowed USD credits, comma-separated, up to 12, each greater than 0 and at most 100000 |
| `VIATE_EPAY_PAY_HOSTS` | no | Extra checkout hosts, comma-separated |
| `VIATE_EPAY_DEVICE` | no | Defaults to `jump` |
| `VIATE_EPAY_ORDER_TTL_SECONDS` | no | Defaults to 1800. Display only |
| `VIATE_EPAY_TIMEOUT_MS` | no | Defaults to 10000 |

A self-hosted gateway and a third-party gateway use the same variables. Point `VIATE_EPAY_ENDPOINT` at whichever one speaks this protocol. Changing the endpoint does not move chain listening into Viate.

`compose.yaml` reads the same names from the environment or a gitignored `.env`. Empty values leave top-up off.

## Customer API

Portal cookie and `X-Viate-Csrf` apply to the mutating route. The notify route is unsigned by cookies and is authenticated by the gateway signature.

| Method | Path | Role |
| --- | --- | --- |
| `GET` | `/api/portal/payments` | Offers, configuration problems, and the customer's orders |
| `POST` | `/api/portal/payments` | Body `{ "usd": "10.00" }`. Returns the order and either a checkout link or a payload |
| `GET` | `/api/portal/payments/:id` | Stored status for that customer. Does not credit |
| `GET` or `POST` | `/api/payments/epay/notify` | Signed gateway notify. Body is `success` or `fail` |

Order `displayStatus` is `pending`, `paid`, `failed`, or `expired`. `expired` means the display timeout passed while the row is still `pending`.

## Before production

- Confirm the gateway supports the configured type and settles in the configured currency.
- Confirm it echoes `param` and signs notify fields with the same MD5 rule.
- Set `VIATE_EPAY_PUBLIC_BASE` to the public HTTPS origin. The default-port form is normalized by the URL parser (`http://host:80` becomes `http://host`).
- Put the merchant key only in the server environment.
- If the cashier host differs from the API host, list it in `VIATE_EPAY_PAY_HOSTS`. Do not use a wildcard.
- Decide the USD amounts and the quote rate. Viate will not invent them.
- There is no refund API and no automatic reversal after credit.

## Tests

```bash
pnpm --filter @viateai/sdk --filter @viateai/plugin-manager build
pnpm --filter @viateai/server exec node --import tsx --test src/epay.test.ts src/payments.test.ts
```

The suite uses an in-process gateway. It does not call a network and does not move money.
