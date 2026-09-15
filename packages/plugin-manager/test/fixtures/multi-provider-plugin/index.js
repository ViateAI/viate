export default {
  id: "fixture-multi",
  register(ctx) {
    ctx.registerProvider({ id: "fixture-multi" });
    ctx.registerProvider({ id: "fixture-multi" });
  },
};
