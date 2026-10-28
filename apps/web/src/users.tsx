import { useEffect, useState } from "react";
import { api, isApiError, type GatewayUser, type LedgerEntry } from "./api";

export function UsersPage({ onNotice }: { onNotice: (value: string | null) => void }) {
  const [users, setUsers] = useState<GatewayUser[] | null>(null);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  async function refresh() {
    const result = await api<{ users: GatewayUser[] }>("/api/admin/users");
    setUsers(result.users);
  }

  useEffect(() => {
    refresh().catch((err) => setError(isApiError(err) ? err.message : "failed to load users"));
  }, []);

  return (
    <section className="stack">
      <form
        className="panel form"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError(null);
          onNotice(null);
          try {
            await api("/api/admin/users", {
              method: "POST",
              body: JSON.stringify({ email, name, password }),
            });
            setEmail("");
            setName("");
            setPassword("");
            await refresh();
            onNotice("Customer created.");
          } catch (err) {
            setError(isApiError(err) ? err.message : "create failed");
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="panel-header">
          <h2>Create customer</h2>
          <p>
            Customers sign in at <a href="/portal">/portal</a>. There is no public signup.
          </p>
        </div>
        <label>
          Email
          <input
            type="email"
            autoComplete="off"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
        </label>
        <label>
          Name
          <input value={name} onChange={(event) => setName(event.target.value)} required />
        </label>
        <label>
          Password
          <input
            type="password"
            autoComplete="new-password"
            minLength={8}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </label>
        <button className="primary" type="submit" disabled={busy}>
          {busy ? "Creating…" : "Create customer"}
        </button>
      </form>
      {error ? <p className="banner error" role="alert">{error}</p> : null}
      {users === null ? <p className="empty">Loading users…</p> : null}
      {users && users.length === 0 ? (
        <div className="empty">
          <strong>No customers</strong>
          Create one, then add a dollar balance before their API keys can call /v1.
        </div>
      ) : null}
      {users?.map((user) => (
        <article className="resource" key={user.id}>
          <div className="resource-main">
            <div className="resource-title-row">
              <h2>{user.email}</h2>
              <StatusBadge tone={user.status === "active" ? "ok" : "warn"}>{user.status}</StatusBadge>
            </div>
            <div className="meta">{user.name}</div>
            <div className="meta">Balance {user.balanceUsd} USD</div>
            {openId === user.id ? (
              <UserEditor
                user={user}
                onError={setError}
                onNotice={onNotice}
                onChanged={async () => {
                  await refresh();
                }}
              />
            ) : null}
          </div>
          <div className="row-actions">
            <button className="ghost" type="button" onClick={() => setOpenId(openId === user.id ? null : user.id)}>
              {openId === user.id ? "Close" : "Manage"}
            </button>
          </div>
        </article>
      ))}
    </section>
  );
}

function UserEditor({
  user,
  onError,
  onNotice,
  onChanged,
}: {
  user: GatewayUser;
  onError: (value: string | null) => void;
  onNotice: (value: string | null) => void;
  onChanged: () => Promise<void>;
}) {
  const [nextPassword, setNextPassword] = useState("");
  const [delta, setDelta] = useState("");
  const [note, setNote] = useState("");
  const [ledger, setLedger] = useState<LedgerEntry[] | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    onError(null);
    onNotice(null);
    try {
      await action();
      await onChanged();
    } catch (err) {
      onError(isApiError(err) ? err.message : "update failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <div className="row-actions">
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await api(`/api/admin/users/${user.id}`, {
                method: "PATCH",
                body: JSON.stringify({ status: user.status === "active" ? "disabled" : "active" }),
              });
              onNotice(user.status === "active" ? "Customer disabled." : "Customer enabled.");
            })
          }
        >
          {user.status === "active" ? "Disable" : "Enable"}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const result = await api<{ ledger: LedgerEntry[] }>(`/api/admin/users/${user.id}/ledger`);
              setLedger(result.ledger);
            })
          }
        >
          Ledger
        </button>
      </div>
      <ProviderAccess userId={user.id} busy={busy} onError={onError} onNotice={onNotice} />
      <form
        className="form"
        onSubmit={(event) => {
          event.preventDefault();
          void run(async () => {
            await api(`/api/admin/users/${user.id}`, {
              method: "PATCH",
              body: JSON.stringify({ password: nextPassword }),
            });
            setNextPassword("");
            onNotice("Password reset.");
          });
        }}
      >
        <label>
          Reset password
          <input
            type="password"
            autoComplete="new-password"
            minLength={8}
            value={nextPassword}
            onChange={(event) => setNextPassword(event.target.value)}
            required
          />
        </label>
        <button type="submit" disabled={busy || nextPassword.length < 8}>
          Reset password
        </button>
      </form>
      <form
        className="form"
        onSubmit={(event) => {
          event.preventDefault();
          void run(async () => {
            await api(`/api/admin/users/${user.id}/balance`, {
              method: "POST",
              body: JSON.stringify({ usd: delta.trim(), note: note.trim() ? note.trim() : undefined }),
            });
            setDelta("");
            setNote("");
            const result = await api<{ ledger: LedgerEntry[] }>(`/api/admin/users/${user.id}/ledger`);
            setLedger(result.ledger);
            onNotice("Dollar balance updated.");
          });
        }}
      >
        <label>
          Grant or adjust dollars
          <input
            inputMode="decimal"
            value={delta}
            onChange={(event) => setDelta(event.target.value)}
            placeholder="10.00 or -1.50"
            required
          />
        </label>
        <label>
          Note
          <input value={note} onChange={(event) => setNote(event.target.value)} maxLength={200} />
        </label>
        <button type="submit" disabled={busy || !delta.trim()}>
          Apply dollars
        </button>
      </form>
      {ledger ? (
        <div className="stack">
          <p className="meta">Latest ledger entries. This is the charge history.</p>
          {ledger.length === 0 ? <p className="meta">No ledger entries.</p> : null}
          {ledger.map((entry) => (
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
        </div>
      ) : null}
    </div>
  );
}

function StatusBadge({ children, tone = "neutral" }: { children: string; tone?: "neutral" | "ok" | "warn" }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

type ProviderAccessView = {
  mode: "all" | "only";
  providerIds: string[];
  available: string[];
};

function ProviderAccess({
  userId,
  busy,
  onError,
  onNotice,
}: {
  userId: string;
  busy: boolean;
  onError: (value: string | null) => void;
  onNotice: (value: string | null) => void;
}) {
  const [access, setAccess] = useState<ProviderAccessView | null>(null);
  const [checked, setChecked] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api<ProviderAccessView>(`/api/admin/users/${userId}/providers`)
      .then((result) => {
        setAccess(result);
        setChecked(result.mode === "all" ? result.available : result.providerIds);
      })
      .catch((err) => onError(isApiError(err) ? err.message : "failed to load providers"));
  }, [onError, userId]);

  async function save(providerIds: string[] | null) {
    setSaving(true);
    onError(null);
    onNotice(null);
    try {
      const result = await api<ProviderAccessView>(`/api/admin/users/${userId}/providers`, {
        method: "PUT",
        body: JSON.stringify({ providerIds }),
      });
      setAccess(result);
      setChecked(result.mode === "all" ? result.available : result.providerIds);
      onNotice(providerIds === null ? "Customer can use every provider." : "Provider access saved.");
    } catch (err) {
      onError(isApiError(err) ? err.message : "save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="stack">
      <div className="panel-header">
        <h2>Providers</h2>
        <p className="meta">
          {access?.mode === "only"
            ? "Only checked providers are visible. Unchecked ones, such as a private test provider, stay hidden."
            : "Every provider is available, including ones you add later. Save a selection to hide the rest."}
        </p>
      </div>
      {access === null ? <p className="meta">Loading providers…</p> : null}
      {access && access.available.length === 0 ? <p className="meta">No connections yet.</p> : null}
      <div className="protocol-toggles">
        {access?.available.map((providerId) => (
          <label className="toggle" key={providerId}>
            <input
              type="checkbox"
              checked={checked.includes(providerId)}
              disabled={busy || saving}
              onChange={(event) => {
                setChecked((current) =>
                  event.target.checked ? [...current, providerId] : current.filter((id) => id !== providerId),
                );
              }}
            />
            {providerId}
          </label>
        ))}
      </div>
      <div className="row-actions">
        <button className="ghost" type="button" disabled={busy || saving || access === null} onClick={() => void save(null)}>
          Use all providers
        </button>
        <button className="primary" type="button" disabled={busy || saving || access === null} onClick={() => void save(checked)}>
          Save providers
        </button>
      </div>
    </div>
  );
}
