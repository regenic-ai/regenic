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
]);
const TASKS = ["lookup", "anaphora", "aggregate", "temporal", "update"];

function semanticSearchMemoryFixture() {
  const root = join(__dirname, "../../evaluation");
  const labels = JSON.parse(readFileSync(join(root, "semantic-search-memory-v1.json"), "utf8"));
  const events = readFileSync(join(root, "semantic-search-memory-v1-events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  if (labels.id !== "semantic-search-memory-v1" || labels.license !== "MIT" || !Array.isArray(labels.cases)) {
    throw new Error("Semantic search memory labels are not the LongMemEval subset");
  }
  const byQuestion = new Map();
  for (const event of events) {
    const group = byQuestion.get(event.question_id) ?? [];
    group.push(event);
    byQuestion.set(event.question_id, group);
  }
  for (const value of labels.cases) {
    const unknown = Object.keys(value).filter((key) => !LABEL_KEYS.has(key));
    if (
      unknown.length > 0 ||
      !TASKS.includes(value.task) ||
      typeof value.query !== "string" ||
      !value.query.trim() ||
      !Array.isArray(value.relevant_event_ids)
    ) {
      throw new Error(`Semantic search memory label ${value.id} is not a LongMemEval case`);
    }
    const turns = byQuestion.get(value.source_question_id);
    if (!turns) {
      throw new Error(`Semantic search memory label ${value.id} has no turns`);
    }
    const marked = turns.filter((event) => event.has_answer).map((event) => event.id);
    if (marked.join("\n") !== value.relevant_event_ids.join("\n")) {
      throw new Error(`Semantic search memory label ${value.id} drifted from has_answer`);
    }
  }
  if (byQuestion.size !== labels.cases.length) {
    throw new Error("Semantic search memory events contain a question without a label");
  }
  const sources = events.map((event) => ({
    event: {
      event_id: event.id,
      org_id: "example-org",
      source: "longmemeval",
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
          read_epoch: "authority:semantic-search-memory-v1",
          recorded_at: "2026-01-01T00:00:00.000Z",
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
      async policyHash() { return "d".repeat(64); },
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
          consumer_id: "semantic-search-memory",
          purpose: "evaluate longmemeval semantic search",
          allowed_uses: ["display"],
          query: value.query,
          temporal: { mode: "current" },
          budget: { profile: "semantic-search-memory-v1", max_tokens: 10000, max_items: 10, max_raw_evidence: 10 },
          requested_kinds: ["event"],
        },
        relevant_event_ids: value.relevant_event_ids,
      })),
    },
  };
}

module.exports = { semanticSearchMemoryFixture };
