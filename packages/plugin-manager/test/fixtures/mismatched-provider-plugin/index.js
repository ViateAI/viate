export default {
  id: "fixture-mismatch",
  register(ctx) {
    ctx.registerProvider({ id: "other-provider" });
  },
};
