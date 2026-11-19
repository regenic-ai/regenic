const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const LABEL_KEYS = new Set([
  "id",
  "task",
  "source_question_id",
  "source_question_type",
  "query",
  "relevant_event_ids",
  "stale_event_ids",
]);
const TASKS = ["lookup", "anaphora", "aggregate", "temporal", "update", "boundary"];

function semanticSearchZhFixture() {
  const root = join(__dirname, "../../evaluation");
  const labels = JSON.parse(readFileSync(join(root, "semantic-search-zh-v1.json"), "utf8"));
  const events = readFileSync(join(root, "semantic-search-zh-v1-events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  if (labels.id !== "semantic-search-zh-v1" || labels.license !== "CC BY 4.0" || !Array.isArray(labels.cases)) {
    throw new Error("Semantic search Chinese labels are not the TimlMemBench subset");
  }
  const known = new Set(events.map((event) => event.id));
  if (known.size !== events.length) {
    throw new Error("Semantic search Chinese events repeat a turn");
  }
  for (const value of labels.cases) {
    const unknown = Object.keys(value).filter((key) => !LABEL_KEYS.has(key));
    const stale = value.stale_event_ids ?? [];
    if (
      unknown.length > 0 ||
      !TASKS.includes(value.task) ||
      typeof value.query !== "string" ||
      !value.query.trim() ||
      value.relevant_event_ids.length === 0 ||
      value.relevant_event_ids.some((eventId) => !known.has(eventId) || stale.includes(eventId)) ||
      stale.some((eventId) => !known.has(eventId))
    ) {
      throw new Error(`Semantic search Chinese label ${value.id} drifted from TimlMemBench`);
    }
  }
  const sources = events.map((event) => ({
    event: {
      event_id: event.id,
      org_id: "example-org",
      source: "timlmembench",
      external_id: event.id,
      operation: "create",
      occurred_at: event.occurred_at,
      ingested_at: event.occurred_at,
      content_hash: createHash("sha256").update(event.text).digest("hex"),
    },
    thread_id: event.thread_id,
    actor_id: event.role,
    required_scope_ids: ["scope-visible"],
    text: event.text,
  }));
  return {
    labels,
    events: sources,
    source: {
      async openRead() {
        return {
          read_epoch: "authority:semantic-search-zh-v1",
          recorded_at: labels.recorded_at,
          lifecycle_complete: true,
          lifecycle_heads: sources.map((value) => ({
            source: value.event.source,
            external_id: value.event.external_id,
            head_event_id: value.event.event_id,
          })),
          events: structuredClone(sources),
        };
      },
    },
    policy: {
      async policyHash() { return "e".repeat(64); },
      async visible({ resource }) {
        return resource.required_scope_ids.every((scope) => scope === "scope-visible");
      },
      async protectedEventIds() { return []; },
      async canReplay() { return true; },
    },
    dataset: {
      schema_version: "1.0",
      id: labels.id,
      cases: labels.cases.map((value) => ({
        id: value.id,
        task: value.task,
        request: {
          schema_version: "1.0",
          id: `request-${value.id}`,
          org_id: "example-org",
          principal: { actor_type: "human", actor_id: "person-1" },
          consumer_id: "semantic-search-zh",
          purpose: "evaluate chinese semantic search",
          allowed_uses: ["display"],
          query: value.query,
          temporal: { mode: "current" },
          budget: { profile: "semantic-search-zh-v1", max_tokens: 10000, max_items: 10, max_raw_evidence: 10 },
          requested_kinds: ["event"],
        },
        relevant_event_ids: value.relevant_event_ids,
        ...(value.stale_event_ids ? { stale_event_ids: value.stale_event_ids } : {}),
      })),
    },
  };
}

module.exports = { semanticSearchZhFixture };
