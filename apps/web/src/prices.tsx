import { useEffect, useRef, useState } from "react";
import { api, isApiError } from "./api";
import { ConfirmDialog } from "./dialog";
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
  prices: CatalogPrice[];
  pricesTotal: number;
  pricesOffset: number;
  pricesLimit: number;
};

type CatalogPrice = {
  modelId: string;
  inputUsdPerMillion: string;
  outputUsdPerMillion: string;
  cacheReadUsdPerMillion: string | null;
  tiers: CatalogTier[];
  overridden: boolean;
};

type CatalogTier = {
  atTokens: number;
  inputUsdPerMillion: string;
  outputUsdPerMillion: string;
  cacheReadUsdPerMillion: string | null;
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
  const catalogRefresh = useRef<() => Promise<void>>(async () => {});
  const [confirm, setConfirm] = useState<PriceOverride | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [editingModelId, setEditingModelId] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const priceRef = useRef<HTMLInputElement>(null);
  const [focusTick, setFocusTick] = useState(0);

  useEffect(() => {
    if (focusTick === 0) return;
    formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    priceRef.current?.focus();
  }, [focusTick, mode]);

  function beginEdit(row: PriceOverride) {
    setEditingModelId(row.modelId);
    setModelId(row.modelId);
    setMode(row.mode);
    setUsdPerRequest(row.mode === "request" ? row.usdPerRequest ?? "" : "");
    setInputUsd(row.mode === "tokens" ? row.inputUsdPerMillion : "");
    setOutputUsd(row.mode === "tokens" ? row.outputUsdPerMillion : "");
    setFocusTick((tick) => tick + 1);
  }

  function cancelEdit() {
    setEditingModelId(null);
    setModelId("");
    setMode("request");
    setInputUsd("");
    setOutputUsd("");
    setUsdPerRequest("");
  }

  return (
    <section className="stack">
      <form
        ref={formRef}
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
            setEditingModelId(null);
            setModelId("");
            setInputUsd("");
            setOutputUsd("");
            setUsdPerRequest("");
            await catalogRefresh.current();
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
            <input ref={priceRef} inputMode="decimal" value={usdPerRequest} onChange={(event) => setUsdPerRequest(event.target.value)} required />
          </label>
        ) : (
          <>
        <label>
          {m.label_input_usd()}
          <input ref={priceRef} inputMode="decimal" value={inputUsd} onChange={(event) => setInputUsd(event.target.value)} required />
        </label>
        <label>
          {m.label_output_usd()}
          <input inputMode="decimal" value={outputUsd} onChange={(event) => setOutputUsd(event.target.value)} required />
        </label>
          </>
        )}
        <div className="row-actions">
          <button className="primary" type="submit" disabled={busy}>
            {busy ? m.busy_saving() : m.action_save_price()}
          </button>
          {editingModelId !== null ? (
            <button className="ghost" type="button" disabled={busy} onClick={cancelEdit}>
              {m.action_cancel()}
            </button>
          ) : null}
        </div>
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
        <article className={editingModelId === row.modelId ? "resource is-editing" : "resource"} key={row.modelId}>
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
            <button type="button" onClick={() => beginEdit(row)}>
              {m.action_edit()}
            </button>
            <button className="danger" type="button" onClick={() => setConfirm(row)}>
              {m.action_remove()}
            </button>
          </div>
        </article>
      ))}
      {confirm ? (
        <ConfirmDialog
          title={m.prices_remove_title({ model: confirm.modelId })}
          body={m.prices_remove_body()}
          confirmLabel={m.action_remove()}
          busy={confirmBusy}
          onCancel={() => {
            if (!confirmBusy) setConfirm(null);
          }}
          onConfirm={async () => {
            setConfirmBusy(true);
            setError(null);
            try {
              await api(`/api/admin/model-prices/${encodeURIComponent(confirm.modelId)}`, { method: "DELETE" });
              if (editingModelId === confirm.modelId) {
                cancelEdit();
              }
              await catalogRefresh.current();
              onNotice(m.prices_removed());
            } catch (err) {
              setError(isApiError(err) ? err.message : m.error_remove());
            } finally {
              setConfirmBusy(false);
              setConfirm(null);
            }
          }}
        />
      ) : null}
      <CatalogPrices
        refreshRef={catalogRefresh}
        onLoaded={(next) => {
          setView(next);
          setError(null);
        }}
        onError={setError}
      />
    </section>
  );
}

const CATALOG_PAGE_SIZE = 50;

function CatalogPrices({
  refreshRef,
  onLoaded,
  onError,
}: {
  refreshRef: { current: () => Promise<void> };
  onLoaded: (view: PriceView) => void;
  onError: (message: string) => void;
}) {
  const [filter, setFilter] = useState("");
  const [applied, setApplied] = useState({ q: "", offset: 0 });
  const [page, setPage] = useState<{
    q: string;
    rows: CatalogPrice[];
    total: number;
    offset: number;
    limit: number;
  } | null>(null);
  const appliedRef = useRef(applied);
  const requestSeq = useRef(0);
  const onLoadedRef = useRef(onLoaded);
  const onErrorRef = useRef(onError);
  appliedRef.current = applied;
  onLoadedRef.current = onLoaded;
  onErrorRef.current = onError;

  async function refresh() {
    const current = appliedRef.current;
    const seq = ++requestSeq.current;
    const params = new URLSearchParams({
      q: current.q,
      offset: String(current.offset),
      limit: String(CATALOG_PAGE_SIZE),
    });
    try {
      const result = await api<PriceView>(`/api/admin/model-prices?${params}`);
      if (seq !== requestSeq.current) {
        return;
      }
      setPage({
        q: current.q,
        rows: result.prices,
        total: result.pricesTotal,
        offset: result.pricesOffset,
        limit: result.pricesLimit,
      });
      onLoadedRef.current(result);
    } catch (err) {
      if (seq !== requestSeq.current) {
        return;
      }
      throw err;
    }
  }
  refreshRef.current = refresh;

  useEffect(() => {
    const handle = window.setTimeout(() => {
      const next = filter.trim();
      setApplied((current) => (current.q === next ? current : { q: next, offset: 0 }));
    }, 200);
    return () => window.clearTimeout(handle);
  }, [filter]);

  useEffect(() => {
    void refreshRef.current().catch((err) => {
      onErrorRef.current(isApiError(err) ? err.message : m.error_load_prices());
    });
  }, [applied]);

  if (!page) {
    return null;
  }

  const pending = page.q !== applied.q || page.offset !== applied.offset;
  const start = page.total === 0 || page.offset >= page.total ? 0 : page.offset + 1;
  const end = start === 0 ? 0 : Math.min(page.offset + page.rows.length, page.total);
  const previousDisabled = pending || page.offset <= 0;
  const nextDisabled = pending || page.offset + page.rows.length >= page.total;

  return (
    <section className="panel">
      <div className="panel-header">
        <h2>{m.prices_catalog_title()}</h2>
        <p>{m.prices_catalog_hint()}</p>
      </div>
      <label className="model-filter">
        {m.label_filter()}
        <input
          type="search"
          value={filter}
          placeholder={m.prices_filter_placeholder()}
          onChange={(event) => setFilter(event.target.value)}
        />
      </label>
      <div className="price-pager">
        <button
          className="ghost"
          type="button"
          disabled={previousDisabled}
          onClick={() =>
            setApplied((current) =>
              current.q !== page.q || current.offset !== page.offset
                ? current
                : { ...current, offset: Math.max(0, page.offset - page.limit) },
            )
          }
        >
          {m.prices_previous()}
        </button>
        <button
          className="ghost"
          type="button"
          disabled={nextDisabled}
          onClick={() =>
            setApplied((current) =>
              current.q !== page.q || current.offset !== page.offset
                ? current
                : { ...current, offset: page.offset + page.limit },
            )
          }
        >
          {m.prices_next()}
        </button>
        <span className="meta">{m.prices_page_range({ start: String(start), end: String(end), total: String(page.total) })}</span>
      </div>
      {page.total === 0 && page.q.length === 0 ? <p className="empty">{m.prices_catalog_empty()}</p> : null}
      {page.total === 0 && page.q.length > 0 ? <p className="empty">{m.prices_filter_empty()}</p> : null}
      {page.rows.length > 0 ? (
        <div className="model-scroll">
          <table className="model-table req-table">
            <caption className="visually-hidden">{m.prices_catalog_title()}</caption>
            <thead>
              <tr>
                <th>{m.prices_col_model()}</th>
                <th>{m.prices_col_input()}</th>
                <th>{m.prices_col_cache()}</th>
                <th>{m.prices_col_output()}</th>
                <th>{m.prices_col_tiers()}</th>
              </tr>
            </thead>
            <tbody>
              {page.rows.map((row) => (
                <tr key={row.modelId} className={row.overridden ? "is-overridden" : undefined}>
                  <td>
                    <span className="model-name">
                      <span className="model-id">{row.modelId}</span>
                      {row.overridden ? <span className="badge neutral">{m.prices_overridden()}</span> : null}
                    </span>
                  </td>
                  <td>{row.inputUsdPerMillion}</td>
                  <td>{row.cacheReadUsdPerMillion ?? ""}</td>
                  <td>{row.outputUsdPerMillion}</td>
                  <td>
                    {row.tiers.map((tier) => (
                      <span className="price-tier" key={tier.atTokens}>
                        {tier.cacheReadUsdPerMillion == null
                          ? m.prices_tier({
                              tokens: String(tier.atTokens),
                              input: tier.inputUsdPerMillion,
                              output: tier.outputUsdPerMillion,
                            })
                          : m.prices_tier_cache({
                              tokens: String(tier.atTokens),
                              input: tier.inputUsdPerMillion,
                              cache: tier.cacheReadUsdPerMillion,
                              output: tier.outputUsdPerMillion,
                            })}
                      </span>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
