const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const {
  CustomerServiceCoordinator,
  CustomerServiceError,
  DeterministicContextEngine,
  DeterministicEventRetriever,
  customerBusinessCitation,
} = require("../../dist");
const {
  MemoryContextArtifactStore,
  MemoryContextRetrieverRegistry,
} = require("@regenic/domain");

const CATEGORY_SPECS = [
  { category: "reference_resolution", action: "query_business", members: true },
  { category: "set_closure", action: "query_business", members: true },
  { category: "reply_chain", action: "query_business", members: true },
  { category: "continuation_gap", action: "query_business", members: true },
  {
    category: "identity_ambiguity",
    action: "clarify",
    forbidden_claims: ["身份已确认"],
  },
  {
    category: "cross_conversation_scope",
    action: "clarify",
    forbidden_claims: ["跨会话范围已确认"],
  },
  {
    category: "business_not_found",
    action: "human",
    members: true,
    business_status: "not_found",
    forbidden_claims: ["所有人都未回复"],
  },
  {
    category: "business_denied",
    action: "human",
    members: true,
    business_status: "permission_denied",
    forbidden_claims: ["所有人都已拒绝"],
  },
  {
    category: "business_unavailable",
    action: "human",
    members: true,
    business_status: "unavailable",
    forbidden_claims: ["业务系统不可用时仍给出状态结论"],
  },
  {
    category: "internal_visibility",
    action: "human",
    members: true,
    visibility: "internal",
    forbidden_claims: ["内部字段可直接对客户披露"],
  },
  {
    category: "stale_context",
    action: "retry",
    members: true,
    stale_detection_required: true,
  },
  {
    category: "business_changed",
    action: "redraft",
    members: true,
  },
];

function customerServiceEvaluationFixture() {
  const cases = CATEGORY_SPECS.flatMap((spec) =>
    Array.from({ length: 5 }, (_value, index) => evaluationCase(spec, index + 1)));
  return {
    dataset: {
      schema_version: "1.0",
      id: "customer-service-synthetic-regression-v1",
      cases,
    },
    execute: executeCustomerServiceCase,
  };
}

function evaluationCase(spec, variant) {
  const suffix = String(variant).padStart(2, "0");
  const id = `cs-${spec.category}-${suffix}`;
  const memberCount = spec.members ? 2 + ((variant - 1) % 3) : 0;
  return {
    id,
    category: spec.category,
    question: `${id}：上次选中的 ${Math.max(memberCount, 2)} 位都回复了吗？`,
    required_event_ids: [`${id}:scope`, `${id}:question`, `${id}:identity`],
    ...(spec.members
      ? { expected_member_keys: Array.from({ length: memberCount }, (_item, member) => `${id}:member-${member + 1}`) }
      : {}),
    expected_action: spec.action,
    ...(spec.forbidden_claims ? { forbidden_claims: spec.forbidden_claims } : {}),
    ...(spec.stale_detection_required ? { stale_detection_required: true } : {}),
  };
}

async function executeCustomerServiceCase(value) {
  const harness = createHarness(value);
  let task = await harness.coordinator.createTask({
    source_event_id: harness.events[1].id,
    content_hash: harness.events[1].content_hash,
  });
  const contextInput = value.category === "continuation_gap"
    ? { query: value.question, max_items: 1, neighbor_count: 4 }
    : value.category === "reply_chain"
      ? { query: `${value.id} 身份`, max_items: 3, neighbor_count: 0 }
      : { query: value.question, max_items: 40, neighbor_count: 4 };
  let searched = await harness.coordinator.searchContext(task.id, contextInput);
  const evidence = [...searched.evidence];
  if (value.category === "continuation_gap") {
    while (searched.continuations.length) {
      const after = searched.continuations.find((item) => item.direction === "after");
      if (!after) break;
      searched = await harness.coordinator.readContext(task.id, {
        continuation_handle: after.handle,
        max_items: 40,
      });
      evidence.push(...searched.evidence);
    }
  }
  const selected = [...new Map(evidence.map((item) => [item.event_id, item])).values()];
  const observation = {
    selected_event_ids: selected.map((item) => item.event_id),
    citations: selected.map((item) => ({
      event_id: item.event_id,
      content_hash_valid: hash(item.text) === item.content_hash,
    })),
    resolved_member_keys: [],
    action: value.expected_action,
    claims: [],
    stale_detected: false,
  };
  const citation = selected[0]?.citation_id;
  assert.ok(citation, `${value.id} must retrieve at least one citation`);

  if (value.expected_action === "clarify") {
    if (value.category === "cross_conversation_scope") {
      await assert.rejects(
        harness.coordinator.searchContext(task.id, {
          query: value.question,
          include_related: true,
        }),
        (error) => error instanceof CustomerServiceError && error.code === "invalid_state",
      );
    }
    task = await harness.coordinator.updateBrief(task.id, {
      customer: { status: "candidate", value: "customer-a", evidence: [citation] },
      project: { status: "unresolved", evidence: [] },
      batch: { status: "unresolved", evidence: [] },
      intent: { status: "candidate", value: "invitation_response", evidence: [citation] },
      members_closed: false,
      members: [],
      requested_fields: [],
      unresolved: ["customer_scope", "member_identity"],
    });
    assert.equal(task.status, "needs_clarification");
    observation.action = "clarify";
    return observation;
  }

  task = await readyTask(harness, task, citation, value.expected_member_keys ?? []);
  observation.resolved_member_keys = task.brief.members.map((member) => member.member_key);

  if (value.expected_action === "retry") {
    const bounded = await harness.coordinator.searchContext(task.id, {
      query: value.question,
      max_items: 1,
      neighbor_count: 4,
    });
    const continuation = bounded.continuations.find((item) => item.direction === "after");
    assert.ok(continuation);
    harness.changeReadEpoch();
    await assert.rejects(
      harness.coordinator.readContext(task.id, {
        continuation_handle: continuation.handle,
        max_items: 40,
      }),
      (error) => {
        observation.stale_detected =
          error instanceof CustomerServiceError && error.code === "context_changed";
        return observation.stale_detected;
      },
    );
    observation.action = "retry";
    return observation;
  }

  task = await harness.coordinator.queryBusiness(task.id);
  if (value.expected_action === "human") {
    const unsafeText = value.forbidden_claims?.[0] ?? "无法确认";
    let rejected = false;
    try {
      await harness.coordinator.createDraft(task.id, draftInput(
        task,
        value.expected_member_keys ?? [],
        unsafeText,
      ));
    } catch (error) {
      rejected = error instanceof CustomerServiceError
        && ["coverage_incomplete", "invalid_request"].includes(error.code);
    }
    assert.equal(rejected, true, `${value.id} must reject an unsafe draft`);
    observation.action = "human";
    return observation;
  }

  if (value.expected_action === "redraft") {
    task = await harness.coordinator.createDraft(task.id, draftInput(
      task,
      value.expected_member_keys ?? [],
      "已根据当前业务记录生成回复。",
    ));
    observation.claims = task.draft.claims.map((claim) => claim.text);
    task = await harness.coordinator.reviewDraft(task.id, {
      result: "approved",
      reviewer: { actor_type: "human", actor_id: "owner" },
    });
    harness.changeBusinessVersion();
    await assert.rejects(
      harness.coordinator.prepareSend(task.id),
      (error) => error instanceof CustomerServiceError && error.code === "context_changed",
    );
    observation.action = "redraft";
    return observation;
  }

  assert.equal(task.status, "verifying");
  observation.action = "query_business";
  return observation;
}

async function readyTask(harness, task, citation, memberKeys) {
  return harness.coordinator.updateBrief(task.id, {
    customer: { status: "verified", value: "customer-a", evidence: [citation] },
    project: { status: "verified", value: "project-a", evidence: [citation] },
    batch: { status: "verified", value: "batch-a", evidence: [citation] },
    intent: { status: "verified", value: "invitation_response", evidence: [citation] },
    expected_member_count: memberKeys.length,
    expected_count_evidence: citation,
    members_closed: true,
    members: memberKeys.map((memberKey, index) => ({
      member_key: memberKey,
      display_name: `成员 ${index + 1}`,
      business_id: `business-${index + 1}`,
      status: "verified",
      evidence: [citation],
      identity_evidence: citation,
    })),
    requested_fields: ["invitation_response"],
    unresolved: [],
  });
}

function draftInput(task, memberKeys, text) {
  return {
    text,
    claims: [{
      claim_id: "claim-status",
      text,
      member_keys: memberKeys,
      fields: ["invitation_response"],
      evidence: task.business_evidence.map((item) => item.citation_id),
    }],
    covered_member_keys: memberKeys,
    unresolved: [],
  };
}

function createHarness(value) {
  const texts = [
    `${value.id} 范围：客户 customer-a，项目 project-a，批次 batch-a。`,
    value.question,
    `${value.id} 身份：${(value.expected_member_keys ?? ["候选甲", "候选乙"]).join("，")}；回复指邀约回复。`,
  ];
  const events = texts.map((text, index) => ({
    id: value.required_event_ids[index],
    org_id: "owner",
    source: "fixture",
    external_id: `${value.id}:message-${index + 1}`,
    operation: "create",
    content_hash: hash(text),
    content_media_type: "text/plain",
    thread_id: `fixture:${value.id}`,
    actor_id: index === 1 ? "customer" : "owner",
    required_scope_ids: [`scope:${value.id}`],
    occurred_at: `2026-10-29T0${index}:00:00.000Z`,
    ingested_at: `2026-10-29T0${index}:00:01.000Z`,
    ...(index === 2 ? { attrs: { parent_external_id: `${value.id}:message-1` } } : {}),
  }));
  const blobs = new Map(events.map((event, index) => [
    event.content_hash,
    Buffer.from(texts[index], "utf8"),
  ]));
  const tasks = new Map();
  let nextId = 0;
  let readEpoch = "epoch-1";
  let businessVersion = "1";
  const category = CATEGORY_SPECS.find((item) => item.category === value.category);
  assert.ok(category);
  const retrievers = new MemoryContextRetrieverRegistry();
  retrievers.register(new DeterministicEventRetriever());
  const context = new DeterministicContextEngine({
    source: {
      async openRead() {
        return {
          read_epoch: readEpoch,
          recorded_at: "2026-10-29T04:00:00.000Z",
          lifecycle_complete: true,
          lifecycle_heads: events.map((event) => ({
            source: event.source,
            external_id: event.external_id,
            head_event_id: event.id,
          })),
          events: events.map((event, index) => ({
            event: {
              event_id: event.id,
              org_id: event.org_id,
              source: event.source,
              external_id: event.external_id,
              operation: event.operation,
              occurred_at: event.occurred_at,
              ingested_at: event.ingested_at,
              content_hash: event.content_hash,
            },
            thread_id: event.thread_id,
            actor_id: event.actor_id,
            required_scope_ids: event.required_scope_ids,
            text: texts[index],
          })),
        };
      },
    },
    policy: {
      async policyHash() {
        return "e".repeat(64);
      },
      async visible() {
        return true;
      },
      async protectedEventIds() {
        return [];
      },
      async canReplay() {
        return true;
      },
    },
    artifacts: new MemoryContextArtifactStore(),
    retrievers,
  });
  const coordinator = new CustomerServiceCoordinator({
    org_id: "owner",
    principal: { actor_type: "human", actor_id: "owner" },
    authority: {
      async getEvent(orgId, eventId) {
        return structuredClone(events.find((event) =>
          event.org_id === orgId && event.id === eventId) ?? null);
      },
      async findBySourceIdentity(identity) {
        return structuredClone(events.find((event) =>
          event.org_id === identity.org_id
          && event.source === identity.source
          && event.external_id === identity.external_id) ?? null);
      },
      async findBlob(contentHash) {
        const bytes = blobs.get(contentHash);
        return bytes
          ? {
              content_hash: contentHash,
              media_type: "text/plain",
              byte_size: bytes.length,
              created_at: events[0].ingested_at,
            }
          : null;
      },
    },
    context_authority: {
      async openContextReadForThread() {
        return {
          read_epoch: readEpoch,
          recorded_at: "2026-10-29T04:00:00.000Z",
          events: structuredClone(events),
          lifecycle_heads: events.map((event) => ({
            source: event.source,
            external_id: event.external_id,
            head_event_id: event.id,
          })),
        };
      },
    },
    blobs: {
      async get(contentHash) {
        const bytes = blobs.get(contentHash);
        if (!bytes) throw new Error("missing blob");
        return bytes;
      },
      async getMany(contentHashes) {
        return new Map(contentHashes.flatMap((contentHash) =>
          blobs.has(contentHash) ? [[contentHash, blobs.get(contentHash)]] : []));
      },
    },
    context,
    tasks: {
      async putCustomerServiceTask(task, expectedRevision) {
        const current = tasks.get(task.id);
        if (expectedRevision === undefined) assert.equal(current, undefined);
        else assert.equal(current.revision, expectedRevision);
        tasks.set(task.id, structuredClone(task));
        return structuredClone(task);
      },
      async getCustomerServiceTask(orgId, taskId) {
        const task = tasks.get(taskId);
        return task?.org_id === orgId ? structuredClone(task) : null;
      },
      async listCustomerServiceTasks() {
        return [...tasks.values()].map(structuredClone);
      },
    },
    business: {
      id: "fixture-business",
      async query(input) {
        const status = category.business_status ?? "found";
        const queryId = `query:${value.id}:${businessVersion}`;
        return {
          citation_id: customerBusinessCitation(queryId),
          query_id: queryId,
          task_id: input.task_id,
          brief_version: input.brief_version,
          provider_id: "fixture-business",
          customer_id: input.customer_id,
          project_id: input.project_id,
          batch_id: input.batch_id,
          requested_fields: input.fields,
          queried_at: "2026-10-29T05:00:00.000Z",
          complete: true,
          results: input.members.map((member, index) => ({
            member_key: member.member_key,
            business_id: member.business_id,
            status: index === 0 ? status : "found",
            fields: index === 0 && status !== "found"
              ? []
              : [{
                  field: "invitation_response",
                  value: index % 2 === 0 ? "declined" : "pending",
                  visibility: category.visibility ?? "customer",
                  authority: "fixture-status",
                  updated_at: "2026-10-29T04:30:00.000Z",
                }],
            ...(index === 0 && status !== "found"
              ? {}
              : {
                  record_id: `record-${index + 1}`,
                  record_version: businessVersion,
                }),
          })),
        };
      },
    },
    now: () => "2026-10-29T05:00:00.000Z",
    create_id: () => `${value.id}:id-${++nextId}`,
  });
  return {
    coordinator,
    events,
    changeReadEpoch() {
      readEpoch = "epoch-2";
    },
    changeBusinessVersion() {
      businessVersion = "2";
    },
  };
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

module.exports = {
  CATEGORY_SPECS,
  customerServiceEvaluationFixture,
};
