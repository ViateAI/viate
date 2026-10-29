import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseAdvertisedEndpointTypes, VIATE_DEFAULT_ENDPOINT_TYPES } from "./endpoints.js";

describe("parseAdvertisedEndpointTypes", () => {
  it("keeps known types in stable order and rejects unknown values", () => {
    assert.deepEqual(parseAdvertisedEndpointTypes(["openai-response", "openai", "openai"]), [
      "openai",
      "openai-response",
    ]);
    assert.deepEqual(parseAdvertisedEndpointTypes(["openai-image", "openai"]), ["openai", "openai-image"]);
    assert.deepEqual(parseAdvertisedEndpointTypes(["openai-audio", "openai-image", "openai"]), [
      "openai",
      "openai-image",
      "openai-audio",
    ]);
    assert.deepEqual(parseAdvertisedEndpointTypes(["openai-video", "openai-audio", "openai"]), [
      "openai",
      "openai-audio",
      "openai-video",
    ]);
    assert.deepEqual(parseAdvertisedEndpointTypes([]), []);
    assert.deepEqual([...VIATE_DEFAULT_ENDPOINT_TYPES], ["openai", "openai-response"]);
    assert.throws(() => parseAdvertisedEndpointTypes(["anthropic"]), /unsupported endpoint type/);
    assert.throws(() => parseAdvertisedEndpointTypes(undefined), /advertisedEndpointTypes is required/);
  });
});
