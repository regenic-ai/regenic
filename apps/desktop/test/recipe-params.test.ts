import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  configForRecipeEdit,
  configFromCatalog,
  invokeCopy,
  missingRequiredField,
} from "../src/renderer/src/recipe-params.ts";
import type { ExecutorCatalogEntry } from "../src/renderer/src/types.ts";

const dsh: ExecutorCatalogEntry = {
  executor_type: "dsh",
  label: "DSH",
  fields: [
    { key: "skill", label: "Skill", kind: "text" },
    { key: "prompt", label: "Prompt", kind: "textarea", required: true },
  ],
};

const cursor: ExecutorCatalogEntry = {
  executor_type: "cursor",
  label: "Cursor",
  params_label: "Cursor agent",
  fields: [
    { key: "repo", label: "Repo", kind: "text", default: "." },
    { key: "model", label: "Model", kind: "select", options: [{ value: "auto", label: "Auto" }] },
    { key: "prompt", label: "Task", kind: "textarea" },
  ],
};

describe("recipe invoke catalog", () => {
  it("preserves the shared instruction and legacy instruction key outside executor fields", () => {
    assert.deepEqual(
      configFromCatalog(dsh, { skill: "review", instruction: "Reply in three lines." }),
      { skill: "review", instruction: "Reply in three lines." },
    );
  });

  it("seeds defaults when switching executor and preserves the shared instruction", () => {
    assert.deepEqual(configFromCatalog(cursor, { skill: "review", prompt: "Ship it." }), {
      repo: ".",
      prompt: "Ship it.",
    });
  });

  it("previews catalog values and the shared instruction without duplicate prompt fields", () => {
    assert.equal(
      invokeCopy(cursor, { repo: "regenic", model: "auto", prompt: "Fix the test." }),
      "regenic · auto · Fix the test.",
    );
    assert.equal(invokeCopy(dsh, { instruction: "legacy" }), "legacy");
  });

  it("does not treat a catalog prompt as an executor-specific required field", () => {
    assert.equal(missingRequiredField(dsh, { skill: "review" }), undefined);
    assert.equal(missingRequiredField(dsh, {}), undefined);
  });

  it("keeps legacy recipe config untouched while editing", () => {
    assert.deepEqual(
      configForRecipeEdit(dsh, { instruction: "legacy", hidden: "preserve" }),
      { instruction: "legacy", hidden: "preserve" },
    );
  });
});
