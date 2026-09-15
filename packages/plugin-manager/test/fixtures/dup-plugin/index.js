export const plugin = {
  id: "fixture-ok",
  register(ctx) {
    ctx.registerProvider({
      id: "fixture-ok",
      async chatCompletions() {
        return { status: 200, headers: {}, body: null };
      },
    });
  },
};

export default plugin;
