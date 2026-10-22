const assert = require("node:assert/strict");
const { createServer } = require("node:http");
const { test } = require("node:test");
const { join } = require("node:path");
const { SqliteAuthorityStore } = require("@regenic/authority-store/sqlite");
const { FsBlobStore } = require("@regenic/blob-store");
const { INGEST_SCHEMA_VERSION, IngestionService } = require("@regenic/domain");
const {
  createRoot,
  startPersonalApi,
} = require("./personal-api-harness.cjs");

test("personal API runs evidence-bound customer task through human approval", async () => {
  const root = await createRoot();
  const database = join(root, "authority.db");
  const blobRoot = join(root, "blobs");
  const source = await ingestCustomerConversation(database, blobRoot);
  const business = await startBusinessStub();
  const { app, origin } = await startPersonalApi(database, blobRoot, {
    REGENIC_CUSTOMER_BUSINESS_URL: business.url,
  });
  try {
    await runWorkflow(origin, source, business);
  } finally {
    await app.close();
    await business.close();
  }
});

async function runWorkflow(origin, source, business) {
  let response = await post(origin, "/v1/me/context/customer-tasks", {
    source_event_id: source.event_id,
    content_hash: source.content_hash,
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  let task = response.body;

  response = await post(origin, `/v1/me/context/customer-tasks/${task.id}/search`, {
    query: "上次选中的 2 位 回复",
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  assert.ok(response.body.evidence.length >= 2);
  const citation = response.body.evidence[0].citation_id;

  response = await post(origin, `/v1/me/context/customer-tasks/${task.id}/brief`, {
    customer: { status: "verified", value: "customer-a", evidence: [citation] },
    project: { status: "verified", value: "project-a", evidence: [citation] },
    batch: { status: "verified", value: "batch-a", evidence: [citation] },
    intent: { status: "verified", value: "invitation_response", evidence: [citation] },
    expected_member_count: 2,
    expected_count_evidence: citation,
    members_closed: true,
    members: [
      {
        member_key: "wang",
        display_name: "小王",
        business_id: "creator-1",
        status: "verified",
        evidence: [citation],
        identity_evidence: citation,
      },
      {
        member_key: "li",
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
  assert.equal(response.status, 201);
  assert.equal(response.body.status, "ready_for_query");

  response = await post(origin, `/v1/me/context/customer-tasks/${task.id}/query`, {});
  assert.equal(response.status, 201);
  task = response.body;
  assert.equal(task.status, "verifying");
  assert.deepEqual(business.requests[0].members, [
    { member_key: "wang", business_id: "creator-1" },
    { member_key: "li", business_id: "creator-2" },
  ]);

  response = await post(origin, `/v1/me/context/customer-tasks/${task.id}/draft`, {
    text: "小王已拒绝，小李仍待回复。",
    claims: [{
      claim_id: "statuses",
      text: "两位当前邀约回复状态",
      member_keys: ["wang", "li"],
      fields: ["invitation_response"],
      evidence: [task.business_evidence[0].citation_id],
    }],
    covered_member_keys: ["wang", "li"],
    unresolved: [],
  });
  assert.equal(response.status, 201);
  assert.equal(response.body.status, "awaiting_review");

  response = await post(origin, `/v1/me/context/customer-tasks/${task.id}/review`, {
    result: "approved",
  });
  assert.equal(response.status, 201);
  assert.equal(response.body.status, "approved");

  const listed = await fetch(`${origin}/v1/me/context/customer-tasks`);
  assert.equal(listed.status, 200);
  assert.equal((await listed.json())[0].id, task.id);
}

async function ingestCustomerConversation(database, blobRoot) {
  const authority = new SqliteAuthorityStore(database);
  const blobs = new FsBlobStore(blobRoot);
  const service = new IngestionService(blobs, authority);
  const records = [
    {
      operation: "create",
      source: "fixture",
      external_id: "customer-a:1",
      occurred_at: "2026-10-22T04:00:00.000Z",
      actor: { id: "owner" },
      scope: { id: "customer-a" },
      type: "message",
      content: [{ role: "body", media_type: "text/plain", text: "上次确认小王和小李，共 2 位。" }],
    },
    {
      operation: "create",
      source: "fixture",
      external_id: "customer-a:2",
      occurred_at: "2026-10-22T04:01:00.000Z",
      actor: { id: "customer" },
      scope: { id: "customer-a" },
      type: "message",
      content: [{ role: "body", media_type: "text/plain", text: "上次选中的 2 位都还没回复吗？" }],
    },
    {
      operation: "create",
      source: "fixture",
      external_id: "customer-a:3",
      parent_external_id: "customer-a:1",
      occurred_at: "2026-10-22T04:02:00.000Z",
      actor: { id: "owner" },
      scope: { id: "customer-a" },
      type: "message",
      content: [{ role: "body", media_type: "text/plain", text: "小王编号 creator-1，小李编号 creator-2；这里的回复指邀约回复。" }],
    },
  ];
  const result = await service.ingest({
    schema_version: INGEST_SCHEMA_VERSION,
    connector_id: "fixture",
    org_id: "local-owner",
    delivery_id: "customer-fixture",
    received_at: "2026-10-22T04:03:00.000Z",
    records,
  });
  const event = await authority.getEvent("local-owner", result.records[1].event_id);
  authority.close();
  return { event_id: event.id, content_hash: event.content_hash };
}

async function startBusinessStub() {
  const requests = [];
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      const body = JSON.parse(raw);
      requests.push(body);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        schema_version: "1.0",
        queried_at: "2026-10-22T04:30:00.000Z",
        complete: true,
        results: body.members.map((member, index) => ({
          ...member,
          status: "found",
          record_id: `record-${index + 1}`,
          record_version: "1",
          fields: [{
            field: "invitation_response",
            value: index === 0 ? "declined" : "pending",
            visibility: "customer",
            authority: "fixture",
            updated_at: "2026-10-22T04:20:00.000Z",
          }],
        })),
      }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}/query`,
    requests,
    close: () => new Promise((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve())),
  };
}

async function post(origin, path, body) {
  const response = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}
