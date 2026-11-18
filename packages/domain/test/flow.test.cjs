const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  FlowConfigError,
  flowConfigFromRecipe,
  parseFlowConfig,
  recipeFieldsFromFlow,
} = require("../dist/flow");

const recipe = {
  id: "flow-1",
  org_id: "local",
  name: "Feishu tasks",
  match: { record_class: "task", source: "feishu", text_contains: " confirm " },
  trigger: { kind: "push", coalesce: true },
  executor_type: "dsh",
  executor_config: { prompt: "Decide", skill: "ops" },
  can_write_back: false,
  write_back_thread_id: "feishu:results",
  hide_on_success: false,
  include_context: true,
  max_concurrent: 2,
  enabled: true,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

describe("flow config", () => {
  it("round-trips an agent flow and keeps an inactive reply target", () => {
    const config = parseFlowConfig(flowConfigFromRecipe(recipe));
    const fields = recipeFieldsFromFlow(config);
    assert.equal(fields.can_write_back, false);
    assert.equal(fields.write_back_thread_id, "feishu:results");
    assert.equal(fields.executor_config.prompt, "Decide");
    assert.equal(fields.executor_config.skill, "ops");
    assert.equal(fields.match.text_contains, " confirm ");
    assert.equal(fields.max_concurrent, 2);
    assert.deepEqual(flowConfigFromRecipe({ ...recipe, ...fields, id: recipe.id, org_id: recipe.org_id, name: recipe.name, created_at: recipe.created_at, updated_at: recipe.updated_at }), config);
  });

  it("rejects scopes, handlers and destinations the kernel cannot run", () => {
    const config = flowConfigFromRecipe(recipe);
    assert.throws(() => recipeFieldsFromFlow({
      ...config,
      scope: { kind: "retrieval", query: "today" },
    }), FlowConfigError);
    assert.throws(() => recipeFieldsFromFlow({
      ...config,
      destination: { kind: "digest" },
    }), FlowConfigError);
    assert.throws(() => recipeFieldsFromFlow({
      ...config,
      destination: { kind: "reply", thread: "origin", confirm: true, send: true },
    }), FlowConfigError);
  });
});
