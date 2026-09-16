import { definePlugin } from "@viateai/sdk";

export const plugin = definePlugin({
  id: "fixture-sdk",
  register(ctx) {
    ctx.registerProvider({
      id: "fixture-sdk",
      async chatCompletions() {
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: null,
        };
      },
    });
  },
});

export default plugin;
