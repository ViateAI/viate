# Ledger

Read this before querying. Do not invent a token rate from this file.

Open the database inside the gateway container:

```js
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync("/data/viate.sqlite", { readOnly: true });
```

Query there so the live WAL is visible. Do not copy the database to the host. Do not read `payload_path` bodies. Retained payloads are the converted OpenAI stream, not the upstream proto, and they do not split cache writes back out.

## Tables

Defined in `apps/server/src/store.ts`.

`connections`: `id`, `provider_id`, `display_label`, `active`, `subscription_status`, `subscription_error`, `subscription_at`, `subscription_due_at`, `subscription_plan`. `credentials_enc` exists. Do not select it.

`connection_usages`: `connection_id`, `type`, `position`, `group_label`, `label`, `unit`, `currency`, `used`, `"limit"`, `remaining`, `resets_at`, `unlimited`, `reported`. Primary key `(connection_id, type)`.

`request_logs`: `started_at`, `outcome`, `request_model`, `upstream_model`, `provider_id`, `connection_id`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `usage_source`. No price column. `billableUsage` in `apps/server/src/chat.ts` writes `usage_source` as `parser`, `estimated`, or `missing`.

- `parser`: the usage parser returned counts.
- `estimated`: the parser returned nothing, the call was HTTP 2xx or the client aborted, and `estimateInputTokens` plus `estimateOutputTokens` was greater than 0. Those counts are a local byte estimate. Cache read and cache write are stored as 0. Sum them apart from `parser` rows, and say they are estimates.
- `missing`: no token counts. Do not invent tokens.

Keep a row whose `usage_source` is something else, and report that value.

`users.password_hash` and API key columns exist. Do not select them.

Percent rows (`unit = 'percent'`) are pool snapshots. `used` and `limit` are the percent, not dollars. Currency rows (`unit = 'currency'`) are money. xAI prepaid is `label = 'Prepaid'`, `currency = 'USD'`, balance in `remaining`. `prepaidUsage` in `viate-plugin-xai-oauth` `src/index.ts` omits that row unless the balance is a positive whole-cent amount, so a missing Prepaid row means zero.

## Queries

Bind parameters. Do not interpolate names into SQL.

Connections by provider or label:

```sql
SELECT id, provider_id, display_label, active,
       subscription_status, subscription_error,
       subscription_at, subscription_due_at, subscription_plan
FROM connections
WHERE provider_id = ? OR display_label = ?;
```

If that matches nothing, select `id, provider_id, display_label` only, match the account the user named, and do not price an unmatched connection.

Usages for one connection, snapshot order:

```sql
SELECT connection_id, type, position, group_label, label, unit, currency,
       used, "limit", remaining, resets_at, unlimited, reported
FROM connection_usages
WHERE connection_id = ?
ORDER BY position;
```

Aggregates for one connection and one window. This is the outcome split, not the price:

```sql
SELECT request_model, outcome, usage_source,
       COUNT(*) AS requests,
       SUM(COALESCE(input_tokens, 0)) AS input_tokens,
       SUM(COALESCE(output_tokens, 0)) AS output_tokens,
       SUM(COALESCE(cache_read_tokens, 0)) AS cache_read_tokens,
       SUM(COALESCE(cache_write_tokens, 0)) AS cache_write_tokens
FROM request_logs
WHERE connection_id = ?
  AND started_at >= ?
  AND started_at < ?
GROUP BY request_model, outcome, usage_source;
```

Earliest log for that connection, compared with the window start:

```sql
SELECT MIN(started_at) AS earliest
FROM request_logs
WHERE connection_id = ?;
```

`MIN(started_at)` inside the window cannot show a late log start. Use this query for the lower-bound caveat.

A second pass over individual requests is required to classify long context. Do not classify from an average, a sum, or a weekly mean.

```sql
SELECT request_model, outcome, usage_source,
       input_tokens, output_tokens, cache_read_tokens, cache_write_tokens
FROM request_logs
WHERE connection_id = ?
  AND started_at >= ?
  AND started_at < ?;
```

Price each returned row, then sum by `request_model`.

## Cache write of 0

Two layers, Devin only. Do not use this remainder equation on grok rows.

- Sibling repo `viate-plugin-devin`. `chatUsage()` in `src/openai.ts` sets `prompt_tokens` to `promptTokens + cachedTokens + cacheWriteTokens` and sets `prompt_tokens_details.cached_tokens` to `cachedTokens` only. In `src/devin.ts`, proto field 4 is decoded as `cacheWriteTokens` and proto field 5 as `cachedTokens`. The Responses conversion in `src/responses.ts` copies that same `cached_tokens` detail and does not copy a write count.
- `parseOpenAIChatUsage` and `parseOpenAIResponsesUsage` in `packages/sdk/src/usage.ts` set `cacheWriteTokens` to the constant 0 and read only `cached_tokens`. `parseAnthropicUsage` records `cache_creation_input_tokens` and adds cache read and cache write into `inputTokens`. Devin does not emit the Anthropic usage shape, so that parser is not on this path.

Logged `cache_write_tokens` of 0 on Devin rows is what those two layers store. The remainder `input_tokens - cache_read_tokens` equals the plugin's `promptTokens + cacheWriteTokens`. Those two quantities cannot be split from retained logs. Do not claim field 4 was zero. Do not say the upstream omitted cache writes.

`parseOpenAIChatUsage` and `parseOpenAIResponsesUsage` store `cacheWriteTokens: 0` for every provider that uses them, including grok. That constant is still not a measurement of the upstream write count. The grok plugin's `chatUsage` in `viate-plugin-grok` `src/index.ts` copies `cached_tokens` only. It does not add a write field into `prompt_tokens`. Do not treat a grok uncached remainder as `promptTokens + cacheWriteTokens`.

## Outcomes

`classifyOutcome` in `apps/server/src/request-logs.ts` returns:

| Condition | Stored `outcome` |
| --- | --- |
| aborted | `aborted` |
| timed out | `timeout` |
| HTTP 2xx | `success` |
| 401 or 403 | `auth_error` |
| other 4xx | `client_error` |
| anything else | `upstream_error` |

The string `ok` matches nothing. Aborted requests can still carry billed tokens. Include every outcome in the token sum, and show this split.

## Scripts

Put scripts under `/tmp`. Do not embed secrets, tokens, or credentials in the script or its output. `docker cp` the script in, run it, then delete that copy inside the container. A sandboxed host `/tmp` delete can fail. That does not fail the valuation. If the host file remains, name the path.
