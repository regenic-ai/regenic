const { createHash } = require("node:crypto");

// Synthetic development labels, not a held-out quality or organization-ACL certification set.
function chineseRetrievalFixture() {
  const specs = [
    { id: "release-old", external: "release", text: "锇钛：发布延迟。", time: "2026-10-13T00:00:00.000Z" },
    { id: "release", external: "release", parent: "release-old", text: "release 发布已获批准，按计划上线。负责人：林青。" },
    { id: "rollback", text: "部署异常时先撤回版本，再恢复上一版服务。" },
    { id: "incident", text: "工单 RG-2048：数据库连接池耗尽，重试间隔 30 秒。" },
    { id: "freeze", text: "本周不发布，不要执行上线。" },
    { id: "traditional", text: "備份還原流程已確認。" },
    { id: "token", text: "api_token 仅保存在本地凭据库。" },
    { id: "date", text: "2026-10-14 完成演练，2026-10-16 复查。" },
    { id: "long", text: `${"周会记录：检查队列运行状态。\n".repeat(40)}关键结论：幂等键必须包含来源身份。\n${"继续观察任务执行情况。\n".repeat(40)}` },
    { id: "hidden", text: "紫锆：内部审批内容。", scope: "scope-hidden" },
    { id: "deleted", external: "deleted", text: "钒铂：已经撤下的记录。" },
    { id: "tombstone", external: "deleted", parent: "deleted", deleted: true, time: "2026-10-15T00:00:00.000Z" },
  ];
  const events = specs.map((spec) => ({
    event: {
      event_id: spec.id,
      org_id: "example-org",
      source: "synthetic",
      external_id: spec.external ?? spec.id,
      operation: spec.deleted ? "tombstone" : spec.parent ? "revise" : "create",
      occurred_at: spec.time ?? "2026-10-14T00:00:00.000Z",
      ingested_at: spec.time ?? "2026-10-14T00:00:00.000Z",
      ...(spec.parent ? { parent_event_id: spec.parent } : {}),
      ...(spec.text ? { content_hash: createHash("sha256").update(spec.text).digest("hex") } : {}),
    },
    thread_id: `thread-${spec.external ?? spec.id}`,
    actor_id: "actor-1",
    required_scope_ids: [spec.scope ?? "scope-visible"],
    ...(spec.text ? { text: spec.text } : {}),
  }));
  const parentIds = new Set(specs.map((spec) => spec.parent));
  const source = {
    async openRead() {
      return {
        read_epoch: "authority:chinese-development-v1",
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
  };
  const policy = {
    async policyHash() { return "c".repeat(64); },
    async visible({ resource }) {
      return resource.required_scope_ids.every((scope) => scope === "scope-visible");
    },
    async protectedEventIds() { return []; },
    async canReplay() { return true; },
  };
  const definitions = [
    { id: "chinese-exact", query: "发布批准", relevant: ["release"] },
    { id: "spoken", query: "服务挂了咋整", relevant: ["rollback"] },
    { id: "identifier", query: "RG-2048", relevant: ["incident"] },
    { id: "date", query: "2026-10-14", relevant: ["date"] },
    { id: "negation", query: "不发布", relevant: ["freeze"] },
    { id: "traditional", query: "備份還原", relevant: ["traditional"] },
    { id: "full-width", query: "ＡＰＩ＿ＴＯＫＥＮ", relevant: ["token"] },
    { id: "mixed-language", query: "release 发布", relevant: ["release"] },
    { id: "long-local-fact", query: "幂等键", relevant: ["long"] },
    { id: "cross-language-gap", query: "capacity exhausted", relevant: ["incident"] },
    { id: "synonym-gap", query: "rollback", relevant: ["rollback"] },
    { id: "thread-filter", query: "发布", relevant: ["freeze"], filters: { thread_ids: ["thread-freeze"] } },
    { id: "hidden-only", query: "紫锆", relevant: [] },
    { id: "deleted-only", query: "钒铂", relevant: [] },
    { id: "superseded-only", query: "锇钛", relevant: [] },
    { id: "no-match", query: "铱铪", relevant: [] },
  ];
  return {
    events,
    source,
    policy,
    dataset: {
      schema_version: "1.0",
      id: "chinese-retrieval-development-v1",
      cases: definitions.map((value) => ({
        id: value.id,
        request: {
          schema_version: "1.0",
          id: `request-${value.id}`,
          org_id: "example-org",
          principal: { actor_type: "human", actor_id: "person-1" },
          consumer_id: "chinese-retrieval-evaluation",
          purpose: "evaluate synthetic Chinese retrieval",
          allowed_uses: ["display"],
          query: value.query,
          temporal: { mode: "current" },
          budget: { profile: "chinese-eval-v1", max_tokens: 10000, max_items: 10, max_raw_evidence: 10 },
          requested_kinds: ["event"],
          ...(value.filters ? { filters: value.filters } : {}),
        },
        relevant_event_ids: value.relevant,
        forbidden_event_ids: ["hidden"],
        stale_event_ids: ["release-old", "deleted", "tombstone"],
      })),
    },
  };
}

module.exports = { chineseRetrievalFixture };
