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
  shouldRefreshActiveRun,
  matchWriteBackPrompt,
  pickAbsenteeInboxRows,
  shouldWriteBackHandle,
  transcriptFromAbsenteeLive,
  waitFromAbsentee,
  waitFromTranscript,
  workFaceOf,
  workStatusFromRun,
  workSubjectFromEvent,
  cancelWorkRun,
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

  it("never treats transcript speech as wait exit", () => {
    const wait = waitFromTranscript({
      prompts: [],
      transcript: { kind: "assistant", text: "done" },
    });
    assert.equal(wait.state, "running");
    assert.equal(wait.transcript.text, "done");
  });

  it("prefers thread_status over later speech for absentee live", () => {
    const ended = {
      event: { id: "status", operation: "create" },
      decision: { reason_codes: ["thread_status"] },
    };
    const spoken = {
      event: { id: "say", operation: "create" },
      decision: { reason_codes: ["assistant_not_current_work"] },
    };
    const picked = pickAbsenteeInboxRows([ended, spoken]);
    assert.equal(picked.live, ended);
    assert.equal(picked.visible, spoken);
  });

  it("maps DSH turn/end to absentee exit, not an assistant face", () => {
    const working = waitFromAbsentee({
      prompts: [],
      transcript: { kind: "assistant", text: "done", activity: "working" },
    });
    assert.equal(working.state, "running");

    const openTurn = waitFromAbsentee({
      prompts: [],
      transcript: {
        kind: "assistant",
        text: "Looking now.",
        turn: { state: "open" },
      },
    });
    assert.equal(openTurn.state, "running");

    const spoken = waitFromAbsentee({
      prompts: [],
      transcript: { kind: "assistant", text: "The travel request is approved." },
    });
    assert.equal(spoken.state, "running");

    const ended = waitFromAbsentee({
      prompts: [],
      transcript: {
        kind: "assistant",
        text: "The travel request is approved.",
        turn: { state: "ended", ok: true, reason: "completed" },
      },
    });
    assert.equal(ended.state, "exited");
    assert.equal(ended.ok, true);
    assert.equal(ended.result.summary, "The travel request is approved.");

    const failed = waitFromAbsentee({
      prompts: [],
      transcript: {
        kind: "assistant",
        text: "provider down",
        turn: { state: "ended", ok: false, reason: "error" },
      },
    });
    assert.equal(failed.state, "exited");
    assert.equal(failed.ok, false);

    const onlyOurAsk = waitFromAbsentee({
      prompts: [],
      transcript: { kind: "user", text: "please handle" },
    });
    assert.equal(onlyOurAsk.state, "running");

    const waiting = waitFromAbsentee({
      prompts: [{ prompt_id: "p1", presentation: "choice", questions: [] }],
      transcript: { kind: "assistant", text: "Need a choice." },
    });
    assert.equal(waiting.state, "waiting_human");

    const dead = waitFromAbsentee({
      prompts: [],
      transcript: { kind: "user", text: "please handle" },
      alive: false,
    });
    assert.equal(dead.state, "exited");
    assert.equal(dead.ok, false);
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

describe("work face", () => {
  it("exposes the run summary on the inbox face", () => {
    const face = workFaceOf(
      {
        id: "work-1",
        org_id: "local-owner",
        thread_id: "crm:order:1",
        unit_key: "job:1",
        record_class: "task",
        thread_facet: "ticket",
        status: "done",
        recipe_id: "recipe-1",
        created_at: "2026-08-27T00:00:00.000Z",
        updated_at: "2026-08-27T00:00:00.000Z",
      },
      { can_write_back: true, executor_type: "dsh" },
      {
        executor_type: "dsh",
        agent_thread_id: "dsh:session-1",
        result: { summary: "  审核不通过：地区不符  " },
      },
    );
    assert.equal(face.has_result, true);
    assert.equal(face.result_summary, "审核不通过：地区不符");
    assert.equal(face.can_write_back, true);
  });
});

describe("dismiss vs handle commit", () => {
  it("does not treat a leftover thread_status as working", () => {
    const leftover = transcriptFromAbsenteeLive({
      liveKind: "system",
      visibleKind: "assistant",
      visibleText: "Approved.",
    });
    assert.equal(leftover.activity, undefined);
    assert.equal(leftover.text, "Approved.");
    assert.equal(
      waitFromAbsentee({ prompts: [], transcript: leftover }).state,
      "running",
    );

    const working = transcriptFromAbsenteeLive({
      liveKind: "system",
      liveActivity: "working",
      visibleKind: "assistant",
      visibleText: "Looking.",
    });
    assert.equal(working.activity, "working");
    assert.equal(working.turn.state, "open");
  });

  it("cancels an inferior without mapping it to failed", () => {
    const now = "2026-08-25T02:00:00.000Z";
    const cancelled = cancelWorkRun(
      { id: "run-1", status: "running", updated_at: "2026-08-25T01:00:00.000Z" },
      now,
    );
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.updated_at, now);
    assert.equal(workStatusFromRun("cancelled"), "skipped");
    assert.equal(shouldRefreshActiveRun("skipped"), false);
    assert.equal(shouldRefreshActiveRun("running"), true);
    assert.equal(
      shouldWriteBackHandle({ status: "completed", result: { summary: "ok" } }, true),
      true,
    );
    assert.equal(
      shouldWriteBackHandle({ status: "completed", result: { summary: "ok" } }, false),
      false,
    );
  });
});

describe("write-back prompt match", () => {
  const orderPrompt = {
    prompt_id: "crm:audit:1",
    presentation: "approval",
    questions: [
      {
        id: "decision",
        prompt: "review",
        options: [{ label: "APPROVED" }, { label: "REJECTED" }],
      },
    ],
  };

  it("maps a Chinese reject summary onto REJECTED", () => {
    const answer = matchWriteBackPrompt(
      [orderPrompt],
      "审核结果：**不通过**\n地区不符",
    );
    assert.deepEqual(answer, {
      prompt_id: "crm:audit:1",
      answers: [{ id: "decision", selected: ["REJECTED"] }],
    });
  });

  it("does not treat 不通过 as APPROVED", () => {
    const answer = matchWriteBackPrompt(
      [orderPrompt],
      "达人通过了粉丝门槛，但语种不通过",
    );
    assert.equal(answer.answers[0].selected[0], "REJECTED");
  });

  it("maps 审核通过 onto APPROVED", () => {
    const answer = matchWriteBackPrompt([orderPrompt], "重新审查后审核通过");
    assert.equal(answer.answers[0].selected[0], "APPROVED");
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
