const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  attentionOf,
  compareAttention,
  currentJobOnSession,
  formatWorkEvidence,
  hiddenExecutorThreadIds,
  matchRecipe,
  MemoryExecutorRegistry,
  normalizeInboxSort,
  openOrUpdateWorkItem,
  projectThreadFacet,
  recordClassFromType,
  recipeAllowsAutoStart,
  recipeSpecificity,
  selectRecipeForSubject,
  shouldOpenWorkItem,
  waitFromTranscript,
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
  it("does not classify from connector capability", () => {
    assert.equal(projectThreadFacet({ type: "message" }), "chat");
    assert.equal(projectThreadFacet({ type: "task" }), "ticket");
    assert.equal(projectThreadFacet({ type: "message", await_reply: true }), "chat");
    assert.equal(projectThreadFacet({ type: "message", hint: "ticket" }), "ticket");
    assert.equal(projectThreadFacet({ type: "message", prompts: true }), "agent");
  });
});

describe("recipe match", () => {
  const subject = {
    record_class: "utterance",
    thread_facet: "chat",
    source: "chat-src",
    thread_id: "chat-src:t1",
  };

  it("prefers the most specific enabled recipe", () => {
    const recipes = [
      makeRecipe("broad", { record_class: "utterance" }),
      makeRecipe("source", { record_class: "utterance", source: "chat-src" }),
      makeRecipe("thread", { thread_id: "chat-src:t1" }),
    ];
    assert.equal(matchRecipe(recipes, subject).id, "thread");
    assert.ok(recipeSpecificity({ thread_id: "x" }) > recipeSpecificity({ source: "chat-src" }));
    assert.equal(matchRecipe([makeRecipe("empty", {})], subject), undefined);
  });
});

describe("recipe auto-start specification", () => {
  it("rejects broadcast triggers", () => {
    assert.equal(recipeAllowsAutoStart({}), false);
    assert.equal(recipeAllowsAutoStart({ source: "chat-src" }), false);
    assert.equal(recipeAllowsAutoStart({ record_class: "utterance" }), false);
    assert.equal(recipeAllowsAutoStart({ thread_facet: "agent" }), false);
    assert.equal(recipeAllowsAutoStart({ record_class: "task" }), true);
    assert.equal(recipeAllowsAutoStart({ thread_id: "chat-src:t1" }), true);
    assert.equal(
      recipeAllowsAutoStart({ source: "chat-src", record_class: "status" }),
      true,
    );
  });
});

describe("work policy", () => {
  it("opens a work item for tasks or specific recipes", () => {
    assert.equal(shouldOpenWorkItem({ record_class: "task" }), true);
    assert.equal(shouldOpenWorkItem({ record_class: "utterance" }), false);
    const recipe = makeRecipe("r1", { thread_id: "chat-src:t1" });
    const subject = workSubjectFromEvent({
      type: "message",
      source: "chat-src",
      thread_id: "chat-src:t1",
    });
    assert.ok(subject);
    assert.equal(selectRecipeForSubject([recipe], subject).id, "r1");
    assert.equal(
      selectRecipeForSubject([makeRecipe("broad", { source: "chat-src" })], subject),
      undefined,
    );
    assert.equal(
      workSubjectFromEvent({
        type: "unknown-native",
        source: "chat-src",
        thread_id: "chat-src:t1",
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
    assert.ok(opened.unit_key);
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

describe("session job face and wait status", () => {
  it("opens a new job on a new head instead of reviving the old one", () => {
    const recipe = makeRecipe("r1", { record_class: "task" });
    const first = openOrUpdateWorkItem({
      org_id: "local-owner",
      subject: {
        record_class: "task",
        thread_facet: "ticket",
        source: "chat-src",
        thread_id: "chat-src:t1",
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
        source: "chat-src",
        thread_id: "chat-src:t1",
      },
      recipe,
      head_event_id: "evt-1",
      now: "2026-08-25T01:00:00.000Z",
    });
    assert.equal(sameHead.status, "done");
    assert.equal(sameHead.id, first.id);
    const nextJob = openOrUpdateWorkItem({
      existing: done,
      org_id: "local-owner",
      subject: {
        record_class: "task",
        thread_facet: "ticket",
        source: "chat-src",
        thread_id: "chat-src:t1",
      },
      recipe,
      head_event_id: "evt-2",
      now: "2026-08-25T01:00:00.000Z",
    });
    assert.equal(nextJob.status, "open");
    assert.notEqual(nextJob.id, first.id);
    assert.equal(nextJob.unit_key, "evt-2");
    const face = currentJobOnSession([done, nextJob], "chat-src:t1");
    assert.equal(face.id, nextJob.id);
  });

  it("never treats transcript as wait exit", () => {
    const wait = waitFromTranscript({
      prompts: [],
      transcript: { kind: "assistant", text: "done" },
    });
    assert.equal(wait.state, "running");
    assert.equal(wait.transcript.text, "done");
  });

  it("hides bound absentee sysout that is not the source session", () => {
    const hidden = hiddenExecutorThreadIds(
      [{ thread_id: "chat-src:t1" }],
      [{ agent_thread_id: "exec:session-9" }, { agent_thread_id: "chat-src:t1" }],
    );
    assert.equal(hidden.has("exec:session-9"), true);
    assert.equal(hidden.has("chat-src:t1"), false);
  });
});

describe("executor registry", () => {
  it("registers catalog without channel names in the kernel", () => {
    const registry = new MemoryExecutorRegistry();
    registry.register({
      executor_type: "exec",
      capabilities: () => ({ start: true, resume: true, status: true }),
      catalog: () => ({ executor_type: "exec", label: "Exec", fields: [] }),
      start: async () => ({ external_run_id: "1", status: "running" }),
      resume: async () => ({ external_run_id: "1", status: "completed" }),
      status: async () => ({ external_run_id: "1", status: "running" }),
    });
    assert.equal(registry.catalog()[0].executor_type, "exec");
    assert.match(formatWorkEvidence({
      thread_id: "chat-src:t1",
      record_class: "utterance",
      thread_facet: "chat",
      source: "chat-src",
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
    executor_type: "exec",
    executor_config: {},
    can_write_back: false,
    enabled: true,
    created_at: "2026-08-25T00:00:00.000Z",
    updated_at: "2026-08-25T00:00:00.000Z",
  };
}
