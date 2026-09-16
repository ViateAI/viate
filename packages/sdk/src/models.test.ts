import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { modelList, toModelList } from "./models.js";

describe("modelList", () => {
  it("builds an OpenAI-style list and drops duplicate ids", () => {
    assert.deepEqual(
      modelList([
        {
          id: "gpt-4o",
          name: "GPT-4o",
          owned_by: "openai",
          context_length: 128000,
        },
        { id: " gpt-4o ", name: "ignored" },
        { id: "gpt-4o-mini" },
      ]),
      {
        object: "list",
        data: [
          {
            id: "gpt-4o",
            object: "model",
            owned_by: "openai",
            name: "GPT-4o",
            context_length: 128000,
          },
          { id: "gpt-4o-mini", object: "model" },
        ],
      },
    );
  });

  it("rejects an empty catalog", () => {
    assert.throws(() => modelList([{ id: " " }]), /model list is empty/);
  });
});

describe("toModelList", () => {
  it("reads OpenAI data[].id lists", () => {
    assert.deepEqual(
      toModelList({
        object: "list",
        data: [
          {
            id: "gpt-4o",
            name: "GPT-4o",
            context_length: 128000.9,
          },
          { id: "gpt-4o-mini" },
        ],
      }),
      {
        object: "list",
        data: [
          {
            id: "gpt-4o",
            object: "model",
            name: "GPT-4o",
            context_length: 128000,
          },
          { id: "gpt-4o-mini", object: "model" },
        ],
      },
    );
  });

  it("does not guess slug catalogs", () => {
    assert.throws(
      () => toModelList({ models: [{ slug: "gpt-6-astra", display_name: "GPT-6-Astra" }] }),
      /model list is empty/,
    );
  });
});
