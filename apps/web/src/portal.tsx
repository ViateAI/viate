import { useEffect, useState, type ReactNode } from "react";
import {
  api,
  isApiError,
  setCsrf,
  type ClientApiKey,
  type GatewayUser,
  type LedgerEntry,
  type PortalChannel,
  type PortalEndpointType,
  type UserUsageRequest,
} from "./api";

type PortalUsage = {
  user: GatewayUser;
  ledger: LedgerEntry[];
  requests: UserUsageRequest[];
};

const ENDPOINT_ORDER: PortalEndpointType[] = [
  "openai",
  "openai-response",
  "openai-image",
  "openai-audio",
  "openai-video",
];

const ENDPOINT_LABEL: Record<PortalEndpointType, string> = {
  openai: "Chat",
  "openai-response": "Responses",
  "openai-image": "Image",
  "openai-audio": "Audio",
  "openai-video": "Video",
};

const LATEST_ROWS = 5;

export function PortalApp() {
  const [ready, setReady] = useState(false);
  const [user, setUser] = useState<GatewayUser | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api<{ authenticated: boolean; csrf: string; user: GatewayUser }>("/api/portal/session")
      .then((result) => {
        if (cancelled) return;
        setCsrf(result.csrf);
        setUser(result.user);
        setReady(true);
      })
      .catch((error) => {
        if (cancelled) return;
        setCsrf(null);
        if (isApiError(error) && error.status === 401) {
          setUser(null);
        } else {
          setBootError(isApiError(error) ? error.message : "failed to load session");
        }
        setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!ready) {
    return <p className="empty">Loading account…</p>;
  }
  if (bootError) {
    return (
      <div className="login-screen">
        <main className="login">
          <h1>Unable to load account</h1>
          <p className="banner error">{bootError}</p>
        </main>
      </div>
    );
  }
  if (!user) {
    return <PortalLogin onLoggedIn={setUser} />;
  }
  return <PortalHome user={user} onUser={setUser} onLoggedOut={() => setUser(null)} />;
}

function PortalLogin({ onLoggedIn }: { onLoggedIn: (user: GatewayUser) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="login-screen">
      <main className="login">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">V</span>
          <div>
            <div className="brand-name">Viate</div>
            <div className="brand-sub">Customer</div>
          </div>
        </div>
        <h1>Customer console</h1>
        <p className="meta">Sign in to view your token balance and API keys.</p>
        <form
          className="form"
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            setError(null);
            try {
              const result = await api<{ csrf: string; user: GatewayUser }>("/api/portal/login", {
                method: "POST",
                body: JSON.stringify({ email, password }),
              });
              setCsrf(result.csrf);
              onLoggedIn(result.user);
            } catch (err) {
              setError(isApiError(err) ? err.message : "login failed");
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>
            Email
            <input
              type="email"
              name="email"
              autoComplete="username"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
          </label>
          <label>
            Password
            <input
              type="password"
              name="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </label>
          {error ? <p className="banner error" role="alert">{error}</p> : null}
          <button className="primary" type="submit" disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </main>
    </div>
  );
}

function PortalHome({
  user,
  onUser,
  onLoggedOut,
}: {
  user: GatewayUser;
  onUser: (user: GatewayUser) => void;
  onLoggedOut: () => void;
}) {
  const [usage, setUsage] = useState<PortalUsage | null>(null);
  const [keys, setKeys] = useState<ClientApiKey[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function refresh() {
    const [usageResult, keyResult] = await Promise.all([
      api<PortalUsage>("/api/portal/usage"),
      api<{ apiKeys: ClientApiKey[] }>("/api/portal/keys"),
    ]);
    setUsage(usageResult);
    setKeys(keyResult.apiKeys);
    onUser(usageResult.user);
  }

  useEffect(() => {
    refresh().catch((err) => setError(isApiError(err) ? err.message : "failed to load account"));
  }, []);

  async function logout() {
    try {
      await api("/api/portal/logout", { method: "POST" });
    } catch {
      // A disabled account still leaves the console.
    }
    setCsrf(null);
    onLoggedOut();
  }

  const balance = usage?.user.balanceUsd ?? user.balanceUsd;

  return (
    <main className="main">
      <div className="topbar" aria-label="Account">
        <div className="page-heading">
          <h1>{user.email}</h1>
          <p className="page-desc">{user.name}</p>
        </div>
        <button className="ghost" type="button" onClick={() => void logout()}>
          Log out
        </button>
      </div>
      {notice ? <p className="banner ok" role="status">{notice}</p> : null}
      {error ? <p className="banner error" role="alert">{error}</p> : null}
      <p className="portal-balance">
        <span className="visually-hidden">Balance </span>
        <span className="portal-balance-amount">{balance}</span>
        <span className="portal-balance-unit">USD</span>
      </p>
      <section className="stack">
        <KeysPanel
          keys={keys}
          onError={setError}
          onNotice={setNotice}
          onChanged={refresh}
        />
        <ActivityPanel ledger={usage?.ledger ?? null} requests={usage?.requests ?? null} />
        <PasswordPanel onError={setError} onNotice={setNotice} />
      </section>
    </main>
  );
}

function ActivityPanel({
  ledger,
  requests,
}: {
  ledger: LedgerEntry[] | null;
  requests: UserUsageRequest[] | null;
}) {
  const summary = ledger && requests ? `${ledger.length} charges · ${requests.length} requests` : "Loading…";

  return (
    <section className="panel portal-activity">
      <div className="panel-header">
        <h2>Activity</h2>
        <p className="meta">{summary}</p>
        <p className="meta">Request logs expire after 7 days.</p>
      </div>
      <LogBlock
        title="Charges"
        rows={ledger}
        empty="No charges yet."
        table={(rows) => <ChargeTable rows={rows} />}
        cards={(rows) => <ChargeCards rows={rows} />}
      />
      <LogBlock
        title="Recent requests"
        rows={requests}
        empty="No recent requests."
        table={(rows) => <RequestTable rows={rows} />}
        cards={(rows) => <RequestCards rows={rows} />}
      />
    </section>
  );
}

function LogBlock<T>({
  title,
  rows,
  empty,
  table,
  cards,
}: {
  title: string;
  rows: T[] | null;
  empty: string;
  table: (rows: T[]) => ReactNode;
  cards: (rows: T[]) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const visible = rows === null ? null : open ? rows : rows.slice(0, LATEST_ROWS);
  return (
    <div className="portal-log-block">
      <div className="portal-log-head">
        <h3>{title}</h3>
        {rows && rows.length > LATEST_ROWS ? (
          <button
            className="portal-show-all"
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((current) => !current)}
          >
            {open ? "Show less" : "Show all"}
          </button>
        ) : null}
      </div>
      {rows === null ? <p className="meta">Loading…</p> : null}
      {rows && rows.length === 0 ? <p className="meta">{empty}</p> : null}
      {visible && visible.length > 0 ? (
        <>
          <div className="portal-log-table-wrap">{table(visible)}</div>
          <div className="portal-log-cards">{cards(visible)}</div>
        </>
      ) : null}
    </div>
  );
}

function ChargeTable({ rows }: { rows: LedgerEntry[] }) {
  return (
    <table className="portal-log-table">
      <caption className="visually-hidden">Charges</caption>
      <thead>
        <tr>
          <th scope="col">When</th>
          <th scope="col">Reason</th>
          <th scope="col">Delta</th>
          <th scope="col">Balance after</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((entry) => (
          <tr key={entry.id}>
            <td>{formatWhen(entry.createdAt)}</td>
            <td>
              {entry.reason}
              {entry.note ? <span className="meta"> {entry.note}</span> : null}
            </td>
            <td>{entry.deltaUsd} USD</td>
            <td>{entry.balanceAfterUsd} USD</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ChargeCards({ rows }: { rows: LedgerEntry[] }) {
  return (
    <>
      {rows.map((entry) => (
        <article className="portal-log-card" key={entry.id}>
          <div>{formatWhen(entry.createdAt)}</div>
          <div>
            {entry.reason}
            {entry.note ? <span className="meta"> {entry.note}</span> : null}
          </div>
          <div>
            {entry.deltaUsd} USD · {entry.balanceAfterUsd} USD after
          </div>
        </article>
      ))}
    </>
  );
}

function RequestTable({ rows }: { rows: UserUsageRequest[] }) {
  return (
    <table className="portal-log-table">
      <caption className="visually-hidden">Recent requests</caption>
      <thead>
        <tr>
          <th scope="col">When</th>
          <th scope="col">Model</th>
          <th scope="col">Status</th>
          <th scope="col">Tokens</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((request) => (
          <tr key={request.id}>
            <td>{formatWhen(request.startedAt)}</td>
            <td>
              {request.requestModel ?? "—"}
              <span className="meta"> {request.endpoint}</span>
            </td>
            <td>{request.status}</td>
            <td>{`${formatTokens(request.inputTokens ?? 0)} in / ${formatTokens(request.outputTokens ?? 0)} out`}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function RequestCards({ rows }: { rows: UserUsageRequest[] }) {
  return (
    <>
      {rows.map((request) => (
        <article className="portal-log-card" key={request.id}>
          <div>{formatWhen(request.startedAt)}</div>
          <div>
            {request.requestModel ?? "—"}
            <span className="meta"> {request.endpoint}</span>
          </div>
          <div>
            {request.status} · {formatTokens(request.inputTokens ?? 0)} in / {formatTokens(request.outputTokens ?? 0)} out
          </div>
        </article>
      ))}
    </>
  );
}

function KeysPanel({
  keys,
  onError,
  onNotice,
  onChanged,
}: {
  keys: ClientApiKey[] | null;
  onError: (value: string | null) => void;
  onNotice: (value: string | null) => void;
  onChanged: () => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [channels, setChannels] = useState<PortalChannel[] | null>(null);
  const [channelId, setChannelId] = useState("");
  const [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState<{ name: string; secret: string } | null>(null);
  const selected = channels?.find((channel) => channel.id === channelId) ?? null;

  useEffect(() => {
    api<{ channels: PortalChannel[] }>("/api/portal/channels")
      .then((result) => {
        setChannels(result.channels);
        setChannelId((current) =>
          result.channels.some((channel) => channel.id === current) ? current : result.channels[0]?.id ?? "",
        );
      })
      .catch((err) => onError(isApiError(err) ? err.message : "failed to load channels"));
  }, [onError]);

  return (
    <section className="panel stack portal-keys">
      <div className="panel-header">
        <h2>API keys</h2>
        <p className="meta">Each key uses one channel. Secrets are shown once. Revoking a key blocks it immediately.</p>
      </div>
      <form
        className="form"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          onError(null);
          onNotice(null);
          try {
            const result = await api<{ apiKey: ClientApiKey; secret: string }>("/api/portal/keys", {
              method: "POST",
              body: JSON.stringify({ name, channelId }),
            });
            setName("");
            setSecret({ name: result.apiKey.name, secret: result.secret });
            await onChanged();
            onNotice("Copy this key now. It will not be shown again.");
          } catch (err) {
            onError(isApiError(err) ? err.message : "create failed");
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          Key name
          <input value={name} onChange={(event) => setName(event.target.value)} required />
        </label>
        <fieldset className="portal-channels">
          <legend>Channel</legend>
          {channels === null ? <p className="meta">Loading…</p> : null}
          {channels && channels.length === 0 ? <p className="meta">No channel is enabled for this account.</p> : null}
          <div className="channel-cards">
            {channels?.map((channel) => (
              <label key={channel.id} className="channel-card">
                <input
                  type="radio"
                  name="portal-channel"
                  value={channel.id}
                  checked={channelId === channel.id}
                  aria-checked={channelId === channel.id}
                  onChange={() => setChannelId(channel.id)}
                  required
                />
                <span className="channel-card-name">{channel.name}</span>
                <span className="meta">
                  {channel.models.length} {channel.models.length === 1 ? "model" : "models"}
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        {selected ? <ChannelModels key={`models-${selected.id}`} channel={selected} /> : null}
        {selected ? (
          <CallExample key={`example-${selected.id}`} channel={selected} token={secret?.secret ?? "YOUR_API_KEY"} />
        ) : null}
        <button className="primary" type="submit" disabled={busy || !name.trim() || !channelId}>
          {busy ? "Creating…" : "Create API key"}
        </button>
      </form>
      {secret ? (
        <div className="banner ok secret-row" role="status">
          <div>
            Copy {secret.name} now: <code>{secret.secret}</code>
          </div>
        </div>
      ) : null}
      {keys === null ? <p className="meta">Loading keys…</p> : null}
      {keys && keys.length === 0 ? <p className="meta">No API keys yet.</p> : null}
      {keys?.map((key) => (
        <article className="resource" key={key.id}>
          <div className="resource-main">
            <div className="resource-title-row">
              <h2>{key.name}</h2>
              <span className="badge">{key.prefix}…</span>
            </div>
            <div className="meta">
              {channels?.find((channel) => channel.id === key.channelId)?.name ?? "No channel"} · created{" "}
              {new Date(key.createdAt).toLocaleString()}
            </div>
          </div>
          <div className="row-actions">
            <button
              className="danger"
              type="button"
              onClick={() => {
                void (async () => {
                  onError(null);
                  try {
                    await api(`/api/portal/keys/${key.id}`, { method: "DELETE" });
                    if (secret?.name === key.name) setSecret(null);
                    await onChanged();
                    onNotice("API key revoked.");
                  } catch (err) {
                    onError(isApiError(err) ? err.message : "revoke failed");
                  }
                })();
              }}
            >
              Revoke
            </button>
          </div>
        </article>
      ))}
    </section>
  );
}

function ChannelModels({ channel }: { channel: PortalChannel }) {
  const [filter, setFilter] = useState("");
  if (channel.models.length === 0) {
    return <p className="meta">No models are published on this channel yet.</p>;
  }
  const query = filter.trim().toLowerCase();
  const visible = query
    ? channel.models.filter((model) => model.id.toLowerCase().includes(query))
    : channel.models;
  return (
    <div className="portal-models">
      {channel.models.length > 8 ? (
        <label>
          Filter models
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.preventDefault();
            }}
          />
        </label>
      ) : null}
      <ul className="portal-model-list">
        {visible.map((model) => (
          <li key={model.id}>
            <span className="model-id">{model.id}</span>
            <span className="portal-endpoint-badges">
              {model.endpoints.map((endpoint) => (
                <span className="badge neutral" key={endpoint}>{ENDPOINT_LABEL[endpoint]}</span>
              ))}
            </span>
          </li>
        ))}
      </ul>
      {visible.length === 0 ? <p className="meta">No models match.</p> : null}
    </div>
  );
}

function CallExample({ channel, token }: { channel: PortalChannel; token: string }) {
  const endpoints = presentEndpoints(channel);
  const [endpoint, setEndpoint] = useState<PortalEndpointType | null>(endpoints[0] ?? null);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const selected = endpoint && endpoints.includes(endpoint) ? endpoint : endpoints[0];

  useEffect(() => {
    if (copyStatus !== "Copied") return;
    const timer = window.setTimeout(() => setCopyStatus(null), 2000);
    return () => window.clearTimeout(timer);
  }, [copyStatus]);

  if (!selected) return null;
  const model = channel.models.find((item) => item.endpoints.includes(selected))?.id;
  if (!model) return null;
  const text = exampleText(selected, window.location.origin, model, token);

  return (
    <div className="portal-example-block">
      <div className="portal-example-toolbar">
        <div className="segmented" role="group" aria-label="Endpoint type">
          {endpoints.map((item) => (
            <button
              key={item}
              type="button"
              aria-pressed={item === selected}
              onClick={() => {
                setEndpoint(item);
                setCopyStatus(null);
              }}
            >
              {ENDPOINT_LABEL[item]}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(text).then(
              () => setCopyStatus("Copied"),
              () => setCopyStatus("Copy failed"),
            );
          }}
        >
          Copy example
        </button>
      </div>
      <pre className="portal-example">{text}</pre>
      {copyStatus ? <p className="meta" role="status">{copyStatus}</p> : null}
      {selected === "openai-audio" ? (
        <p className="meta">Transcriptions are POST /v1/audio/transcriptions multipart file + model.</p>
      ) : null}
    </div>
  );
}

function PasswordPanel({
  onError,
  onNotice,
}: {
  onError: (value: string | null) => void;
  onNotice: (value: string | null) => void;
}) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [busy, setBusy] = useState(false);

  return (
    <form
      className="panel form"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        onError(null);
        onNotice(null);
        try {
          await api("/api/portal/password", {
            method: "POST",
            body: JSON.stringify({ currentPassword, newPassword }),
          });
          setCurrentPassword("");
          setNewPassword("");
          onNotice("Password changed.");
        } catch (err) {
          onError(isApiError(err) ? err.message : "password change failed");
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="panel-header">
        <h2>Change password</h2>
      </div>
      <label>
        Current password
        <input
          type="password"
          autoComplete="current-password"
          value={currentPassword}
          onChange={(event) => setCurrentPassword(event.target.value)}
          required
        />
      </label>
      <label>
        New password
        <input
          type="password"
          autoComplete="new-password"
          minLength={8}
          value={newPassword}
          onChange={(event) => setNewPassword(event.target.value)}
          required
        />
      </label>
      <button className="primary" type="submit" disabled={busy || newPassword.length < 8}>
        {busy ? "Saving…" : "Change password"}
      </button>
    </form>
  );
}

function presentEndpoints(channel: PortalChannel): PortalEndpointType[] {
  const seen = new Set<string>();
  for (const model of channel.models) {
    for (const endpoint of model.endpoints) seen.add(endpoint);
  }
  return ENDPOINT_ORDER.filter((endpoint) => seen.has(endpoint));
}

function exampleText(endpoint: PortalEndpointType, origin: string, model: string, token: string): string {
  const auth = `Authorization: Bearer ${token}`;
  const body = (value: unknown) => JSON.stringify(value, null, 2);
  if (endpoint === "openai") {
    return requestExample(
      "POST",
      `${origin}/v1/chat/completions`,
      auth,
      body({ model, messages: [{ role: "user", content: "Hello" }] }),
    );
  }
  if (endpoint === "openai-response") {
    return requestExample("POST", `${origin}/v1/responses`, auth, body({ model, input: "Hello" }));
  }
  if (endpoint === "openai-image") {
    return requestExample("POST", `${origin}/v1/images/generations`, auth, body({ model, prompt: "A lighthouse" }));
  }
  if (endpoint === "openai-audio") {
    return requestExample(
      "POST",
      `${origin}/v1/audio/speech`,
      auth,
      body({ model, input: "Hello", voice: "alloy" }),
    );
  }
  return `${requestExample(
    "POST",
    `${origin}/v1/videos/generations`,
    auth,
    body({ model, prompt: "A lighthouse" }),
  )}\n\nGET ${origin}/v1/videos/REQUEST_ID\n${auth}`;
}

function requestExample(method: string, url: string, auth: string, body: string): string {
  return `${method} ${url}\n${auth}\nContent-Type: application/json\n\n${body}`;
}

function formatWhen(value: string): string {
  return new Date(value).toLocaleString();
}

function formatTokens(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value);
}
