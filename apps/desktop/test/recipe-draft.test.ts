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
  writeBackChoices,
} from "../src/renderer/src/recipe-draft.ts";
import type { RecipeView } from "../src/renderer/src/types.ts";
import { matchingConversations } from "../src/renderer/src/recipe-preview.ts";

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
  hide_on_success: false,
  enabled: true,
  created_at: "",
  updated_at: "",
};

describe("recipe draft", () => {
  it("does not add task or unit-kind restrictions to a new conversation push rule", () => {
    const conversations = [{ id: "chat:room", label: "Room", source: "chat", can_send: true }];
    const draft = starterDraft("chat", emptyDraft(), [{ id: "chat", label: "Chat" }], conversations);
    assert.deepEqual(draftMatch({ ...draft, text_contains: "[给客户]" }), {
      thread_id: "chat:room", text_contains: "[给客户]",
    });
    assert.equal(canAutoStart(draftMatch(draft), draft), true);
    const channel = starterDraft("channel", emptyDraft(), [{ id: "chat", label: "Chat" }], conversations);
    assert.deepEqual(draftMatch(channel), { source: "chat", record_class: "task" });
  });

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

  it("defaults new rules to keeping conversations visible and preserves legacy rule behavior", () => {
    assert.equal(emptyDraft().hide_on_success, false);
    assert.equal(draftFromRecipe(rule).hide_on_success, false);
    assert.equal(draftFromRecipe({ ...rule, hide_on_success: true }).hide_on_success, true);
    const legacy = { ...rule };
    delete legacy.hide_on_success;
    assert.equal(draftFromRecipe(legacy).hide_on_success, true);
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
        assert.doesNotMatch(summary, /filterInactiveSummary|filterContainsSummary|filterExcludesSummary/);
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

  it("keeps old executor config intact when opening an existing recipe", () => {
    const saved: RecipeView = {
      ...rule,
      executor_config: {
        instruction: "Legacy playbook",
        skill: "review",
        retired_option: "keep me",
      },
    };
    const draft = draftFromRecipe(saved, {
      executor_type: "dsh",
      label: "DSH",
      fields: [{ key: "skill", label: "Skill" }],
    });
    assert.deepEqual(draft.config, saved.executor_config);
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

  it("only offers positively sendable destinations without replacing an unavailable saved target", () => {
    const conversations = [
      { id: "feishu:chat-1", label: "Read only", can_send: false },
      { id: "other:results", label: "Writable", can_send: true },
      { id: "other:unknown", label: "Unknown" },
    ];
    const draft = draftFromRecipe({ ...rule, can_write_back: true, write_back_thread_id: "missing:old" });
    assert.deepEqual(writeBackChoices(draft, conversations, t), [
      { value: "other:results", label: "Writable" },
    ]);
    assert.equal(writeBackAvailable(draft, conversations), false);
    assert.equal(draft.can_write_back, true);
    assert.equal(draft.write_back_thread_id, "missing:old");
    const writable = { ...draft, write_back_thread_id: "other:results" };
    assert.equal(writeBackAvailable(writable, conversations), true);
    assert.equal(writeBackAvailable({ ...writable, write_back_thread_id: "" }, conversations), false);
    assert.deepEqual(writeBackChoices(draft, [], t), []);
    assert.equal(writeBackAvailable(draft, []), false);
  });

  it("checks the trial's original conversation and ignores a hidden scope selection", () => {
    const conversations = [
      { id: "feishu:chat-1", label: "Read only", source: "feishu", record_class: "task" as const, unit_kind: "message", can_send: false },
      { id: "other:results", label: "Writable", source: "other", record_class: "task" as const, unit_kind: "message", can_send: true },
    ];
    const draft = { ...draftFromRecipe(rule), scope: "tasks" as const };
    assert.equal(writeBackAvailable(draft, conversations), true);
    assert.equal(writeBackAvailable(draft, conversations, "feishu:chat-1"), false);
    assert.equal(writeBackAvailable(draft, conversations, "other:results"), true);
    assert.equal(writeBackChoices(draft, conversations, t)[0]?.value, "");
    assert.equal(writeBackAvailable({ ...draft, scope: "source", source: "feishu" }, conversations), false);
  });

  it("drops hidden fields once the scope changes", () => {
    const draft = { ...draftFromRecipe(rule), scope: "tasks" as const };
    assert.deepEqual(draftMatch(draft), { record_class: "task", unit_kind: "message" });
  });

  it("keeps dynamic original destinations independent of current message conditions", () => {
    const conversations = [
      { id: "chat:writable", label: "Writable", source: "chat", record_class: "task" as const, can_send: true, body_text: "draft" },
      { id: "chat:readonly", label: "Read only", source: "chat", record_class: "task" as const, can_send: false, body_text: "draft" },
    ];
    for (const scope of ["tasks", "source"] as const) {
      for (const filters of [
        { text_contains: "[customer]", text_excludes: "" },
        { text_contains: "", text_excludes: "draft" },
      ]) {
        const draft = { ...emptyDraft(), scope, source: "chat", ...filters };
        assert.equal(writeBackAvailable(draft, conversations), true);
        assert.equal(writeBackChoices(draft, conversations, t)[0]?.value, "");
        assert.deepEqual(matchingConversations(draftMatch(draft), conversations, "push"), [],
          "Current trial candidates and execution previews still apply body filters");
        assert.equal(writeBackAvailable(draft, conversations, "chat:readonly"), false);
        assert.equal(writeBackAvailable({ ...draft, write_back_thread_id: "chat:readonly" }, conversations), false);
        assert.equal(writeBackAvailable({ ...draft, write_back_thread_id: "missing:target" }, conversations), false);
        assert.equal(writeBackAvailable({ ...draft, write_back_thread_id: "chat:writable" }, conversations), true);
        assert.equal(writeBackAvailable({ ...draft, source: "outside", scope: "source" }, conversations), false,
          "Structural scope must still restrict dynamic destinations");
        assert.equal(writeBackAvailable(draft, conversations.map((item) => ({ ...item, can_send: false }))), false);
      }
    }
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
