import { nanoPerMillionFromUsd } from "./money.js";
import type { AdminStore } from "./store.js";

export const MODELS_DEV_PRICE_URL = "https://models.dev/api.json";
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 20_000;
const VENDOR_PROVIDER_IDS = ["openai", "anthropic", "google", "google-vertex", "xai", "mistral", "deepseek"] as const;

export type ModelPriceRate = {
  inputNanoPerMillion: number;
  outputNanoPerMillion: number;
  cacheReadNanoPerMillion?: number;
  perRequestNano?: number;
};

export type ModelPriceRow = ModelPriceRate & {
  modelId: string;
};

export type ModelPriceLogger = {
  error: (obj: unknown, msg?: string) => void;
};

export type ModelPriceCatalog = {
  readonly ready: boolean;
  lookup(modelId: string): ModelPriceRate | null;
  start(): Promise<void>;
  refresh(): Promise<void>;
  stop(): void;
};

export type ModelPriceIndex = {
  byId: Map<string, ModelPriceRate>;
  bySuffix: Map<string, string[]>;
};

type CatalogOptions = {
  store: AdminStore;
  fetchImpl?: typeof fetch;
  log?: ModelPriceLogger;
  url?: string;
  intervalMs?: number;
};

export function modelPriceRowsFromDocument(document: unknown): ModelPriceRow[] {
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new Error("model price document is invalid");
  }
  const providers = new Map(Object.entries(document));
  const chosen = new Map<string, ModelPriceRow>();
  const vendors = new Set<string>(VENDOR_PROVIDER_IDS);
  for (const providerId of VENDOR_PROVIDER_IDS) {
    absorbProvider(chosen, providers.get(providerId));
  }
  for (const [providerId, provider] of providers) {
    if (vendors.has(providerId)) {
      continue;
    }
    absorbProvider(chosen, provider);
  }
  return [...chosen.values()];
}

export function indexModelPrices(rows: readonly ModelPriceRow[]): ModelPriceIndex {
  const byId = new Map<string, ModelPriceRate>();
  const bySuffix = new Map<string, string[]>();
  for (const row of rows) {
    byId.set(row.modelId, {
      inputNanoPerMillion: row.inputNanoPerMillion,
      outputNanoPerMillion: row.outputNanoPerMillion,
      ...(row.cacheReadNanoPerMillion != null ? { cacheReadNanoPerMillion: row.cacheReadNanoPerMillion } : {}),
    });
    const slash = row.modelId.lastIndexOf("/");
    if (slash <= 0 || slash >= row.modelId.length - 1) {
      continue;
    }
    const bare = row.modelId.slice(slash + 1);
    const existing = bySuffix.get(bare);
    if (existing) {
      existing.push(row.modelId);
    } else {
      bySuffix.set(bare, [row.modelId]);
    }
  }
  return { byId, bySuffix };
}

export function lookupModelPrice(index: ModelPriceIndex, modelId: string): ModelPriceRate | null {
  return resolveModelPrice(index, modelId, () => null);
}

export function resolveModelPrice(
  index: ModelPriceIndex,
  modelId: string,
  override: (modelId: string) => ModelPriceRate | null,
): ModelPriceRate | null {
  const manual = override(modelId);
  if (manual) {
    return manual;
  }
  const direct = lookupIndexedPrice(index, modelId);
  if (direct) {
    return direct;
  }
  const derived = splitPriceSuffix(modelId);
  if (!derived) {
    return null;
  }
  const baseOverride = override(derived.base);
  const base =
    baseOverride && baseOverride.perRequestNano == null ? baseOverride : lookupIndexedPrice(index, derived.base);
  if (!base) {
    return null;
  }
  if (!derived.fast) {
    return base;
  }
  const inputNanoPerMillion = base.inputNanoPerMillion * 2;
  const outputNanoPerMillion = base.outputNanoPerMillion * 2;
  const cacheReadNanoPerMillion =
    base.cacheReadNanoPerMillion == null ? undefined : base.cacheReadNanoPerMillion * 2;
  if (
    !Number.isSafeInteger(inputNanoPerMillion) ||
    !Number.isSafeInteger(outputNanoPerMillion) ||
    (cacheReadNanoPerMillion != null && !Number.isSafeInteger(cacheReadNanoPerMillion))
  ) {
    return null;
  }
  return cacheReadNanoPerMillion == null
    ? { inputNanoPerMillion, outputNanoPerMillion }
    : { inputNanoPerMillion, outputNanoPerMillion, cacheReadNanoPerMillion };
}

const SAME_PRICE_SEGMENTS: Record<string, true> = {
  low: true,
  medium: true,
  high: true,
  xhigh: true,
  max: true,
  thinking: true,
};

function splitPriceSuffix(modelId: string): { base: string; fast: boolean } | null {
  if (modelId.includes("/")) {
    return null;
  }
  const parts = modelId.split("-");
  let end = parts.length;
  let fast = false;
  let stripped = false;
  while (end > 1) {
    const segment = parts[end - 1] ?? "";
    if (segment === "fast") {
      fast = true;
      end -= 1;
      stripped = true;
      continue;
    }
    if (SAME_PRICE_SEGMENTS[segment]) {
      end -= 1;
      stripped = true;
      continue;
    }
    break;
  }
  if (!stripped || end < 1) {
    return null;
  }
  return { base: parts.slice(0, end).join("-"), fast };
}

function lookupIndexedPrice(index: ModelPriceIndex, modelId: string): ModelPriceRate | null {
  const exact = index.byId.get(modelId);
  if (exact) {
    return { ...exact };
  }
  if (modelId.includes("/")) {
    return null;
  }
  const matches = index.bySuffix.get(modelId) ?? [];
  if (matches.length === 1) {
    const only = matches[0];
    const rate = only ? index.byId.get(only) : undefined;
    return rate ? { ...rate } : null;
  }
  if (matches.length > 1) {
    const preferredId = `openrouter/${modelId}`;
    const preferred = index.byId.get(preferredId);
    return preferred && matches.includes(preferredId) ? { ...preferred } : null;
  }
  return null;
}

export function createModelPriceCatalog(options: CatalogOptions): ModelPriceCatalog {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = options.url ?? MODELS_DEV_PRICE_URL;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const log = options.log;
  let index = indexModelPrices([]);
  let ready = false;
  let started = false;
  let timer: NodeJS.Timeout | null = null;

  async function refresh(): Promise<void> {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok) {
      throw new Error(`model price fetch failed: ${response.status}`);
    }
    const rows = modelPriceRowsFromDocument(await response.json());
    const fetchedAt = new Date().toISOString();
    options.store.replaceModelPrices(rows, fetchedAt, url);
    index = indexModelPrices(rows);
    ready = true;
  }

  return {
    get ready() {
      return ready || options.store.listModelPriceOverrides().length > 0;
    },
    lookup(modelId: string) {
      return resolveModelPrice(index, modelId, (id) => options.store.getModelPriceOverride(id));
    },
    async start() {
      if (started) {
        return;
      }
      started = true;
      const saved = options.store.listModelPrices();
      index = indexModelPrices(saved.rows);
      ready = saved.fetchedAt !== null;
      try {
        await refresh();
      } catch (error) {
        log?.error({ err: error }, "model price refresh failed");
      }
      timer = setInterval(() => {
        void refresh().catch((error: unknown) => {
          log?.error({ err: error }, "model price refresh failed");
        });
      }, intervalMs);
      timer.unref();
    },
    refresh,
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}

function priceRow(modelId: string, model: unknown): ModelPriceRow | null {
  if (!model || typeof model !== "object" || Array.isArray(model) || !("cost" in model)) {
    return null;
  }
  const cost = model.cost;
  if (!cost || typeof cost !== "object" || Array.isArray(cost)) {
    return null;
  }
  const inputNanoPerMillion = nanoPerMillionFromUsd("input" in cost ? cost.input : undefined);
  const outputNanoPerMillion = nanoPerMillionFromUsd("output" in cost ? cost.output : undefined);
  const cacheReadNanoPerMillion = nanoPerMillionFromUsd("cache_read" in cost ? cost.cache_read : undefined);
  if (inputNanoPerMillion === null || outputNanoPerMillion === null) {
    return null;
  }
  return {
    modelId,
    inputNanoPerMillion,
    outputNanoPerMillion,
    ...(cacheReadNanoPerMillion != null ? { cacheReadNanoPerMillion } : {}),
  };
}

function absorbProvider(chosen: Map<string, ModelPriceRow>, provider: unknown): void {
  if (!provider || typeof provider !== "object" || Array.isArray(provider) || !("models" in provider)) {
    return;
  }
  const models = provider.models;
  if (!models || typeof models !== "object" || Array.isArray(models)) {
    return;
  }
  for (const [modelId, model] of Object.entries(models)) {
    if (chosen.has(modelId)) {
      continue;
    }
    const row = priceRow(modelId, model);
    if (row) {
      chosen.set(modelId, row);
    }
  }
}
