import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  matchingConversations,
  overlappingPriorityGroup,
  previewRecipeMatch,
  recipeMatches,
  shouldConfirmRecipeSave,
  subjectFromConversation,
} from "../src/renderer/src/recipe-preview.ts";
import type { RecipeConversationOption, RecipeView } from "../src/renderer/src/types.ts";

const chat: RecipeConversationOption = {
  id: "feishu:chat-1",
  label: "Design review",
  source: "feishu",
  record_class: "utterance",
  thread_facet: "chat",
};

const task: RecipeConversationOption = {
  id: "feishu:task-1",
  label: "Invoice approval",
  source: "feishu",
  record_class: "task",
  thread_facet: "ticket",
  unit_kind: "approval",
  has_work: true,
};

const otherChannel: RecipeConversationOption = {
  id: "slack:task-2",
  label: "Slack ticket",
  source: "slack",
  record_class: "task",
  thread_facet: "ticket",
};

describe("recipe match preview", () => {
  it("previews both filters against message bodies, not conversation names", () => {
    const match = { record_class: "task" as const, text_contains: "approve", text_excludes: "draft" };
    const preview = previewRecipeMatch({
      match,
      recipes: [],
      conversations: [
        { ...task, id: "ok", body_text: "please APPROVE release" },
        { ...task, id: "draft", body_text: "please APPROVE DRAFT" },
        { ...task, id: "missing", label: "approve release" },
        { ...task, id: "other", body_text: "release" },
      ],
    });
    assert.deepEqual(preview.sample_ids, ["ok"]);
    assert.equal(preview.count, 1);
    assert.equal(recipeMatches({ record_class: "task", text_excludes: "draft" },
      subjectFromConversation(task)!), false);
  });

  it("matches a bound chat by thread id", () => {
    const subject = subjectFromConversation(chat);
    assert.ok(subject);
    assert.equal(
      recipeMatches({ thread_id: "feishu:chat-1" }, subject),
      true,
    );
    assert.equal(
      recipeMatches({ thread_id: "feishu:other" }, subject),
      false,
    );
  });

  it("counts Current-work tasks for an all-tasks rule", () => {
    const preview = previewRecipeMatch({
      match: { record_class: "task" },
      conversations: [chat, task, otherChannel],
      recipes: [],
    });
    assert.equal(preview.ready, true);
    assert.equal(preview.count, 2);
    assert.deepEqual(preview.samples, ["Invoice approval", "Slack ticket"]);
  });

  it("filters by channel and reports a more-specific conflict", () => {
    const specific: RecipeView = {
      id: "r-specific",
      org_id: "local",
      name: "Approvals only",
      match: { record_class: "task", source: "feishu", unit_kind: "approval" },
      trigger: { kind: "push", coalesce: true },
      executor_type: "dsh",
      executor_config: {},
      can_write_back: true,
      include_context: false,
      enabled: true,
      created_at: "",
      updated_at: "",
    };
    const preview = previewRecipeMatch({
      match: { record_class: "task", source: "feishu" },
      conversations: [chat, task, otherChannel],
      recipes: [specific],
    });
    assert.equal(preview.count, 1);
    assert.equal(preview.samples[0], "Invoice approval");
    assert.equal(preview.preempted_by, "Approvals only");
  });

  it("stays not-ready until a chat is chosen for thread scope", () => {
    const preview = previewRecipeMatch({
      match: {},
      conversations: [task],
      recipes: [],
    });
    assert.equal(preview.ready, false);
    assert.equal(preview.count, 0);
  });

  it("asks to confirm broad or high-blast saves", () => {
    assert.equal(
      shouldConfirmRecipeSave({
        isNew: true,
        triggerKind: "push",
        scope: "tasks",
        canWriteBack: false,
        preview: { ready: true, count: 0, samples: [], sample_ids: [] },
      }),
      true,
    );
    assert.equal(
      shouldConfirmRecipeSave({
        isNew: true,
        triggerKind: "push",
        scope: "thread",
        canWriteBack: true,
        preview: { ready: true, count: 1, samples: ["A"], sample_ids: ["a"] },
      }),
      false,
    );
    assert.equal(
      shouldConfirmRecipeSave({
        isNew: true,
        triggerKind: "push",
        scope: "source",
        canWriteBack: true,
        preview: { ready: true, count: 2, samples: ["A", "B"], sample_ids: ["a", "b"] },
      }),
      true,
    );
    assert.equal(
      shouldConfirmRecipeSave({
        isNew: false,
        triggerKind: "manual",
        scope: "tasks",
        canWriteBack: true,
        preview: { ready: true, count: 9, samples: [], sample_ids: [] },
      }),
      false,
    );
  });

  it("orders overlapping rules by specificity", () => {
    const broad: RecipeView = {
      id: "broad",
      org_id: "local",
      name: "All tasks",
      match: { record_class: "task" },
      trigger: { kind: "push", coalesce: true },
      executor_type: "dsh",
      executor_config: {},
      can_write_back: false,
      include_context: false,
      enabled: true,
      created_at: "",
      updated_at: "",
    };
    const narrow: RecipeView = {
      ...broad,
      id: "narrow",
      name: "Feishu approvals",
      match: { record_class: "task", source: "feishu", unit_kind: "approval" },
    };
    const rows = overlappingPriorityGroup(broad, [broad, narrow]);
    assert.equal(rows[0]?.id, "narrow");
    assert.equal(rows[0]?.rank, 1);
    assert.equal(rows[1]?.id, "broad");
    assert.equal(rows[1]?.rank, 2);
    assert.equal(rows[1]?.is_self, true);
  });

  it("lists every matching chat as a try sample", () => {
    assert.deepEqual(
      matchingConversations({ record_class: "task" }, [chat, task, otherChannel])?.map(
        (item) => item.id,
      ),
      ["feishu:task-1", "slack:task-2"],
    );
    assert.equal(matchingConversations({}, [chat]), null);
    assert.equal(matchingConversations({ source: " " }, [chat]), null);
  });

  it("ranks like dispatch: scheduled rules never compete", () => {
    const base: RecipeView = {
      id: "a-push",
      org_id: "local",
      name: "On message",
      match: { thread_id: "feishu:chat-1" },
      trigger: { kind: "push", coalesce: true },
      executor_type: "dsh",
      executor_config: {},
      can_write_back: false,
      include_context: false,
      enabled: true,
      created_at: "",
      updated_at: "",
    };
    const scheduled: RecipeView = {
      ...base,
      id: "0-pull",
      name: "Scheduled",
      trigger: { kind: "pull", interval_ms: 3_600_000 },
    };
    const manual: RecipeView = {
      ...base,
      id: "0-manual",
      name: "Manual",
      trigger: { kind: "manual" },
    };
    const preview = previewRecipeMatch({
      match: base.match,
      draftId: base.id,
      triggerKind: "push",
      conversations: [chat],
      recipes: [base, scheduled],
    });
    assert.equal(preview.preempted_by, undefined);
    assert.deepEqual(overlappingPriorityGroup(scheduled, [base, scheduled]), []);
    const rows = overlappingPriorityGroup(manual, [base, scheduled, manual]);
    assert.deepEqual(
      rows.map((row) => row.id),
      ["a-push", "0-manual"],
    );
  });

  it("ranks the unsaved draft, not the saved copy", () => {
    const saved: RecipeView = {
      id: "r1",
      org_id: "local",
      name: "Saved",
      match: { record_class: "task" },
      trigger: { kind: "push", coalesce: true },
      executor_type: "dsh",
      executor_config: {},
      can_write_back: false,
      include_context: false,
      enabled: true,
      created_at: "",
      updated_at: "",
    };
    const other: RecipeView = {
      ...saved,
      id: "r2",
      name: "Feishu tasks",
      match: { record_class: "task", source: "feishu" },
    };
    const rows = overlappingPriorityGroup(
      {
        id: "r1",
        name: "Draft",
        match: { record_class: "task", source: "feishu", unit_kind: "approval" },
        enabled: true,
        trigger: { kind: "push" },
      },
      [saved, other],
    );
    assert.equal(rows[0]?.id, "r1");
    assert.equal(rows[0]?.name, "Draft");
  });
});
