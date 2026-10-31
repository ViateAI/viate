import { ParaglideMessage } from "@inlang/paraglide-js-react";
import { useEffect, useState } from "react";
import { api, isApiError, type GatewayUser, type LedgerEntry } from "./api";
import { formatDateTime } from "./format";
import { m } from "./paraglide/messages.js";

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
    refresh().catch((err) => setError(isApiError(err) ? err.message : m.error_load_users()));
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
            onNotice(m.users_created());
          } catch (err) {
            setError(isApiError(err) ? err.message : m.error_create());
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="panel-header">
          <h2>{m.users_create_title()}</h2>
          <p>
            <ParaglideMessage
              message={m.users_create_hint}
              markup={{ link: ({ children }) => <a href="/portal">{children}</a> }}
            />
          </p>
        </div>
        <label>
          {m.label_email()}
          <input
            type="email"
            autoComplete="off"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
        </label>
        <label>
          {m.label_name()}
          <input value={name} onChange={(event) => setName(event.target.value)} required />
        </label>
        <label>
          {m.label_password()}
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
          {busy ? m.busy_creating() : m.action_create_customer()}
        </button>
      </form>
      {error ? <p className="banner error" role="alert">{error}</p> : null}
      {users === null ? <p className="empty">{m.users_loading()}</p> : null}
      {users && users.length === 0 ? (
        <div className="empty">
          <strong>{m.users_empty_title()}</strong>
          {m.users_empty_body()}
        </div>
      ) : null}
      {users?.map((user) => (
        <article className="resource" key={user.id}>
          <div className="resource-main">
            <div className="resource-title-row">
              <h2>{user.email}</h2>
              <StatusBadge tone={user.status === "active" ? "ok" : "warn"}>{user.status === "active" ? m.status_active() : m.status_disabled()}</StatusBadge>
            </div>
            <div className="meta">{user.name}</div>
            <div className="meta">{m.users_balance({ amount: user.balanceUsd })}</div>
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
              {openId === user.id ? m.action_close() : m.action_manage()}
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
      onError(isApiError(err) ? err.message : m.error_update());
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
              onNotice(user.status === "active" ? m.users_disabled() : m.users_enabled());
            })
          }
        >
          {user.status === "active" ? m.action_disable() : m.action_enable()}
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
          {m.users_ledger()}
        </button>
      </div>
      <ChannelAccess userId={user.id} busy={busy} onError={onError} onNotice={onNotice} />
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
            onNotice(m.users_password_reset());
          });
        }}
      >
        <label>
          {m.label_reset_password()}
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
          {m.action_reset_password()}
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
            onNotice(m.users_balance_updated());
          });
        }}
      >
        <label>
          {m.users_delta()}
          <input
            inputMode="decimal"
            value={delta}
            onChange={(event) => setDelta(event.target.value)}
            placeholder={m.users_delta_placeholder()}
            required
          />
        </label>
        <label>
          {m.label_note()}
          <input value={note} onChange={(event) => setNote(event.target.value)} maxLength={200} />
        </label>
        <button type="submit" disabled={busy || !delta.trim()}>
          {m.action_apply_dollars()}
        </button>
      </form>
      {ledger ? (
        <div className="stack">
          <p className="meta">{m.users_ledger_hint()}</p>
          {ledger.length === 0 ? <p className="meta">{m.users_ledger_empty()}</p> : null}
          {ledger.map((entry) => (
            <div key={entry.id} className="meta-list">
              <div>
                <dt>{entry.reason}</dt>
                <dd>{entry.deltaUsd} USD</dd>
              </div>
              <div>
                <dt>{m.label_balance()}</dt>
                <dd>{entry.balanceAfterUsd} USD</dd>
              </div>
              <div>
                <dt>{m.label_when()}</dt>
                <dd>{formatDateTime(entry.createdAt)}</dd>
              </div>
              {entry.note ? (
                <div>
                  <dt>{m.label_note()}</dt>
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

type ChannelGrant = {
  channelIds: string[];
  channels: Array<{ id: string; name: string; ratio: string }>;
};

function ChannelAccess({
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
  const [access, setAccess] = useState<ChannelGrant | null>(null);
  const [checked, setChecked] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api<ChannelGrant>(`/api/admin/users/${userId}/channels`)
      .then((result) => {
        setAccess(result);
        setChecked(result.channelIds);
      })
      .catch((err) => onError(isApiError(err) ? err.message : m.error_load_channels()));
  }, [onError, userId]);

  async function save() {
    setSaving(true);
    onError(null);
    onNotice(null);
    try {
      const result = await api<ChannelGrant>(`/api/admin/users/${userId}/channels`, {
        method: "PUT",
        body: JSON.stringify({ channelIds: checked }),
      });
      setAccess(result);
      setChecked(result.channelIds);
      onNotice(result.channelIds.length === 0 ? m.users_access_none() : m.users_access_saved());
    } catch (err) {
      onError(isApiError(err) ? err.message : m.error_save());
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="stack">
      <div className="panel-header">
        <h2>{m.users_channels_title()}</h2>
        <p className="meta">{m.users_access_hint()}</p>
      </div>
      {access === null ? <p className="meta">{m.users_channels_loading()}</p> : null}
      {access && access.channels.length === 0 ? <p className="meta">{m.users_channels_empty()}</p> : null}
      <div className="protocol-toggles">
        {access?.channels.map((channel) => (
          <label className="toggle" key={channel.id}>
            <input
              type="checkbox"
              checked={checked.includes(channel.id)}
              disabled={busy || saving}
              onChange={(event) => {
                setChecked((current) =>
                  event.target.checked ? [...current, channel.id] : current.filter((id) => id !== channel.id),
                );
              }}
            />
            {channel.name} · {channel.ratio}x
          </label>
        ))}
      </div>
      <div className="row-actions">
        <button className="primary" type="button" disabled={busy || saving || access === null} onClick={() => void save()}>
          {m.action_save_channels()}
        </button>
      </div>
    </div>
  );
}
