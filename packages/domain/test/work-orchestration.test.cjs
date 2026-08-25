const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  attentionOf,
  compareAttention,
  formatWorkEvidence,
  hiddenExecutorThreadIds,
  matchRecipe,
  MemoryExecutorRegistry,
  normalizeInboxSort,
  openOrUpdateWorkItem,
  projectThreadFacet,
  recordClassFromType,
  recipeSpecificity,
  selectRecipeForSubject,
  shouldOpenWorkItem,
  workSubjectFromEvent,
} = require("../dist");

describe("recordClassFromType", () => {
  it("maps known types into the closed set", () => {
    assert.equal(recordClassFromType("message"), "utterance");
    assert.equal(recordClassFromType("thread_reply"), "utterance");
    assert.equal(recordClassFromType("task"), "task");
    assert.equal(recordClassFromType("thread_status"), "status");
    assert.equal(recordClassFromType("prompt"), "prompt");
    assert.equal(recordClassFromType("unknown-native"), undefined);
    assert.equal(recordClassFromType(undefined), "utterance");
  });
});

describe("projectThreadFacet", () => {
  it("does not classify from connector name", () => {
    assert.equal(projectThreadFacet({ type: "message" }), "chat");
    assert.equal(projectThreadFacet({ type: "task" }), "ticket");
    assert.equal(projectThreadFacet({ type: "message", await_reply: true }), "agent");
    assert.equal(projectThreadFacet({ type: "message", hint: "ticket" }), "ticket");
  });
});

describe("recipe match", () => {
  const subject = {
    record_class: "utterance",
    thread_facet: "chat",
    source: "feishu",
    thread_id: "feishu:oc_1",
  };

  it("prefers the most specific enabled recipe", () => {
    const recipes = [
      makeRecipe("broad", { record_class: "utterance" }),
      makeRecipe("source", { record_class: "utterance", source: "feishu" }),
      makeRecipe("thread", { thread_id: "feishu:oc_1" }),
    ];
    assert.equal(matchRecipe(recipes, subject).id, "thread");
    assert.ok(recipeSpecificity({ thread_id: "x" }) > recipeSpecificity({ source: "feishu" }));
    assert.equal(matchRecipe([makeRecipe("empty", {})], subject), undefined);
  });
});

describe("work policy", () => {
  it("opens a work item for tasks or matched recipes", () => {
    assert.equal(shouldOpenWorkItem({ record_class: "task" }), true);
    assert.equal(shouldOpenWorkItem({ record_class: "utterance" }), false);
    const recipe = makeRecipe("r1", { source: "feishu" });
    const subject = workSubjectFromEvent({
      type: "message",
      source: "feishu",
      thread_id: "feishu:oc_1",
    });
    assert.ok(subject);
    assert.equal(selectRecipeForSubject([recipe], subject).id, "r1");
    assert.equal(
      workSubjectFromEvent({
        type: "unknown-native",
        source: "feishu",
        thread_id: "feishu:oc_1",
      }),
      undefined,
    );
    const opened = openOrUpdateWorkItem({
      org_id: "local-owner",
      subject,
      recipe,
      now: "2026-08-25T00:00:00.000Z",
    });
    assert.equal(opened.status, "open");
    assert.equal(opened.thread_facet, "chat");
  });
});

describe("attention", () => {
  it("ranks waiting humans above running machines", () => {
    assert.equal(attentionOf({ prompts: 1 }), "waiting_you");
    assert.equal(attentionOf({ work_status: "running" }), "running");
    assert.equal(attentionOf({ unread: true }), "unread");
    assert.ok(compareAttention("waiting_you", "running") < 0);
    assert.equal(normalizeInboxSort("attention"), "attention");
    assert.equal(normalizeInboxSort("nope"), "normal");
  });
});

describe("work reopen and hidden executor threads", () => {
  it("reopens a finished item when a new matching event arrives", () => {
    const recipe = makeRecipe("r1", { record_class: "task" });
    const first = openOrUpdateWorkItem({
      org_id: "local-owner",
      subject: {
        record_class: "task",
        thread_facet: "ticket",
        source: "feishu",
        thread_id: "feishu:oc_1",
      },
      recipe,
      head_event_id: "evt-1",
      now: "2026-08-25T00:00:00.000Z",
    });
    const done = { ...first, status: "done" };
    const sameHead = openOrUpdateWorkItem({
      existing: done,
      org_id: "local-owner",
      subject: {
        record_class: "task",
        thread_facet: "ticket",
        source: "feishu",
        thread_id: "feishu:oc_1",
      },
      recipe,
      head_event_id: "evt-1",
      now: "2026-08-25T01:00:00.000Z",
    });
    assert.equal(sameHead.status, "done");
    const reopened = openOrUpdateWorkItem({
      existing: done,
      org_id: "local-owner",
      subject: {
        record_class: "task",
        thread_facet: "ticket",
        source: "feishu",
        thread_id: "feishu:oc_1",
      },
      recipe,
      head_event_id: "evt-2",
      now: "2026-08-25T01:00:00.000Z",
    });
    assert.equal(reopened.status, "open");
    assert.equal(reopened.id, first.id);
  });

  it("hides bound executor sessions that are not the source ticket", () => {
    const hidden = hiddenExecutorThreadIds(
      [{ thread_id: "feishu:oc_1" }],
      [{ agent_thread_id: "dsh:session-9" }, { agent_thread_id: "feishu:oc_1" }],
    );
    assert.equal(hidden.has("dsh:session-9"), true);
    assert.equal(hidden.has("feishu:oc_1"), false);
  });
});

describe("executor registry", () => {
  it("registers catalog without channel names in the kernel", () => {
    const registry = new MemoryExecutorRegistry();
    registry.register({
      executor_type: "dsh",
      capabilities: () => ({ start: true, resume: true, status: true }),
      catalog: () => ({ executor_type: "dsh", label: "DSH", fields: [] }),
      start: async () => ({ external_run_id: "1", status: "running" }),
      resume: async () => ({ external_run_id: "1", status: "completed" }),
      status: async () => ({ external_run_id: "1", status: "running" }),
    });
    assert.equal(registry.catalog()[0].executor_type, "dsh");
    assert.match(formatWorkEvidence({
      thread_id: "feishu:oc_1",
      record_class: "utterance",
      thread_facet: "chat",
      source: "feishu",
      text: "please handle",
    }), /please handle/);
  });
});

function makeRecipe(id, match) {
  return {
    id,
    org_id: "local-owner",
    name: id,
    match,
    executor_type: "dsh",
    executor_config: {},
    can_write_back: false,
    enabled: true,
    created_at: "2026-08-25T00:00:00.000Z",
    updated_at: "2026-08-25T00:00:00.000Z",
  };
}
