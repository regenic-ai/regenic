const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { test } = require("node:test");
const {
  CustomerServiceCoordinator,
  CustomerServiceError,
  customerBusinessCitation,
} = require("../dist");

function hash(text) {
  return createHash("sha256").update(text).digest("hex");
}

function fixture(options = {}) {
  const texts = [
    "上次确认的是小王和小李，共 2 位。",
    "客户问：上次选中的 2 位都还没回复吗？",
    "小王的业务编号是 creator-1，小李是 creator-2；这里的回复指邀约回复。",
  ];
  const events = texts.map((text, index) => ({
    id: `event-${index + 1}`,
    org_id: "owner",
    source: "fixture",
    external_id: `message-${index + 1}`,
    operation: "create",
    content_hash: hash(text),
    content_media_type: "text/plain",
    thread_id: "fixture:conversation:customer-a",
    actor_id: index === 1 ? "customer" : "owner",
    required_scope_ids: ["customer-a"],
    occurred_at: `2026-10-22T04:0${index}:00.000Z`,
    ingested_at: `2026-10-22T04:0${index}:01.000Z`,
    ...(index === 2 ? { attrs: { parent_external_id: "message-1", native_thread_id: "topic-1" } } : {}),
  }));
  const blobs = new Map(events.map((event, index) => [
    event.content_hash,
    Buffer.from(texts[index], "utf8"),
  ]));
  const tasks = new Map();
  let id = 0;
  let now = 0;
  const businessState = {
    visibility: options.visibility ?? "customer",
    secondStatus: options.secondStatus ?? "found",
    version: "1",
  };
  const gateway = {
    id: "fixture-business",
    async query(input) {
      const queriedAt = `2026-10-22T05:${String(now++).padStart(2, "0")}:00.000Z`;
      const queryId = `query-${now}`;
      const members = input.members.map((member, index) => ({ member, index }));
      const pageMembers = options.paginate
        ? (input.page ? members.slice(1) : members.slice(0, 1))
        : members;
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
        queried_at: queriedAt,
        complete: !options.paginate || Boolean(input.page),
        ...(options.paginate && !input.page ? { next_page: "page-2" } : {}),
        results: pageMembers.map(({ member, index }) => ({
          member_key: member.member_key,
          business_id: member.business_id,
          status: index === 1 ? businessState.secondStatus : "found",
          record_id: `record-${index + 1}`,
          record_version: businessState.version,
          fields: (index === 1 && businessState.secondStatus !== "found") ? [] : [{
            field: "invitation_response",
            value: index === 0 ? "declined" : "pending",
            visibility: businessState.visibility,
            authority: "fixture-status",
            updated_at: "2026-10-22T04:30:00.000Z",
          }],
        })),
      };
    },
  };
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
        return blobs.has(contentHash)
          ? { content_hash: contentHash, media_type: "text/plain", byte_size: blobs.get(contentHash).length, created_at: events[0].ingested_at }
          : null;
      },
    },
    context_authority: {
      async openContextReadForThread() {
        return {
          read_epoch: "epoch-1",
          recorded_at: "2026-10-22T04:10:00.000Z",
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
        if (!bytes) throw new Error("missing");
        return bytes;
      },
      async getMany(contentHashes) {
        return new Map(contentHashes.flatMap((contentHash) =>
          blobs.has(contentHash) ? [[contentHash, blobs.get(contentHash)]] : []));
      },
    },
    context: {
      async assemble() {
        return {
          snapshot: { id: "snapshot-1" },
          bundle: {
            sections: [{
              items: [{
                kind: "event",
                resource_id: events[0].id,
                content_hash: events[0].content_hash,
                text: texts[0],
              }],
            }],
            degradation_flags: [],
          },
        };
      },
    },
    tasks: {
      async putCustomerServiceTask(task, expectedRevision) {
        const current = tasks.get(task.id);
        if (expectedRevision === undefined) {
          assert.equal(current, undefined);
        } else {
          assert.equal(current.revision, expectedRevision);
          assert.equal(task.revision, expectedRevision + 1);
        }
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
    business: gateway,
    now: () => "2026-10-22T05:00:00.000Z",
    create_id: () => `id-${++id}`,
  });
  return { coordinator, events, businessState };
}

test("customer task runs from source context through verified send", async () => {
  const { coordinator, events } = fixture();
  let task = await coordinator.createTask({
    source_event_id: events[1].id,
    content_hash: events[1].content_hash,
  });
  assert.equal(task.status, "resolving_context");
  assert.equal(task.brief.question, "客户问：上次选中的 2 位都还没回复吗？");

  const searched = await coordinator.searchContext(task.id, {
    query: "上次选中的 2 位 回复",
  });
  assert.deepEqual(
    searched.evidence.map((item) => item.event_id),
    ["event-1", "event-2", "event-3"],
  );
  assert.equal(
    searched.evidence.find((item) => item.event_id === "event-3").reply_to_event_id,
    "event-1",
  );
  const citation = searched.evidence[0].citation_id;

  task = await coordinator.updateBrief(task.id, {
    customer: { status: "verified", value: "customer-a", evidence: [citation] },
    project: { status: "verified", value: "project-a", evidence: [citation] },
    batch: { status: "verified", value: "batch-previous", evidence: [citation] },
    intent: { status: "verified", value: "invitation_response", evidence: [citation] },
    expected_member_count: 2,
    expected_count_evidence: citation,
    members_closed: true,
    members: [
      {
        member_key: "xiaowang",
        display_name: "小王",
        business_id: "creator-1",
        status: "verified",
        evidence: [citation],
        identity_evidence: citation,
      },
      {
        member_key: "xiaoli",
        display_name: "小李",
        business_id: "creator-2",
        status: "verified",
        evidence: [citation],
        identity_evidence: citation,
      },
    ],
    requested_fields: ["invitation_response"],
    unresolved: [],
  });
  assert.equal(task.status, "ready_for_query");

  task = await coordinator.queryBusiness(task.id);
  assert.equal(task.status, "verifying");
  assert.equal(task.business_evidence[0].results.length, 2);

  task = await coordinator.createDraft(task.id, {
    text: "小王已拒绝，小李目前仍待回复。",
    claims: [{
      claim_id: "claim-status",
      text: "两位的邀约回复状态",
      member_keys: ["xiaowang", "xiaoli"],
      fields: ["invitation_response"],
      evidence: [task.business_evidence[0].citation_id],
    }],
    covered_member_keys: ["xiaowang", "xiaoli"],
    unresolved: [],
  });
  assert.equal(task.status, "awaiting_review");

  task = await coordinator.reviewDraft(task.id, {
    result: "approved",
    reviewer: { actor_type: "human", actor_id: "owner" },
  });
  assert.equal(task.status, "approved");

  task = await coordinator.prepareSend(task.id);
  assert.equal(task.status, "sending");
  task = await coordinator.recordSent(task.id, {
    client_request_id: "send-1",
    event_id: "outbound-1",
  });
  assert.equal(task.status, "sent");
  assert.equal(task.draft.sent.event_id, "outbound-1");
});

test("customer brief cannot cite evidence from another task", async () => {
  const { coordinator, events } = fixture();
  const task = await coordinator.createTask({
    source_event_id: events[1].id,
    content_hash: events[1].content_hash,
  });
  await assert.rejects(
    coordinator.updateBrief(task.id, {
      customer: { status: "verified", value: "customer-a", evidence: ["context:foreign"] },
      project: { status: "unresolved", evidence: [] },
      batch: { status: "unresolved", evidence: [] },
      intent: { status: "unresolved", evidence: [] },
      members_closed: false,
      members: [],
      requested_fields: [],
    }),
    (error) => error instanceof CustomerServiceError && error.code === "invalid_request",
  );
});

test("missing business rows cannot be marked as covered", async () => {
    const { coordinator, events } = fixture({ secondStatus: "not_found" });
    const task = await readyTask(coordinator, events);
    const queried = await coordinator.queryBusiness(task.id);
    await assert.rejects(
      coordinator.createDraft(task.id, {
        text: "两位都已处理。",
        claims: [{
          claim_id: "claim-status",
          text: "两位状态",
          member_keys: ["xiaowang", "xiaoli"],
          fields: ["invitation_response"],
          evidence: [queried.business_evidence[0].citation_id],
        }],
        covered_member_keys: ["xiaowang", "xiaoli"],
        unresolved: [],
      }),
      (error) => error instanceof CustomerServiceError && error.code === "coverage_incomplete",
    );
  });

  test("internal business fields cannot support customer-visible claims", async () => {
    const { coordinator, events } = fixture({ visibility: "internal" });
    const task = await readyTask(coordinator, events);
    const queried = await coordinator.queryBusiness(task.id);
    await assert.rejects(
      coordinator.createDraft(task.id, {
        text: "内部状态。",
        claims: [{
          claim_id: "claim-status",
          text: "内部状态",
          member_keys: ["xiaowang", "xiaoli"],
          fields: ["invitation_response"],
          evidence: [queried.business_evidence[0].citation_id],
        }],
        covered_member_keys: ["xiaowang", "xiaoli"],
        unresolved: [],
      }),
      (error) => error instanceof CustomerServiceError && error.code === "invalid_request",
    );
  });

  test("changed business facts invalidate approval before send", async () => {
    const { coordinator, events, businessState } = fixture();
    const ready = await readyTask(coordinator, events);
    let task = await coordinator.queryBusiness(ready.id);
    task = await coordinator.createDraft(task.id, {
      text: "小王已拒绝，小李仍待回复。",
      claims: [{
        claim_id: "claim-status",
        text: "两位状态",
        member_keys: ["xiaowang", "xiaoli"],
        fields: ["invitation_response"],
        evidence: [task.business_evidence[0].citation_id],
      }],
      covered_member_keys: ["xiaowang", "xiaoli"],
      unresolved: [],
    });
    await coordinator.reviewDraft(task.id, {
      result: "approved",
      reviewer: { actor_type: "human", actor_id: "owner" },
    });
    businessState.version = "2";
    await assert.rejects(
      coordinator.prepareSend(task.id),
      (error) => error instanceof CustomerServiceError && error.code === "context_changed",
    );
    const invalidated = await coordinator.getTask(task.id);
    assert.equal(invalidated.status, "verifying");
    assert.equal(invalidated.draft.review, undefined);
  });

  test("verified brief values cannot omit task evidence", async () => {
    const { coordinator, events } = fixture();
    const task = await coordinator.createTask({
      source_event_id: events[1].id,
      content_hash: events[1].content_hash,
    });
    await assert.rejects(
      coordinator.updateBrief(task.id, {
        customer: { status: "verified", value: "customer-a", evidence: [] },
        project: { status: "verified", value: "project-a", evidence: [] },
        batch: { status: "verified", value: "batch-a", evidence: [] },
        intent: { status: "verified", value: "invitation_response", evidence: [] },
        members_closed: true,
        members: [{
          member_key: "xiaowang",
          display_name: "小王",
          business_id: "creator-1",
          status: "verified",
          evidence: [],
        }],
        requested_fields: ["invitation_response"],
        unresolved: [],
      }),
      (error) => error instanceof CustomerServiceError && error.code === "invalid_request",
    );
  });

  test("completed continuation chains can support a draft", async () => {
    const { coordinator, events } = fixture({ paginate: true });
    const ready = await readyTask(coordinator, events);
    let task = await coordinator.queryBusiness(ready.id);
    assert.equal(task.status, "querying");
    await assert.rejects(
      coordinator.queryBusiness(task.id, { page: "unexpected" }),
      (error) => error instanceof CustomerServiceError && error.code === "invalid_request",
    );
    task = await coordinator.queryBusiness(task.id, { page: "page-2" });
    assert.equal(task.status, "verifying");
    task = await coordinator.createDraft(task.id, {
      text: "小王已拒绝，小李仍待回复。",
      claims: [{
        claim_id: "claim-status",
        text: "两位状态",
        member_keys: ["xiaowang", "xiaoli"],
        fields: ["invitation_response"],
        evidence: task.business_evidence.map((item) => item.citation_id),
      }],
      covered_member_keys: ["xiaowang", "xiaoli"],
      unresolved: [],
    });
    assert.equal(task.status, "awaiting_review");
    task = await coordinator.reviewDraft(task.id, {
      result: "approved",
      reviewer: { actor_type: "human", actor_id: "owner" },
    });
    task = await coordinator.prepareSend(task.id);
    assert.equal(task.status, "sending");
  });

  async function readyTask(coordinator, events) {
    const created = await coordinator.createTask({
      source_event_id: events[1].id,
      content_hash: events[1].content_hash,
    });
    const searched = await coordinator.searchContext(created.id, {
      query: "上次选中的 2 位 回复",
    });
    const citation = searched.evidence[0].citation_id;
    return coordinator.updateBrief(created.id, {
      customer: { status: "verified", value: "customer-a", evidence: [citation] },
      project: { status: "verified", value: "project-a", evidence: [citation] },
      batch: { status: "verified", value: "batch-previous", evidence: [citation] },
      intent: { status: "verified", value: "invitation_response", evidence: [citation] },
      expected_member_count: 2,
      expected_count_evidence: citation,
      members_closed: true,
      members: [
        {
          member_key: "xiaowang",
          display_name: "小王",
          business_id: "creator-1",
          status: "verified",
          evidence: [citation],
          identity_evidence: citation,
        },
        {
          member_key: "xiaoli",
          display_name: "小李",
          business_id: "creator-2",
          status: "verified",
          evidence: [citation],
          identity_evidence: citation,
        },
      ],
      requested_fields: ["invitation_response"],
      unresolved: [],
    });
}
