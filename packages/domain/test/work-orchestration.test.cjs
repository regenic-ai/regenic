const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  attentionOf,
  compareAttention,
  currentJobOnSession,
  WORK_EVIDENCE_CHAR_LIMIT,
  WORK_EVIDENCE_OMITTED,
  WORK_EVIDENCE_THREAD_LIMIT,
  budgetThreadEvidence,
  composeWorkConversation,
  composeWorkEvidenceText,
  composeWorkspaceInstructionFiles,
  composeWorkspaceTaskEvidence,
  WORK_AGENTS_FILENAME,
  WORK_AGENTS_INLINE_LIMIT,
  WORK_CONVERSATION_FILENAME,
  WORK_FILE_THREAD_LIMIT,
  formatThreadContext,
  formatWorkEvidence,
  isExecutorSysoutBody,
  packThreadEvidence,
  selectThreadEvidenceLines,
  hiddenExecutorThreadIds,
  matchRecipe,
  MemoryExecutorRegistry,
  normalizeInboxSort,
  openOrUpdateWorkItem,
  projectThreadFacet,
  recordClassFromType,
  pullPeriodKey,
  pullUnitKey,
  isPullDue,
  advancePullNextRun,
  shouldKeepPullSchedule,
  writeBackIdempotencyKey,
  recipeAllowsAutoStart,
  recipeAllowsPullDispatch,
  recipeAllowsPushDispatch,
  shouldAcceptPushRecord,
  shouldRetryFailedPush,
  recipeSpecificity,
  recipePreemptedBy,
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
  enqueueWriteBack,
  deliveryClaimSend,
  deliveryRecordReceipt,
  deliveryAcked,
  deliveryWriteBackFailed,
  deliveryRetryNow,
  deliverySendTimedOut,
  deliveryAbandoned,
  reclaimDeliveryLease,
  shouldFlushDelivery,
  isDeadLetter,
  deliveryNeedsAttention,
  deliveryFaceOf,
  WORK_DELIVERY_MAX_ATTEMPTS,
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
    const general = makeRecipe("general", { record_class: "task" });
    const specific = makeRecipe("specific", {
      record_class: "task",
      source: "chat-src",
    });
    assert.equal(recipePreemptedBy(general, [general, specific])?.id, "specific");
    assert.equal(recipePreemptedBy(specific, [general, specific]), undefined);
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

  it("dispatches push and pull separately", () => {
    const push = makeRecipe("push", { thread_id: "chat-src:t1" });
    const pull = makeRecipe("pull", { thread_id: "chat-src:t1" }, {
      kind: "pull",
      interval_ms: 60 * 60 * 1000,
    });
    const manual = makeRecipe("manual", { thread_id: "chat-src:t1" }, { kind: "manual" });
    const subject = {
      record_class: "utterance",
      thread_facet: "chat",
      source: "chat-src",
      thread_id: "chat-src:t1",
    };
    assert.equal(recipeAllowsPushDispatch(push), true);
    assert.equal(recipeAllowsPushDispatch(pull), false);
    assert.equal(recipeAllowsPullDispatch(pull), true);
    assert.equal(selectRecipeForSubject([pull, manual, push], subject).id, "push");
    assert.equal(selectRecipeForSubject([pull, manual], subject).id, "manual");
  });

  it("ignores outbound and assistant echoes for push", () => {
    assert.equal(shouldAcceptPushRecord({ direction: "inbound", kind: "user" }), true);
    assert.equal(shouldAcceptPushRecord({ direction: "outbound", kind: "user" }), false);
    assert.equal(shouldAcceptPushRecord({ direction: "inbound", kind: "assistant" }), false);
    assert.equal(shouldAcceptPushRecord({ direction: "inbound", kind: "system" }), false);
    assert.equal(
      shouldAcceptPushRecord({ direction: "inbound", kind: "user", external_id: "feishu:out:1" }),
      false,
    );
  });

  it("accepts inbound task tickets even when kind is system", () => {
    assert.equal(
      shouldAcceptPushRecord({
        direction: "inbound",
        kind: "system",
        type: "task",
      }),
      true,
    );
    assert.equal(
      shouldAcceptPushRecord({
        direction: "inbound",
        kind: "assistant",
        type: "task",
      }),
      true,
    );
    assert.equal(
      shouldAcceptPushRecord({
        direction: "outbound",
        kind: "system",
        type: "task",
      }),
      false,
    );
  });

  it("keeps pull periods stable and retries failed push with backoff", () => {
    const hour = 60 * 60 * 1000;
    const period = pullPeriodKey(Date.parse("2026-08-27T10:20:00.000Z"), hour);
    assert.equal(period, pullPeriodKey(Date.parse("2026-08-27T10:40:00.000Z"), hour));
    assert.equal(pullUnitKey("r1", period), `pull:r1:${period}`);
    const due = makeRecipe("due", { thread_id: "chat-src:t1" }, {
      kind: "pull",
      interval_ms: hour,
    });
    due.next_run_at = "2026-08-27T10:00:00.000Z";
    assert.equal(isPullDue(due, "2026-08-27T10:00:00.000Z"), true);
    due.next_run_at = "2026-08-27T11:00:00.000Z";
    assert.equal(isPullDue(due, "2026-08-27T10:59:59.000Z"), false);
    assert.equal(
      advancePullNextRun("2026-08-27T10:00:00.000Z", hour, "2026-08-27T13:10:00.000Z"),
      "2026-08-27T14:00:00.000Z",
    );
    const scheduled = makeRecipe("due", { thread_id: "chat-src:t1" }, {
      kind: "pull",
      interval_ms: hour,
    });
    assert.equal(
      shouldKeepPullSchedule(scheduled, {
        match: { thread_id: "chat-src:t1" },
        trigger: { kind: "pull", interval_ms: hour },
      }),
      true,
    );
    assert.equal(
      shouldKeepPullSchedule(scheduled, {
        match: { thread_id: "chat-src:other" },
        trigger: { kind: "pull", interval_ms: hour },
      }),
      false,
    );
    assert.equal(
      shouldRetryFailedPush({
        status: "failed",
        updated_at: "2026-08-27T10:00:00.000Z",
        attempts: 0,
        now: "2026-08-27T10:00:29.000Z",
      }),
      false,
    );
    assert.equal(
      shouldRetryFailedPush({
        status: "failed",
        updated_at: "2026-08-27T10:00:00.000Z",
        attempts: 0,
        now: "2026-08-27T10:00:30.000Z",
      }),
      true,
    );
    assert.equal(
      shouldRetryFailedPush({
        status: "failed",
        updated_at: "2026-08-27T10:00:00.000Z",
        attempts: 3,
        now: "2026-08-27T12:00:00.000Z",
      }),
      false,
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
    const running = { ...opened, status: "running", head_event_id: "evt-1" };
    const held = openOrUpdateWorkItem({
      existing: running,
      org_id: "local-owner",
      subject,
      recipe,
      head_event_id: "evt-2",
      now: "2026-08-25T00:01:00.000Z",
    });
    assert.equal(held.id, running.id);
    assert.equal(held.head_event_id, "evt-1");
    const split = openOrUpdateWorkItem({
      existing: running,
      org_id: "local-owner",
      subject,
      recipe: makeRecipe("r1", { thread_id: "chat-src:t1" }, { kind: "push", coalesce: false }),
      head_event_id: "evt-2",
      now: "2026-08-25T00:02:00.000Z",
    });
    assert.notEqual(split.id, running.id);
    assert.equal(split.head_event_id, "evt-2");
    assert.equal(split.unit_key, "evt-2");
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
    const olderRunning = {
      ...done,
      id: "work-old",
      status: "running",
      created_at: "2026-08-25T00:00:00.000Z",
      updated_at: "2026-08-25T02:00:00.000Z",
    };
    const newerOpen = {
      ...nextJob,
      id: "work-new",
      status: "open",
      created_at: "2026-08-25T01:00:00.000Z",
      updated_at: "2026-08-25T01:00:00.000Z",
    };
    assert.equal(
      currentJobOnSession([olderRunning, newerOpen], "chat-src:t1").id,
      "work-new",
    );
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

  it("exposes the delivery ledger on the inbox face", () => {
    const delivery = enqueueWriteBack({
      org_id: "local-owner",
      work_item_id: "work-1",
      recipe_id: "recipe-1",
      kind: "push",
      unit_key: "job:1",
      payload: { summary: "审核不通过：地区不符" },
      now: "2026-08-27T00:00:00.000Z",
    });
    const face = workFaceOf(
      {
        id: "work-1",
        org_id: "local-owner",
        thread_id: "crm:order:1",
        unit_key: "job:1",
        record_class: "task",
        thread_facet: "ticket",
        status: "open",
        recipe_id: "recipe-1",
        created_at: "2026-08-27T00:00:00.000Z",
        updated_at: "2026-08-27T00:00:00.000Z",
      },
      { can_write_back: true, executor_type: "dsh" },
      null,
      delivery,
    );
    assert.equal(face.delivery?.status, "queued");
    assert.equal(face.delivery?.write_back, "pending");
  });
});

describe("work delivery", () => {
  const now = "2026-08-27T00:00:00.000Z";

  function queued() {
    return enqueueWriteBack({
      org_id: "local-owner",
      work_item_id: "work-1",
      recipe_id: "recipe-1",
      kind: "push",
      unit_key: "evt-1",
      event_id: "evt-1",
      payload: { summary: "审核不通过：地区不符" },
      now,
    });
  }

  it("reuses one outbox row and snapshots the payload", () => {
    const first = queued();
    const again = enqueueWriteBack({
      org_id: first.org_id,
      work_item_id: first.work_item_id,
      recipe_id: first.recipe_id,
      kind: "push",
      unit_key: first.unit_key,
      payload: { summary: "second" },
      now,
      existing: first,
    });
    assert.equal(again.id, first.id);
    assert.equal(again.payload.summary, "second");
    assert.equal(shouldFlushDelivery(first, now), true);
    assert.equal(
      first.idempotency_key,
      writeBackIdempotencyKey(first.work_item_id, first.payload),
    );
    assert.equal(
      writeBackIdempotencyKey(first.work_item_id, first.payload),
      writeBackIdempotencyKey(first.work_item_id, {
        summary: first.payload.summary,
      }),
    );
    assert.notEqual(again.idempotency_key, first.idempotency_key);
    const sent = deliveryRecordReceipt(
      deliveryClaimSend(queued(), now),
      { accepted: true, rpc_id: "rpc-1" },
      now,
    );
    const same = enqueueWriteBack({
      org_id: sent.org_id,
      work_item_id: sent.work_item_id,
      recipe_id: sent.recipe_id,
      kind: "push",
      unit_key: sent.unit_key,
      payload: sent.payload,
      now: "2026-08-27T10:00:01.000Z",
      existing: sent,
    });
    assert.equal(same.status, "write_back");
    assert.equal(same.attempts, 1);
    assert.deepEqual(same.channel_receipt, { accepted: true, rpc_id: "rpc-1" });
    assert.equal(same.idempotency_key, sent.idempotency_key);
    const claimed = deliveryClaimSend(queued(), now);
    const timedOut = deliverySendTimedOut(claimed, now);
    assert.equal(timedOut.attempts, 0);
    assert.equal(timedOut.status, "write_back");
    assert.equal(timedOut.lease_expires_at, claimed.lease_expires_at);
  });

  it("reclaims an expired lease and does not flush an in-flight send", () => {
    let delivery = deliveryClaimSend(queued(), now);
    assert.equal(delivery.status, "write_back");
    assert.equal(shouldFlushDelivery(delivery, now), false);
    const later = new Date(Date.parse(delivery.lease_expires_at) + 1).toISOString();
    const reclaimed = reclaimDeliveryLease(delivery, later);
    assert.equal(reclaimed.status, "queued");
    assert.equal(shouldFlushDelivery(delivery, later), true);
  });

  it("acks a sent write-back and dead-letters after three send failures", () => {
    let delivery = deliveryClaimSend(queued(), now);
    delivery = deliveryAcked(delivery, "sent", now);
    assert.equal(delivery.status, "acked");
    assert.equal(delivery.write_back, "sent");
    assert.equal(shouldFlushDelivery(delivery, now), false);

    delivery = deliveryClaimSend(queued(), now);
    delivery = deliveryWriteBackFailed(delivery, "no prompt", now);
    assert.equal(delivery.status, "write_back");
    assert.equal(delivery.write_back, "failed");
    assert.equal(deliveryNeedsAttention(delivery), true);
    assert.equal(shouldFlushDelivery(delivery, now), false);
    assert.equal(shouldFlushDelivery(delivery, delivery.next_retry_at), true);

    delivery = deliveryClaimSend(deliveryRetryNow(delivery, "2026-08-27T00:01:00.000Z"), "2026-08-27T00:01:00.000Z");
    delivery = deliveryWriteBackFailed(delivery, "no prompt", "2026-08-27T00:01:00.000Z");
    delivery = deliveryClaimSend(deliveryRetryNow(delivery, "2026-08-27T00:10:00.000Z"), "2026-08-27T00:10:00.000Z");
    delivery = deliveryWriteBackFailed(delivery, "no prompt", "2026-08-27T00:10:00.000Z");
    assert.equal(delivery.attempts, WORK_DELIVERY_MAX_ATTEMPTS);
    assert.equal(delivery.status, "dead");
    assert.equal(isDeadLetter(delivery), true);
    assert.equal(deliveryFaceOf(delivery)?.status, "dead");
    assert.equal(deliveryAbandoned(delivery, now).write_back, "skipped");
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
    assert.equal(shouldWriteBackHandle({ status: "completed" }, true), true);
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

  it("maps an exact option label or first-line conclusion", () => {
    assert.deepEqual(matchWriteBackPrompt([orderPrompt], "REJECTED"), {
      prompt_id: "crm:audit:1",
      answers: [{ id: "decision", selected: ["REJECTED"] }],
    });
    assert.equal(
      matchWriteBackPrompt([orderPrompt], "REJECTED\n地区不符").answers[0].selected[0],
      "REJECTED",
    );
    assert.equal(
      matchWriteBackPrompt(
        [orderPrompt],
        "不通过\n地区不符",
        (label) => (label === "REJECTED" ? ["REJECTED", "不通过"] : [label]),
      ).answers[0].selected[0],
      "REJECTED",
    );
  });

  it("does not infer a conclusion from narrative text", () => {
    assert.equal(matchWriteBackPrompt([orderPrompt], "通过"), undefined);
    assert.equal(matchWriteBackPrompt([orderPrompt], "不通过\n地区不符"), undefined);
    assert.equal(
      matchWriteBackPrompt([orderPrompt], "审核结果：**不通过**\n地区不符"),
      undefined,
    );
    assert.equal(
      matchWriteBackPrompt([orderPrompt], "达人通过了粉丝门槛，但语种不通过"),
      undefined,
    );
    assert.equal(matchWriteBackPrompt([orderPrompt], "重新审查后审核通过"), undefined);
    assert.equal(matchWriteBackPrompt([orderPrompt], "未通过"), undefined);
    assert.equal(matchWriteBackPrompt([orderPrompt], "不建议通过"), undefined);
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
    const evidence = formatWorkEvidence({
      thread_id: "chat-src:t1",
      record_class: "utterance",
      thread_facet: "chat",
      source: "chat-src",
      text: "please handle",
    });
    assert.match(evidence, /please handle/);
    assert.equal(isExecutorSysoutBody(evidence), true);
    assert.equal(
      isExecutorSysoutBody(
        "我是CEO，请站在我的角度去回复对方消息。\n\nWORK\nWork item feishu:oc_1\nrecord_class=utterance",
      ),
      true,
    );
    assert.equal(isExecutorSysoutBody("只用一句话回复：pong"), false);
    assert.equal(
      formatThreadContext([
        { speaker: "熊峰", text: "先看上周的单" },
        { speaker: "user", text: "按上次说的办" },
      ]),
      "熊峰: 先看上周的单\n\nuser: 按上次说的办",
    );
    assert.deepEqual(
      selectThreadEvidenceLines([
        { speaker: "A", text: "hello" },
        { tombstone: true, text: "gone" },
        { status: true, text: "working" },
        { working: true, text: "Looking" },
        { speaker: "B", text: "  " },
        { speaker: "B", text: "please handle" },
      ]),
      [
        { speaker: "A", text: "hello" },
        { speaker: "B", text: "please handle" },
      ],
    );
    const capped = selectThreadEvidenceLines(
      Array.from({ length: WORK_EVIDENCE_THREAD_LIMIT + 5 }, (_, index) => ({
        speaker: "user",
        text: `m${index}`,
      })),
    );
    assert.equal(capped.length, WORK_EVIDENCE_THREAD_LIMIT);
    assert.equal(capped[0].text, "m5");
    assert.equal(capped[capped.length - 1].text, `m${WORK_EVIDENCE_THREAD_LIMIT + 4}`);
    assert.equal(
      composeWorkEvidenceText({
        include_context: false,
        trigger_text: "latest ticket",
        head_text: "older head",
        thread_lines: [{ speaker: "A", text: "history" }],
      }),
      "latest ticket",
    );
    const split = composeWorkEvidenceText({
      include_context: true,
      trigger_text: "latest ticket",
      thread_lines: [
        { speaker: "A", text: "history" },
        { speaker: "B", text: "latest ticket" },
      ],
    });
    assert.match(split, /Treat <background> as established context/);
    assert.match(split, /<background>\nA: history\n<\/background>/);
    assert.match(split, /<current>\nB: latest ticket\n<\/current>/);
    assert.equal(split.includes("B: latest ticket\n\n"), false);
    const packed = packThreadEvidence({
      lines: [
        { speaker: "A", text: "old" },
        { speaker: "B", text: "new" },
      ],
      overflow: true,
    });
    assert.equal(packed.omitted, true);
    assert.match(packed.text, new RegExp(WORK_EVIDENCE_OMITTED.replace(/[[\]]/g, "\\$&")));
    assert.match(packed.text, /B: new/);
    const tight = budgetThreadEvidence(
      [
        { speaker: "A", text: "aaaa" },
        { speaker: "B", text: "bbbb" },
      ],
      12,
    );
    assert.equal(tight.omitted, 1);
    assert.deepEqual(tight.lines, [{ speaker: "B", text: "bbbb" }]);
    const oneHuge = budgetThreadEvidence(
      [{ speaker: "user", text: "x".repeat(WORK_EVIDENCE_CHAR_LIMIT + 50) }],
      20,
    );
    assert.equal(oneHuge.lines.length, 1);
    assert.ok(oneHuge.lines[0].text.length < 20);
    const overflowed = composeWorkEvidenceText({
      include_context: true,
      head_text: "the ticket",
      thread_overflow: true,
      thread_lines: [{ speaker: "A", text: "recent" }],
    });
    assert.match(overflowed, new RegExp(WORK_EVIDENCE_OMITTED.replace(/[[\]]/g, "\\$&")));
    assert.match(overflowed, /<background>[\s\S]*A: recent/);
    assert.match(overflowed, /<current>\nuser: the ticket\n<\/current>$/);
    assert.match(
      composeWorkEvidenceText({
        include_context: true,
        head_text: "the ticket",
        thread_lines: [{ speaker: "A", text: "recent" }],
      }),
      /<current>\nuser: the ticket\n<\/current>$/,
    );
    assert.equal(
      composeWorkEvidenceText({
        include_context: true,
        thread_lines: [
          { speaker: "A", text: "history" },
          { speaker: "B", text: "later" },
        ],
      }),
      "A: history\n\nB: later",
    );
    const filePack = composeWorkConversation({
      include_context: true,
      trigger_text: "latest ticket",
      thread_lines: [
        { speaker: "A", text: "history" },
        { speaker: "B", text: "latest ticket" },
      ],
    });
    assert.equal(filePack.background, "A: history");
    assert.equal(filePack.current_line, "B: latest ticket");
    assert.equal(filePack.omitted, false);
    const omittedRe = new RegExp(WORK_EVIDENCE_OMITTED.replace(/[[\]]/g, "\\$&"));
    const midHistory = Array.from(
      { length: WORK_EVIDENCE_THREAD_LIMIT + 5 },
      (_, index) => ({ speaker: "user", text: `older-${index}` }),
    );
    const mid = composeWorkConversation({
      include_context: true,
      trigger_text: "do it",
      thread_lines: [...midHistory, { speaker: "user", text: "do it" }],
    });
    assert.equal(mid.omitted, false);
    assert.equal(mid.background.includes(WORK_EVIDENCE_OMITTED), false);
    assert.match(mid.inline_text, omittedRe);
    const midFiles = composeWorkspaceInstructionFiles({
      background: mid.background,
      omitted: mid.omitted,
    });
    assert.equal(
      (midFiles[WORK_CONVERSATION_FILENAME] ?? midFiles[WORK_AGENTS_FILENAME] ?? "").includes(
        WORK_EVIDENCE_OMITTED,
      ),
      false,
    );
    const fileOmitted = composeWorkConversation({
      include_context: true,
      trigger_text: "do it",
      thread_overflow: true,
      thread_lines: [
        { speaker: "A", text: `kept ${"y".repeat(WORK_AGENTS_INLINE_LIMIT)}` },
        { speaker: "user", text: "do it" },
      ],
    });
    assert.equal(fileOmitted.omitted, true);
    assert.match(fileOmitted.background, omittedRe);
    const overflowFiles = composeWorkspaceInstructionFiles({
      background: fileOmitted.background,
      omitted: fileOmitted.omitted,
    });
    const stamped =
      overflowFiles[WORK_CONVERSATION_FILENAME] ?? overflowFiles[WORK_AGENTS_FILENAME] ?? "";
    assert.equal(stamped.split(WORK_EVIDENCE_OMITTED).length - 1, 1);
    assert.equal(WORK_FILE_THREAD_LIMIT > WORK_EVIDENCE_THREAD_LIMIT, true);
    const small = composeWorkspaceInstructionFiles({
      background: "A: history",
    });
    assert.equal(small[WORK_CONVERSATION_FILENAME], undefined);
    assert.match(small[WORK_AGENTS_FILENAME], /## Prior turns/);
    assert.match(small[WORK_AGENTS_FILENAME], /A: history/);
    const large = composeWorkspaceInstructionFiles({
      background: "x".repeat(WORK_AGENTS_INLINE_LIMIT + 1),
    });
    assert.ok(large[WORK_CONVERSATION_FILENAME]);
    assert.match(large[WORK_AGENTS_FILENAME], /conversation\.md/);
    assert.equal(large[WORK_AGENTS_FILENAME].includes("xxxx"), false);
    assert.equal(
      composeWorkspaceTaskEvidence({ current_line: "B: latest ticket" }),
      "<current>\nB: latest ticket\n</current>",
    );
    assert.equal(WORK_CONVERSATION_FILENAME, "conversation.md");
  });
});

function makeRecipe(id, match, trigger = { kind: "push", coalesce: true }) {
  return {
    id,
    org_id: "local-owner",
    name: id,
    match,
    trigger,
    executor_type: "exec",
    executor_config: {},
    can_write_back: false,
    include_context: false,
    enabled: true,
    created_at: "2026-08-25T00:00:00.000Z",
    updated_at: "2026-08-25T00:00:00.000Z",
  };
}
