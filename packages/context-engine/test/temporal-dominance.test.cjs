const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { describe, it } = require("node:test");
const { MemoryContextArtifactStore, MemoryContextRetrieverRegistry } = require("@regenic/domain");
const { DeterministicContextEngine, DeterministicEventRetriever } = require("../dist");

function event(id, occurredAt, text) {
  return {
    event: {
      event_id: id,
      org_id: "example-org",
      source: "example-chat",
      external_id: id,
      operation: "create",
      occurred_at: occurredAt,
      ingested_at: occurredAt,
      content_hash: createHash("sha256").update(text).digest("hex"),
    },
    thread_id: "thread-1",
    required_scope_ids: ["scope-visible"],
    text,
  };
}

function engine(events, protectedIds = []) {
  const retrievers = new MemoryContextRetrieverRegistry();
  retrievers.register(new DeterministicEventRetriever());
  return new DeterministicContextEngine({
    source: {
      async openRead() {
        return {
          read_epoch: "authority:temporal-dominance",
          recorded_at: "2026-06-01T00:00:00.000Z",
          lifecycle_complete: true,
          lifecycle_heads: events.map((value) => ({
            source: value.event.source,
            external_id: value.event.external_id,
            head_event_id: value.event.event_id,
          })),
          events: structuredClone(events),
        };
      },
    },
    policy: {
      async policyHash() { return "a".repeat(64); },
      async visible({ resource }) {
        return resource.required_scope_ids.every((scope) => scope === "scope-visible");
      },
      async protectedEventIds() { return protectedIds; },
      async canReplay() { return true; },
    },
    artifacts: new MemoryContextArtifactStore(),
    retrievers,
  });
}

function request(query) {
  return {
    schema_version: "1.0",
    id: "request-dominance",
    org_id: "example-org",
    principal: { actor_type: "human", actor_id: "person-1" },
    consumer_id: "temporal-dominance",
    purpose: "check superseded evidence",
    allowed_uses: ["display"],
    query,
    temporal: { mode: "current" },
    budget: { profile: "test-v1", max_tokens: 4000, max_items: 10, max_raw_evidence: 10 },
    requested_kinds: ["event"],
  };
}

const older = event("plan-old", "2026-01-02T00:00:00.000Z", "南坡门方案按原计划走。");
const newer = event("plan-new", "2026-03-02T00:00:00.000Z", "南坡门方案重开了，先别按原计划，改到西侧装卸门。");

async function selected(query, protectedIds = []) {
  const result = await engine([older, newer], protectedIds).assemble(request(query));
  return result.bundle.sections.flatMap((section) => section.items).map((item) => item.resource_id);
}

describe("Temporal dominance", () => {
  it("drops the older statement when the query asks for the current plan", async () => {
    assert.deepEqual(await selected("现在南坡门方案还能用吗"), ["plan-new"]);
  });

  it("drops the newer statement when the query asks for the original plan", async () => {
    assert.deepEqual(await selected("一开始南坡门方案是什么"), ["plan-old"]);
  });

  it("keeps both statements when the query does not ask for one time", async () => {
    const ids = await selected("南坡门方案");
    assert.deepEqual(ids.slice().sort(), ["plan-new", "plan-old"]);
  });

  it("keeps a protected older statement", async () => {
    const ids = await selected("现在南坡门方案还能用吗", ["plan-old"]);
    assert.deepEqual(ids.slice().sort(), ["plan-new", "plan-old"]);
  });

  it("ranks the statement from the named day ahead of the other day", async () => {
    assert.equal((await selected("在 2026-03-02 那时南坡门方案怎么走"))[0], "plan-new");
    assert.equal((await selected("在 2026-01-02 那时南坡门方案怎么走"))[0], "plan-old");
  });

  it("keeps a protected statement that is far from the named day", async () => {
    const ids = await selected("在 2026-03-02 那时南坡门方案怎么走", ["plan-old"]);
    assert.deepEqual(ids.slice().sort(), ["plan-new", "plan-old"]);
  });
});
