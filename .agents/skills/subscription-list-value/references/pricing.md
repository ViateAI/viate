# Pricing

Read the vendor's current public card on the day of the report. Quote the numbers on that card. Use the catalog below only as a calculator after the card confirms the rate.

| Vendor | Card |
| --- | --- |
| xAI / Grok | https://docs.x.ai/developers/pricing |
| Claude | https://platform.claude.com/docs/en/about-claude/pricing |
| Devin plan fee | https://docs.devin.ai — only if that page still lists the SKU |

State a subscription fee only when the page you opened still lists that SKU. SuperGrokPro is a discontinued xAI SKU. If the page does not list it, do not invent its monthly fee.

## Catalog calculator

`createModelPriceCatalog` in `apps/server/src/model-prices.ts` loads `MODELS_DEV_PRICE_URL` (`https://models.dev/api.json`). `lookupModelPrice` returns input, output, an optional cache-read rate, and optional `contextTiers` (`inputNanoPerMillion`, `outputNanoPerMillion`, `cacheReadNanoPerMillion`). `priceRow` loads a tier from `cost.tiers` when `tier.type` is `context` and `tier.size` is the token threshold. The catalog has no cache-write rate.

`selectContextPrice(rate, inputTokens)` picks the tier with the greatest `atTokens` that is still `<= inputTokens`, and replaces that request's input, output, and cache-read rates. It does not price only the tokens above the line. Below every tier, or with no tiers, it returns the base rate.

Convert a card rate with `nanoPerMillionFromUsd` and charge a token bucket with `chargeNano`, both in `apps/server/src/money.ts`. A null lookup is not "unpriced, skip the row". Price that model from the vendor card.

## Overrides

`splitPriceSuffix` treats `low`, `medium`, `high`, `xhigh`, `max`, and `thinking` as the same price as the base. A trailing `fast` that matches doubles input, output, cache read, and each context tier. A trailing `fast` after an unknown segment does not match. `lookupModelPrice` of `grok-4.7-build-fast` is null because `build` stops the walk (`apps/server/src/model-prices.test.ts`). Price that id from the published Grok 4.7 Fast card.

Claude generation 4.6 and later includes the long context window at the standard rate. If `contextTiers` still surcharges those ids, do not apply `selectContextPrice` to them. Confirm on the Claude pricing page.

Grok long context is a published higher tier, per request. Confirm the threshold before using 200k. When the card replaces the whole request's rate, `selectContextPrice` is the calculator. When the card prices only the tokens above the line at the higher rate, follow the card instead. Do not apply a flat 1.1× multiplier.

The catalog has no cache-write rate. Take write rates from the vendor card. For Claude, the card publishes a short-lived write (about 5 minutes, about 1.25× input) and an hour write (about 2× input). Quote the card's actual numbers in the report.

## What to price

Default: cache reads at the cache-read rate. Cache writes only for tokens stored in `cache_write_tokens`. Do not add a write premium on top of cache reads.

Counterfactual, only when the user asks to treat cache hits as writes: price the logged cache-read tokens at the short-lived write rate, and price them again at the hour write rate. Label both totals counterfactual. Keep the logged-rate total beside them.

In the report, name any catalog rate you overrode, the card URL, and the date you read the card. USD per million tokens.
