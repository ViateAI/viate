import { useEffect, useState } from "react";
import { api, isApiError } from "./api";

type PriceOverride = {
  modelId: string;
  mode: "tokens" | "request";
  inputUsdPerMillion: string;
  outputUsdPerMillion: string;
  usdPerRequest: string | null;
  updatedAt: string;
};

type PriceView = {
  overrides: PriceOverride[];
  unpriced: string[];
};

export function PricesPage({ onNotice }: { onNotice: (value: string | null) => void }) {
  const [view, setView] = useState<PriceView | null>(null);
  const [modelId, setModelId] = useState("");
  const [mode, setMode] = useState<"tokens" | "request">("request");
  const [inputUsd, setInputUsd] = useState("");
  const [outputUsd, setOutputUsd] = useState("");
  const [usdPerRequest, setUsdPerRequest] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    const result = await api<PriceView>("/api/admin/model-prices");
    setView(result);
  }

  useEffect(() => {
    refresh().catch((err) => setError(isApiError(err) ? err.message : "failed to load prices"));
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
            await api("/api/admin/model-prices", {
              method: "PUT",
              body: JSON.stringify({
                modelId,
                inputUsdPerMillion: mode === "tokens" ? inputUsd.trim() : "0",
                outputUsdPerMillion: mode === "tokens" ? outputUsd.trim() : "0",
                usdPerRequest: mode === "request" ? usdPerRequest.trim() : "",
              }),
            });
            setModelId("");
            setInputUsd("");
            setOutputUsd("");
            setUsdPerRequest("");
            await refresh();
            onNotice("Model price saved.");
          } catch (err) {
            setError(isApiError(err) ? err.message : "save failed");
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="panel-header">
          <h2>Manual price</h2>
          <p>
            USD per 1,000,000 tokens. A saved price overrides models.dev for that exact id. Without one, a trailing
            fast suffix is twice the base model. low, medium, high, xhigh, max, and thinking use the base price.
            Per request charges that amount once for a successful call, even when the response has no token usage.
          </p>
        </div>
        <label>
          Billing
          <select value={mode} onChange={(event) => setMode(event.target.value === "request" ? "request" : "tokens")}>
            <option value="request">Per request</option>
            <option value="tokens">Per million tokens</option>
          </select>
        </label>
        <label>
          Model
          <input list="unpriced-models" value={modelId} onChange={(event) => setModelId(event.target.value)} required />
          <datalist id="unpriced-models">
            {view?.unpriced.map((id) => (
              <option key={id} value={id} />
            ))}
          </datalist>
        </label>
        {mode === "request" ? (
          <label>
            USD per request
            <input inputMode="decimal" value={usdPerRequest} onChange={(event) => setUsdPerRequest(event.target.value)} required />
          </label>
        ) : (
          <>
        <label>
          Input USD / 1M
          <input inputMode="decimal" value={inputUsd} onChange={(event) => setInputUsd(event.target.value)} required />
        </label>
        <label>
          Output USD / 1M
          <input inputMode="decimal" value={outputUsd} onChange={(event) => setOutputUsd(event.target.value)} required />
        </label>
          </>
        )}
        <button className="primary" type="submit" disabled={busy}>
          {busy ? "Saving…" : "Save price"}
        </button>
      </form>
      {error ? (
        <p className="banner error" role="alert">
          {error}
        </p>
      ) : null}
      {view === null ? <p className="empty">Loading prices…</p> : null}
      {view && view.unpriced.length > 0 ? (
        <p className="meta">No automatic price: {view.unpriced.join(", ")}</p>
      ) : null}
      {view && view.overrides.length === 0 ? (
        <div className="empty">
          <strong>No manual prices</strong>
          Models that models.dev already prices do not need an entry.
        </div>
      ) : null}
      {view?.overrides.map((row) => (
        <article className="resource" key={row.modelId}>
          <div className="resource-main">
            <div className="resource-title-row">
              <h2>{row.modelId}</h2>
            </div>
            <div className="meta">
              {row.mode === "request"
                ? `Per request ${row.usdPerRequest}`
                : `In ${row.inputUsdPerMillion} · Out ${row.outputUsdPerMillion}`}
            </div>
          </div>
          <div className="row-actions">
            <button
              className="danger"
              type="button"
              onClick={() => {
                void (async () => {
                  setError(null);
                  try {
                    await api(`/api/admin/model-prices/${encodeURIComponent(row.modelId)}`, { method: "DELETE" });
                    await refresh();
                    onNotice("Model price removed.");
                  } catch (err) {
                    setError(isApiError(err) ? err.message : "remove failed");
                  }
                })();
              }}
            >
              Remove
            </button>
          </div>
        </article>
      ))}
    </section>
  );
}
