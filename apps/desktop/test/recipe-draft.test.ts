import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  canAutoStart,
  applyTriggerKind,
  conflictCopy,
  draftFromRecipe,
  draftMatch,
  emptyDraft,
  starterDraft,
  recipeCardLine,
  writeBackAvailable,
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
  it("preserves filters through editing and scope changes, and clears blank fields", () => {
    const saved = { ...rule, match: { ...rule.match, text_contains: " approve ", text_excludes: "draft" } };
    const draft = draftFromRecipe(saved);
    assert.deepEqual(draftMatch(draft), saved.match);
    assert.equal(draftMatch({ ...draft, scope: "tasks" }).text_contains, " approve ");
    assert.equal(draftMatch({ ...draft, trigger_kind: "pull" }).text_excludes, "draft");
    const cleared = draftMatch({ ...draft, text_contains: "", text_excludes: "   " });
    assert.equal(cleared.text_contains, undefined);
    assert.equal(cleared.text_excludes, undefined);
    assert.match(recipeCardLine(saved, [], [], "Test", t), /filterContainsSummary/);
    assert.match(recipeCardLine(saved, [], [], "Test", t), /filterExcludesSummary/);
  });

  it("enables context for new rules and starters without changing saved rules", () => {
    assert.equal(emptyDraft().include_context, true);
    for (const kind of ["chat", "channel", "schedule"] as const) {
      assert.equal(starterDraft(kind, emptyDraft(), [], []).include_context, true);
    }
    assert.equal(draftFromRecipe(rule).include_context, false);
  });

  it("keeps inactive conditions through trigger switching, save/edit and list summaries", () => {
    const saved = { ...rule, match: { ...rule.match, text_contains: " approve ", text_excludes: "draft" } };
    let draft = draftFromRecipe(saved);
    for (const kind of ["pull", "manual", "push"] as const) {
      draft = applyTriggerKind(draft, kind);
      assert.equal(draft.text_contains, " approve ");
      assert.equal(draft.text_excludes, "draft");
      const reloaded = { ...saved, trigger: { kind }, match: draftMatch(draft) };
      draft = draftFromRecipe(reloaded);
      const summary = recipeCardLine(reloaded, [], [], "Test", t);
      if (kind === "push") {
        assert.match(summary, /filterContainsSummary/);
        assert.doesNotMatch(summary, /filterInactiveSummary/);
      } else {
        assert.match(summary, /filterInactiveSummary/);
        assert.doesNotMatch(summary, /filterContainsSummary|filterExcludesSummary/);
      }
    }
  });

  it("keeps match fields the form does not show when editing", () => {
    const draft = draftFromRecipe(rule, undefined, [
      { id: "feishu:chat-1", label: "Design review" },
    ]);
    assert.deepEqual(draftMatch(draft), rule.match);
    assert.equal(draft.thread_title, "Design review");
  });

  it("preserves a selected result destination and checks its sendability", () => {
    const saved: RecipeView = {
      ...rule,
      can_write_back: true,
      write_back_thread_id: "feishu:chat-results",
    };
    const conversations = [
      { id: "feishu:chat-1", label: "Source", can_send: true },
      { id: "feishu:chat-results", label: "Results", can_send: false },
    ];
    const draft = draftFromRecipe(saved, undefined, conversations);

    assert.equal(draft.write_back_thread_id, "feishu:chat-results");
    assert.equal(writeBackAvailable(draft, conversations), false);
    assert.equal(
      writeBackAvailable(
        { ...draft, write_back_thread_id: "" },
        conversations,
      ),
      true,
    );
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
