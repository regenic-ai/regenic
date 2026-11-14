const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  PersonalSearchAnswerService,
  SEARCH_ANSWER_REDUCED_CITATION_MAX,
  mapWorkItemId,
  reduceFacts,
} = require("../dist/personal-search-answer.service");
const {
  MAP_REDUCE_BATCH_EVENTS,
  MAP_REDUCE_BATCH_EVIDENCE_CHARS,
  adaptiveMapBatchOffsets,
  mapBatchMessageLine,
} = require("../dist/personal-conversation-context.service");

const MESSAGE_COUNT = 2_000;
const QUERY = "How many unique support tickets were reported?";

describe("aggregate scale regression gate", () => {
  it("keeps a 2,000-message authorized scope inside every adaptive batch budget", () => {
    const scenario = scaleScenario();

    assert.equal(scenario.messages.length, MESSAGE_COUNT);
    assert.ok(
      scenario.offsets.length - 1 >= MESSAGE_COUNT / MAP_REDUCE_BATCH_EVENTS,
      "the scope must span many adaptive batches",
    );
    assert.ok(
      scenario.offsets.some((offset, index) =>
        index > 0
        && index < scenario.offsets.length - 1
        && offset - scenario.offsets[index - 1] < MAP_REDUCE_BATCH_EVENTS),
      "long messages must force at least one character-limited batch",
    );

    for (let batch = 0; batch < scenario.offsets.length - 1; batch += 1) {
      const start = scenario.offsets[batch];
      const end = scenario.offsets[batch + 1];
      const prompt = renderEvidence(
        scenario.messages.slice(start, end),
        QUERY,
      );
      assert.ok(end - start <= MAP_REDUCE_BATCH_EVENTS);
      assert.ok(
        prompt.length <= MAP_REDUCE_BATCH_EVIDENCE_CHARS,
        `batch ${batch} emitted ${prompt.length} characters`,
      );
    }
  });

  it("retries, reconstructs, and deterministically reduces the scale scenario", async () => {
    const scenario = scaleScenario();
    const harness = scaleHarness(scenario);
    let service = harness.service();

    const firstAttempt = await service.get("scale-answer");
    assert.deepEqual(firstAttempt.progress, {
      phase: "mapping",
      completed_batches: 0,
      total_batches: scenario.offsets.length - 1,
      processed_messages: 0,
      total_messages: MESSAGE_COUNT,
      current_attempt: 1,
      max_attempts: 2,
    });

    harness.completeCurrent("not valid json");
    const retry = await service.get("scale-answer");
    assert.equal(retry.progress.current_attempt, 2);
    assert.equal(retry.progress.completed_batches, 0);
    assert.equal(
      retry.work_item_id,
      mapWorkItemId("scale-answer", 0, 1),
    );

    harness.completeCurrent(mapOutput(0));
    harness.failNextStart = true;
    await assert.rejects(service.get("scale-answer"), /simulated API restart/);
    assert.equal(harness.record.scope.map_reduce.completed_batches, 1);
    assert.equal(harness.record.scope.map_reduce.batch_attempt, 0);

    const persisted = structuredClone(harness.record);
    harness.reconstruct(persisted);
    service = harness.service();
    const resumed = await service.get("scale-answer");
    assert.equal(resumed.progress.current_attempt, 1);
    assert.equal(resumed.progress.completed_batches, 1);
    assert.equal(
      resumed.progress.processed_messages,
      scenario.offsets[1],
    );
    assert.deepEqual(
      harness.evidenceCalls.at(-1).eventIds,
      scenario.eventIds.slice(scenario.offsets[1], scenario.offsets[2]),
      "restart must resume from persisted adaptive boundaries",
    );

    const totalBatches = scenario.offsets.length - 1;
    for (let batch = 1; batch < totalBatches; batch += 1) {
      harness.completeCurrent(mapOutput(batch));
      const result = await service.get("scale-answer");
      assert.equal(result.progress.completed_batches, batch + 1);
      assert.equal(
        result.progress.processed_messages,
        scenario.offsets[batch + 1],
      );
    }

    assert.equal(harness.record.scope.complete, false);
    assert.equal(harness.record.scope.incomplete_reason, "fact_conflict");
    assert.equal(harness.record.scope.conflict_count, 1);
    const publicResult = harness.lastResult;
    assert.equal(publicResult.scope.conflict_count, 1);
    assert.equal(publicResult.progress.conflict_count, 1);
    assert.equal(publicResult.progress.phase, "reducing");
    assert.doesNotMatch(
      JSON.stringify(publicResult),
      /map_reduce|batch_offsets|facts|dedupe_key|ticket 42|conflict 7/i,
    );

    const retryIds = harness.prepared
      .map((input) => input.id)
      .filter((id) => id.startsWith("search-answer-map:scale-answer:0:"));
    assert.deepEqual(retryIds.filter((id) => id.endsWith(":1")), [
      mapWorkItemId("scale-answer", 0, 1),
    ]);
    assert.equal(retryIds.some((id) => id.endsWith(":2")), false);

    const reduced = reduceFacts(
      harness.record.scope.map_reduce.facts,
      scenario.eventIds,
    );
    const shuffled = reduceFacts(
      deterministicShuffle(harness.record.scope.map_reduce.facts),
      scenario.eventIds,
    );
    assert.deepEqual(Buffer.from(shuffled), Buffer.from(reduced));
    assert.match(reduced, /metric="ticket" total=1 /);
    assert.doesNotMatch(reduced, /conflict/i);

    const citations = reduced.match(/\[\d+\]/g) ?? [];
    assert.equal(citations.length, SEARCH_ANSWER_REDUCED_CITATION_MAX);
    assert.match(
      reduced,
      new RegExp(
        `\\+${totalBatches - SEARCH_ANSWER_REDUCED_CITATION_MAX} additional evidence$`,
      ),
    );
    assert.match(
      harness.reduceEvidence,
      new RegExp(escapeRegExp(reduced)),
    );

    assert.ok(harness.evidenceCalls.length >= totalBatches + 1);
    for (const call of harness.evidenceCalls) {
      assert.ok(call.eventIds.length <= MAP_REDUCE_BATCH_EVENTS);
      assert.ok(call.prompt.length <= MAP_REDUCE_BATCH_EVIDENCE_CHARS);
      assert.ok(call.eventIds.every((id) => scenario.authorized.has(id)));
    }
  });
});

function scaleScenario() {
  const messages = Array.from({ length: MESSAGE_COUNT }, (_, index) => ({
    occurred_at: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
    source: index % 3 === 0 ? "support-email" : "support-chat",
    text: index % 3 === 0
      ? `Ticket narrative ${index}: ${"context ".repeat(620)}`
      : `Ticket update ${index}: customer confirmed the current status.`,
    ...(index % 97 === 0
      ? {
          attachments: [{
            media_type: "application/pdf",
            filename: `case-${index}.pdf`,
          }],
        }
      : {}),
  }));
  const eventIds = messages.map((_, index) =>
    `authorized-event-${String(index).padStart(4, "0")}`);
  return {
    messages,
    eventIds,
    authorized: new Set(eventIds),
    offsets: adaptiveMapBatchOffsets(messages, QUERY),
  };
}

function renderEvidence(messages, query) {
  return [
    "QUESTION",
    query,
    "",
    "BATCH MESSAGES",
    ...messages.map((message, index) => mapBatchMessageLine(message, index)),
  ].join("\n");
}

function mapOutput(batch) {
  const facts = [{
    dedupe_key: batch % 2 === 0 ? " Ticket  42 " : "ＴＩＣＫＥＴ 42",
    group: "support",
    metric: "ticket",
    value: 1,
    evidence_refs: [1],
  }];
  if (batch < 2) {
    facts.push({
      dedupe_key: batch === 0 ? " Conflict  7 " : "ＣＯＮＦＬＩＣＴ 7",
      group: "support",
      metric: "ticket",
      value: batch + 1,
      evidence_refs: [2],
    });
  }
  return JSON.stringify(facts);
}

function scaleHarness(scenario) {
  const states = new Map();
  const prepared = [];
  const evidenceCalls = [];
  let record = {
    id: "scale-answer",
    org_id: "org-1",
    work_item_id: mapWorkItemId("scale-answer", 0, 0),
    query: QUERY,
    event_ids: scenario.eventIds,
    scope: {
      intent: "aggregate",
      complete: true,
      total_count: MESSAGE_COUNT,
      included_count: MESSAGE_COUNT,
      omitted_count: 0,
      map_reduce: {
        strategy: "map_reduce",
        phase: "mapping",
        snapshot_id: "authorized-snapshot",
        batch_offsets: scenario.offsets,
        total_batches: scenario.offsets.length - 1,
        completed_batches: 0,
        batch_attempt: 0,
        facts: [],
      },
    },
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
  states.set(record.work_item_id, executionState(run("running"), "running"));

  const harness = {
    states,
    prepared,
    evidenceCalls,
    failNextStart: false,
    lastResult: undefined,
    reduceEvidence: "",
    get record() {
      return record;
    },
    completeCurrent(summary) {
      states.set(
        record.work_item_id,
        executionState(completedRun(summary), "done"),
      );
    },
    reconstruct(persisted) {
      record = structuredClone(persisted);
      states.set(record.work_item_id, executionState(undefined, "open"));
      harness.failNextStart = false;
    },
  };

  const authority = {
    getSearchAnswer: async () => structuredClone(record),
    putSearchAnswer: async (next) => {
      record = structuredClone(next);
      return structuredClone(record);
    },
  };
  const runtime = {
    orgId: () => "org-1",
    requireHost: () => ({ get: () => authority }),
  };
  const context = {
    mapBatchEvidence: async (snapshotId, eventIds, query) => {
      assert.equal(snapshotId, "authorized-snapshot");
      assert.ok(eventIds.every((id) => scenario.authorized.has(id)));
      const indexes = eventIds.map((id) => scenario.eventIds.indexOf(id));
      const prompt = renderEvidence(
        indexes.map((index) => scenario.messages[index]),
        query,
      );
      evidenceCalls.push({ eventIds: [...eventIds], prompt });
      return prompt;
    },
  };
  const work = {
    refreshAuxiliaryExecution: async (id) =>
      states.get(id) ?? executionState(undefined, "open"),
    prepareAuxiliaryExecution: async (input) => {
      prepared.push(input);
      if (!states.has(input.id)) {
        states.set(input.id, executionState(undefined, "open"));
      }
      return { work_item: { id: input.id }, recipe: {} };
    },
    startPreparedAuxiliaryExecution: async (value, evidence) => {
      if (harness.failNextStart) {
        harness.failNextStart = false;
        throw new Error("simulated API restart");
      }
      if (value.work_item.id === "search-answer:scale-answer") {
        harness.reduceEvidence = evidence;
      }
      const running = run("running");
      states.set(value.work_item.id, executionState(running, "running"));
      return { work_item: value.work_item, run: running };
    },
  };
  harness.service = () => {
    const service = new PersonalSearchAnswerService(runtime, context, {}, work);
    return {
      get: async (id) => {
        const result = await service.get(id);
        harness.lastResult = result;
        return result;
      },
    };
  };
  return harness;
}

function executionState(currentRun, status) {
  return { run: currentRun, work_item: { status } };
}

function completedRun(summary) {
  return {
    ...run("completed"),
    result: { summary },
  };
}

function run(status) {
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

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function deterministicShuffle(values) {
  const shuffled = [...values];
  let state = 0x5eed1234;
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    const target = state % (index + 1);
    [shuffled[index], shuffled[target]] = [shuffled[target], shuffled[index]];
  }
  return shuffled;
}
