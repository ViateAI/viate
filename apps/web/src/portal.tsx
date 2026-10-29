import { useEffect, useState } from "react";
import {
  api,
  isApiError,
  setCsrf,
  type ChannelView,
  type ClientApiKey,
  type GatewayUser,
  type LedgerEntry,
  type UserUsageRequest,
} from "./api";

type PortalUsage = {
  user: GatewayUser;
  ledger: LedgerEntry[];
  requests: UserUsageRequest[];
};

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
      <div className="topbar">
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
      <section className="stack">
        <article className="panel">
          <div className="panel-header">
            <h2>Balance</h2>
            <p className="meta">{balance} USD</p>
          </div>
        </article>
        <LedgerPanel ledger={usage?.ledger ?? null} />
        <RequestsPanel requests={usage?.requests ?? null} />
        <KeysPanel
          keys={keys}
          onError={setError}
          onNotice={setNotice}
          onChanged={refresh}
        />
        <PasswordPanel onError={setError} onNotice={setNotice} />
      </section>
    </main>
  );
}

function LedgerPanel({ ledger }: { ledger: LedgerEntry[] | null }) {
  return (
    <section className="panel stack">
      <div className="panel-header">
        <h2>Charge history</h2>
        <p className="meta">The ledger is the durable record of grants, adjustments, and usage charges.</p>
      </div>
      {ledger === null ? <p className="meta">Loading ledger…</p> : null}
      {ledger && ledger.length === 0 ? <p className="meta">No charges yet.</p> : null}
      {ledger?.map((entry) => (
        <div key={entry.id} className="meta-list">
          <div>
            <dt>{entry.reason}</dt>
            <dd>{entry.deltaUsd} USD</dd>
          </div>
          <div>
            <dt>Balance</dt>
            <dd>{entry.balanceAfterUsd} USD</dd>
          </div>
          <div>
            <dt>When</dt>
            <dd>{new Date(entry.createdAt).toLocaleString()}</dd>
          </div>
          {entry.note ? (
            <div>
              <dt>Note</dt>
              <dd>{entry.note}</dd>
            </div>
          ) : null}
        </div>
      ))}
    </section>
  );
}

function RequestsPanel({ requests }: { requests: UserUsageRequest[] | null }) {
  return (
    <section className="panel stack">
      <div className="panel-header">
        <h2>Recent requests</h2>
        <p className="meta">Request logs expire after 7 days. They are not a lifetime usage total.</p>
      </div>
      {requests === null ? <p className="meta">Loading requests…</p> : null}
      {requests && requests.length === 0 ? <p className="meta">No recent requests.</p> : null}
      {requests?.map((request) => (
        <div key={request.id} className="meta-list">
          <div>
            <dt>{request.endpoint}</dt>
            <dd>{request.requestModel ?? "—"}</dd>
          </div>
          <div>
            <dt>Status</dt>
            <dd>{request.status}</dd>
          </div>
          <div>
            <dt>Tokens</dt>
            <dd>
              {formatTokens(request.inputTokens ?? 0)} in / {formatTokens(request.outputTokens ?? 0)} out
            </dd>
          </div>
          <div>
            <dt>When</dt>
            <dd>{new Date(request.startedAt).toLocaleString()}</dd>
          </div>
        </div>
      ))}
    </section>
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
  const [channels, setChannels] = useState<ChannelView[] | null>(null);
  const [channelId, setChannelId] = useState("");
  const [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState<{ name: string; secret: string } | null>(null);

  useEffect(() => {
    api<{ channels: ChannelView[] }>("/api/portal/channels")
      .then((result) => {
        setChannels(result.channels);
        setChannelId((current) => current || result.channels[0]?.id || "");
      })
      .catch((err) => onError(isApiError(err) ? err.message : "failed to load channels"));
  }, [onError]);

  return (
    <section className="panel stack">
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
        <label>
          Channel
          <select value={channelId} onChange={(event) => setChannelId(event.target.value)} required>
            {channels?.map((channel) => (
              <option key={channel.id} value={channel.id}>
                {channel.name} · {channel.ratio}x
              </option>
            ))}
          </select>
        </label>
        {channels && channels.length === 0 ? <p className="meta">No channel is enabled for this account.</p> : null}
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

function formatTokens(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value);
}
