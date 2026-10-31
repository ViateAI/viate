import { useEffect, useState } from "react";
import { api, isApiError } from "./api";
import { m } from "./paraglide/messages.js";

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
    refresh().catch((err) => setError(isApiError(err) ? err.message : m.error_load_prices()));
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
            onNotice(m.prices_saved());
          } catch (err) {
            setError(isApiError(err) ? err.message : m.error_save());
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="panel-header">
          <h2>{m.prices_title()}</h2>
          <p>{m.prices_hint()}</p>
        </div>
        <label>
          {m.label_billing()}
          <select value={mode} onChange={(event) => setMode(event.target.value === "request" ? "request" : "tokens")}>
            <option value="request">{m.billing_request()}</option>
            <option value="tokens">{m.billing_tokens()}</option>
          </select>
        </label>
        <label>
          {m.label_model()}
          <input list="unpriced-models" value={modelId} onChange={(event) => setModelId(event.target.value)} required />
          <datalist id="unpriced-models">
            {view?.unpriced.map((id) => (
              <option key={id} value={id} />
            ))}
          </datalist>
        </label>
        {mode === "request" ? (
          <label>
            {m.label_usd_per_request()}
            <input inputMode="decimal" value={usdPerRequest} onChange={(event) => setUsdPerRequest(event.target.value)} required />
          </label>
        ) : (
          <>
        <label>
          {m.label_input_usd()}
          <input inputMode="decimal" value={inputUsd} onChange={(event) => setInputUsd(event.target.value)} required />
        </label>
        <label>
          {m.label_output_usd()}
          <input inputMode="decimal" value={outputUsd} onChange={(event) => setOutputUsd(event.target.value)} required />
        </label>
          </>
        )}
        <button className="primary" type="submit" disabled={busy}>
          {busy ? m.busy_saving() : m.action_save_price()}
        </button>
      </form>
      {error ? (
        <p className="banner error" role="alert">
          {error}
        </p>
      ) : null}
      {view === null ? <p className="empty">{m.prices_loading()}</p> : null}
      {view && view.unpriced.length > 0 ? (
        <p className="meta">{m.prices_unpriced({ ids: view.unpriced.join(", ") })}</p>
      ) : null}
      {view && view.overrides.length === 0 ? (
        <div className="empty">
          <strong>{m.prices_empty_title()}</strong>
          {m.prices_empty_body()}
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
                ? m.prices_per_request({ amount: row.usdPerRequest ?? "" })
                : m.prices_in_out({ input: row.inputUsdPerMillion, output: row.outputUsdPerMillion })}
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
                    onNotice(m.prices_removed());
                  } catch (err) {
                    setError(isApiError(err) ? err.message : m.error_remove());
                  }
                })();
              }}
            >
              {m.action_remove()}
            </button>
          </div>
        </article>
      ))}
    </section>
  );
}
