const { createHash } = require("node:crypto");

// Independent synthetic labels: do not use this split to tune retrieval parameters.
function semanticHoldoutFixture() {
  const specs = [
    ["invoice", "财务约定：每月十日核对账单，逾期先联系供应商，暂不自动扣款。"],
    ["travel", "差旅报销必须附电子发票和项目编号，由部门经理确认后付款。"],
    ["credentials", "访问口令丢失时先核验身份，再签发一次性恢复链接，旧链接立即失效。"],
    ["backup", "每周六凌晨执行完整备份，恢复操作必须先在隔离环境验证。"],
    ["meeting", "设计评审移至周四下午三点，参会者提前提交界面草图。"],
    ["inventory", "仓库缺货时创建采购申请，禁止用未经登记的替代零件。"],
    ["access", "临时访客只允许查看公开资料，合同原件仅限法务团队访问。"],
    ["incident", "工单 OPS-731：缓存节点磁盘写满，先清理过期分片再恢复写入。"],
    ["deployment", "新版本已经通过审批，今晚二十点开始灰度发布。"],
    ["freeze", "支付模块尚未完成对账核验，本周禁止更新生产版本。"],
    ["old", "钌钨：原来的结算安排已取消。"],
    ["current", "新的结算安排：所有退款在五个工作日内原路返回。", { external: "old", parent: "old" }],
    ["deleted", "铋锑：过期采购记录。"],
    ["tombstone", undefined, { external: "deleted", parent: "deleted", deleted: true }],
    ["hidden", "镍钼：不向当前使用者开放的资料。", { hidden: true }],
  ];
  const cases = [
    ["invoice", "每月哪天检查供应商账单？", ["invoice"]],
    ["travel", "出差花费要拿什么凭证才能领回钱？", ["travel"]],
    ["credentials", "忘记密码以后怎么重新登录？", ["credentials"]],
    ["backup", "How do we verify data restoration?", ["backup"]],
    ["meeting", "设计评审几点开始？", ["meeting"]],
    ["inventory", "零件不够用了该怎么办？", ["inventory"]],
    ["access", "访客能阅读原始合同吗？", ["access"]],
    ["identifier", "OPS-731", ["incident"]],
    ["incident", "缓存无法写入是因为什么？", ["incident"]],
    ["deployment", "今晚几点上线新版本？", ["deployment"]],
    ["negation", "支付模块本周能更新吗？", ["freeze"], { thread_ids: ["thread-freeze"] }],
    ["refund", "退款要等多久才能到账？", ["current"]],
    ["filtered", "备份怎么恢复", [], { sources: ["not-present"] }],
    ["hidden", "镍钼", []],
    ["deleted", "铋锑", []],
    ["superseded", "钌钨", []],
    ["unrelated", "如何给火星上的向日葵授粉？", []],
    ["noise", "zxqv991kzz", []],
  ];
  return createSemanticFixture(specs, cases, "semantic-synthetic-holdout-v1");
}

function createSemanticFixture(specs, cases, id) {
  const events = specs.map(([id, text, options = {}]) => ({
    event: {
      event_id: id, org_id: "example-org", source: "holdout", external_id: options.external ?? id,
      operation: options.deleted ? "tombstone" : options.parent ? "revise" : "create",
      occurred_at: "2026-10-16T00:00:00.000Z", ingested_at: "2026-10-16T00:00:00.000Z",
      ...(options.parent ? { parent_event_id: options.parent } : {}),
      ...(text ? { content_hash: createHash("sha256").update(text).digest("hex") } : {}),
    },
    thread_id: `thread-${options.external ?? id}`, actor_id: "holdout-actor",
    required_scope_ids: [options.hidden ? "hidden" : "visible"],
    ...(text ? { text } : {}),
  }));
  const parents = new Set(events.map((entry) => entry.event.parent_event_id).filter(Boolean));
  return {
    events,
    source: { async openRead() { return {
      read_epoch: `authority:${id}`, recorded_at: "2026-10-17T00:00:00.000Z",
      lifecycle_complete: true,
      lifecycle_heads: events.filter((entry) => !parents.has(entry.event.event_id)).map((entry) => ({
        source: entry.event.source, external_id: entry.event.external_id, head_event_id: entry.event.event_id,
      })),
      events: structuredClone(events),
    }; } },
    policy: {
      async policyHash() { return "d".repeat(64); },
      async visible({ resource }) { return resource.required_scope_ids.every((scope) => scope === "visible"); },
      async protectedEventIds() { return []; }, async canReplay() { return true; },
    },
    dataset: { schema_version: "1.0", id,
      cases: cases.map(([id, query, relevant, filters]) => ({
        id, relevant_event_ids: relevant, forbidden_event_ids: ["hidden"],
        stale_event_ids: ["old", "deleted", "tombstone"],
        request: {
          schema_version: "1.0", id: `holdout-${id}`, org_id: "example-org",
          principal: { actor_type: "human", actor_id: "person-1" },
          consumer_id: "synthetic-holdout", purpose: "evaluate independent synthetic retrieval",
          allowed_uses: ["display"], query, temporal: { mode: "current" }, requested_kinds: ["event"],
          budget: { profile: "holdout-v1", max_tokens: 10000, max_items: 10, max_raw_evidence: 10 },
          ...(filters ? { filters } : {}),
        },
      })),
    },
  };
}

module.exports = { semanticHoldoutFixture, createSemanticFixture };
