# Viate

Gateway for OpenAI-shaped `/v1` traffic. Provider capabilities come from plugins loaded in the server process. The CLI and the admin UI share one installer.

## Requirements

- Node.js `>=24`
- pnpm `12.16.1`

## Local

```bash
pnpm install
export VIATE_ADMIN_PASSWORD='replace-me'
pnpm dev
pnpm dev:web
```

`pnpm dev` is the API. It listens on `0.0.0.0:4317`. There is no default admin password.

`pnpm dev:web` is the Vite admin on port `5173`, base `/admin/`. It proxies `/api`, `/health`, `/oauth`, and `/.well-known` to `127.0.0.1:4317`. `/` redirects to `/portal`.

The API serves the admin and portal UI only when a built `index.html` is available. `pnpm dev` does not build that UI. After `pnpm build`, the server finds `apps/web/dist` on its own. Set `VIATE_ADMIN_UI_DIST` to point elsewhere.

```bash
pnpm build
pnpm start
pnpm typecheck
pnpm test
```

`pnpm start` runs the built server (`node apps/server/dist/main.js` via the workspace script).

## Docker

`compose.yaml` sets `image: ghcr.io/viateai/viate:latest` and still builds the local `Dockerfile`.

```bash
export VIATE_ADMIN_PASSWORD='replace-me'
docker compose up -d --build
```

`docker compose up -d --build` builds locally and tags `ghcr.io/viateai/viate:latest`. `VIATE_ADMIN_PASSWORD` comes from the environment or a gitignored `.env` beside `compose.yaml`. `.env.example` is the template. Compose reads `${VIATE_ADMIN_PASSWORD:-}`. Empty means admin stays disabled.

A published gateway release (`v*`) builds `ghcr.io/viateai/viate:latest` and `ghcr.io/viateai/viate:<release tag>` from that tag. An SDK release (`sdk-v*`) publishes `@viateai/sdk` and does not build the image. `workflow_dispatch` pushes only `ghcr.io/viateai/viate:sha-<full commit sha>` and does not move `:latest`.

To run the published image without a local build:

```bash
docker compose pull && docker compose up -d
```

The image listens on `0.0.0.0:4317`, sets `VIATE_DATA_DIR=/data` and `VIATE_ADMIN_UI_DIST=/app/web`, and publishes `4317`. State is the `viate-data` volume mounted at `/data`. `viate` is on `PATH` inside the image.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | Bind address |
| `PORT` | `4317` | Bind port. Integer from 1 to 65535 |
| `VIATE_DATA_DIR` | `~/.viate` | State root. Docker uses `/data` |
| `VIATE_ADMIN_PASSWORD` | unset | Enables `/api/admin`. No default |
| `VIATE_ADMIN_UI_DIST` | built UI, if found | Directory that contains admin `index.html` |
| `VIATE_PNPM` | `pnpm` | pnpm binary the installer spawns |
| `VIATE_TRUST_PROXY` | `loopback,uniquelocal` | Addresses allowed to set `X-Forwarded-For`. `false` ignores it. `true` trusts every hop |
| `VIATE_USER_MAX_INFLIGHT` | `8` | Per-user cap on requests in flight |
| `VIATE_LOG_PAYLOADS` | off | Store prompt and response bodies with the request log |
| `VIATE_REQUEST_LOG_RETENTION_DAYS` | `7` | How long request logs and stored bodies are kept |
| `VIATE_PUBLIC_URL` | unset | Issuer for OAuth and OpenID discovery, and the `iss` claim of an `id_token`. No path, query, or fragment. When unset, the issuer is `X-Forwarded-Proto` (or the request protocol) plus `Host` |
| `VIATE_EPAY_ENDPOINT` | unset | EPay-compatible gateway base URL. Unset disables top-up |
| `VIATE_EPAY_PID` | unset | Merchant id |
| `VIATE_EPAY_KEY` | unset | Merchant key. Server only. Never returned by the API |
| `VIATE_EPAY_PUBLIC_BASE` | unset | Public site origin used to build the notify and return URLs |
| `VIATE_EPAY_TYPE` | unset | Gateway payment type, such as the value that gateway uses for USDT. Not assumed |
| `VIATE_EPAY_CURRENCY` | unset | Quote currency echoed back in `param`, such as `USDT` |
| `VIATE_EPAY_QUOTE_PER_USD` | unset | Quote-currency units charged per 1 USD |
| `VIATE_EPAY_USD_AMOUNTS` | unset | Comma-separated USD amounts the customer may buy |
| `VIATE_EPAY_PAY_HOSTS` | endpoint host | Extra checkout hosts allowed for the payment redirect |
| `VIATE_EPAY_DEVICE` | `jump` | EPay `device` value |
| `VIATE_EPAY_ORDER_TTL_SECONDS` | `1800` | When a pending order is shown as expired. A valid notify can still credit it |
| `VIATE_EPAY_TIMEOUT_MS` | `10000` | Gateway request timeout |

EPay top-up is documented in `docs/payments.md`. Leaving every `VIATE_EPAY_*` variable unset turns the feature off. A partial set stays off and names the missing variables. The customer return page is not proof of payment.

## HTTP

`GET /health` is always registered and returns `{ "status": "ok" }`.

`GET /`, `GET /portal`, and `GET /admin` are registered only when a built admin `index.html` is loaded. Then `GET /` is a 302 to `/portal`, and `/portal` and `/admin` serve that UI. Without that UI, `GET /` is not a 302. `/api/portal` is the customer API and works without the admin password. `/api/admin` is the operator API.

`/v1` routes:

| Method | Path |
| --- | --- |
| `POST` | `/v1/chat/completions` |
| `GET` | `/v1/models` |
| `POST` | `/v1/embeddings` |
| `POST` | `/v1/responses` |
| `POST` | `/v1/responses/compact` |
| `POST` | `/v1/images/generations` |
| `POST` | `/v1/images/edits` |
| `POST` | `/v1/audio/transcriptions` |
| `POST` | `/v1/audio/speech` |
| `POST` | `/v1/videos/generations` |
| `POST` | `/v1/videos/edits` |
| `POST` | `/v1/videos/extensions` |
| `GET` | `/v1/videos/:requestId` |
| `GET` | `/v1/user/balance` |

`GET /v1/user/balance` returns the key owner's spendable USD balance as `balanceUsd`, for example `{ "balanceUsd": "10.50" }`. It does not start a request or charge.

OAuth and OpenID Connect endpoints:

| Method | Path |
| --- | --- |
| `GET` | `/.well-known/oauth-authorization-server` |
| `GET` | `/.well-known/openid-configuration` |
| `GET` | `/oauth/jwks` |
| `GET` | `/oauth/authorize` |
| `POST` | `/oauth/login` |
| `POST` | `/oauth/token` |
| `GET` | `/oauth/userinfo` |
| `POST` | `/oauth/revoke` |
| `GET` | `/oauth/client-info` |

The first start writes an ES256 private key to `$VIATE_DATA_DIR/oidc-signing.key` as PKCS#8 PEM, mode `0600`. The `kid` is the RFC 7638 SHA-256 thumbprint of the public JWK. This version does not rotate keys. `GET /oauth/jwks` returns `{ "keys": [ ... ] }`. Additional PEM blocks in that file are published after the first key. Signing uses the first key only. The API does not return the private key.

`GET /.well-known/openid-configuration` repeats the authorization-server metadata and adds `jwks_uri`, `subject_types_supported` (`public`), `id_token_signing_alg_values_supported` (`ES256`), and `claims_supported`. Its `scopes_supported` list is `openid`, `email`, `profile`, and the service scopes. `GET /.well-known/oauth-authorization-server` stays as it was: the only user scope it advertises is `profile`.

`GET /oauth/authorize` is an authorization-code request with PKCE S256. `scope` is a space-separated list of `openid`, `email`, and `profile`. Omitted or empty means `profile`. Any other scope is `invalid_scope`. An optional `nonce` is stored with the code and later copied into `id_token`. It must be 1 to 512 characters and must not contain control characters. An unknown `client_id` or a `redirect_uri` that is not an exact registered URI returns 400 and does not redirect. A client that is not first-party returns 400 `consent not supported`. Other parameter errors redirect to `redirect_uri` with `error` and `state`. Without an active `viate_oauth` session, the response redirects to `/portal/oauth-login?return=` set to the encoded authorize path and query. A successful login then redirects to `redirect_uri` with `code` and `state`. Codes expire after 60 seconds. Replaying a code revokes the token family issued from it.

`POST /oauth/login` accepts `{ "email", "password" }` and the same origin check and per-address-and-email limit as portal login. The response is `{ "ok": true, "redirect" }`. `redirect` is the `return` query value when it is a path beginning with `/oauth/authorize?`; every other value becomes `/portal`. The login page posts that `return` value and navigates to `redirect`.

`POST /oauth/token` accepts `application/x-www-form-urlencoded` and `client_secret_basic` or `client_secret_post`. Grants are `authorization_code`, `refresh_token`, and `client_credentials`. Access tokens last one hour (`vat_`). Refresh tokens last 30 days (`vrt_`) and rotate; replaying a rotated refresh token revokes its family. Client-credentials tokens have no user and no refresh token. `scope` must be a subset of the client's registered service scopes; omitted means all of them. Responses set `Cache-Control: no-store`. Token errors use `{ "error", "error_description" }`. When the granted scope includes `openid`, an `authorization_code` response also includes `id_token`. Refresh and client-credentials responses do not. `id_token` is an ES256 JWT that expires 10 minutes after `iat`. Its claims are `iss`, `sub` (the viate user id), `aud` (the client id), `exp`, `iat`, `auth_time` (seconds since the OAuth login), and `nonce` when the authorize request sent one. Scope `email` adds `email` and `email_verified`. Scope `profile` adds `name`. Viate has no email verification flow, so `email_verified` is always `false`.

`GET /oauth/userinfo` requires a user access token. A token whose scope does not include `openid` returns `{ "sub", "email", "name", "status" }`, and also `email_verified: false` when that scope includes `email`. A token whose scope includes `openid` returns `sub`, `status`, and the claims for the granted scopes: `email` and `email_verified` (`false`) for `email`, and `name` for `profile`. An invalid token is 401 `invalid_token`. A token for a user who is not `active` is 403 `user_inactive`. `POST /oauth/revoke` requires client authentication. Revoking a refresh token revokes its family. A missing token is 400; an unknown token is still 200.

`GET /oauth/client-info?client_id=` returns `{ "name" }` for the OAuth login page. It does not return secrets, redirect URIs, or scopes.

Service endpoints authenticate with `Authorization: Bearer` and a client-credentials access token. Portal and admin cookies are not accepted. A bad token is 401 `invalid token`. A token missing the route scope is 403 `insufficient scope`. Errors use `{ "error": { "message", "type": "viate_error" } }`.

| Method | Path | Scope |
| --- | --- | --- |
| `GET` | `/api/service/users?cursor=&limit=` | `users:read` |
| `GET` | `/api/service/users/:id` | `users:read` |
| `GET` | `/api/service/channels` | `channels:read` |
| `GET` | `/api/service/users/:id/channels` | `channels:read` |
| `POST` | `/api/service/users/:id/keys` | `keys:write` |
| `GET` | `/api/service/keys?kind=bot` | `keys:write` |
| `DELETE` | `/api/service/keys/:id` | `keys:write` |
| `GET` | `/api/service/usage?keyIds=&from=&to=&granularity=` | `usage:read` |

`GET /api/service/users` returns `{ "users": [{ "id", "email", "name", "status", "createdAt" }], "nextCursor" }`. `limit` defaults to 50 and must be from 1 to 200. `cursor` and `nextCursor` are opaque. User order is `createdAt` descending, then id descending. `GET /api/service/channels` and the per-user channel route return `{ "channels": [{ "id", "name" }] }`. The per-user route uses the same channel grants as `/api/portal/channels`.

`POST /api/service/users/:id/keys` body is `{ "name", "channelId", "kind": "bot", "externalRef" }`. The user must be active and the channel must be granted. The plaintext `key` is returned once. `GET /api/service/keys?kind=bot` lists keys issued by the current client and does not return the secret. Omit `kind` to list every key that client issued. `DELETE` returns 404 for a key issued by another client.

`GET /api/service/usage` takes a comma-separated `keyIds` list of at most 200 ids, ISO `from` and `to` instants, and `granularity` of `hour` or `day`. `to` must be after `from`, and the span cannot exceed 7 days. The window is half-open: `started_at >= from` and `started_at < to`. Keys that this client did not issue are ignored. Each bucket is `{ "keyId", "bucket", "requests", "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "costUsd" }`. Counts come from `request_logs`. `costUsd` is the sum of ledger charges for those requests (`-delta`), formatted like other USD strings. Hours and days are UTC. Empty ranges, including anything older than request-log retention, return `{ "buckets": [] }`.

Admin OAuth client routes use the admin session, same-origin check, and CSRF header:

| Method | Path |
| --- | --- |
| `GET` | `/api/admin/oauth-clients` |
| `POST` | `/api/admin/oauth-clients` |
| `PATCH` | `/api/admin/oauth-clients/:id` |
| `POST` | `/api/admin/oauth-clients/:id/rotate-secret` |
| `DELETE` | `/api/admin/oauth-clients/:id` |

Create and rotate return the plaintext secret once. Fields are `name`, `redirectUris` (also accepted as `redirect_uris`), `scopes`, and `allowHttpRedirects` (also `allow_http_redirects`). Registered scopes are `users:read`, `channels:read`, `keys:write`, and `usage:read`. Redirect URIs must be `https`, or `http` on `localhost`, `127.0.0.1`, or `[::1]` with any port, unless `allowHttpRedirects` is true. Fragments are rejected. Delete revokes that client's tokens and codes. It does not delete keys that client issued; their owner is cleared so the portal can revoke them. The admin page is `/admin/oauth-clients`.

A provider method that is not implemented returns 404 `capability not supported`.

Streaming `POST /v1/chat/completions` is forwarded with `stream_options.include_usage` set, so a completed stream can be billed. Other fields already in `stream_options` are kept.

Admission reserves estimated input (UTF-8 bytes of extractable request text, divided by 4 and rounded up), an output allowance (the first positive `max_completion_tokens`, `max_tokens`, or `max_output_tokens`, capped at 4096, otherwise 256), and the per-request price, multiplied by the channel ratio. That reserve is not spendable. Settlement uses usage from the plugin parser or, when the plugin set none, the host OpenAI chat, OpenAI responses, and Anthropic parsers, in that order. A completed response or a client abort with no parsed usage is charged from the text estimate. Unused reserve is returned. Cost above the reserve can make the balance negative. No parsed usage and no extractable text means no token charge. A restart returns unsettled reserves and clears in-flight counts.

Video is an xAI-shaped async job, not OpenAI Sora. Submit on the three `POST` routes. A JSON success body with `request_id` is stored with the connection that served it. `GET /v1/videos/:requestId` polls that same connection with `{ "request_id": "<id>" }`.

Advertised endpoint types label `GET /v1/models`. They do not close request routes. Known types are `openai`, `openai-response`, `openai-image`, `openai-audio`, and `openai-video`. The default advertisement is `openai` and `openai-response`.

A channel allows every published model (`all`) or an exact model-id list (`models`). It does not name a provider. Routing uses published connections for that model id. A `models` list does not grow when later models are published.

## Authentication

`/v1` accepts `Authorization: Bearer <key>` or `x-api-key`. Admin and portal cookies do not authenticate `/v1`. A missing key, an unknown key, or a data directory with no client keys returns 401 `invalid api key`.

Customers create client keys at `/portal` (`POST /api/portal/keys`). A first-party OAuth client with `keys:write` can issue a `bot` key through `POST /api/service/users/:id/keys`. Admin can list and delete keys. It does not issue them.

Without `VIATE_ADMIN_PASSWORD`, every `/api/admin` route returns 503:

```json
{ "error": { "message": "admin management is disabled", "type": "viate_error" } }
```

Admin and portal mutations need a same-origin request and an `X-Viate-Csrf` header. Login needs a same-origin request. The check compares `Origin` to `X-Forwarded-Proto` (or the request protocol) plus `Host`. A public HTTPS proxy must forward `Host`, `X-Forwarded-Proto`, and `X-Forwarded-For`. `VIATE_TRUST_PROXY` defaults to `loopback,uniquelocal`, so a proxy on localhost or a private address can set the client IP and a public client cannot. A hop count is rejected: this Fastify version does not honor one. Set the value to the proxy's address when that proxy connects from a public IP, or `false` when nothing sits in front. Portal login is limited per client address and email. Admin login is limited per client address.

Every client key belongs to a user. Portal keys are issued with `POST /api/portal/keys`. Bot keys are issued with `POST /api/service/users/:id/keys`. A key whose `userId` is missing is rejected with 403 `api key is not bound to a user`. `GET /api/portal/keys` adds `kind` (`client` or `bot`) and `managed` (`true` when an OAuth client owns the key). `DELETE /api/portal/keys/:id` returns 403 `managed key` for those keys. The portal shows a bot label and hides delete until the owning client is removed. Disabling a user revokes that user's OAuth tokens. A key with no `channelId` is not denied. A denied channel, a model outside that channel's rule, or a missing price for a requested model rejects before admission. Price lookup and admission run for every accepted key. A user can have at most `VIATE_USER_MAX_INFLIGHT` requests in flight (default 8).

## Cookies

Session cookies `viate_admin`, `viate_csrf`, `viate_user`, and `viate_user_csrf` are `HttpOnly`, `SameSite=Strict`, and not `Secure`. `Max-Age` is 12 hours. `Secure` is unset, so a browser will send these cookies on plain HTTP. Put a public deployment behind an HTTPS reverse proxy.

`viate_oauth` is a separate session used only to recognize a signed-in user at `GET /oauth/authorize`. It is `HttpOnly`, `SameSite=Lax`, `Path=/oauth`, and `Max-Age` is 12 hours. `Secure` is added only when the request is HTTPS, using the same `X-Forwarded-Proto` or protocol check as the same-origin comparison. The cookie is not sent to `/api/*` and does not authenticate those routes. It stays `Lax` so a cross-site visit to `/oauth/authorize` can include it; the Strict cookies above cannot.

## Plugins

Do not install plugins you do not trust. Plugins execute in-process as trusted code. Install uses `ignore-scripts=true`. That does not make an untrusted plugin safe.

A plugin `package.json` needs `viate.entry`. Also set `viate.id`:

```json
{
  "name": "@example/your-plugin",
  "type": "module",
  "viate": {
    "id": "your-provider",
    "entry": "index.js"
  }
}
```

Install rejects a package with no `viate.entry`. The entry must export `definePlugin({ id, register })` from `@viateai/sdk` as the default export, the named `plugin` export, or the module itself. `register` must call `ctx.registerProvider` once. The provider `id` must equal the plugin `id`. A duplicate plugin id fails to load. Log through `ctx.log`.

`@viateai/sdk` is the host SDK. The installer removes it from the plugin dependency set so pnpm does not install a second copy.

`add`, `update`, and `remove` stage a pending workspace. The server applies it on the next start. Until then the previous active set stays loaded.

## CLI

Subcommands are `plugin list`, `plugin add <source>`, `plugin remove <name>`, and `plugin update <name>`. `--data-dir <path>` (or `--data-dir=<path>`) overrides the data directory for that invocation. `<source>` is passed to `pnpm add`. `<name>` is the installed package name and must not start with `-`.

From a checkout, `pnpm viate` runs the built CLI. Build once, then:

```bash
pnpm viate plugin list
pnpm viate plugin add <source>
pnpm viate plugin remove <name>
pnpm viate plugin update <name>
pnpm viate --data-dir <path> plugin list
```

A bare `--` before `plugin` is ignored. In the image, `viate` is on `PATH`: `viate plugin list`.

## Data

Default data directory is `~/.viate`. Docker uses `/data`.

- SQLite: `$VIATE_DATA_DIR/viate.sqlite`
- Connection secrets: AES-256-GCM, key file `$VIATE_DATA_DIR/credential.key`, mode `0600`
- Plugin install state: `$VIATE_DATA_DIR/plugins/` (`active/`, `pending/`, `state.json`, lock)
- Request metadata: `request_logs` in SQLite, kept for `VIATE_REQUEST_LOG_RETENTION_DAYS` (default 7). Prompt and response bodies are written under `$VIATE_DATA_DIR/request-logs/` only when `VIATE_LOG_PAYLOADS` is on (default off), and removed with the same retention. `GET /api/service/usage` reads those rows, so a range outside the retention window is empty.
- OAuth clients, authorization codes, and tokens are in the same SQLite database. Only hashes are stored. Expired codes and tokens are deleted by the same cleanup pass as request logs.

The admin connection list returns `hasCredentials`, not the secret.

## Layout

| Path | Package |
| --- | --- |
| `apps/server` | `@viateai/server` |
| `apps/web` | `@viateai/web` |
| `packages/sdk` | `@viateai/sdk` |
| `packages/plugin-manager` | `@viateai/plugin-manager` |
| `packages/cli` | `@viateai/cli` |

`@viateai/sdk` is published to npm on its own `sdk-v*` tags. `@viateai/server`, `@viateai/web`, `@viateai/plugin-manager`, and `@viateai/cli` are private and follow the gateway `v*` tag.

## License

MIT. See [LICENSE](LICENSE).
