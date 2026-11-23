import { randomUUID } from "node:crypto";
import type { ModelPriceLookup } from "./chat.js";
import type { AdminStore, CreatedApiKey } from "./store.js";

export const zeroModelPrices: ModelPriceLookup = {
  ready: true,
  lookup: () => ({ inputNanoPerMillion: 0, outputNanoPerMillion: 0 }),
};

export function issueClient(store: AdminStore, name: string, channelId?: string | null): CreatedApiKey {
  const local = name.toLowerCase().replace(/[^a-z0-9]+/g, "") || "client";
  const user = store.createUser({
    email: `${local}-${randomUUID()}@example.com`,
    name,
    password: "password1",
  });
  store.grantUsd(user.id, "100");
  return store.createApiKey(name, user.id, channelId);
}
