import { useEffect, useState } from "react";
import { api, isApiError, type ChannelRule, type ChannelView } from "./api";

const EMPTY_MATCH: ChannelRule = {
  kind: "match",
  providerId: null,
  prefix: null,
  excludePrefix: null,
  chatOnly: false,
};

export function ChannelsPage({ onNotice }: { onNotice: (value: string | null) => void }) {
  const [channels, setChannels] = useState<ChannelView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [ratio, setRatio] = useState("1");
  const [rule, setRule] = useState<ChannelRule>({ kind: "all" });
  const [busy, setBusy] = useState(false);

  async function refresh() {
    const result = await api<{ channels: ChannelView[] }>("/api/admin/channels");
    setChannels(result.channels);
  }

  useEffect(() => {
    refresh().catch((err) => setError(isApiError(err) ? err.message : "failed to load channels"));
  }, []);

  function load(channel: ChannelView) {
    setEditing(channel.id);
    setName(channel.name);
    setRatio(channel.ratio);
    setRule(channel.rule);
    setError(null);
  }

  function reset() {
    setEditing(null);
    setName("");
    setRatio("1");
    setRule({ kind: "all" });
  }

  return (
    <section className="stack">
      {error ? <p className="banner error" role="alert">{error}</p> : null}
      <form
        className="panel form"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError(null);
          onNotice(null);
          try {
            const body = JSON.stringify({ name, ratio, rule });
            if (editing) {
              await api(`/api/admin/channels/${editing}`, { method: "PUT", body });
              onNotice("Channel saved.");
            } else {
              await api("/api/admin/channels", { method: "POST", body });
              onNotice("Channel created.");
            }
            reset();
            await refresh();
          } catch (err) {
            setError(isApiError(err) ? err.message : "save failed");
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="panel-header">
          <h2>{editing ? "Edit channel" : "Create channel"}</h2>
          <p className="meta">
            A channel sets the price multiplier and which published models a key on that channel can call. Nothing is
            created until you save one.
          </p>
        </div>
        <label>
          Name
          <input value={name} onChange={(event) => setName(event.target.value)} required />
        </label>
        <label>
          Ratio
          <input value={ratio} onChange={(event) => setRatio(event.target.value)} required />
        </label>
        <label>
          Models
          <select
            value={rule.kind}
            onChange={(event) => setRule(event.target.value === "match" ? { ...EMPTY_MATCH } : { kind: "all" })}
          >
            <option value="all">All published models</option>
            <option value="match">Match a provider and model id</option>
          </select>
        </label>
        {rule.kind === "match" ? (
          <>
            <label>
              Provider id
              <input
                value={rule.providerId ?? ""}
                onChange={(event) => setRule({ ...rule, providerId: event.target.value || null })}
              />
            </label>
            <label>
              Model id prefix
              <input
                value={rule.prefix ?? ""}
                onChange={(event) => setRule({ ...rule, prefix: event.target.value || null })}
              />
            </label>
            <label>
              Exclude prefix
              <input
                value={rule.excludePrefix ?? ""}
                onChange={(event) => setRule({ ...rule, excludePrefix: event.target.value || null })}
              />
            </label>
            <label className="toggle">
              <input
                type="checkbox"
                checked={rule.chatOnly}
                onChange={(event) => setRule({ ...rule, chatOnly: event.target.checked })}
              />
              Chat routes only
            </label>
          </>
        ) : null}
        <div className="row-actions">
          <button className="primary" type="submit" disabled={busy || !name.trim()}>
            {busy ? "Saving…" : editing ? "Save channel" : "Create channel"}
          </button>
          {editing ? (
            <button className="ghost" type="button" disabled={busy} onClick={reset}>
              Cancel
            </button>
          ) : null}
        </div>
      </form>
      {channels === null ? <p className="meta">Loading channels…</p> : null}
      {channels && channels.length === 0 ? <p className="meta">No channels yet.</p> : null}
      {channels?.map((channel) => (
        <article className="resource" key={channel.id}>
          <div className="resource-main">
            <div className="resource-title-row">
              <h2>{channel.name}</h2>
              <span className="badge">{channel.ratio}x</span>
            </div>
            <div className="meta">{describeRule(channel.rule)}</div>
          </div>
          <div className="row-actions">
            <button type="button" onClick={() => load(channel)}>
              Edit
            </button>
            <button
              className="danger"
              type="button"
              onClick={() => {
                void (async () => {
                  setError(null);
                  onNotice(null);
                  try {
                    await api(`/api/admin/channels/${channel.id}`, { method: "DELETE" });
                    if (editing === channel.id) reset();
                    await refresh();
                    onNotice("Channel deleted.");
                  } catch (err) {
                    setError(isApiError(err) ? err.message : "delete failed");
                  }
                })();
              }}
            >
              Delete
            </button>
          </div>
        </article>
      ))}
    </section>
  );
}

function describeRule(rule: ChannelRule): string {
  if (rule.kind === "all") {
    return "All published models, including ones published later.";
  }
  const parts = [
    rule.providerId ? `provider ${rule.providerId}` : null,
    rule.prefix ? `id starts with ${rule.prefix}` : null,
    rule.excludePrefix ? `except ${rule.excludePrefix}` : null,
    rule.chatOnly ? "chat routes only" : null,
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(", ") : "Match";
}
