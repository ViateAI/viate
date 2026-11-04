# @viateai/sdk

Contract for a Viate provider plugin.

On plugin install the gateway removes `@viateai/sdk` from that plugin's `dependencies`, `optionalDependencies`, and `peerDependencies`. `import "@viateai/sdk"` then resolves to the copy built into that gateway.

For local typechecking, set both ranges to the gateway release you build against:

```json
{
  "type": "module",
  "peerDependencies": {
    "@viateai/sdk": "<gateway release>"
  },
  "devDependencies": {
    "@viateai/sdk": "<gateway release>"
  },
  "viate": {
    "id": "your-provider",
    "entry": "index.js"
  }
}
```

`viate.entry` exports `definePlugin({ id, register })` as the default export, the named `plugin` export, or the module itself. `register` calls `ctx.registerProvider` once. The provider `id` matches the plugin `id`. Log with `ctx.log`.

```js
import { definePlugin } from "@viateai/sdk";

export const plugin = definePlugin({
  id: "your-provider",
  register(ctx) {
    ctx.registerProvider({
      id: "your-provider",
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
```

The package entry is `.` only, ESM import only. The gateway runs it on Node.js 24.

Runtime exports:

- `definePlugin`
- `modelList`, `toModelList`
- `parseOpenAIChatUsage`, `parseOpenAIResponsesUsage`, `parseAnthropicUsage`
- `pickAllowedHeaders`, `INBOUND_HEADER_ALLOWLIST`, `OUTBOUND_HEADER_ALLOWLIST`
- `createPluginLogger`, `silentPluginLogger`

`ProviderHandler` carries the capabilities: chat, embeddings, responses, images, audio, video, `listModels`, `keepalive`, `subscription`, and the credential and OAuth hooks. Argument and result types ship from the same entry.

MIT. See [LICENSE](LICENSE). Source is [packages/sdk](https://github.com/ViateAI/viate/tree/main/packages/sdk) in [ViateAI/viate](https://github.com/ViateAI/viate).
