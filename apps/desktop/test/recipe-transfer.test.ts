import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildRecipeBundle,
  parseRecipeBundle,
  recipeToTransferItem,
  stringifyRecipeBundle,
} from "../src/renderer/src/recipe-transfer.ts";
import type { RecipeView } from "../src/renderer/src/types.ts";

const sample: RecipeView = {
  id: "r1",
  org_id: "local",
  name: "Feishu tasks",
  match: { record_class: "task", source: "feishu" },
  trigger: { kind: "push", coalesce: true },
  executor_type: "dsh",
  executor_config: { prompt: "Triage", skill: "ops" },
  can_write_back: true,
  include_context: false,
  max_concurrent: 2,
  enabled: true,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

describe("recipe transfer", () => {
  it("round-trips a recipe bundle without ids", () => {
    const bundle = buildRecipeBundle([sample], "2026-09-05T12:00:00.000Z");
    assert.equal(bundle.version, 1);
    assert.equal(bundle.recipes.length, 1);
    assert.equal("id" in recipeToTransferItem(sample), false);
    const raw = stringifyRecipeBundle(bundle);
    const parsed = parseRecipeBundle(raw);
    assert.equal(parsed.recipes[0]?.name, "Feishu tasks");
    assert.equal(parsed.recipes[0]?.executor_type, "dsh");
    assert.equal(parsed.recipes[0]?.max_concurrent, 2);
    assert.deepEqual(parsed.recipes[0]?.match, {
      record_class: "task",
      source: "feishu",
    });
  });

  it("rejects empty or broken bundles", () => {
    assert.throws(() => parseRecipeBundle("{"), /invalid_json/);
    assert.throws(
      () => parseRecipeBundle(JSON.stringify({ version: 1, recipes: [] })),
      /empty_recipes/,
    );
    assert.throws(
      () =>
        parseRecipeBundle(
          JSON.stringify({
            version: 1,
            recipes: [{ name: "x", executor_type: "dsh" }],
          }),
        ),
      /invalid_recipe/,
    );
  });
});
