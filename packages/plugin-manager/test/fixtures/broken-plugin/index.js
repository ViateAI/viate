export const plugin = {
  id: "fixture-broken",
  register() {
    throw new Error("broken plugin exploded");
  },
};

export default plugin;
