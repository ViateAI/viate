import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  createModelPriceCatalog,
  indexModelPrices,
  lookupModelPrice,
  modelPriceRowsFromDocument,
} from "./model-prices.js";
import { AdminStore } from "./store.js";

const GPT4O = { inputNanoPerMillion: 3_000_000_000, outputNanoPerMillion: 15_000_000_000 };

describe("model price catalog", () => {
  it("uses an exact id and a unique bare suffix", () => {
    const index = indexModelPrices(
      modelPriceRowsFromDocument({
        openai: {
          models: {
            "gpt-4o-mini": { cost: { input: 0.15, output: 0.6 } },
            skipped: { cost: { input: 1 } },
            negative: { cost: { input: -1, output: 1 } },
            text: { cost: { input: "3", output: 15 } },
          },
        },
        other: {
          models: {
            "openai/gpt-4o": { cost: { input: 1, output: 2 } },
          },
        },
        openrouter: {
          models: {
            "openai/gpt-4o": { cost: { input: 3, output: 15 } },
          },
        },
        later: {
          models: {
            "openai/gpt-4o": { cost: { input: 9, output: 9 } },
          },
        },
      }),
    );

    assert.deepEqual(lookupModelPrice(index, "openai/gpt-4o"), {
      inputNanoPerMillion: 1_000_000_000,
      outputNanoPerMillion: 2_000_000_000,
    });
    assert.deepEqual(lookupModelPrice(index, "gpt-4o"), {
      inputNanoPerMillion: 1_000_000_000,
      outputNanoPerMillion: 2_000_000_000,
    });
    assert.deepEqual(lookupModelPrice(index, "gpt-4o-mini"), {
      inputNanoPerMillion: 150_000_000,
      outputNanoPerMillion: 600_000_000,
    });
    assert.equal(lookupModelPrice(index, "skipped"), null);
    assert.equal(lookupModelPrice(index, "missing"), null);
  });

  it("doubles a fast suffix and keeps thinking-level suffixes at the base price", () => {
    const index = indexModelPrices(
      modelPriceRowsFromDocument({
        xai: {
          models: {
            "grok-4.7": { cost: { input: 2, output: 6 } },
          },
        },
      }),
    );
    const base = {
      inputNanoPerMillion: 2_000_000_000,
      outputNanoPerMillion: 6_000_000_000,
    };
    const doubled = {
      inputNanoPerMillion: 4_000_000_000,
      outputNanoPerMillion: 12_000_000_000,
    };
    assert.deepEqual(lookupModelPrice(index, "grok-4.7-high"), base);
    assert.deepEqual(lookupModelPrice(index, "grok-4.7-xhigh"), base);
    assert.deepEqual(lookupModelPrice(index, "grok-4.7-max"), base);
    assert.deepEqual(lookupModelPrice(index, "grok-4.7-thinking"), base);
    assert.deepEqual(lookupModelPrice(index, "grok-4.7-fast"), doubled);
    assert.equal(lookupModelPrice(index, "grok-4.7-build-fast"), null);
    assert.deepEqual(lookupModelPrice(index, "grok-4.7-high-fast"), doubled);
    assert.deepEqual(lookupModelPrice(index, "grok-4.7-max-fast"), doubled);
    assert.deepEqual(lookupModelPrice(index, "grok-4.7-thinking-fast"), doubled);
    assert.equal(lookupModelPrice(index, "grok-4.7-unknown"), null);

    const dedicated = indexModelPrices(
      modelPriceRowsFromDocument({
        xai: {
          models: {
            "grok-4.7": { cost: { input: 2, output: 6 } },
            "grok-4.7-fast": { cost: { input: 1, output: 3 } },
          },
        },
      }),
    );
    assert.deepEqual(lookupModelPrice(dedicated, "grok-4.7-fast"), {
      inputNanoPerMillion: 1_000_000_000,
      outputNanoPerMillion: 3_000_000_000,
    });
  });

  it("prefers a later vendor price over an earlier reseller id", () => {
    const index = indexModelPrices(
      modelPriceRowsFromDocument({
        cortecs: {
          models: {
            "gpt-4o": { cost: { input: 2.659, output: 10.635 } },
            "llama-3": { cost: { input: 1, output: 2 } },
          },
        },
        openai: {
          models: {
            "gpt-4o": { cost: { input: 2.5, output: 10 } },
          },
        },
        openrouter: {
          models: {
            "openai/gpt-4o": { cost: { input: 3, output: 15 } },
          },
        },
      }),
    );
    assert.deepEqual(lookupModelPrice(index, "gpt-4o"), {
      inputNanoPerMillion: 2_500_000_000,
      outputNanoPerMillion: 10_000_000_000,
    });
    assert.deepEqual(lookupModelPrice(index, "openai/gpt-4o"), GPT4O);
    assert.deepEqual(lookupModelPrice(index, "llama-3"), {
      inputNanoPerMillion: 1_000_000_000,
      outputNanoPerMillion: 2_000_000_000,
    });
  });

  it("returns null when several suffixes match and openrouter is not one of them", () => {
    const ambiguous = indexModelPrices(
      modelPriceRowsFromDocument({
        a: {
          models: {
            "openai/gpt-4o": { cost: { input: 1, output: 1 } },
            "anthropic/gpt-4o": { cost: { input: 2, output: 2 } },
          },
        },
      }),
    );
    assert.equal(lookupModelPrice(ambiguous, "gpt-4o"), null);

    const preferred = indexModelPrices(
      modelPriceRowsFromDocument({
        a: {
          models: {
            "openai/gpt-4o": { cost: { input: 1, output: 1 } },
            "openrouter/gpt-4o": { cost: { input: 4, output: 5 } },
          },
        },
      }),
    );
    assert.deepEqual(lookupModelPrice(preferred, "gpt-4o"), {
      inputNanoPerMillion: 4_000_000_000,
      outputNanoPerMillion: 5_000_000_000,
    });
  });

  it("keeps sqlite prices when refresh fails and replaces them after a successful parse", async () => {
    const dir = await mkdtemp(join(tmpdir(), "viate-prices-"));
    const store = await AdminStore.open(dir);
    const errors: string[] = [];
    store.replaceModelPrices(
      [{ modelId: "openai/gpt-4o", ...GPT4O }],
      "2026-01-01T00:00:00.000Z",
      "https://models.dev/api.json",
    );
    let fetches = 0;
    const catalog = createModelPriceCatalog({
      store,
      log: {
        error(_obj, msg) {
          errors.push(msg ?? "");
        },
      },
      fetchImpl: async () => {
        fetches += 1;
        if (fetches === 1) {
          throw new Error("network down");
        }
        return Response.json({
          openrouter: { models: { "openai/gpt-4o": { cost: { input: 1, output: 2 } } } },
        });
      },
    });
    try {
      await catalog.start();
      assert.equal(catalog.ready, true);
      assert.equal(fetches, 1);
      assert.deepEqual(errors, ["model price refresh failed"]);
      const captured = catalog.lookup("gpt-4o");
      assert.deepEqual(captured, GPT4O);

      await catalog.refresh();
      assert.deepEqual(catalog.lookup("openai/gpt-4o"), {
        inputNanoPerMillion: 1_000_000_000,
        outputNanoPerMillion: 2_000_000_000,
      });
      assert.deepEqual(captured, GPT4O);
      const saved = store.listModelPrices();
      assert.equal(saved.rows.length, 1);
      assert.equal(saved.rows[0]?.inputNanoPerMillion, 1_000_000_000);
      assert.notEqual(saved.fetchedAt, null);
      store.setModelPriceOverride("grok-4.7-build-fast", "4.50", "9");
      assert.deepEqual(catalog.lookup("grok-4.7-build-fast"), {
        inputNanoPerMillion: 4_500_000_000,
        outputNanoPerMillion: 9_000_000_000,
      });
      await catalog.refresh();
      assert.deepEqual(catalog.lookup("grok-4.7-build-fast"), {
        inputNanoPerMillion: 4_500_000_000,
        outputNanoPerMillion: 9_000_000_000,
      });
      store.deleteModelPriceOverride("grok-4.7-build-fast");
      assert.equal(catalog.lookup("grok-4.7-build-fast"), null);
      store.setModelPriceOverride("grok-imagine-image-2.0", "0", "0", "0.04");
      assert.equal(catalog.lookup("grok-imagine-image-2.0")?.perRequestNano, 40_000_000);
      const user = store.createUser({ email: "image@example.com", name: "Image", password: "password1" });
      store.grantUsd(user.id, "1");
      store.admitUser(user.id);
      store.settleUsage({
        userId: user.id,
        requestId: "image-1",
        inputTokens: 0,
        outputTokens: 0,
        inputNanoPerMillion: 0,
        outputNanoPerMillion: 0,
        perRequestNano: 40_000_000,
      });
      store.settleUsage({
        userId: user.id,
        requestId: "image-1",
        inputTokens: 0,
        outputTokens: 0,
        inputNanoPerMillion: 0,
        outputNanoPerMillion: 0,
        perRequestNano: 40_000_000,
      });
      assert.equal(store.getUser(user.id)?.balanceUsd, "0.96");
    } finally {
      catalog.stop();
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("stays unready when the first fetch fails and sqlite has no catalog", async () => {
    const dir = await mkdtemp(join(tmpdir(), "viate-prices-empty-"));
    const store = await AdminStore.open(dir);
    const catalog = createModelPriceCatalog({
      store,
      log: { error() {} },
      fetchImpl: async () => {
        throw new Error("network down");
      },
    });
    try {
      await catalog.start();
      assert.equal(catalog.ready, false);
      assert.equal(catalog.lookup("gpt-4o"), null);
    } finally {
      catalog.stop();
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
