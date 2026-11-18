const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { describe, it } = require("node:test");
const {
  PersonalSearchAnswerService,
  SEARCH_ANSWER_REDUCED_CITATION_MAX,
  SEARCH_ANSWER_MAP_RETRY_PROMPT,
  SEARCH_ANSWER_PLANNER_RETRY_PROMPT,
  mapWorkItemId,
  parseAggregatePlan,
  parseMapFacts,
  planWorkItemId,
  reduceFacts,
  reduceFactsWithDiagnostics,
  searchAnswerCitations,
  searchAnswerMapBatchRefs,
  searchAnswerProgress,
} = require("../dist/personal-search-answer.service");
const {
  searchAnswerIdFromWorkItem,
} = require("../dist/personal-system-work");
const {
  PersonalConversationContextService,
  adaptiveMapBatchOffsets,
  mapBatchMessageLine,
} = require("../dist/personal-conversation-context.service");
const badCaseFixtures = require("./fixtures/typed-aggregate-bad-cases.cjs");

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

  describe("typed aggregate plans and facts", () => {
    const count = () => ({
      version: 1,
      operation: "count",
      metric: { id: "video_count", label: "Video count" },
      group_dimensions: [{ id: "month", label: "Month" }],
      subject: { terms: ["hollyland"], constraints: [] },
      value_type: "count",
      dedupe_strategy: "event_id",
    });

    it("parses only strict JSON plans", () => {
      assert.equal(parseAggregatePlan(JSON.stringify(count())).metric.id, "video_count");
      assert.throws(
        () => parseAggregatePlan(`\`\`\`json\n${JSON.stringify(count())}\n\`\`\``),
        /Invalid aggregate plan/,
      );
      assert.throws(
        () => parseAggregatePlan(JSON.stringify({ ...count(), raw_prompt: "no" })),
        /unknown field/,
      );
    });

    it("rejects wrong metrics, values and categories", () => {
      const output = (metric, value) => JSON.stringify([{
        dedupe_key: "event_id:model-value-is-ignored",
        group: "2026-10",
        metric,
        value,
        evidence_refs: [1],
      }]);
      assert.throws(
        () => parseMapFacts(output("other", 1), ["event-1"], count()),
        /metric/,
      );
      assert.throws(
        () => parseMapFacts(output("video_count", 2), ["event-1"], count()),
        /atomic/,
      );
      const status = {
        ...count(),
        operation: "status_summary",
        value_type: "category",
        metric: { id: "task_status", label: "Task status" },
        allowed_categories: [
          { id: "done", label: "Done" },
          { id: "open", label: "Open" },
        ],
      };
      assert.throws(
        () => parseMapFacts(output("task_status", "blocked"), ["event-1"], status),
        /not allowed/,
      );
      assert.throws(
        () => parseMapFacts(JSON.stringify([{
          dedupe_key: "event_id:joined",
          group: "g",
          metric: "video_count",
          value: 1,
          evidence_refs: [1, 2],
        }]), ["event-1", "event-2"], count()),
        /Invalid fact/,
      );
    });

    it("uses deterministic event IDs and operation-specific stable reduction", () => {
      const parsed = parseMapFacts(JSON.stringify([{
        dedupe_key: "event_id:untrusted",
        group: "2026-10",
        metric: "video_count",
        value: 1,
        evidence_refs: [1],
      }]), ["event-1"], count());
      assert.equal(parsed[0].dedupe_key, "event_id:event-1");
      assert.equal(
        reduceFacts(parsed, ["event-1"], count()),
        '- group="2026-10" metric="video_count" total=1 [1]',
      );

      const list = {
        ...count(),
        operation: "list",
        value_type: "category",
        metric: { id: "customer", label: "Customer" },
        dedupe_strategy: "business_id",
      };
      const listFacts = [
        fact("business_id:customer-2", "unreplied", "customer", "Beta", ["e2"]),
        fact("business_id:customer-1", "unreplied", "customer", "Acme", ["e1"]),
      ];
      const reduced = reduceFacts(listFacts, ["e1", "e2"], list);
      assert.equal(
        reduced,
        '- group="unreplied" metric="customer" item="Acme" [1]\n'
          + '- group="unreplied" metric="customer" item="Beta" [2]',
      );
      assert.equal(
        Buffer.compare(
          Buffer.from(reduced),
          Buffer.from(reduceFacts(listFacts.toReversed(), ["e1", "e2"], list)),
        ),
        0,
      );

      const status = {
        ...count(),
        operation: "status_summary",
        value_type: "category",
        metric: { id: "task_status", label: "Task status" },
        allowed_categories: [
          { id: "done", label: "Done" },
          { id: "open", label: "Open" },
        ],
      };
      assert.equal(
        reduceFacts([
          fact("event_id:e1", "alice", "task_status", "done", ["e1"]),
          fact("event_id:e2", "alice", "task_status", "open", ["e2"]),
        ], ["e1", "e2"], status),
        '- group="alice" metric="task_status" category="done" total=1 [1]\n'
          + '- group="alice" metric="task_status" category="open" total=1 [2]',
      );
    });

    it("forms bounded keys for every dedupe strategy", () => {
      const output = (key) => JSON.stringify([{
        dedupe_key: key,
        group: "g",
        metric: "customer",
        value: "Acme",
        evidence_refs: [1],
      }]);
      for (const [strategy, key, expected, metadata] of [
        ["business_id", "business_id: ACME  42", "business_id:acme 42",
          [{ event_id: "e1", business_id: "acme 42" }]],
        ["external_id", "external_id: EXT-42", "external_id:ext-42",
          [{ event_id: "e1", external_id: "ext-42" }]],
        ["url", "url:https://example.com/a#fragment", "url:https://example.com/a",
          [{ event_id: "e1", url: "https://example.com/a" }]],
        ["text_signature", "text_signature: Customer ACME", /^text_signature:[a-f0-9]{64}$/,
          undefined],
      ]) {
        const spec = {
          ...count(),
          operation: "list",
          value_type: "category",
          metric: { id: "customer", label: "Customer" },
          dedupe_strategy: strategy,
        };
        const actual = parseMapFacts(output(key), ["e1"], spec, metadata)[0].dedupe_key;
        expected instanceof RegExp
          ? assert.match(actual, expected)
          : assert.equal(actual, expected);
      }
    });

    it("closes the four aggregate bad-case fixtures end to end", () => {
      for (const fixture of badCaseFixtures) {
        const spec = parseAggregatePlan(JSON.stringify(fixture.spec));
        const facts = parseMapFacts(
          JSON.stringify(fixture.facts),
          fixture.refs,
          spec,
          fixture.metadata,
        );
        assert.match(
          reduceFacts(facts, fixture.refs, spec),
          fixture.expected,
          fixture.name,
        );
      }
    });
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
    assert.match(reduced, /\+3 additional evidence$/);
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

  describe("aggregate cache manifest validation", () => {
    it("fails closed when cached evidence bytes are missing or corrupt", async () => {
      const bytes = Buffer.from("authorized evidence");
      const hash = createHash("sha256").update(bytes).digest("hex");
      let stored = bytes;
      const service = new PersonalConversationContextService({
        requireHost: () => ({
          get: (name) => name === "blobs"
            ? { getMany: async () => new Map([[hash, stored]]) }
            : { findBlobs: async () => new Map([[hash, {}]]) },
        }),
      });

      await service.validateMapManifest([{ event_id: "e1", content_hash: hash }]);
      stored = Buffer.from("corrupt evidence");
      await assert.rejects(
        service.validateMapManifest([{ event_id: "e1", content_hash: hash }]),
        (error) => error.code === "context_changed",
      );
    });
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

  it("serializes adaptive progress without private map state", async () => {
    const eventIds = Array.from({ length: 10 }, (_, index) => `event-${index}`);
    const harness = retryHarness(runWithStatus("running"), {
      eventIds,
      batchOffsets: [0, 3, 8, 10],
      completedBatches: 1,
      attempt: 1,
    });

    const result = await harness.service().get("answer-1");

    assert.deepEqual(result.progress, {
      phase: "mapping",
      completed_batches: 1,
      total_batches: 3,
      processed_messages: 3,
      total_messages: 10,
      current_attempt: 2,
      max_attempts: 2,
      active_batches: 2,
      pending_batches: 0,
      retrying_batches: 1,
      max_parallelism: 3,
    });
    const serialized = JSON.stringify(result);
    for (const privateField of [
      "map_reduce",
      "batch_offsets",
      "snapshot_id",
      "facts",
      "dedupe_key",
    ]) {
      assert.doesNotMatch(serialized, new RegExp(privateField));
    }
    assert.equal(result.work_item_id, "search-answer:answer-1");
  });

  it("reports all authorized messages during reduction and bounds conflicts", () => {
    const eventIds = Array.from({ length: 10 }, (_, index) => `event-${index}`);
    const progress = searchAnswerProgress({
      id: "answer-1",
      org_id: "org-1",
      work_item_id: "search-answer:answer-1",
      query: "How many?",
      event_ids: eventIds,
      scope: {
        intent: "aggregate",
        complete: false,
        total_count: 10,
        included_count: 10,
        omitted_count: 0,
        conflict_count: 50_000,
        map_reduce: {
          strategy: "map_reduce",
          phase: "reducing",
          snapshot_id: "private",
          batch_offsets: [0, 3, 8, 10],
          total_batches: 3,
          completed_batches: 3,
          batch_attempt: 0,
          facts: [],
        },
      },
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    });

    assert.deepEqual(progress, {
      phase: "reducing",
      completed_batches: 3,
      total_batches: 3,
      processed_messages: 10,
      total_messages: 10,
      current_attempt: 1,
      max_attempts: 1,
      active_batches: 1,
      pending_batches: 0,
      retrying_batches: 0,
      max_parallelism: 1,
      conflict_count: 2_000,
    });
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
    assert.equal(harness.record.scope.map_reduce.batches[0].attempt, 1);
    assert.equal(
      harness.record.scope.map_reduce.batches[0].work_item_id,
      mapWorkItemId("answer-1", 0, 1),
    );
    assert.equal(harness.prepared.at(-1).prompt, SEARCH_ANSWER_MAP_RETRY_PROMPT);
    assert.doesNotMatch(harness.prepared.at(-1).prompt, /not json/);

    harness.states.set(
      harness.record.scope.map_reduce.batches[0].work_item_id,
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
      harness.record.scope.map_reduce.batches[0].work_item_id,
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
    const retryId = harness.record.scope.map_reduce.batches[0].work_item_id;
    assert.equal(harness.record.scope.map_reduce.batches[0].attempt, 1);

    harness.startError = undefined;
    harness.states.set(retryId, executionState(undefined, "open"));
    const resumed = await harness.service().get("answer-1");

    assert.equal(resumed.status, "running");
    assert.equal(harness.record.scope.map_reduce.batches[0].work_item_id, retryId);
    assert.equal(harness.record.scope.map_reduce.batches[0].attempt, 1);
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
    assert.equal(harness.record.scope.map_reduce.batches[0].attempt, 1);
    assert.equal(harness.prepared.length, 0);
  });

  it("normalizes serial state without losing completed facts or boundaries", async () => {
    const legacyFact = fact("legacy-1", "support", "ticket", 1, ["event-1"]);
    const harness = retryHarness(runWithStatus("running"), {
      eventIds: ["event-1", "event-2", "event-3", "event-4"],
      batchOffsets: [0, 1, 3, 4],
      completedBatches: 1,
      legacyFacts: [legacyFact],
    });

    await harness.service().get("answer-1");

    const map = harness.record.scope.map_reduce;
    assert.deepEqual(
      map.batches.map(({ index, start_offset, end_offset }) => ({
        index,
        start_offset,
        end_offset,
      })),
      [
        { index: 0, start_offset: 0, end_offset: 1 },
        { index: 1, start_offset: 1, end_offset: 3 },
        { index: 2, start_offset: 3, end_offset: 4 },
      ],
    );
    assert.deepEqual(map.batches[0].facts, [legacyFact]);
    assert.deepEqual(map.facts, [legacyFact]);
  });

  it("cancels every active batch and keeps cancellation terminal", async () => {
    const harness = retryHarness(runWithStatus("running"), {
      eventIds: ["e1", "e2", "e3", "e4"],
      batchOffsets: [0, 1, 2, 3, 4],
    });
    const service = harness.service();
    await service.get("answer-1");
    const activeIds = harness.record.scope.map_reduce.batches
      .filter((batch) => batch.status === "running")
      .map((batch) => batch.work_item_id);
    harness.cancelErrorIds.add(activeIds[0]);

    await assert.rejects(service.cancel("answer-1"), /cancel failed/);
    assert.deepEqual(new Set(harness.cancelledIds), new Set(activeIds));
    assert.equal(harness.record.outcome, "cancelled");
    harness.cancelErrorIds.clear();
    const terminal = await service.get("answer-1");
    assert.equal(terminal.status, "cancelled");
    assert.equal(harness.cancelledIds.length, activeIds.length);
  });

  it("uses the original creation deadline and cancels legacy active work once", async () => {
    const harness = retryHarness(runWithStatus("running"), {
      createdAt: "2020-01-01T00:00:00.000Z",
    });
    const service = harness.service();

    const timedOut = await service.get("answer-1");
    assert.equal(timedOut.status, "timed_out");
    assert.equal(harness.record.outcome, "timed_out");
    assert.deepEqual(harness.cancelledIds, [mapWorkItemId("answer-1", 0, 0)]);
    await service.get("answer-1");
    assert.equal(harness.cancelledIds.length, 1);
    assert.equal(harness.prepared.length, 0);
  });

  it("times out and cancels every active parallel batch without refilling", async () => {
    const harness = retryHarness(runWithStatus("running"), {
      eventIds: ["e1", "e2", "e3"],
      batchOffsets: [0, 1, 2, 3],
      createdAt: "2020-01-01T00:00:00.000Z",
    });
    const map = harness.record.scope.map_reduce;
    map.batches = [0, 1, 2].map((index) => ({
      index,
      start_offset: index,
      end_offset: index + 1,
      status: "running",
      attempt: 0,
      work_item_id: mapWorkItemId("answer-1", index, 0),
    }));
    for (const batch of map.batches) {
      harness.states.set(
        batch.work_item_id,
        executionState(runWithStatus("running"), "running"),
      );
    }

    const result = await harness.service().get("answer-1");

    assert.equal(result.status, "timed_out");
    assert.deepEqual(
      new Set(harness.cancelledIds),
      new Set(map.batches.map((batch) => batch.work_item_id)),
    );
    assert.equal(harness.prepared.length, 0);
  });

  it("keeps retry work item IDs attributable to the original answer", () => {
    assert.equal(
      searchAnswerIdFromWorkItem(mapWorkItemId("answer-1", 4, 1)),
      "answer-1",
    );
    assert.equal(
      searchAnswerIdFromWorkItem(planWorkItemId("answer-1", 1)),
      "answer-1",
    );
  });
});

describe("persistent aggregate planning", () => {
  const validPlan = JSON.stringify({
    version: 1,
    operation: "count",
    metric: { id: "task_count", label: "Task count" },
    group_dimensions: [{ id: "person", label: "Person" }],
    subject: { terms: ["task"], constraints: [] },
    value_type: "count",
    dedupe_strategy: "event_id",
  });

  it("persists a validated hash before opening at most three map batches", async () => {
    const harness = planningHarness(completedRun(validPlan));
    const result = await harness.service().get("answer-plan");

    assert.equal(harness.record.scope.map_reduce.phase, "mapping");
    assert.match(harness.record.scope.spec_hash, /^[a-f0-9]{64}$/);
    assert.equal(harness.record.scope.plan.metric.id, "task_count");
    assert.equal(result.progress.active_batches, 3);
    assert.equal(result.progress.pending_batches, 1);
    assert.equal(harness.started.filter((id) => id.startsWith("search-answer-map:")).length, 3);
    assert.equal(harness.bodyReads, 1);
    assert.deepEqual(
      harness.record.scope.map_reduce.batches.slice(0, 3)
        .map((batch) => batch.map_inputs.map((input) => input.event_id)),
      [["e1"], ["e2"], ["e3"]],
    );
    const serialized = JSON.stringify(result);
    assert.doesNotMatch(serialized, /subject|snapshot_id|facts|work_item_id.*search-answer-map/);
  });

  it("reuses content-addressed event facts without starting map runs", async () => {
    const harness = planningHarness(completedRun(validPlan), {
      cached: true,
    });
    const result = await harness.service().get("answer-plan");

    assert.equal(result.progress.cache_hits, 4);
    assert.equal(result.progress.cache_misses, 0);
    assert.equal(result.progress.completed_batches, 4);
    assert.equal(
      harness.started.filter((id) => id.startsWith("search-answer-map:")).length,
      0,
    );
    assert.equal(harness.manifestReads, 1);
    assert.equal(harness.bodyReads, 0);
    assert.deepEqual(harness.validated, ["e1", "e2", "e3", "e4"]);
    assert.equal(harness.record.scope.map_reduce.cache_manifest.version, 1);
    assert.deepEqual(harness.cacheVersions, ["typed-event-v1:dsh"]);
  });

  it("does not reuse an empty or expired fact list", async () => {
    const empty = planningHarness(completedRun(validPlan), {
      cached: true,
      emptyEventId: "e4",
    });
    const emptyResult = await empty.service().get("answer-plan");
    assert.equal(emptyResult.progress.cache_hits, 3);
    assert.equal(emptyResult.progress.cache_misses, 1);

    const expired = planningHarness(completedRun(validPlan), {
      cached: true,
      cacheUpdatedAt: "2020-01-01T00:00:00.000Z",
    });
    const expiredResult = await expired.service().get("answer-plan");
    assert.equal(expiredResult.progress.cache_hits, 0);
    assert.equal(expiredResult.progress.cache_misses, 4);
  });

  it("recomputes legacy routing and cancels a running cached batch", async () => {
    const harness = planningHarness(completedRun(validPlan), { cached: true });
    await harness.service().get("answer-plan");
    const batch = harness.record.scope.map_reduce.batches[0];
    batch.status = "running";
    batch.work_item_id = "orphan-map";
    delete harness.record.scope.map_reduce.cache_manifest;
    await harness.service().get("answer-plan");

    assert.equal(harness.manifestReads, 2);
    assert.deepEqual(harness.cancelled, ["orphan-map"]);
    assert.equal(batch.status, "completed");
    assert.equal(batch.work_item_id, undefined);
  });

  it("keeps a running batch's original routing when cancellation fails", async () => {
    const harness = planningHarness(completedRun(validPlan), {
      cached: true,
      cancelError: new Error("executor unavailable"),
    });
    const batch = harness.record.scope.map_reduce.batches[0];
    batch.status = "running";
    batch.work_item_id = "legacy-map";

    const result = await harness.service().get("answer-plan");

    assert.deepEqual(harness.cancelled, ["legacy-map"]);
    assert.equal(batch.status, "running");
    assert.equal(batch.work_item_id, "legacy-map");
    assert.equal(batch.map_event_ids, undefined);
    assert.equal(harness.record.scope.map_reduce.cache_manifest, undefined);
    assert.equal(result.progress.active_batches, 1);
  });

  it("treats a changed content hash as a cache miss", async () => {
    const harness = planningHarness(completedRun(validPlan), {
      cached: true,
      staleEventId: "e1",
    });
    const result = await harness.service().get("answer-plan");

    assert.equal(result.progress.cache_hits, 3);
    assert.equal(result.progress.cache_misses, 1);
    assert.equal(
      harness.started.filter((id) => id.startsWith("search-answer-map:")).length,
      1,
    );
    assert.equal(harness.manifestReads, 1);
    assert.equal(harness.bodyReads, 1);
    assert.deepEqual(harness.validated, ["e2", "e3", "e4"]);
    assert.deepEqual(
      harness.record.scope.map_reduce.batches.map((batch) => batch.map_event_ids),
      [["e1"], [], [], []],
    );

    await harness.service().get("answer-plan");
    assert.equal(harness.manifestReads, 1);

    const mapId = harness.record.scope.map_reduce.batches[0].work_item_id;
    harness.states.set(
      mapId,
      executionState(completedRun(JSON.stringify([{
        dedupe_key: "event_id:ignored",
        group: "all",
        metric: "task_count",
        value: 1,
        evidence_refs: [1],
      }])), "done"),
    );
    await harness.service().get("answer-plan");
    assert.equal(harness.bodyReads, 1);
  });

  it("retries invalid JSON once without embedding the invalid output", async () => {
    const harness = planningHarness(completedRun("INVALID SECRET"));
    const retry = await harness.service().get("answer-plan");

    assert.equal(retry.progress.phase, "planning");
    assert.equal(retry.progress.current_attempt, 2);
    assert.equal(harness.record.work_item_id, planWorkItemId("answer-plan", 1));
    assert.equal(harness.prepared.at(-1).prompt, SEARCH_ANSWER_PLANNER_RETRY_PROMPT);
    assert.doesNotMatch(harness.evidence.at(-1), /INVALID SECRET/);

    harness.states.set(
      planWorkItemId("answer-plan", 1),
      executionState(completedRun(validPlan), "completed"),
    );
    const mapped = await harness.service().get("answer-plan");
    assert.equal(mapped.progress.phase, "mapping");
  });

  it("fails closed after planning retry exhaustion", async () => {
    const harness = planningHarness(completedRun("{}"), {
      planningAttempt: 1,
    });
    const result = await harness.service().get("answer-plan");
    assert.equal(result.status, "failed");
    assert.equal(result.scope.complete, false);
    assert.equal(result.scope.incomplete_reason, "planning_failed");
    assert.equal(harness.prepared.length, 0);
  });

  it("fails closed when a persisted spec no longer matches its hash", async () => {
    const harness = planningHarness(completedRun(validPlan));
    await harness.service().get("answer-plan");
    harness.record.scope.map_reduce.spec.metric.id = "tampered";

    const result = await harness.service().get("answer-plan");
    assert.equal(result.status, "failed");
    assert.equal(result.scope.incomplete_reason, "schema_mismatch");
    assert.equal(result.scope.spec_hash, undefined);
    assert.equal(result.scope.plan, undefined);
  });

  it("recovers an open planner run after restart", async () => {
    const harness = planningHarness(undefined, { itemStatus: "open" });
    const result = await harness.service().get("answer-plan");
    assert.equal(result.progress.phase, "planning");
    assert.deepEqual(harness.started, [planWorkItemId("answer-plan", 0)]);
  });

  it("cancels planning and honors the original overall deadline", async () => {
    const cancelled = planningHarness(runWithStatus("running"));
    const cancelledView = await cancelled.service().cancel("answer-plan");
    assert.equal(cancelledView.status, "cancelled");
    assert.deepEqual(cancelled.cancelled, [planWorkItemId("answer-plan", 0)]);

    const expired = planningHarness(runWithStatus("running"), {
      createdAt: "2020-01-01T00:00:00.000Z",
    });
    const timedOut = await expired.service().get("answer-plan");
    assert.equal(timedOut.status, "timed_out");
    assert.deepEqual(expired.cancelled, [planWorkItemId("answer-plan", 0)]);
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

function planningHarness(initialRun, options = {}) {
  const eventIds = ["e1", "e2", "e3", "e4"];
  const states = new Map();
  const prepared = [];
  const started = [];
  const evidence = [];
  const cancelled = [];
  const attempt = options.planningAttempt ?? 0;
  const harness = {
    record: {
      id: "answer-plan",
      org_id: "org-1",
      work_item_id: planWorkItemId("answer-plan", attempt),
      query: "count tasks by person",
      event_ids: eventIds,
      scope: {
        intent: "aggregate",
        complete: true,
        total_count: 4,
        included_count: 4,
        omitted_count: 0,
        map_reduce: {
          strategy: "map_reduce",
          phase: "planning",
          snapshot_id: "private-snapshot",
          executor_type: "dsh",
          batch_offsets: [0, 1, 2, 3, 4],
          total_batches: 4,
          planning_attempt: attempt,
          completed_batches: 0,
          batch_attempt: 0,
          facts: [],
          batches: [0, 1, 2, 3].map((index) => ({
            index,
            start_offset: index,
            end_offset: index + 1,
            status: "pending",
            attempt: 0,
          })),
        },
      },
      created_at: options.createdAt ?? new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    states,
    prepared,
    started,
    evidence,
    cancelled,
    manifestReads: 0,
    bodyReads: 0,
    validated: [],
    cacheVersions: [],
  };
  states.set(
    harness.record.work_item_id,
    executionState(initialRun, options.itemStatus ?? "completed"),
  );
  const authority = {
    getSearchAnswer: async () => harness.record,
    putSearchAnswer: async (record) => {
      harness.record = structuredClone(record);
      return harness.record;
    },
    getAggregateFactCache: async (_orgId, specHash, extractorVersion, ids) => {
      harness.cacheVersions.push(extractorVersion);
      return options.cached
        ? ids.map((event_id) => ({
            org_id: "org-1",
            spec_hash: specHash,
            extractor_version: extractorVersion,
            event_id,
            content_hash: event_id === options.staleEventId
              ? `stale-hash-${event_id}`
              : `hash-${event_id}`,
            facts: event_id === options.emptyEventId ? [] : [{
              dedupe_key: `event_id:${event_id}`,
              group: "all",
              metric: "task_count",
              value: 1,
              event_ids: [event_id],
            }],
            created_at: options.cacheUpdatedAt ?? new Date().toISOString(),
            updated_at: options.cacheUpdatedAt ?? new Date().toISOString(),
          }))
        : [];
    },
    putAggregateFactCache: async () => {},
  };
  const runtime = {
    orgId: () => "org-1",
    requireHost: () => ({ get: () => authority }),
  };
  const context = {
    mapBatchEvidence: async () => "typed evidence",
    mapSnapshotManifest: async (_snapshotId, ids) => {
      harness.manifestReads += 1;
      return ids.map((event_id) => ({
        event_id,
        content_hash: `hash-${event_id}`,
      }));
    },
    validateMapManifest: async (entries) => {
      harness.validated.push(...entries.map((entry) => entry.event_id));
    },
    mapBatchInputs: async (_snapshotId, ids) => {
      harness.bodyReads += 1;
      return ids.map((event_id) => ({
        event_id,
        content_hash: `hash-${event_id}`,
        message: { event_id, text: `message ${event_id}` },
        dedupe: { event_id },
      }));
    },
    mapBatchDedupeMetadata: async (ids) =>
      ids.map((event_id) => ({ event_id })),
  };
  const work = {
    refreshAuxiliaryExecution: async (id) =>
      states.get(id) ?? executionState(undefined, "open"),
    prepareAuxiliaryExecution: async (input) => {
      prepared.push(input);
      states.set(input.id, executionState(undefined, "open"));
      return { work_item: { id: input.id }, recipe: {} };
    },
    prepareExistingAuxiliaryExecution: async (id) => ({
      work_item: { id },
      recipe: {},
    }),
    startPreparedAuxiliaryExecution: async (preparedValue, value) => {
      const id = preparedValue.work_item.id;
      started.push(id);
      evidence.push(value);
      const run = runWithStatus("running");
      states.set(id, executionState(run, "running"));
      return { work_item: preparedValue.work_item, run };
    },
    cancelAuxiliaryExecution: async (id, cancelOptions = {}) => {
      cancelled.push(id);
      if (options.cancelError) throw options.cancelError;
      if (cancelOptions.searchAnswerTerminal) {
        harness.record = {
          ...harness.record,
          outcome: cancelOptions.searchAnswerTerminal.outcome,
          updated_at: new Date().toISOString(),
        };
      }
      return { work_item: { id, status: "skipped" }, run: runWithStatus("cancelled") };
    },
  };
  harness.service = () =>
    new PersonalSearchAnswerService(runtime, context, {}, work);
  return harness;
}

function retryHarness(initialRun, options = {}) {
  const states = new Map();
  const prepared = [];
  const started = [];
  const initialAttempt = options.attempt ?? 0;
  const completedBatches = options.completedBatches ?? 0;
  const eventIds = options.eventIds ?? ["event-1"];
  const batchOffsets = options.batchOffsets ?? [0, eventIds.length];
  const harness = {
    record: {
      id: "answer-1",
      org_id: "org-1",
      work_item_id: mapWorkItemId(
        "answer-1",
        completedBatches,
        initialAttempt,
      ),
      query: "How many tickets?",
      event_ids: eventIds,
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
          batch_offsets: batchOffsets,
          total_batches: batchOffsets.length - 1,
          completed_batches: completedBatches,
          batch_attempt: initialAttempt,
          facts: options.legacyFacts ?? [],
        },
      },
      ...(options.outcome ? { outcome: options.outcome } : {}),
      created_at: options.createdAt ?? new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    states,
    prepared,
    started,
    startError: undefined,
    contextError: undefined,
    cancelledIds: [],
    cancelErrorIds: new Set(),
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
    prepareAuxiliaryExecution: async (input, searchAnswer) => {
      prepared.push(input);
      if (searchAnswer) harness.record = searchAnswer;
      const value = { work_item: { id: input.id }, recipe: {} };
      if (!states.has(input.id)) {
        states.set(input.id, executionState(undefined, "open"));
      }
      return value;
    },
    prepareExistingAuxiliaryExecution: async (id) => ({
      work_item: { id },
      recipe: {},
    }),
    startPreparedAuxiliaryExecution: async (value) => {
      started.push(value);
      if (harness.startError) throw harness.startError;
      const run = runWithStatus("running");
      states.set(value.work_item.id, executionState(run, "running"));
      return { work_item: value.work_item, run };
    },
    cancelAuxiliaryExecution: async (id, options = {}) => {
      harness.cancelledIds.push(id);
      if (options.searchAnswerTerminal) {
        harness.record = {
          ...harness.record,
          outcome: options.searchAnswerTerminal.outcome,
          updated_at: "2026-01-01T00:00:01.000Z",
        };
      }
      const cancelled = runWithStatus("cancelled");
      states.set(id, executionState(cancelled, "skipped"));
      if (harness.cancelErrorIds.has(id)) {
        throw new Error("cancel failed");
      }
      return executionState(cancelled, "skipped");
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
