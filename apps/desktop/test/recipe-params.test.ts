import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
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
  it("keeps existing catalog values and maps a legacy DSH instruction", () => {
    assert.deepEqual(
      configFromCatalog(dsh, { skill: "review", instruction: "Reply in three lines." }),
      { skill: "review", prompt: "Reply in three lines." },
    );
  });

  it("seeds defaults when switching executor and drops foreign keys", () => {
    assert.deepEqual(configFromCatalog(cursor, { skill: "review", prompt: "Ship it." }), {
      repo: ".",
      prompt: "Ship it.",
    });
  });

  it("previews values in catalog field order, not hardcoded skill/prompt", () => {
    assert.equal(
      invokeCopy(cursor, { repo: "regenic", model: "auto", prompt: "Fix the test." }),
      "regenic · auto · Fix the test.",
    );
    assert.equal(invokeCopy(dsh, { instruction: "legacy" }), "legacy");
  });

  it("blocks a missing required catalog field", () => {
    assert.equal(missingRequiredField(dsh, { skill: "review" }), "Prompt");
    assert.equal(missingRequiredField(dsh, { skill: "review", prompt: "同意" }), undefined);
  });
});
