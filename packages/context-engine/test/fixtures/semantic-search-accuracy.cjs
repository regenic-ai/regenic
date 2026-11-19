const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const LABEL_KEYS = new Set(["id", "task", "query", "relevant_event_ids", "filters"]);
const FILTER_KEYS = new Set(["occurred_after", "occurred_before", "thread_ids"]);

function semanticSearchAccuracyFixture() {
  const labels = JSON.parse(readFileSync(
    join(__dirname, "../../evaluation/semantic-search-accuracy-v1.json"),
    "utf8",
  ));
  for (const value of labels.cases) {
    const unknown = Object.keys(value).filter((key) => !LABEL_KEYS.has(key));
    if (unknown.length > 0 || typeof value.query !== "string" || value.query.trim() !== value.query) {
      throw new Error(`Semantic search label ${value.id} must store only the query and Event ids`);
    }
    if (value.filters && Object.keys(value.filters).some((key) => !FILTER_KEYS.has(key))) {
      throw new Error(`Semantic search label ${value.id} has an unsupported filter`);
    }
  }
  const specs = [
    { id: "rel-old", external: "release-window", text: "发布延迟。", time: "2026-09-01T00:00:00.000Z", thread: "thread-release" },
    { id: "rel-window", external: "release-window", parent: "rel-old", text: "周五发布窗口定在 18:00，版本 1.4.0。", time: "2026-09-01T01:00:00.000Z", thread: "thread-release" },
    { id: "rel-ack", text: "好的，明天发你发布说明。", time: "2026-09-02T00:00:00.000Z", thread: "thread-release" },
    { id: "rel-note", text: "发布说明已发，版本 1.4.0。", time: "2026-09-03T00:00:00.000Z", thread: "thread-release" },
    { id: "rel-cancel", text: "本周不发布，窗口取消。", time: "2026-10-02T00:00:00.000Z", thread: "thread-release" },
    { id: "inc-open", text: "工单 RG-2048：数据库连接池耗尽，重试间隔 30 秒。", time: "2026-09-10T00:00:00.000Z", thread: "thread-incident" },
    { id: "inc-action", text: "这个工单先撤回版本，再恢复上一版服务。", time: "2026-09-10T01:00:00.000Z", thread: "thread-incident" },
    { id: "inc-close", text: "RG-2048 已恢复。", time: "2026-09-11T00:00:00.000Z", thread: "thread-incident" },
    { id: "mtg-status", text: "周会：检查队列运行状态。", time: "2026-09-15T00:00:00.000Z", thread: "thread-meeting" },
    { id: "mtg-decision", text: "关键结论：幂等键必须包含来源身份。", time: "2026-09-15T01:00:00.000Z", thread: "thread-meeting" },
    { id: "mtg-follow", text: "继续观察任务执行情况。", time: "2026-09-16T00:00:00.000Z", thread: "thread-meeting" },
    { id: "en-approve", text: "The release was approved and will ship on schedule.", time: "2026-09-20T00:00:00.000Z", thread: "thread-en" },
    { id: "en-rollback", text: "If the deploy fails, roll back the version first.", time: "2026-09-21T00:00:00.000Z", thread: "thread-en" },
    { id: "en-token", text: "API tokens stay in the local credential store.", time: "2026-09-22T00:00:00.000Z", thread: "thread-en" },
    { id: "bill-aug", text: "八月账单：席位 12，金额 2400。", time: "2026-08-01T00:00:00.000Z", thread: "thread-bill" },
    { id: "bill-sep", text: "九月账单：席位 15，金额 3000。", time: "2026-09-01T00:00:00.000Z", thread: "thread-bill" },
    { id: "bill-oct", text: "十月账单：席位 15，金额 3000。", time: "2026-10-01T00:00:00.000Z", thread: "thread-bill" },
    { id: "trad-backup", text: "備份還原流程已確認。", time: "2026-09-18T00:00:00.000Z", thread: "thread-ops" },
    { id: "hidden", text: "紫锆：内部审批备注。", time: "2026-09-18T00:00:00.000Z", thread: "thread-hidden", scope: "scope-hidden" },
  ];
  const events = specs.map((spec) => ({
    event: {
      event_id: spec.id,
      org_id: "example-org",
      source: "synthetic",
      external_id: spec.external ?? spec.id,
      operation: spec.parent ? "revise" : "create",
      occurred_at: spec.time,
      ingested_at: spec.time,
      ...(spec.parent ? { parent_event_id: spec.parent } : {}),
      content_hash: createHash("sha256").update(spec.text).digest("hex"),
    },
    thread_id: spec.thread,
    actor_id: "actor-1",
    required_scope_ids: [spec.scope ?? "scope-visible"],
    text: spec.text,
  }));
  const parentIds = new Set(specs.map((spec) => spec.parent).filter(Boolean));
  const knownIds = new Set(specs.map((spec) => spec.id));
  for (const value of labels.cases) {
    for (const eventId of value.relevant_event_ids) {
      if (!knownIds.has(eventId) || eventId === "hidden" || eventId === "rel-old") {
        throw new Error(`Semantic search label ${value.id} points at ${eventId}`);
      }
    }
  }
  return {
    labels,
    events,
    source: {
      async openRead() {
        return {
          read_epoch: "authority:semantic-search-accuracy-v1",
          recorded_at: "2026-10-16T00:00:00.000Z",
          lifecycle_complete: true,
          lifecycle_heads: events.filter((value) => !parentIds.has(value.event.event_id)).map((value) => ({
            source: value.event.source,
            external_id: value.event.external_id,
            head_event_id: value.event.event_id,
          })),
          events: structuredClone(events),
        };
      },
    },
    policy: {
      async policyHash() { return "c".repeat(64); },
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
          consumer_id: "semantic-search-accuracy",
          purpose: "evaluate synthetic semantic search",
          allowed_uses: ["display"],
          query: value.query,
          temporal: { mode: "current" },
          budget: { profile: "semantic-search-accuracy-v1", max_tokens: 10000, max_items: 10, max_raw_evidence: 10 },
          requested_kinds: ["event"],
          ...(value.filters ? { filters: value.filters } : {}),
        },
        relevant_event_ids: value.relevant_event_ids,
        forbidden_event_ids: ["hidden"],
        stale_event_ids: ["rel-old"],
      })),
    },
  };
}

module.exports = { semanticSearchAccuracyFixture };
