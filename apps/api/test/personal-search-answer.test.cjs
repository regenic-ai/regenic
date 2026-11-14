const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  PersonalSearchAnswerService,
  SEARCH_ANSWER_REDUCED_CITATION_MAX,
  SEARCH_ANSWER_MAP_RETRY_PROMPT,
  mapWorkItemId,
  parseMapFacts,
  reduceFacts,
  reduceFactsWithDiagnostics,
  searchAnswerCitations,
  searchAnswerMapBatchRefs,
} = require("../dist/personal-search-answer.service");
const {
  searchAnswerIdFromWorkItem,
} = require("../dist/personal-system-work");
const {
  adaptiveMapBatchOffsets,
  mapBatchMessageLine,
} = require("../dist/personal-conversation-context.service");

describe("search answer citations", () => {
  it("prefers structured executor evidence and uses bracket refs as fallback", () => {
    assert.deepEqual(
      searchAnswerCitations(
        "Alice replied [1], Bob is unknown [2], and [9] is invalid.",
        ["event-1", "event-2", "event-3"],
        ["event-3", "event-outside", "event-1"],
      ),
      [
        { ref: 3, event_id: "event-3" },
        { ref: 1, event_id: "event-1" },
        { ref: 2, event_id: "event-2" },
      ],
    );
  });
});

describe("aggregate fact reduction", () => {
  it("canonicalizes superficial dedupe key variants", () => {
    const facts = parseMapFacts(
      JSON.stringify([
        {
          dedupe_key: "  ＴＩＣＫＥＴ　 42  ",
          group: "support",
          metric: "ticket",
          value: 1,
          evidence_refs: [1],
        },
      ]),
      ["event-1"],
    );

    assert.equal(facts[0].dedupe_key, "ticket 42");
  });

  it("merges identical duplicates and unions their citations", () => {
    const facts = [
      fact(" Ticket  42 ", "support", "ticket", 1, ["event-2"]),
      fact("ＴＩＣＫＥＴ 42", "support", "ticket", 1, ["event-1", "event-2"]),
    ];

    assert.equal(
      reduceFacts(facts, ["event-1", "event-2"]),
      '- group="support" metric="ticket" total=1 [1] [2]',
    );
  });

  it("excludes conflicting identities from totals and reports conflicts", () => {
    const reduced = reduceFactsWithDiagnostics([
      fact("ticket-1", "support", "ticket", 1, ["event-1"]),
      fact("TICKET-1", "support", "ticket", 2, ["event-2"]),
      fact("ticket-2", "support", "ticket", 1, ["event-3"]),
    ], ["event-1", "event-2", "event-3"]);

    assert.equal(reduced.conflict_count, 1);
    assert.equal(
      reduced.text,
      '- group="support" metric="ticket" total=1 [3]',
    );
  });

  it("is invariant to map batch and fact order", () => {
    const facts = [
      fact("b", "support", "status", "open", ["event-3"]),
      fact("a", "support", "ticket", 1, ["event-2"]),
      fact(" A ", "support", "ticket", 1, ["event-1"]),
      fact("c", "accounts", "ticket", 2, ["event-4"]),
    ];
    const refs = ["event-1", "event-2", "event-3", "event-4"];

    assert.equal(
      reduceFacts(facts, refs),
      reduceFacts(facts.toReversed(), refs),
    );
  });

  it("rejects non-finite, unsafe, and blank map values", () => {
    const entry = (value) => JSON.stringify([{
      dedupe_key: "ticket-1",
      group: "support",
      metric: "ticket",
      value,
      evidence_refs: [1],
    }]);

    assert.throws(
      () => parseMapFacts(entry(Number.MAX_SAFE_INTEGER + 1), ["event-1"]),
      /Invalid fact/,
    );
    assert.throws(
      () => parseMapFacts(entry(" \t "), ["event-1"]),
      /Invalid fact/,
    );
    assert.throws(
      () => parseMapFacts(entry(1).replace('"value":1', '"value":1e309'), ["event-1"]),
      /Invalid fact/,
    );
    assert.equal(parseMapFacts(entry(1.5), ["event-1"])[0].value, 1.5);
  });

  it("bounds citations and reports omitted evidence accurately", () => {
    const eventIds = Array.from(
      { length: SEARCH_ANSWER_REDUCED_CITATION_MAX + 3 },
      (_, index) => `event-${index + 1}`,
    );
    const reduced = reduceFacts([
      fact("ticket-1", "support", "ticket", 1, eventIds),
    ], eventIds);

    assert.match(
      reduced,
      new RegExp(`\\[${SEARCH_ANSWER_REDUCED_CITATION_MAX}\\]`),
    );
    assert.doesNotMatch(
      reduced,
      new RegExp(`\\[${SEARCH_ANSWER_REDUCED_CITATION_MAX + 1}\\]`),
    );
    assert.match(reduced, /additional_evidence=3$/);
  });
});

describe("adaptive aggregate map batches", () => {
  it("splits on rendered evidence characters before 100 messages", () => {
    const messages = Array.from({ length: 70 }, (_, index) => ({
      occurred_at: "2026-08-30T00:00:00.000Z",
      source: "synthetic-chat",
      text: `${index}-${"x".repeat(3_995)}`,
      ...(index === 0
        ? { attachments: [{ media_type: "application/pdf", filename: "brief.pdf" }] }
        : {}),
    }));
    const offsets = adaptiveMapBatchOffsets(messages);
    assert.ok(offsets[1] < 100);
    assert.ok(offsets.length > 2);
    for (let batch = 0; batch < offsets.length - 1; batch += 1) {
      const evidence = messages
        .slice(offsets[batch], offsets[batch + 1])
        .map((message, index) => mapBatchMessageLine(message, index))
        .join("\n");
      assert.ok(evidence.length <= 120_000);
      assert.ok(offsets[batch + 1] - offsets[batch] <= 100);
    }
    assert.match(mapBatchMessageLine(messages[0], 0), /\[attachment: brief\.pdf\]/);
  });

  it("uses persisted offsets when slicing a resumed batch", () => {
    const eventIds = Array.from({ length: 150 }, (_, index) => `event-${index}`);
    const map = {
      strategy: "map_reduce",
      phase: "mapping",
      snapshot_id: "snapshot-1",
      batch_offsets: [0, 37, 91, 150],
      total_batches: 3,
      completed_batches: 1,
      facts: [],
    };
    assert.deepEqual(
      searchAnswerMapBatchRefs(eventIds, map, map.completed_batches),
      eventIds.slice(37, 91),
    );
  });
});

describe("aggregate map retry", () => {
  it("persists and exposes conflict diagnostics before reducing", async () => {
    const harness = retryHarness(completedRun(JSON.stringify([
      {
        dedupe_key: "ticket-1",
        group: "support",
        metric: "ticket",
        value: 1,
        evidence_refs: [1],
      },
      {
        dedupe_key: " TICKET-1 ",
        group: "support",
        metric: "ticket",
        value: 2,
        evidence_refs: [1],
      },
    ])));

    const result = await harness.service().get("answer-1");

    assert.equal(harness.record.scope.complete, false);
    assert.equal(harness.record.scope.incomplete_reason, "fact_conflict");
    assert.equal(harness.record.scope.conflict_count, 1);
    assert.equal(result.scope.conflict_count, 1);
    assert.equal(result.progress.conflict_count, 1);
  });

  it("retries invalid output once and then reduces successful facts", async () => {
    const harness = retryHarness(completedRun("not json"));

    const retry = await harness.service().get("answer-1");
    assert.equal(retry.status, "running");
    assert.equal(harness.record.scope.map_reduce.batch_attempt, 1);
    assert.equal(
      harness.record.work_item_id,
      mapWorkItemId("answer-1", 0, 1),
    );
    assert.equal(harness.prepared.at(-1).prompt, SEARCH_ANSWER_MAP_RETRY_PROMPT);
    assert.doesNotMatch(harness.prepared.at(-1).prompt, /not json/);

    harness.states.set(
      harness.record.work_item_id,
      executionState(completedRun(
        '[{"dedupe_key":"ticket-1","group":"support","metric":"ticket","value":1,"evidence_refs":[1]}]',
      ), "done"),
    );
    await harness.service().get("answer-1");

    assert.equal(harness.record.scope.map_reduce.phase, "reducing");
    assert.equal(harness.record.scope.map_reduce.facts.length, 1);
    assert.deepEqual(
      harness.record.scope.map_reduce.facts[0].event_ids,
      ["event-1"],
    );
  });

  it("retries an executor failure once", async () => {
    const harness = retryHarness(runWithStatus("failed"));

    await harness.service().get("answer-1");
    harness.states.set(
      harness.record.work_item_id,
      executionState(completedRun("[]"), "done"),
    );
    await harness.service().get("answer-1");

    assert.equal(harness.record.scope.map_reduce.phase, "reducing");
    assert.equal(
      harness.prepared.filter((input) => input.purpose === "search-answer-map").length,
      1,
    );
  });

  it("fails closed after the retry is exhausted", async () => {
    const harness = retryHarness(completedRun("invalid"), { attempt: 1 });

    const result = await harness.service().get("answer-1");

    assert.equal(result.status, "failed");
    assert.equal(result.scope.incomplete_reason, "map_failed");
    assert.equal(harness.prepared.length, 0);
  });

  it("keeps cancellation and timeout terminal without retrying", async () => {
    const cancelled = retryHarness(runWithStatus("cancelled"), {
      itemStatus: "skipped",
    });
    assert.equal((await cancelled.service().get("answer-1")).status, "cancelled");
    assert.equal(cancelled.prepared.length, 0);

    const timedOut = retryHarness(runWithStatus("failed"), {
      outcome: "timed_out",
    });
    assert.equal((await timedOut.service().get("answer-1")).status, "timed_out");
    assert.equal(timedOut.prepared.length, 0);
  });

  it("resumes the persisted retry attempt after an API restart", async () => {
    const harness = retryHarness(runWithStatus("failed"));
    harness.startError = new Error("executor unavailable");

    await assert.rejects(harness.service().get("answer-1"), /executor unavailable/);
    const retryId = harness.record.work_item_id;
    assert.equal(harness.record.scope.map_reduce.batch_attempt, 1);

    harness.startError = undefined;
    harness.states.set(retryId, executionState(undefined, "open"));
    const resumed = await harness.service().get("answer-1");

    assert.equal(resumed.status, "running");
    assert.equal(harness.record.work_item_id, retryId);
    assert.equal(harness.record.scope.map_reduce.batch_attempt, 1);
    assert.equal(harness.started.at(-1).work_item.id, retryId);
    assert.equal(harness.prepared.at(-1).prompt, SEARCH_ANSWER_MAP_RETRY_PROMPT);
  });

  it("surfaces snapshot authorization changes instead of starting a retry", async () => {
    const harness = retryHarness(runWithStatus("failed"));
    const error = Object.assign(new Error("Snapshot changed"), {
      code: "context_changed",
    });
    harness.contextError = error;

    await assert.rejects(harness.service().get("answer-1"), error);
    assert.equal(harness.record.scope.map_reduce.batch_attempt, 0);
    assert.equal(harness.prepared.length, 0);
  });

  it("keeps retry work item IDs attributable to the original answer", () => {
    assert.equal(
      searchAnswerIdFromWorkItem(mapWorkItemId("answer-1", 4, 1)),
      "answer-1",
    );
  });
});

function fact(dedupeKey, group, metric, value, eventIds) {
  return {
    dedupe_key: dedupeKey,
    group,
    metric,
    value,
    event_ids: eventIds,
  };
}

function retryHarness(initialRun, options = {}) {
  const states = new Map();
  const prepared = [];
  const started = [];
  const initialAttempt = options.attempt ?? 0;
  const harness = {
    record: {
      id: "answer-1",
      org_id: "org-1",
      work_item_id: mapWorkItemId("answer-1", 0, initialAttempt),
      query: "How many tickets?",
      event_ids: ["event-1"],
      scope: {
        intent: "aggregate",
        complete: true,
        total_count: 1,
        included_count: 1,
        omitted_count: 0,
        map_reduce: {
          strategy: "map_reduce",
          phase: "mapping",
          snapshot_id: "snapshot-1",
          batch_offsets: [0, 1],
          total_batches: 1,
          completed_batches: 0,
          batch_attempt: initialAttempt,
          facts: [],
        },
      },
      ...(options.outcome ? { outcome: options.outcome } : {}),
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    },
    states,
    prepared,
    started,
    startError: undefined,
    contextError: undefined,
  };
  states.set(
    harness.record.work_item_id,
    executionState(initialRun, options.itemStatus ?? "failed"),
  );
  const authority = {
    getSearchAnswer: async () => harness.record,
    putSearchAnswer: async (record) => {
      harness.record = record;
      return record;
    },
  };
  const runtime = {
    orgId: () => "org-1",
    requireHost: () => ({ get: () => authority }),
  };
  const context = {
    mapBatchEvidence: async () => {
      if (harness.contextError) throw harness.contextError;
      return "QUESTION\nHow many tickets?\n\nBATCH MESSAGES\n[1] ticket";
    },
  };
  const work = {
    refreshAuxiliaryExecution: async (id) =>
      states.get(id) ?? executionState(undefined, "open"),
    prepareAuxiliaryExecution: async (input) => {
      prepared.push(input);
      const value = { work_item: { id: input.id }, recipe: {} };
      if (!states.has(input.id)) {
        states.set(input.id, executionState(undefined, "open"));
      }
      return value;
    },
    startPreparedAuxiliaryExecution: async (value) => {
      started.push(value);
      if (harness.startError) throw harness.startError;
      const run = runWithStatus("running");
      states.set(value.work_item.id, executionState(run, "running"));
      return { work_item: value.work_item, run };
    },
  };
  harness.service = () =>
    new PersonalSearchAnswerService(runtime, context, {}, work);
  return harness;
}

function executionState(run, status) {
  return { run, work_item: { status } };
}

function completedRun(summary) {
  return {
    ...runWithStatus("completed"),
    result: { summary },
  };
}

function runWithStatus(status) {
  return {
    id: `run-${status}`,
    org_id: "org-1",
    work_item_id: "work-1",
    recipe_id: "recipe-1",
    executor_type: "executor-1",
    status,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}
