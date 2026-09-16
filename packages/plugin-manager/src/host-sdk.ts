import module from "node:module";

const REGISTERED = Symbol.for("viate.registerHostSdk");
const HOST_SDK = "@viateai/sdk";
const HOST_PARENT_URL = import.meta.url;

export function registerHostSdk(): void {
  const globalState = globalThis as Record<symbol, boolean | undefined>;
  if (globalState[REGISTERED]) {
    return;
  }
  globalState[REGISTERED] = true;
  module.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === HOST_SDK || specifier.startsWith(`${HOST_SDK}/`)) {
        return nextResolve(specifier, { ...context, parentURL: HOST_PARENT_URL });
      }
      return nextResolve(specifier, context);
    },
  });
}
