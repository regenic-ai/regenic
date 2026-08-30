const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  MemoryContextArtifactStore,
  MemoryContextRetrieverRegistry,
  contextRuntimePlugin,
  hashCanonicalContext,
  hashContextBundle,
  hashContextBundlePayload,
  hashContextSnapshot,
  validateContextBundle,
  validateContextSnapshot,
} = require("@regenic/domain");
const { createHost } = require("@regenic/plugin-host");
const {
  ContextEngineError,
  DeterministicContextEngine,
  DeterministicEventRetriever,
  deterministicContextEnginePlugin,
  deterministicEventRetrieverPlugin,
} = require("../dist");

const POLICY_HASH = "c".repeat(64);

function request(overrides = {}) {
  return {
    schema_version: "1.0",
    id: "request-1",
    org_id: "example-org",
    principal: { actor_type: "human", actor_id: "person-1" },
    consumer_id: "test-consumer",
    purpose: "answer a synthetic release question",
    allowed_uses: ["display", "reason"],
    query: "release approved",
    anchors: [{ kind: "conversation", id: "thread-1" }],
    temporal: { mode: "current" },
    budget: {
      profile: "test-v1",
      max_tokens: 100,
      max_items: 5,
      max_raw_evidence: 2,
      section_tokens: { evidence: 100 },
    },
    requested_kinds: ["event"],
    ...overrides,
  };
}

function sourceEvent(input) {
  return {
    event: {
      event_id: input.id,
      org_id: input.org_id ?? "example-org",
      source: input.source ?? "example-chat",
      external_id: input.external_id,
      operation: input.operation ?? "create",
      occurred_at: input.occurred_at,
      ingested_at: input.ingested_at,
      ...(input.content_hash ? { content_hash: input.content_hash } : {}),
      ...(input.parent_event_id ? { parent_event_id: input.parent_event_id } : {}),
    },
    thread_id: input.thread_id ?? "thread-1",
    required_scope_ids: input.scopes ?? ["scope-visible"],
    ...(input.text === undefined ? {} : { text: input.text }),
    ...(input.estimated_tokens === undefined ? {} : { estimated_tokens: input.estimated_tokens }),
  };
}

function fixtureEvents() {
  return [
    sourceEvent({
      id: "event-1",
      external_id: "message-1",
      operation: "create",
      occurred_at: "2026-08-29T09:00:00.000Z",
      ingested_at: "2026-08-29T09:01:00.000Z",
      content_hash: "1".repeat(64),
      text: "The release is delayed.",
      estimated_tokens: 6,
    }),
    sourceEvent({
      id: "event-2",
      external_id: "message-1",
      operation: "revise",
      parent_event_id: "event-1",
      occurred_at: "2026-08-29T10:00:00.000Z",
      ingested_at: "2026-08-29T10:01:00.000Z",
      content_hash: "2".repeat(64),
      text: "The release is approved.",
      estimated_tokens: 6,
    }),
    sourceEvent({
      id: "event-3",
      external_id: "message-2",
      occurred_at: "2026-08-29T11:00:00.000Z",
      ingested_at: "2026-08-29T11:01:00.000Z",
      content_hash: "3".repeat(64),
      text: "A second release was approved.",
      estimated_tokens: 7,
    }),
    sourceEvent({
      id: "event-hidden",
      external_id: "message-secret",
      occurred_at: "2026-08-29T11:30:00.000Z",
      ingested_at: "2026-08-29T11:31:00.000Z",
      content_hash: "4".repeat(64),
      text: "The secret release is approved.",
      scopes: ["scope-hidden"],
      estimated_tokens: 7,
    }),
    sourceEvent({
      id: "event-deleted",
      external_id: "message-deleted",
      occurred_at: "2026-08-29T08:00:00.000Z",
      ingested_at: "2026-08-29T08:01:00.000Z",
      content_hash: "5".repeat(64),
      text: "The deleted release was approved.",
      estimated_tokens: 7,
    }),
    sourceEvent({
      id: "event-tombstone",
      external_id: "message-deleted",
      operation: "tombstone",
      parent_event_id: "event-deleted",
      occurred_at: "2026-08-29T12:00:00.000Z",
      ingested_at: "2026-08-29T12:01:00.000Z",
    }),
  ];
}

function lifecycleHeads(events) {
  const groups = new Map();
  for (const source of events) {
    const key = JSON.stringify([source.event.source, source.event.external_id]);
    const group = groups.get(key) ?? [];
    group.push(source);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => {
    const parentIds = new Set(group.map((source) => source.event.parent_event_id).filter(Boolean));
    const head = group.find((source) => !parentIds.has(source.event.event_id)) ?? group[0];
    return {
      source: head.event.source,
      external_id: head.event.external_id,
      head_event_id: head.event.event_id,
    };
  });
}

function source(events = fixtureEvents(), overrides = {}) {
  return {
    async openRead() {
      return {
        read_epoch: "authority:42",
        recorded_at: "2026-08-30T00:00:00.000Z",
        lifecycle_complete: true,
        lifecycle_heads: lifecycleHeads(events),
        events: structuredClone(events),
        ...structuredClone(overrides),
      };
    },
  };
}

function policy(allowedScopes = ["scope-visible"], protectedEventIds = []) {
  const allowed = new Set(allowedScopes);
  return {
    async policyHash() {
      return POLICY_HASH;
    },
    async visible({ resource }) {
      return resource.required_scope_ids.every((scope) => allowed.has(scope));
    },
    async protectedEventIds() {
      return structuredClone(protectedEventIds);
    },
    async canReplay({ request: replay, bundle }) {
      return replay.purpose === bundle.purpose && replay.allowed_uses.every((use) => ["display", "reason"].includes(use));
    },
  };
}

function engine(options = {}) {
  const retrievers = new MemoryContextRetrieverRegistry();
  retrievers.register(new DeterministicEventRetriever());
  return new DeterministicContextEngine({
    source: options.source ?? source(),
    policy: options.policy ?? policy(),
    artifacts: options.artifacts ?? new MemoryContextArtifactStore(),
    retrievers,
  });
}

function materialFor(source, overrides = {}) {
  const evidence = [{
    event_id: source.event.event_id,
    source: source.event.source,
    external_id: source.event.external_id,
    operation: source.event.operation,
    occurred_at: source.event.occurred_at,
    content_hash: source.event.content_hash,
  }];
  return {
    candidate: {
      candidate_id: `event:${source.event.event_id}`,
      kind: "event",
      resource_id: source.event.event_id,
      evidence,
      required_scope_ids: source.required_scope_ids,
      recorded_at: source.event.ingested_at,
      status: "current",
      content_hash: source.event.content_hash,
      scores: { lexical: 1 },
      estimated_tokens: source.estimated_tokens ?? 1,
      ...overrides.candidate,
    },
    section: overrides.section ?? "evidence",
    item: {
      candidate_id: `event:${source.event.event_id}`,
      resource_id: source.event.event_id,
      kind: "event",
      status: "current",
      text: source.text,
      content_hash: source.event.content_hash,
      evidence,
      estimated_tokens: source.estimated_tokens ?? 1,
      ...overrides.item,
    },
  };
}

describe("deterministic context engine", () => {
  it("filters authorization before retrieval and resolves current heads and tombstones", async () => {
    let receivedEventIds;
    const retrievers = new MemoryContextRetrieverRegistry();
    retrievers.register({
      id: "spy",
      capabilities: () => ({ candidate_kinds: ["event"], lexical: false, vector: false, graph: false, rerank: false, multilingual: false }),
      async retrieve(plan) {
        receivedEventIds = plan.events.map((event) => event.event.event_id);
        return new DeterministicEventRetriever().retrieve(plan);
      },
    });
    const context = new DeterministicContextEngine({
      source: source(),
      policy: policy(),
      artifacts: new MemoryContextArtifactStore(),
      retrievers,
    });

    const result = await context.assemble(request());

    assert.equal(receivedEventIds.includes("event-hidden"), false);
    assert.deepEqual(result.bundle.sections[0].items.map((item) => item.resource_id), ["event-3", "event-2"]);
    assert.equal(result.bundle.sections[0].items.some((item) => item.resource_id === "event-deleted"), false);
    assert.equal(validateContextSnapshot(result.snapshot).success, true);
    assert.equal(validateContextBundle(result.bundle).success, true);
  });

  it("supports history and as-of views without changing source Events", async () => {
    const context = engine();
    const history = await context.assemble(request({
      query: undefined,
      anchors: undefined,
      temporal: { mode: "history" },
      budget: { profile: "history", max_tokens: 1_000, max_items: 20, max_raw_evidence: 20 },
    }));
    const historyItems = history.bundle.sections.flatMap((section) => section.items);
    assert.equal(historyItems.find((item) => item.resource_id === "event-1").status, "superseded");
    assert.equal(historyItems.find((item) => item.resource_id === "event-deleted").status, "retracted");

    const asOf = await context.assemble(request({
        query: undefined,
        anchors: undefined,
        temporal: { mode: "as_of", recorded_at: "2026-08-29T09:30:00.000Z" },
        budget: { profile: "as-of", max_tokens: 1_000, max_items: 20, max_raw_evidence: 20 },
    }));
    const asOfItems = asOf.bundle.sections.flatMap((section) => section.items);
    assert.equal(asOfItems.some((item) => item.resource_id === "event-1"), true);
    assert.equal(asOfItems.some((item) => item.resource_id === "event-2"), false);

    const offsetEvent = sourceEvent({
      id: "event-offset",
      external_id: "message-offset",
      occurred_at: "2026-08-29T10:00:00+02:00",
      ingested_at: "2026-08-29T10:15:00+02:00",
      content_hash: "8".repeat(64),
      text: "offset event",
    });
    const offsetAsOf = await engine({ source: source([offsetEvent]) }).assemble(request({
        query: undefined,
        anchors: undefined,
        temporal: { mode: "as_of", recorded_at: "2026-08-29T08:30:00.000Z" },
        budget: { profile: "offset", max_tokens: 100, max_items: 5, max_raw_evidence: 5 },
    }));
    assert.equal(offsetAsOf.bundle.sections.flatMap((section) => section.items).length, 1);
  });

  it("uses the requested as-of time for age filtering and recency scoring", async () => {
    const historicalEvent = sourceEvent({
      id: "event-historical-age",
      external_id: "message-historical-age",
      occurred_at: "2026-08-29T08:00:00.000Z",
      ingested_at: "2026-08-29T08:01:00.000Z",
      content_hash: "8".repeat(64),
      text: "historical event",
    });
    const values = await new DeterministicEventRetriever().retrieve({
      request: request({
        query: undefined,
        anchors: undefined,
        temporal: { mode: "as_of", recorded_at: "2026-08-29T10:00:00.000Z" },
        budget: {
          profile: "historical-age",
          max_tokens: 100,
          max_items: 5,
          max_raw_evidence: 5,
          max_age_days: 1,
        },
      }),
      read_epoch: "authority:future-read",
      recorded_at: "2026-09-30T00:00:00.000Z",
      principal_policy_hash: POLICY_HASH,
      events: [{ ...historicalEvent, status: "current" }],
    });

    assert.equal(values.length, 1);
    assert.ok(Math.abs(values[0].candidate.scores.recency - (12 / 13)) < 1e-12);
  });

  it("rejects an as-of time beyond the authority read boundary", async () => {
    await assert.rejects(
      engine().assemble(request({
        temporal: { mode: "as_of", recorded_at: "2026-08-31T00:00:00.000Z" },
      })),
      (error) => error instanceof ContextEngineError &&
        error.code === "source_boundary" &&
        error.message.includes("does not cover"),
    );
  });

  it("applies source, thread, actor, and occurred-time filters before lexical scoring", async () => {
    const events = fixtureEvents().map((event, index) => ({ ...event, actor_id: index === 1 ? "actor-match" : "actor-other" }));
    const result = await engine({ source: source(events) }).assemble(request({
        query: undefined,
        anchors: undefined,
        filters: {
          sources: ["example-chat"],
          thread_ids: ["thread-1"],
          actor_ids: ["actor-match"],
          occurred_after: "2026-08-29T09:30:00.000Z",
          occurred_before: "2026-08-29T10:30:00.000Z",
        },
    }));
    assert.deepEqual(
      result.bundle.sections.flatMap((section) => section.items).map((item) => item.resource_id),
      ["event-2"],
    );
  });

  it("does not resurrect a create when a tombstone falls outside content filters", async () => {
    const events = fixtureEvents().filter((event) => event.event.external_id === "message-deleted");
    const result = await engine({ source: source(events) }).assemble(request({
        query: undefined,
        anchors: undefined,
        filters: { occurred_before: "2026-08-29T09:00:00.000Z" },
    }));
    assert.equal(result.bundle.sections.length, 0);
  });

  it("rejects a read boundary that predates an included tombstone", async () => {
    const events = fixtureEvents().filter(
      (event) => event.event.external_id === "message-deleted",
    );
    await assert.rejects(
      engine({
        source: source(events, { recorded_at: "2026-08-29T10:00:00.000Z" }),
      }).assemble(request({ query: undefined, anchors: undefined })),
      (error) => error instanceof ContextEngineError && error.code === "source_boundary",
    );
  });

  it("rejects lifecycle scope drift before an invisible tombstone can expose stale text", async () => {
    const events = fixtureEvents()
      .filter((event) => event.event.external_id === "message-deleted")
      .map((event) => event.event.operation === "tombstone"
        ? { ...event, required_scope_ids: ["scope-hidden"] }
        : event);
    await assert.rejects(
      engine({ source: source(events) }).assemble(request({ query: undefined, anchors: undefined })),
      (error) => error instanceof ContextEngineError && error.code === "source_boundary",
    );
  });

  it("orders same-timestamp lifecycle records by parent linkage", async () => {
    const created = sourceEvent({
      id: "event-9",
      external_id: "message-same-time",
      occurred_at: "2026-08-29T08:00:00.000Z",
      ingested_at: "2026-08-29T08:01:00.000Z",
      content_hash: "9".repeat(64),
      text: "same-time original",
    });
    const tombstone = sourceEvent({
      id: "event-10",
      external_id: "message-same-time",
      operation: "tombstone",
      parent_event_id: "event-9",
      occurred_at: "2026-08-29T08:00:00.000Z",
      ingested_at: "2026-08-29T08:01:00.000Z",
    });
    const result = await engine({ source: source([tombstone, created]) }).assemble(
      request({ query: undefined, anchors: undefined }),
    );
    assert.equal(result.bundle.sections.length, 0);
  });

  it("rejects missing or authority-mismatched lifecycle head manifests", async () => {
    const created = sourceEvent({
      id: "event-manifest-create",
      external_id: "message-manifest",
      occurred_at: "2026-08-29T08:00:00.000Z",
      ingested_at: "2026-08-29T08:01:00.000Z",
      content_hash: "a".repeat(64),
      text: "manifest original",
    });
    await assert.rejects(
      engine({ source: source([created], { lifecycle_heads: undefined }) }).assemble(request()),
      (error) => error instanceof ContextEngineError && error.code === "source_boundary",
    );
    await assert.rejects(
      engine({
        source: source([created], {
          lifecycle_heads: [{
            source: "example-chat",
            external_id: "message-manifest",
            head_event_id: "event-omitted-successor",
          }],
        }),
      }).assemble(request()),
      (error) => error instanceof ContextEngineError && error.code === "source_boundary",
    );
  });

  it("rejects dangling parents and invalid lifecycle operation shapes", async () => {
    const root = sourceEvent({
      id: "event-shape-root",
      external_id: "message-shape",
      occurred_at: "2026-08-29T08:00:00.000Z",
      ingested_at: "2026-08-29T08:01:00.000Z",
      content_hash: "a".repeat(64),
      text: "shape root",
    });
    const invalidLifecycles = [
      [sourceEvent({
        id: "event-dangling",
        external_id: "message-dangling",
        operation: "revise",
        parent_event_id: "event-missing",
        occurred_at: "2026-08-29T09:00:00.000Z",
        ingested_at: "2026-08-29T09:01:00.000Z",
        content_hash: "b".repeat(64),
        text: "dangling revision",
      })],
      [root, sourceEvent({
        id: "event-create-with-parent",
        external_id: "message-shape",
        operation: "create",
        parent_event_id: root.event.event_id,
        occurred_at: "2026-08-29T09:00:00.000Z",
        ingested_at: "2026-08-29T09:01:00.000Z",
        content_hash: "b".repeat(64),
        text: "invalid second create",
      })],
      [root, sourceEvent({
        id: "event-tombstone-with-content",
        external_id: "message-shape",
        operation: "tombstone",
        parent_event_id: root.event.event_id,
        occurred_at: "2026-08-29T09:00:00.000Z",
        ingested_at: "2026-08-29T09:01:00.000Z",
        content_hash: "b".repeat(64),
      })],
      [root, sourceEvent({
        id: "event-unknown-operation",
        external_id: "message-shape",
        operation: "replace",
        parent_event_id: root.event.event_id,
        occurred_at: "2026-08-29T09:00:00.000Z",
        ingested_at: "2026-08-29T09:01:00.000Z",
        content_hash: "b".repeat(64),
        text: "unknown operation",
      })],
    ];
    for (const events of invalidLifecycles) {
      await assert.rejects(
        engine({ source: source(events) }).assemble(request()),
        (error) => error instanceof ContextEngineError && error.code === "source_boundary",
      );
    }
  });

  it("rejects a revision whose occurrence time precedes its parent", async () => {
    const parent = sourceEvent({
      id: "event-time-parent",
      external_id: "message-time-order",
      occurred_at: "2026-08-29T10:00:00.000Z",
      ingested_at: "2026-08-29T10:01:00.000Z",
      content_hash: "a".repeat(64),
      text: "later parent",
    });
    const child = sourceEvent({
      id: "event-time-child",
      external_id: "message-time-order",
      operation: "revise",
      parent_event_id: parent.event.event_id,
      occurred_at: "2026-08-29T09:00:00.000Z",
      ingested_at: "2026-08-29T11:01:00.000Z",
      content_hash: "b".repeat(64),
      text: "backdated revision",
    });

    await assert.rejects(
      engine({ source: source([parent, child]) }).assemble(request({
        query: undefined,
        anchors: undefined,
        temporal: { mode: "history", valid_at: "2026-08-29T09:30:00.000Z" },
      })),
      (error) => error instanceof ContextEngineError &&
        error.code === "source_boundary" &&
        error.message.includes("time order"),
    );
  });

  it("rejects lifecycle cycles and forks", async () => {
    const cycleA = sourceEvent({
      id: "event-cycle-a",
      external_id: "message-cycle",
      operation: "revise",
      parent_event_id: "event-cycle-b",
      occurred_at: "2026-08-29T09:00:00.000Z",
      ingested_at: "2026-08-29T09:01:00.000Z",
      content_hash: "a".repeat(64),
      text: "cycle a",
    });
    const cycleB = sourceEvent({
      id: "event-cycle-b",
      external_id: "message-cycle",
      operation: "revise",
      parent_event_id: "event-cycle-a",
      occurred_at: "2026-08-29T09:00:00.000Z",
      ingested_at: "2026-08-29T09:01:00.000Z",
      content_hash: "b".repeat(64),
      text: "cycle b",
    });
    await assert.rejects(
      engine({ source: source([cycleA, cycleB]) }).assemble(request()),
      (error) => error instanceof ContextEngineError &&
        error.code === "source_boundary" &&
        error.message.includes("parent cycle"),
    );

    const root = sourceEvent({
      id: "event-fork-root",
      external_id: "message-fork",
      occurred_at: "2026-08-29T08:00:00.000Z",
      ingested_at: "2026-08-29T08:01:00.000Z",
      content_hash: "c".repeat(64),
      text: "fork root",
    });
    const revisions = ["a", "b"].map((suffix, index) => sourceEvent({
      id: `event-fork-${suffix}`,
      external_id: "message-fork",
      operation: "revise",
      parent_event_id: root.event.event_id,
      occurred_at: `2026-08-29T${String(9 + index).padStart(2, "0")}:00:00.000Z`,
      ingested_at: `2026-08-29T${String(9 + index).padStart(2, "0")}:01:00.000Z`,
      content_hash: suffix.repeat(64),
      text: `fork ${suffix}`,
    }));
    await assert.rejects(
      engine({ source: source([root, ...revisions]) }).assemble(request()),
      (error) => error instanceof ContextEngineError &&
        error.code === "source_boundary" &&
        error.message.includes("multiple heads"),
    );
  });

  it("withholds an entire lifecycle when a successor is not visible", async () => {
    const created = sourceEvent({
      id: "event-visible-predecessor",
      external_id: "message-chain-acl",
      occurred_at: "2026-08-29T08:00:00.000Z",
      ingested_at: "2026-08-29T08:01:00.000Z",
      content_hash: "a".repeat(64),
      text: "visible predecessor",
    });
    const hiddenSuccessor = sourceEvent({
      id: "event-hidden-successor",
      external_id: "message-chain-acl",
      operation: "revise",
      parent_event_id: created.event.event_id,
      occurred_at: "2026-08-29T09:00:00.000Z",
      ingested_at: "2026-08-29T09:01:00.000Z",
      content_hash: "b".repeat(64),
      text: "hidden successor",
    });
    let retrievedEventIds;
    const retrievers = new MemoryContextRetrieverRegistry();
    retrievers.register({
      id: "chain-acl-spy",
      capabilities: () => ({ candidate_kinds: ["event"], lexical: false, vector: false, graph: false, rerank: false, multilingual: false }),
      async retrieve(plan) {
        retrievedEventIds = plan.events.map((event) => event.event.event_id);
        return [];
      },
    });
    const context = new DeterministicContextEngine({
      source: source([created, hiddenSuccessor]),
      policy: {
        ...policy(),
        async visible({ resource }) {
          return resource.resource_id !== hiddenSuccessor.event.event_id;
        },
      },
      artifacts: new MemoryContextArtifactStore(),
      retrievers,
    });

    const result = await context.assemble(request({
      query: undefined,
      anchors: undefined,
      temporal: { mode: "history" },
    }));
    assert.deepEqual(retrievedEventIds, []);
    assert.equal(result.bundle.sections.length, 0);
  });

  it("enforces hard budgets, emits opaque redactions, and degrades without optional capabilities", async () => {
    const result = await engine().assemble(request({
      budget: {
        profile: "small-v1",
        max_tokens: 6,
        max_items: 1,
        max_raw_evidence: 1,
        section_tokens: { evidence: 6 },
      },
    }));

    assert.equal(result.bundle.sections[0].items.length, 1);
    assert.equal(result.bundle.budget_ledger.selected_tokens, 6);
    assert.equal(result.bundle.budget_ledger.truncated_items, 1);
    assert.deepEqual(result.bundle.redactions, [{ section: "evidence", category: "budget", count: 1 }]);
    assert.deepEqual(result.bundle.degradation_flags, ["graph_absent", "model_absent", "rerank_absent", "vector_absent"]);
  });

  it("does not trust a retriever to under-report text token cost", async () => {
    const underReported = sourceEvent({
      id: "event-under-reported",
      external_id: "message-under-reported",
      occurred_at: "2026-08-30T00:00:00.000Z",
      ingested_at: "2026-08-30T00:00:00.000Z",
      content_hash: "7".repeat(64),
      text: "This text cannot fit inside one token.",
      scopes: [],
      estimated_tokens: 0,
    });
    const retrievers = new MemoryContextRetrieverRegistry();
    retrievers.register({
      id: "under-reported",
      capabilities: () => ({ candidate_kinds: ["event"], lexical: true, vector: false, graph: false, rerank: false, multilingual: true }),
      async retrieve() {
        const evidence = [{
          event_id: "event-under-reported",
          source: "example-chat",
          external_id: "message-under-reported",
          operation: "create",
          occurred_at: "2026-08-30T00:00:00.000Z",
          content_hash: "7".repeat(64),
        }];
        return [{
          candidate: {
            candidate_id: "event:event-under-reported",
            kind: "event",
            resource_id: "event-under-reported",
            evidence,
            required_scope_ids: [],
            recorded_at: "2026-08-30T00:00:00.000Z",
            status: "current",
            content_hash: "7".repeat(64),
            scores: { lexical: 1 },
            estimated_tokens: 0,
          },
          section: "evidence",
          item: {
            candidate_id: "event:event-under-reported",
            resource_id: "event-under-reported",
            kind: "event",
            status: "current",
            text: "This text cannot fit inside one token.",
            content_hash: "7".repeat(64),
            evidence,
            estimated_tokens: 0,
          },
        }];
      },
    });
    const context = new DeterministicContextEngine({
      source: source([underReported]),
      policy: policy(),
      artifacts: new MemoryContextArtifactStore(),
      retrievers,
    });
    const result = await context.assemble(request({
      query: undefined,
      anchors: undefined,
      budget: { profile: "one-token", max_tokens: 1, max_items: 1, max_raw_evidence: 1 },
    }));
    assert.equal(result.bundle.sections.length, 0);
    assert.equal(result.bundle.budget_ledger.truncated_items, 1);
  });

  it("rejects candidates that are not bound to authorized source Events", async () => {
    const hidden = fixtureEvents().find((event) => event.event.event_id === "event-hidden");
    const retrievers = new MemoryContextRetrieverRegistry();
    retrievers.register({
      id: "malicious",
      capabilities: () => ({ candidate_kinds: ["event"], lexical: true, vector: false, graph: false, rerank: false, multilingual: true }),
      async retrieve() {
        return [materialFor(hidden)];
      },
    });
    const context = new DeterministicContextEngine({
      source: source(),
      policy: policy(),
      artifacts: new MemoryContextArtifactStore(),
      retrievers,
    });
    await assert.rejects(
      context.assemble(request()),
      (error) => error instanceof ContextEngineError && error.code === "invalid_candidate",
    );
  });

  it("rejects a custom retriever that tries to revive a superseded Event", async () => {
    const oldRevision = fixtureEvents().find((event) => event.event.event_id === "event-1");
    const retrievers = new MemoryContextRetrieverRegistry();
    retrievers.register({
      id: "stale-revision",
      capabilities: () => ({ candidate_kinds: ["event"], lexical: true, vector: false, graph: false, rerank: false, multilingual: true }),
      async retrieve() {
        return [materialFor(oldRevision)];
      },
    });
    const context = new DeterministicContextEngine({
      source: source(),
      policy: policy(),
      artifacts: new MemoryContextArtifactStore(),
      retrievers,
    });
    await assert.rejects(
      context.assemble(request()),
      (error) => error instanceof ContextEngineError && error.code === "invalid_candidate",
    );
  });

  it("rejects undeclared or unrequested candidate kinds", async () => {
    const visible = fixtureEvents()[1];
    const retrievers = new MemoryContextRetrieverRegistry();
    retrievers.register({
      id: "kind-spoof",
      capabilities: () => ({ candidate_kinds: ["event"], lexical: true, vector: false, graph: false, rerank: false, multilingual: true }),
      async retrieve() {
        return [materialFor(visible, {
          candidate: {
            candidate_id: "digest:event-2",
            kind: "digest",
            projection: { projector_id: "spoof", algorithm_version: "1", generation: "1" },
          },
          item: { candidate_id: "digest:event-2", kind: "digest" },
        })];
      },
    });
    const context = new DeterministicContextEngine({
      source: source(),
      policy: policy(),
      artifacts: new MemoryContextArtifactStore(),
      retrievers,
    });
    await assert.rejects(
      context.assemble(request()),
      (error) => error instanceof ContextEngineError && error.code === "invalid_candidate",
    );
  });

  it("rejects attempts by Event retrievers to publish protected policy context", async () => {
    const policyEvent = sourceEvent({
      id: "event-policy",
      external_id: "message-policy",
      occurred_at: "2026-08-29T00:00:00.000Z",
      ingested_at: "2026-08-29T00:01:00.000Z",
      content_hash: "6".repeat(64),
      text: "Mandatory policy context.",
      estimated_tokens: 5,
    });
    const retrievers = new MemoryContextRetrieverRegistry();
    retrievers.register({
      id: "sections",
      capabilities: () => ({ candidate_kinds: ["event"], lexical: true, vector: false, graph: false, rerank: false, multilingual: true }),
      async retrieve() {
        return [materialFor(policyEvent, { section: "policy" })];
      },
    });
    const context = new DeterministicContextEngine({
      source: source([policyEvent]),
      policy: policy(),
      artifacts: new MemoryContextArtifactStore(),
      retrievers,
    });
    await assert.rejects(
      context.assemble(request({ query: undefined, anchors: undefined })),
      (error) => error instanceof ContextEngineError && error.code === "invalid_candidate",
    );
  });

  it("lets core promote trusted protected Events before higher-scored evidence", async () => {
    const policyEvent = sourceEvent({
      id: "event-trusted-policy",
      external_id: "message-trusted-policy",
      occurred_at: "2026-08-29T00:00:00.000Z",
      ingested_at: "2026-08-29T00:01:00.000Z",
      content_hash: "6".repeat(64),
      text: "Trusted policy context.",
      estimated_tokens: 5,
    });
    const evidenceEvent = sourceEvent({
      id: "event-higher-score",
      external_id: "message-higher-score",
      occurred_at: "2026-08-29T01:00:00.000Z",
      ingested_at: "2026-08-29T01:01:00.000Z",
      content_hash: "7".repeat(64),
      text: "Higher-scored evidence.",
      estimated_tokens: 5,
    });
    const retrievers = new MemoryContextRetrieverRegistry();
    retrievers.register({
      id: "trusted-policy-selection",
      capabilities: () => ({ candidate_kinds: ["event"], lexical: true, vector: false, graph: false, rerank: false, multilingual: true }),
      async retrieve() {
        return [
          materialFor(evidenceEvent, { candidate: { scores: { lexical: 100 } } }),
          materialFor(policyEvent, { candidate: { scores: { lexical: 1 } } }),
        ];
      },
    });
    const context = new DeterministicContextEngine({
      source: source([policyEvent, evidenceEvent]),
      policy: policy(["scope-visible"], [policyEvent.event.event_id]),
      artifacts: new MemoryContextArtifactStore(),
      retrievers,
    });

    const result = await context.assemble(request({
      query: undefined,
      anchors: undefined,
      budget: { profile: "protected", max_tokens: 10, max_items: 1, max_raw_evidence: 1 },
    }));
    assert.deepEqual(result.bundle.sections.map((section) => section.kind), ["policy"]);
    assert.equal(result.bundle.sections[0].items[0].resource_id, policyEvent.event.event_id);
    assert.equal(result.snapshot.selected[0].resource_id, policyEvent.event.event_id);
  });

  it("fails when a protected Event is omitted by retrieval or cannot fit the budget", async () => {
    const policyEvent = sourceEvent({
      id: "event-required-policy",
      external_id: "message-required-policy",
      occurred_at: "2026-08-29T00:00:00.000Z",
      ingested_at: "2026-08-29T00:01:00.000Z",
      content_hash: "6".repeat(64),
      text: "Required policy context.",
      estimated_tokens: 5,
    });
    const omittedRetrievers = new MemoryContextRetrieverRegistry();
    omittedRetrievers.register({
      id: "omits-policy",
      capabilities: () => ({ candidate_kinds: ["event"], lexical: true, vector: false, graph: false, rerank: false, multilingual: true }),
      async retrieve() {
        return [];
      },
    });
    const omitted = new DeterministicContextEngine({
      source: source([policyEvent]),
      policy: policy(["scope-visible"], [policyEvent.event.event_id]),
      artifacts: new MemoryContextArtifactStore(),
      retrievers: omittedRetrievers,
    });
    await assert.rejects(
      omitted.assemble(request({ query: undefined, anchors: undefined })),
      (error) => error instanceof ContextEngineError &&
        error.code === "invalid_candidate" &&
        error.message.includes("was not retrieved"),
    );

    const retrieved = new MemoryContextRetrieverRegistry();
    retrieved.register({
      id: "retrieves-policy",
      capabilities: () => ({ candidate_kinds: ["event"], lexical: true, vector: false, graph: false, rerank: false, multilingual: true }),
      async retrieve() {
        return [materialFor(policyEvent)];
      },
    });
    const tooSmall = new DeterministicContextEngine({
      source: source([policyEvent]),
      policy: policy(["scope-visible"], [policyEvent.event.event_id]),
      artifacts: new MemoryContextArtifactStore(),
      retrievers: retrieved,
    });
    await assert.rejects(
      tooSmall.assemble(request({
        query: undefined,
        anchors: undefined,
        budget: { profile: "too-small", max_tokens: 4, max_items: 1, max_raw_evidence: 1 },
      })),
      (error) => error instanceof ContextEngineError &&
        error.code === "invalid_request" &&
        error.message.includes("cannot fit protected Event"),
    );
  });

  it("rejects protected Event IDs outside the authorized lifecycle view", async () => {
    await assert.rejects(
      engine({ policy: policy(["scope-visible"], ["event-hidden"]) }).assemble(request()),
      (error) => error instanceof ContextEngineError &&
        error.code === "invalid_candidate" &&
        error.message.includes("outside the authorized lifecycle view"),
    );
  });

  it("isolates engine behavior from caller mutations to configuration profiles", async () => {
    const retrievalProfile = {
      version: "isolated-retrieval",
      score_weights: { anchor: 4, exact_match: 3, lexical: 2, recency: 1 },
    };
    const assemblyProfile = {
      version: "isolated-assembly",
      section_order: ["policy", "memory", "working", "facts", "summaries", "evidence"],
    };
    const retrievers = new MemoryContextRetrieverRegistry();
    retrievers.register(new DeterministicEventRetriever());
    const context = new DeterministicContextEngine({
      source: source(),
      policy: policy(),
      artifacts: new MemoryContextArtifactStore(),
      retrievers,
      retrieval_profile: retrievalProfile,
      assembly_profile: assemblyProfile,
    });
    retrievalProfile.version = "mutated";
    retrievalProfile.score_weights.lexical = -100;
    assemblyProfile.version = "mutated";
    assemblyProfile.section_order.length = 0;

    const result = await context.assemble(request());
    assert.equal(result.snapshot.retrieval_profile_version, "isolated-retrieval");
    assert.equal(result.snapshot.assembly_profile_version, "isolated-assembly");
    assert.deepEqual(result.bundle.sections.map((section) => section.kind), ["evidence"]);
  });

  it("produces stable snapshots and replays only after policy authorization", async () => {
    const artifacts = new MemoryContextArtifactStore();
    const context = engine({ artifacts });
    const first = await context.assemble(request());
    const second = await context.assemble(request({ id: "request-2" }));

    assert.equal(first.snapshot.id, second.snapshot.id);
    assert.equal(first.snapshot.content_hash, second.snapshot.content_hash);
    assert.equal(first.bundle.content_hash, second.bundle.content_hash);

    const replayed = await context.replay({
      org_id: "example-org",
      snapshot_id: first.snapshot.id,
      principal: { actor_type: "human", actor_id: "person-1" },
      consumer_id: "test-consumer",
      purpose: "answer a synthetic release question",
      allowed_uses: ["display"],
    });
    assert.equal(replayed.content_hash, first.bundle.content_hash);

    const denied = engine({ artifacts, policy: policy([]) });
    await assert.rejects(
      denied.replay({
        org_id: "example-org",
        snapshot_id: first.snapshot.id,
        principal: { actor_type: "human", actor_id: "person-1" },
        consumer_id: "test-consumer",
        purpose: "answer a synthetic release question",
        allowed_uses: ["execute"],
      }),
      (error) => error instanceof ContextEngineError && error.code === "replay_forbidden",
    );
  });

  it("rejects malformed replay requests before consulting storage", async () => {
    await assert.rejects(
      engine().replay({
        org_id: "example-org",
        snapshot_id: "snapshot-missing",
        principal: { actor_type: "human", actor_id: "person-1" },
        consumer_id: "test-consumer",
        purpose: "answer a synthetic release question",
        allowed_uses: [],
      }),
      (error) => error instanceof ContextEngineError && error.code === "invalid_request",
    );
  });

  it("rejects corrupted replay data even when the policy would allow it", async () => {
    const valid = await engine().assemble(request());
    const alteredBundle = structuredClone(valid.bundle);
    alteredBundle.sections[0].items[0].text = "A rehashed but altered body.";
    alteredBundle.sections[0].items[0].evidence[0].external_id = "altered-message";
    alteredBundle.citations[0].external_id = "altered-message";
    alteredBundle.content_hash = hashContextBundle(alteredBundle);
    const corruptStore = {
      async getSnapshot() {
        return valid.snapshot;
      },
      async getBundle() {
        return alteredBundle;
      },
    };
    const context = engine({ artifacts: corruptStore });
    await assert.rejects(
      context.replay({
        org_id: "example-org",
        snapshot_id: valid.snapshot.id,
        principal: { actor_type: "human", actor_id: "person-1" },
        consumer_id: "test-consumer",
        purpose: "answer a synthetic release question",
        allowed_uses: ["display"],
      }),
      (error) => error instanceof ContextEngineError && error.code === "invalid_candidate",
    );
  });

  it("rejects jointly rehashed replay data that retains the original snapshot ID", async () => {
    const valid = await engine().assemble(request());
    const alteredBundle = structuredClone(valid.bundle);
    alteredBundle.sections[0].items[0].text = "A jointly rehashed altered body.";
    alteredBundle.content_hash = hashContextBundle(alteredBundle);
    const { snapshot_id: _snapshotId, content_hash: _contentHash, ...alteredPayload } = alteredBundle;
    const alteredSnapshot = structuredClone(valid.snapshot);
    alteredSnapshot.bundle_payload_hash = hashContextBundlePayload(alteredPayload);
    alteredSnapshot.content_hash = hashContextSnapshot(alteredSnapshot);
    assert.notEqual(alteredSnapshot.content_hash, valid.snapshot.content_hash);
    assert.equal(alteredSnapshot.id, valid.snapshot.id);
    const context = engine({
      artifacts: {
        async getSnapshot() {
          return alteredSnapshot;
        },
        async getBundle() {
          return alteredBundle;
        },
      },
    });

    await assert.rejects(
      context.replay({
        org_id: "example-org",
        snapshot_id: valid.snapshot.id,
        principal: { actor_type: "human", actor_id: "person-1" },
        consumer_id: "test-consumer",
        purpose: "answer a synthetic release question",
        allowed_uses: ["display"],
      }),
      (error) => error instanceof ContextEngineError && error.code === "invalid_candidate",
    );
  });

  it("rejects cross-organization source leakage", async () => {
    const leaked = source([sourceEvent({
      id: "event-other-org",
      org_id: "other-org",
      external_id: "message-1",
      occurred_at: "2026-08-29T00:00:00.000Z",
      ingested_at: "2026-08-29T00:01:00.000Z",
      content_hash: "9".repeat(64),
      text: "release approved",
    })]);
    await assert.rejects(
      engine({ source: leaked }).assemble(request()),
      (error) => error instanceof ContextEngineError && error.code === "source_boundary",
    );
  });

  it("rejects parent links that cross source identities", async () => {
    const first = sourceEvent({
      id: "event-a",
      external_id: "message-a",
      parent_event_id: "event-b",
      occurred_at: "2026-08-29T00:00:00.000Z",
      ingested_at: "2026-08-29T00:01:00.000Z",
      content_hash: "a".repeat(64),
      text: "release approved",
    });
    const second = sourceEvent({
      id: "event-b",
      external_id: "message-b",
      parent_event_id: "event-a",
      occurred_at: "2026-08-29T00:00:00.000Z",
      ingested_at: "2026-08-29T00:01:00.000Z",
      content_hash: "b".repeat(64),
      text: "release approved",
    });
    await assert.rejects(
      engine({ source: source([first, second]) }).assemble(request()),
      (error) => error instanceof ContextEngineError && error.code === "source_boundary",
    );
  });

  it("keeps same-named scores separate across retrievers during fusion", async () => {
    const shared = sourceEvent({
      id: "event-score-z-shared",
      external_id: "message-score-shared",
      occurred_at: "2026-08-29T08:00:00.000Z",
      ingested_at: "2026-08-29T08:01:00.000Z",
      content_hash: "a".repeat(64),
      text: "shared score candidate",
    });
    const other = sourceEvent({
      id: "event-score-a-other",
      external_id: "message-score-other",
      occurred_at: "2026-08-29T09:00:00.000Z",
      ingested_at: "2026-08-29T09:01:00.000Z",
      content_hash: "b".repeat(64),
      text: "other score candidate",
    });
    const retrievers = new MemoryContextRetrieverRegistry();
    retrievers.register({
      id: "score-first",
      capabilities: () => ({ candidate_kinds: ["event"], lexical: true, vector: false, graph: false, rerank: false, multilingual: true }),
      async retrieve() {
        return [
          materialFor(shared, { candidate: { scores: { lexical: 1 } } }),
          materialFor(other, { candidate: { scores: { lexical: 2.5 } } }),
        ];
      },
    });
    retrievers.register({
      id: "score-second",
      capabilities: () => ({ candidate_kinds: ["event"], lexical: true, vector: false, graph: false, rerank: false, multilingual: true }),
      async retrieve() {
        return [materialFor(shared, { candidate: { scores: { lexical: 2 } } })];
      },
    });
    const context = new DeterministicContextEngine({
      source: source([shared, other]),
      policy: policy(),
      artifacts: new MemoryContextArtifactStore(),
      retrievers,
      retrieval_profile: {
        version: "namespaced-scores",
        score_weights: {
          [JSON.stringify(["score-first", "lexical"])]: 1,
          [JSON.stringify(["score-second", "lexical"])]: 1,
        },
      },
    });

    const result = await context.assemble(request({
      query: undefined,
      anchors: undefined,
      budget: { profile: "one-score", max_tokens: 100, max_items: 1, max_raw_evidence: 1 },
    }));
    assert.equal(result.snapshot.selected[0].resource_id, shared.event.event_id);
  });

  it("rejects mismatched material for the same candidate", async () => {
    const retrievers = new MemoryContextRetrieverRegistry();
    const base = new DeterministicEventRetriever();
    retrievers.register({
      id: "first",
      capabilities: () => base.capabilities(),
      retrieve: (plan) => base.retrieve(plan),
    });
    retrievers.register({
      id: "second",
      capabilities: () => base.capabilities(),
      async retrieve(plan) {
        return (await base.retrieve(plan)).map((value) => ({
          ...value,
          item: { ...value.item, text: `${value.item.text} altered` },
        }));
      },
    });
    const context = new DeterministicContextEngine({
      source: source(),
      policy: policy(),
      artifacts: new MemoryContextArtifactStore(),
      retrievers,
    });
    await assert.rejects(
      context.assemble(request()),
      (error) => error instanceof ContextEngineError && error.code === "invalid_candidate",
    );
  });

  it("mounts retriever and engine services through plugin fibers", async () => {
    const host = await createHost();
    await host.plugin(contextRuntimePlugin);
    const retrieverHandle = await host.plugin(deterministicEventRetrieverPlugin);
    const engineHandle = await host.plugin(deterministicContextEnginePlugin, {
      source: source(),
      policy: policy(),
    });

    assert.ok(host.get("context"));
    assert.equal(host.get("context-retrievers").list().length, 1);
    await engineHandle.dispose();
    assert.throws(() => host.get("context"), /Service is not available/);
    await retrieverHandle.dispose();
    assert.equal(host.get("context-retrievers").list().length, 0);
    await host.dispose();
  });

  it("keeps policy hashes sensitive to authorization state", () => {
    assert.notEqual(
      hashCanonicalContext({ scopes: ["scope-visible"] }),
      hashCanonicalContext({ scopes: ["scope-hidden"] }),
    );
  });
});