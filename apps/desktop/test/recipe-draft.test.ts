import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  canAutoStart,
  conflictCopy,
  draftFromRecipe,
  draftMatch,
  recipeCardLine,
} from "../src/renderer/src/recipe-draft.ts";
import type { RecipeView } from "../src/renderer/src/types.ts";

const t = (key: string, vars?: Record<string, string | number>) =>
  vars ? `${key}:${JSON.stringify(vars)}` : key;

const rule: RecipeView = {
  id: "r1",
  org_id: "local",
  name: "Chat rule",
  match: {
    thread_id: "feishu:chat-1",
    source: "feishu",
    record_class: "utterance",
    unit_kind: "message",
  },
  trigger: { kind: "push", coalesce: true },
  executor_type: "dsh",
  executor_config: {},
  can_write_back: false,
  include_context: false,
  enabled: true,
  created_at: "",
  updated_at: "",
};

describe("recipe draft", () => {
  it("keeps match fields the form does not show when editing", () => {
    const draft = draftFromRecipe(rule, undefined, [
      { id: "feishu:chat-1", label: "Design review" },
    ]);
    assert.deepEqual(draftMatch(draft), rule.match);
    assert.equal(draft.thread_title, "Design review");
  });

  it("keeps a saved source rule's record class", () => {
    const sourceRule: RecipeView = {
      ...rule,
      match: { source: "feishu", record_class: "approval" as never },
    };
    const draft = draftFromRecipe(sourceRule);
    assert.deepEqual(draftMatch(draft), sourceRule.match);
  });

  it("drops hidden fields once the scope changes", () => {
    const draft = { ...draftFromRecipe(rule), scope: "tasks" as const };
    assert.deepEqual(draftMatch(draft), { record_class: "task", unit_kind: "message" });
  });

  it("refuses a channel rule with no channel picked", () => {
    const draft = {
      ...draftFromRecipe(rule),
      base_match: undefined,
      scope: "source" as const,
      source: "",
    };
    const match = draftMatch(draft);
    assert.deepEqual(match, {});
    assert.equal(canAutoStart(match, draft), false);
  });

  it("does not warn that a scheduled rule preempts a message rule", () => {
    const scheduled: RecipeView = {
      ...rule,
      id: "0-pull",
      name: "Scheduled",
      match: { thread_id: "feishu:chat-1" },
      trigger: { kind: "pull", interval_ms: 3_600_000 },
    };
    const push: RecipeView = { ...rule, match: { thread_id: "feishu:chat-1" } };
    assert.equal(conflictCopy(push, [push, scheduled], t as never), null);
    assert.equal(conflictCopy(scheduled, [push, scheduled], t as never), null);
  });

  it("always says whether results are sent back", () => {
    const keep = recipeCardLine(rule, [], [], "DSH", t as never);
    assert.match(keep, /recipes\.outcomeKeep/);
    const send = recipeCardLine(
      { ...rule, can_write_back: true },
      [],
      [],
      "DSH",
      t as never,
    );
    assert.match(send, /recipes\.outcomeBack/);
  });
});
