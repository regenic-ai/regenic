const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { createHash } = require("node:crypto");
const { once } = require("node:events");
const { createServer } = require("node:http");
const { join } = require("node:path");
const { createInterface } = require("node:readline");
const { test } = require("node:test");
const { SqliteAuthorityStore } = require("@regenic/authority-store/sqlite");
const { FsBlobStore } = require("@regenic/blob-store");
const { INGEST_SCHEMA_VERSION, IngestionService } = require("@regenic/domain");
const {
  PERSONAL_API_KEY,
  createRoot,
  startPersonalApi,
} = require("./personal-api-harness.cjs");

test("customer-service system acceptance crosses MCP, API, context, and business boundaries", async () => {
  const root = await createRoot();
  const database = join(root, "authority.db");
  const blobRoot = join(root, "blobs");
  const sources = await ingestScenarios(database, blobRoot);
  const business = await startBusinessService();
  const { app, origin } = await startPersonalApi(database, blobRoot, {
    REGENIC_CUSTOMER_BUSINESS_URL: business.url,
  });
  const mcp = await startMcp(origin);

  try {
    const tools = await mcp.request("tools/list");
    const toolNames = tools.tools.map((tool) => tool.name);
    assert.ok(toolNames.includes("search_context"));
    assert.ok(toolNames.includes("query_customer_business"));
    assert.ok(toolNames.includes("create_customer_reply_draft"));
    assert.ok(!toolNames.some((name) => /review|send/.test(name)));

    const happy = await runHappyPath(mcp, origin, sources.happy, business);
    const notFound = await runRejectedClaimPath(
      mcp,
      sources.notFound,
      "customer-not-found",
      "project-not-found",
      "batch-not-found",
      "missing",
      "creator-missing",
      /without a found business result/,
    );
    const internal = await runRejectedClaimPath(
      mcp,
      sources.internal,
      "customer-internal",
      "project-internal",
      "batch-internal",
      "internal",
      "creator-internal",
      /non-customer field invitation_response/i,
    );

    assert.equal(business.invalidScopeRequests.length, 0);
    const semantic = {
      schema_version: "1.0",
      suite_id: "customer-service-system-acceptance-v1",
      scope: "MCP stdio -> Personal API -> Context Engine -> controlled business HTTP service",
      scenarios: {
        happy_path: happy,
        business_not_found: notFound,
        internal_visibility: internal,
      },
      metrics: {
        scenario_count: 3,
        scenario_pass_rate: 1,
        exact_business_scope_rate: 1,
        unsafe_claim_rejection_rate: 1,
        stale_approval_invalidation_rate: 1,
        mcp_review_or_send_tools: 0,
        severe_errors: 0,
        passed: true,
      },
      limitations: [
        "Uses deterministic oracle arguments instead of a model-driven Cursor session.",
        "Uses synthetic connector events and a controlled business service.",
        "Does not certify production tenant authorization, connector completeness, latency, or capacity.",
      ],
    };
    const report = {
      ...semantic,
      content_hash: createHash("sha256").update(JSON.stringify(semantic)).digest("hex"),
    };
    console.log(JSON.stringify(report));
  } finally {
    await mcp.close();
    await app.close();
    await business.close();
  }
});

async function runHappyPath(mcp, origin, source, business) {
  const task = await createAndSearch(mcp, source);
  const citation = task.search.evidence[0].citation_id;
  const brief = await mcp.call("update_customer_brief", {
    task_id: task.created.id,
    customer: verified("customer-happy", citation),
    project: verified("project-happy", citation),
    batch: verified("batch-happy", citation),
    intent: verified("invitation_response", citation),
    expected_member_count: 2,
    expected_count_evidence: citation,
    members_closed: true,
    members: [
      member("wang", "小王", "creator-1", citation),
      member("li", "小李", "creator-2", citation),
    ],
    requested_fields: ["invitation_response"],
    unresolved: [],
  });
  assert.equal(brief.status, "ready_for_query");

  const queried = await mcp.call("query_customer_business", {
    task_id: task.created.id,
  });
  assert.equal(queried.status, "verifying");
  assert.deepEqual(
    business.requests.at(-1).members,
    [
      { member_key: "wang", business_id: "creator-1" },
      { member_key: "li", business_id: "creator-2" },
    ],
  );
  const businessCitation = queried.business_evidence[0].citation_id;
  const drafted = await mcp.call("create_customer_reply_draft", {
    task_id: task.created.id,
    text: "小王已拒绝邀约，小李目前仍待回复。",
    claims: [{
      claim_id: "invitation-status",
      text: "两位当前邀约回复状态",
      member_keys: ["wang", "li"],
      fields: ["invitation_response"],
      evidence: [businessCitation],
    }],
    covered_member_keys: ["wang", "li"],
    unresolved: [],
  });
  assert.equal(drafted.status, "awaiting_review");

  const approved = await post(origin, `/v1/me/context/customer-tasks/${task.created.id}/review`, {
    result: "approved",
  });
  assert.equal(approved.status, 201);
  assert.equal(approved.body.status, "approved");

  business.happyVersion = "2";
  const send = await post(origin, `/v1/me/context/customer-tasks/${task.created.id}/send`, {});
  assert.equal(send.status, 409);
  assert.equal(send.body.error.code, "context_changed");
  const refreshed = await mcp.call("get_customer_task", { task_id: task.created.id });
  assert.equal(refreshed.status, "verifying");
  assert.equal(refreshed.draft.review, undefined);

  return {
    passed: true,
    source_evidence_count: task.search.evidence.length,
    queried_member_count: 2,
    human_review_boundary: "http",
    changed_business_blocked_send: true,
  };
}

async function runRejectedClaimPath(
  mcp,
  source,
  customerId,
  projectId,
  batchId,
  memberKey,
  businessId,
  expectedError,
) {
  const task = await createAndSearch(mcp, source);
  const citation = task.search.evidence[0].citation_id;
  await mcp.call("update_customer_brief", {
    task_id: task.created.id,
    customer: verified(customerId, citation),
    project: verified(projectId, citation),
    batch: verified(batchId, citation),
    intent: verified("invitation_response", citation),
    expected_member_count: 1,
    expected_count_evidence: citation,
    members_closed: true,
    members: [member(memberKey, memberKey, businessId, citation)],
    requested_fields: ["invitation_response"],
    unresolved: [],
  });
  const queried = await mcp.call("query_customer_business", {
    task_id: task.created.id,
  });
  const error = await mcp.callError("create_customer_reply_draft", {
    task_id: task.created.id,
    text: "该成员尚未回复。",
    claims: [{
      claim_id: "unsafe-status",
      text: "该成员尚未回复",
      member_keys: [memberKey],
      fields: ["invitation_response"],
      evidence: [queried.business_evidence[0].citation_id],
    }],
    covered_member_keys: [memberKey],
    unresolved: [],
  });
  assert.match(error, expectedError);
  const current = await mcp.call("get_customer_task", { task_id: task.created.id });
  assert.equal(current.status, "verifying");
  assert.equal(current.draft, undefined);
  return {
    passed: true,
    unsafe_claim_rejected: true,
    task_remained_unapproved: true,
  };
}

async function createAndSearch(mcp, source) {
  const created = await mcp.call("create_customer_task", {
    source_event_id: source.event_id,
    content_hash: source.content_hash,
  });
  const search = await mcp.call("search_context", {
    task_id: created.id,
    query: source.query,
    max_items: 20,
    neighbor_count: 4,
  });
  assert.ok(search.evidence.length >= 3);
  assert.ok(source.required_event_ids.every((eventId) =>
    search.evidence.some((evidence) => evidence.event_id === eventId)));
  return { created, search };
}

function verified(value, citation) {
  return { status: "verified", value, evidence: [citation] };
}

function member(memberKey, displayName, businessId, citation) {
  return {
    member_key: memberKey,
    display_name: displayName,
    business_id: businessId,
    status: "verified",
    evidence: [citation],
    identity_evidence: citation,
  };
}

async function ingestScenarios(database, blobRoot) {
  const definitions = [
    {
      key: "happy",
      customer: "customer-happy",
      query: "验收正常场景 上次选中的 2 位 回复",
      scope: "验收正常场景：客户 customer-happy，项目 project-happy，批次 batch-happy；上次确认小王和小李，共 2 位。",
      question: "验收正常场景：上次选中的 2 位都还没回复吗？",
      identity: "验收正常场景：小王编号 creator-1，小李编号 creator-2；回复指邀约回复。",
    },
    {
      key: "notFound",
      customer: "customer-not-found",
      query: "验收无记录场景 候选人 回复",
      scope: "验收无记录场景：客户 customer-not-found，项目 project-not-found，批次 batch-not-found，共 1 位。",
      question: "验收无记录场景：这位候选人回复了吗？",
      identity: "验收无记录场景：候选人编号 creator-missing；回复指邀约回复。",
    },
    {
      key: "internal",
      customer: "customer-internal",
      query: "验收内部字段场景 候选人 回复",
      scope: "验收内部字段场景：客户 customer-internal，项目 project-internal，批次 batch-internal，共 1 位。",
      question: "验收内部字段场景：这位候选人回复了吗？",
      identity: "验收内部字段场景：候选人编号 creator-internal；回复指邀约回复。",
    },
  ];
  const authority = new SqliteAuthorityStore(database);
  const service = new IngestionService(new FsBlobStore(blobRoot), authority);
  const result = {};
  try {
    for (const definition of definitions) {
      const records = [definition.scope, definition.question, definition.identity].map((text, index) => ({
        operation: "create",
        source: "fixture",
        external_id: `${definition.customer}:${index + 1}`,
        occurred_at: `2026-10-29T0${index}:00:00.000Z`,
        actor: { id: index === 1 ? definition.customer : "owner" },
        scope: { id: definition.customer },
        type: "message",
        content: [{ role: "body", media_type: "text/plain", text }],
        ...(index === 2 ? { parent_external_id: `${definition.customer}:1` } : {}),
      }));
      const ingested = await service.ingest({
        schema_version: INGEST_SCHEMA_VERSION,
        connector_id: "fixture",
        org_id: "local-owner",
        delivery_id: `system-acceptance-${definition.key}`,
        received_at: "2026-10-29T04:00:00.000Z",
        records,
      });
      const question = await authority.getEvent("local-owner", ingested.records[1].event_id);
      result[definition.key] = {
        event_id: question.id,
        content_hash: question.content_hash,
        query: definition.query,
        required_event_ids: ingested.records.map((record) => record.event_id),
      };
    }
  } finally {
    authority.close();
  }
  return result;
}

async function startBusinessService() {
  const state = {
    requests: [],
    invalidScopeRequests: [],
    happyVersion: "1",
  };
  const expected = {
    "customer-happy": {
      project_id: "project-happy",
      batch_id: "batch-happy",
      members: new Map([["wang", "creator-1"], ["li", "creator-2"]]),
    },
    "customer-not-found": {
      project_id: "project-not-found",
      batch_id: "batch-not-found",
      members: new Map([["missing", "creator-missing"]]),
    },
    "customer-internal": {
      project_id: "project-internal",
      batch_id: "batch-internal",
      members: new Map([["internal", "creator-internal"]]),
    },
  };
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    state.requests.push(body);
    const scope = expected[body.customer_id];
    const valid = scope
      && scope.project_id === body.project_id
      && scope.batch_id === body.batch_id
      && body.fields.length === 1
      && body.fields[0] === "invitation_response"
      && body.members.every((item) => scope.members.get(item.member_key) === item.business_id);
    if (!valid) state.invalidScopeRequests.push(body);

    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      schema_version: "1.0",
      queried_at: "2026-10-29T05:00:00.000Z",
      complete: true,
      results: body.members.map((item, index) => {
        if (body.customer_id === "customer-not-found") {
          return { ...item, status: "not_found", fields: [], reason_code: "missing" };
        }
        const internal = body.customer_id === "customer-internal";
        return {
          ...item,
          status: "found",
          record_id: `${body.customer_id}:record:${index + 1}`,
          record_version: internal ? "1" : state.happyVersion,
          fields: [{
            field: "invitation_response",
            value: index === 0 ? "declined" : "pending",
            visibility: internal ? "internal" : "customer",
            authority: "system-acceptance",
            updated_at: "2026-10-29T04:30:00.000Z",
          }],
        };
      }),
    }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    ...state,
    url: `http://127.0.0.1:${address.port}/query`,
    get happyVersion() {
      return state.happyVersion;
    },
    set happyVersion(value) {
      state.happyVersion = value;
    },
    close: () => new Promise((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve())),
  };
}

async function startMcp(origin) {
  const child = spawn(process.execPath, [
    join(__dirname, "..", "..", "..", "packages", "local-cli", "dist", "main.js"),
    "customer-service-mcp",
    "--base-url",
    origin,
  ], {
    env: { ...process.env, REGENIC_PERSONAL_API_KEY: PERSONAL_API_KEY },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map();
  let nextId = 0;
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => {
    const response = JSON.parse(line);
    const waiter = pending.get(response.id);
    if (!waiter) return;
    pending.delete(response.id);
    waiter.resolve(response);
  });
  child.on("exit", (code) => {
    for (const waiter of pending.values()) {
      waiter.reject(new Error(`Customer-service MCP exited with ${code}: ${stderr}`));
    }
    pending.clear();
  });
  const request = async (method, params) => {
    const id = ++nextId;
    const response = await new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id,
        method,
        ...(params === undefined ? {} : { params }),
      })}\n`);
    });
    if (response.error) throw new Error(response.error.message);
    return response.result;
  };
  const initialized = await request("initialize", {
    protocolVersion: "2025-03-26",
  });
  assert.equal(initialized.serverInfo.name, "regenic-customer-service");
  return {
    request,
    async call(name, args) {
      const result = await request("tools/call", { name, arguments: args });
      if (result.isError) throw new Error(result.content[0].text);
      return result.structuredContent;
    },
    async callError(name, args) {
      const result = await request("tools/call", { name, arguments: args });
      assert.equal(result.isError, true);
      return result.content[0].text;
    },
    async close() {
      child.stdin.end();
      const [code] = await once(child, "exit");
      assert.equal(code, 0, stderr);
    },
  };
}

async function post(origin, path, body) {
  const response = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-regenic-personal-key": PERSONAL_API_KEY,
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}
