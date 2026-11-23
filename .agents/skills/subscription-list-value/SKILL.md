---
name: subscription-list-value
description: >-
  Use when estimating what Viate subscription traffic would have cost at public
  API list prices (用量, 标价, 原始价值), including xAI OAuth, Grok, Devin, quota
  percents versus request_logs, or repricing cache hits as cache writes. Not
  for changing parsers, billing code, or pricing one request.
---

# Subscription list value

Two numbers. Keep them apart.

- `connection_usages` is the vendor quota snapshot. `used` / `limit` are often a percent of a pool, with `resets_at`. That is not dollars.
- `request_logs` is the token ledger. Price those tokens at the vendor's current public API card. Gateway `token_ledger` and user settlements are a different bill.

The figure to report is included-pool consumption priced as on-demand API usage. The first sentence of the report says that.

Changing a parser, billing code, or the price of one request body is a different task. Stop and say so.

## Find the ledger

Read `references/ledger.md` before querying.

1. Run `docker ps`. The local gateway container is usually named `viate`.
2. Inspect mounts. Open `/data/viate.sqlite` in the container that has that file, with `node:sqlite` `DatabaseSync` and `{ readOnly: true }`. Compose sets `VIATE_DATA_DIR=/data`.
3. If no container has that file, stop. `~/.viate/viate.sqlite` is a different directory and is often empty. Do not price it.

Select only the columns in `references/ledger.md`. Do not select `credentials_enc`, `password_hash`, or API key columns, and do not print secrets.

Put scripts under `/tmp`. Do not embed secrets. Delete the copy inside the container when finished. A sandboxed host `/tmp` delete can fail; that does not fail the valuation.

## Map rows

Match the name the user gave to `connections.provider_id` and `display_label`, then follow `connection_id`.

- The xAI OAuth plan sits on the `xai-oauth` connection. When `request_logs` for that `connection_id` are empty, price the `grok` connection with the same `display_label`. That traffic's upstream host is `cli-chat-proxy.grok.com`. State the oauth connection's request count.
- Devin tokens are on the `devin` connection. Price that connection.

## Window

The quota period ends at `connection_usages.resets_at`. Take the length from the row's label.

- Weekly label: start seven days before `resets_at`.
- Daily label: start one day before `resets_at`.
- Monthly label: start one calendar month before the UTC instant `resets_at`.
- No period in the label: do not invent a start. Report `resets_at` and the log range you priced.

Include rows with `started_at >= start` and `started_at < resets_at`.

Show each bound in Asia/Shanghai and keep the UTC instant beside it.

If the earliest `request_logs.started_at` for that connection is after the window start, call the dollar total a lower bound for the quota window.

A daily row and a weekly row are different windows. The weekly window contains the daily one. Price each window. Do not add those totals together.

Other clients on the same subscription (Cursor, grok.com, the vendor's own app) are outside this database. When you compare logs to the quota percent, say the logs may be only the gateway's share.

## Price each request

Read `references/pricing.md` before assigning a rate.

Price each request, then sum by model. Do not price the week's token sum at one tier.

- Uncached input = `input_tokens - cache_read_tokens - cache_write_tokens`, floored at 0.
- Stored `input_tokens` already includes the cache tokens the parser kept. Do not add cache tokens on top of it. The OpenAI parsers copy `prompt_tokens` and store cache write as 0. `parseAnthropicUsage` adds cache read and cache write into `inputTokens`.
- Long context is per request. Compare that request's `input_tokens` with the threshold on the current card. Confirm Grok's threshold on the card before using 200k. When the card replaces the whole request's rate above that line, use `selectContextPrice` in `apps/server/src/model-prices.ts`. If the card prices only the tokens above the line at the higher rate, follow the card. Do not classify from an average. Do not apply a flat 1.1× multiplier.
- Split `usage_source` before summing. `parser` rows are provider counts. `estimated` rows are a local byte estimate with cache counts of 0. `missing` rows have no tokens. Read `references/ledger.md`.
- Effort suffixes are not a price. `low`, `medium`, `high`, `xhigh`, `max`, and `thinking` use the base card. `claude-opus-5-5-medium` is Opus 5.5.
- Include every stored outcome in the token sum, and show the outcome split. Stored outcomes are `success`, `aborted`, `timeout`, `auth_error`, `client_error`, `upstream_error`. The string `ok` matches nothing. Aborted requests can still carry billed tokens.

A stored cache write of 0 is not evidence the upstream sent 0. Read the cache-write section of `references/ledger.md` before explaining a zero.

Default: price logged cache-read tokens at the cache-read rate, and apply a write rate only to tokens stored in `cache_write_tokens`. Do not add a write premium on top of cache reads.

If the user asks to treat cache hits as writes, price those cache-read tokens at the short-lived write rate and again at the hour write rate from the current card. Label both totals counterfactual. Keep the logged-rate total beside them. A write is about 1.25× or 2× the input rate; a hit is a small fraction of input. Quote the card when its factors differ.

## Claims

State a dollar pool size only as a labeled inference: if these logs are the entire reported percent, pool ≈ priced / (used / limit). Other clients make the pool larger than that.

State a subscription fee only when the price page you opened still lists that SKU. SuperGrokPro is a discontinued xAI SKU. If the page does not list it, do not invent its monthly fee. `SuperGrok` is not `SuperGrokPro`.

State an annual figure only when the user asks. Name the multiplier (weekly × 52, daily × 365, monthly × 12) and call the product an extrapolation.

Do not say the upstream omitted cache writes. Say retained rows cannot show that.

Report on-demand spend and prepaid balance from the snapshot, separately from the list-value total. A currency `used` of 0, or a missing xAI `Prepaid` row, means no extra payment. Do not turn a percent row into an on-demand dollar amount.

## Report

Write the report in the user's language.

1. One sentence: list value per subscription for the window, and that it is included-pool usage at API list rates.
2. Per subscription: plan, each quota row (`label`, `used`, `limit`, `resets_at`), on-demand, prepaid.
3. Table: model, requests, uncached input, cache read, cache write, output, long-context requests, list value.
4. Rate card actually used: USD per million tokens, source URL, and the date you read it. Name any catalog rate you overrode.
5. Caveats that apply: log start versus window start, other clients, aborted tokens, cache-write accounting.

Compute money in integer nanos. `nanoPerMillionFromUsd` and `chargeNano` are in `apps/server/src/money.ts`. `apps/server/src/model-prices.ts` calls `nanoPerMillionFromUsd` when it reads a catalog rate. Charge each bucket with `chargeNano`, sum bigint nanos, then round the total to the cent half-up: `(totalNanos + 5_000_000n) / 10_000_000n` cents.

Do not change gateway or plugin code during a valuation. Report the cache-write gap. Edit code only when the user asks for a code change.
