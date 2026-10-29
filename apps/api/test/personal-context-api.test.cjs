const assert = require("node:assert/strict");
const { createServer } = require("node:http");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { afterEach, describe, it } = require("node:test");
const { SqliteAuthorityStore } = require("@regenic/authority-store/sqlite");
const { FsBlobStore } = require("@regenic/blob-store");
const {
  INGEST_SCHEMA_VERSION,
  IngestionService,
  canonicalContextJson,
  hashCanonicalContext,
  hashContextArtifactInputs,
} = require("@regenic/domain");
const { createHttpApp } = require("../dist/http-app");

const roots = [];
const apps = [];
const servers = [];
const previousEnv = new Map();

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(servers.splice(0).map((server) => closeServer(server)));
  restoreEnv();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createRoot() {
  const root = await mkdtemp(join(tmpdir(), "regenic-context-api-"));
  roots.push(root);
  return root;
}

async function ingestEvidence(database, blobRoot, suffix = "", threadId = "chat-1") {
  const authority = new SqliteAuthorityStore(database);
  const service = new IngestionService(new FsBlobStore(blobRoot), authority);
  const result = await service.ingest({
    schema_version: INGEST_SCHEMA_VERSION,
    connector_id: "synthetic-chat",
    org_id: "local-owner",
    delivery_id: `delivery-context-api${suffix ? `-${suffix}` : ""}`,
    received_at: "2026-08-30T01:00:00.000Z",
    records: [{
      operation: "create",
      source: "synthetic-chat",
      external_id: `${threadId}:message-1${suffix ? `-${suffix}` : ""}`,
      occurred_at: "2026-08-30T00:00:00.000Z",
      actor: { id: "person-1" },
      scope: { id: threadId },
      type: "message",
      direction_tags: ["product"],
      weight_hints: { urgency: 1, importance: 1 },
      content: [{
        role: "body",
        media_type: "text/plain",
        text: suffix ? `Additional release evidence ${suffix}.` : "The release is approved for Monday.",
      }],
    }],
  });
  authority.close();
  return result.records[0].event_id;
}

async function ingestConversationEvidence(database, blobRoot) {
  const authority = new SqliteAuthorityStore(database);
  const service = new IngestionService(new FsBlobStore(blobRoot), authority);
  const result = await service.ingest({
    schema_version: INGEST_SCHEMA_VERSION,
    connector_id: "synthetic-chat",
    org_id: "local-owner",
    delivery_id: "delivery-expanded-context",
    received_at: "2026-08-30T01:00:00.000Z",
    records: [
      {
        operation: "create",
        source: "synthetic-chat",
        external_id: "customer-a:1",
        occurred_at: "2026-08-30T00:00:00.000Z",
        actor: { id: "owner" },
        scope: { id: "customer-a" },
        type: "message",
        content: [{ role: "body", media_type: "text/plain", text: "Customer customer-a selected Alice and Bob." }],
      },
      {
        operation: "create",
        source: "synthetic-chat",
        external_id: "customer-a:2",
        occurred_at: "2026-08-30T00:01:00.000Z",
        actor: { id: "customer" },
        scope: { id: "customer-a" },
        type: "message",
        content: [{ role: "body", media_type: "text/plain", text: "pending-answer-question: did both selected creators reply?" }],
      },
      {
        operation: "create",
        source: "synthetic-chat",
        external_id: "customer-a:3",
        parent_external_id: "customer-a:1",
        occurred_at: "2026-08-30T00:02:00.000Z",
        actor: { id: "owner" },
        scope: { id: "customer-a" },
        type: "thread_reply",
        content: [{ role: "body", media_type: "text/plain", text: "identity-follow-up: Alice is creator-1 and Bob is creator-2." }],
      },
    ],
  });
  authority.close();
  return result.records.map((record) => record.event_id);
}

async function ingestAttachmentConversation(database, blobRoot) {
  const authority = new SqliteAuthorityStore(database);
  const service = new IngestionService(new FsBlobStore(blobRoot), authority);
  const message = (index, content) => ({
    operation: "create",
    source: "synthetic-chat",
    external_id: `customer-b:${index}`,
    occurred_at: `2026-08-30T00:0${index}:00.000Z`,
    actor: { id: "customer" },
    scope: { id: "customer-b" },
    type: "message",
    content,
  });
  await service.ingest({
    schema_version: INGEST_SCHEMA_VERSION,
    connector_id: "synthetic-chat",
    org_id: "local-owner",
    delivery_id: "delivery-attachment-context",
    received_at: "2026-08-30T01:00:00.000Z",
    records: [
      message(1, [{ role: "body", media_type: "text/plain", text: "opening-line before the photos" }]),
      message(2, [{
        role: "attachment", media_type: "image/png", source_filename: "image.png",
        external_locator: "synthetic:image:1",
      }]),
      message(3, [{ role: "body", media_type: "text/plain", text: "photo-caption-question: which one?" }]),
      message(4, [{
        role: "attachment", media_type: "application/pdf", source_filename: "brief.pdf",
        external_locator: "synthetic:file:1",
      }]),
      message(5, [{ role: "body", media_type: "text/plain", text: "closing-line after the photos" }]),
    ],
  });
  authority.close();
}

async function ingestConversationMetadataOnly(database, blobRoot) {
  const ids = await ingestConversationEvidence(database, blobRoot);
  const authority = new SqliteAuthorityStore(database);
  await new IngestionService(new FsBlobStore(blobRoot), authority).ingest({
    schema_version: INGEST_SCHEMA_VERSION,
    connector_id: "synthetic-chat",
    org_id: "local-owner",
    delivery_id: "delivery-metadata-only",
    received_at: "2026-08-30T01:00:00.000Z",
    records: [{
      operation: "create",
      source: "synthetic-chat",
      external_id: "customer-a:4",
      occurred_at: "2026-08-30T00:03:00.000Z",
      actor: { id: "customer" },
      scope: { id: "customer-a" },
      type: "message",
      content: [{
        role: "metadata",
        media_type: "application/vnd.regenic.surface+json",
        text: JSON.stringify({ channel: "synthetic", kind: "user" }),
      }],
    }],
  });
  authority.close();
  return ids;
}

async function startExecutorStub(summary) {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString("utf8");
    requests.push({ method: request.method, url: request.url, body: text ? JSON.parse(text) : undefined });
    const done = request.method === "GET" && summary !== undefined;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(done
      ? { status: "completed", external_run_id: "run-1", agent_thread_id: "dsh:answer-1", result: { summary } }
      : { status: "running", external_run_id: "run-1", agent_thread_id: "dsh:answer-1" }));
  });
  await listenServer(server);
  servers.push(server);
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, requests };
}

async function installHttpExecutor(origin, baseUrl) {
  const response = await postJson(`${origin}/v1/me/executors`, {
    kind: "http",
    name: "Answer agent",
    config: { base_url: baseUrl },
  });
  assert.equal(response.response.status, 201, response.text);
  return JSON.parse(response.text).id;
}

async function startModelStub(mode = "valid") {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requests.push({
      url: request.url,
      authorization: request.headers.authorization,
      body,
    });
    const prompt = JSON.parse(body.messages[1].content);
    const item = prompt.context_bundle.sections[0].items[0];
    const answer = mode === "invalid-citation"
      ? {
          answer: "A forged answer.",
          citations: [{ candidate_id: item.candidate_id, event_ids: ["event-forged"] }],
        }
      : {
          answer: "The release is approved for Monday.",
          citations: [{
            candidate_id: item.candidate_id,
            event_ids: [item.evidence[0].event_id],
          }],
        };
    response.statusCode = 200;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      model: "fake-model-response",
      choices: [{
        message: { role: "assistant", content: JSON.stringify(answer) },
        finish_reason: "stop",
      }],
    }));
  });
  await listenServer(server);
  servers.push(server);
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
  };
}

async function startApi(root, model = { driver: "none" }, embedding, seed = ingestEvidence) {
  const database = join(root, "authority.db");
  const blobRoot = join(root, "blobs");
  const env = {
    REGENIC_AUTHORITY_DRIVER: "sqlite",
    REGENIC_DATABASE: database,
    REGENIC_BLOB_ROOT: blobRoot,
    REGENIC_ORG: "local-owner",
    REGENIC_PERSONAL_API: "1",
    LISTEN_HOST: "127.0.0.1",
    PORT: "4370",
    HOME: root,
    USERPROFILE: root,
    REGENIC_MODEL_DRIVER: model.driver,
    REGENIC_MODEL_BASE_URL: model.baseUrl,
    REGENIC_MODEL_NAME: model.driver === "none" ? undefined : "fake-model",
    REGENIC_MODEL_API_KEY_REF: model.driver === "none" ? undefined : "env:CONTEXT_API_MODEL_KEY",
    REGENIC_MODEL_TIMEOUT_MS: "2000",
    REGENIC_MODEL_MAX_RESPONSE_BYTES: "65536",
    CONTEXT_API_MODEL_KEY: model.driver === "none" ? undefined : "context-api-test-secret",
    REGENIC_EMBEDDING_DRIVER: embedding ? "local_http" : "none",
    REGENIC_EMBEDDING_BASE_URL: embedding,
  };
  setEnv(env);
  const seeded = seed ? await seed(database, blobRoot) : undefined;
  const eventId = Array.isArray(seeded) ? seeded[0] : seeded;
  const app = await createHttpApp({ logger: false });
  await app.listen(0, "127.0.0.1");
  apps.push(app);
  return { app, origin: await app.getUrl(), eventId, database };
}

function assembleBody() {
  return {
    consumer_id: "context-api-test",
    purpose: "answer a synthetic release question",
    allowed_uses: ["display", "reason"],
    query: "release approved",
    temporal: { mode: "current" },
    budget: {
      profile: "context-api-test",
      max_tokens: 100,
      max_items: 5,
      max_raw_evidence: 5,
    },
    requested_kinds: ["event"],
  };
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { response, text: await response.text() };
}

async function getJson(url) {
  const response = await fetch(url);
  return { response, text: await response.text() };
}

describe("personal context API", () => {
  it("maps unknown provider/job errors to a fixed safe diagnostic category", () => {
    const { semanticIssue } = require("../dist/semantic-diagnostics");
    assert.equal(semanticIssue("sensitive_error_detail"), "indexing_failed");
    assert.equal(semanticIssue(undefined), "indexing_failed");
    assert.equal(semanticIssue("cancelled"), "indexing_failed");
    assert.equal(semanticIssue("unavailable"), "provider_unavailable");
    assert.equal(semanticIssue("invalid_input"), "input_invalid");
  });

  it("opens only the current authorized search source and rejects stale, deleted, foreign or forged references", async () => {
    const root = await createRoot();
    const { origin, eventId, database } = await startApi(root);
    const searched = JSON.parse((await postJson(`${origin}/v1/me/context/search`, { query: "release" })).text);
    const reference = { event_id: eventId, content_hash: searched.items[0].content_hash };
    const opened = await postJson(`${origin}/v1/me/context/search/source?locale=zh`, reference);
    assert.equal(opened.response.status, 200, opened.text);
    const source = JSON.parse(opened.text);
    assert.equal(source.text, "The release is approved for Monday.");
    assert.equal(source.item.event.id, eventId);
    assert.equal(source.item.event.content_hash, reference.content_hash);
    assert.ok(source.item.thread_id && source.snapshot_id);
    for (const body of [{}, { ...reference, org_id: "other" }, { ...reference, content_hash: "bad" }]) {
      assert.equal((await postJson(`${origin}/v1/me/context/search/source`, body)).response.status, 400);
    }
    assert.equal((await postJson(`${origin}/v1/me/context/search/source`, {
      ...reference, content_hash: "f".repeat(64),
    })).response.status, 404);
    const authority = new SqliteAuthorityStore(database);
    const ingest = new IngestionService(new FsBlobStore(join(root, "blobs")), authority);
    try {
      for (const [operation, delivery, org] of [
        ["create", "foreign", "other"], ["revise", "revised", "local-owner"], ["tombstone", "deleted", "local-owner"],
      ]) {
        const accepted = await ingest.ingest({
          schema_version: INGEST_SCHEMA_VERSION, connector_id: "synthetic-chat", org_id: org,
          delivery_id: delivery, received_at: new Date().toISOString(),
          records: [{
            operation, source: "synthetic-chat", external_id: "chat-1:message-1",
            occurred_at: new Date().toISOString(), actor: { id: "person-1" }, scope: { id: "chat-1" },
            type: "message", ...(operation === "tombstone" ? {} : { content: [{
              role: "body", media_type: "text/plain", text: "The updated release approval.",
            }] }),
          }],
        });
        assert.ok(accepted.records, JSON.stringify(accepted));
        assert.equal(accepted.records[0].status, "accepted");
        const id = accepted.records[0].event_id;
        if (org === "other") {
          const foreign = await authority.getEvent(org, id);
          assert.equal((await postJson(`${origin}/v1/me/context/search/source`, {
            event_id: id, content_hash: foreign.content_hash,
          })).response.status, 404);
        } else {
          assert.equal((await postJson(`${origin}/v1/me/context/search/source`, reference)).response.status, 404);
          if (operation === "revise") {
            const updated = await authority.getEvent(org, id);
            const current = await postJson(`${origin}/v1/me/context/search/source`, {
              event_id: id, content_hash: updated.content_hash,
            });
            assert.equal(current.response.status, 200, current.text);
            assert.equal(JSON.parse(current.text).text, "The updated release approval.");
          }
        }
      }
    } finally { authority.close(); }
  });

  it("diagnoses failures without raw errors and safely retries a bounded known generation after repair", async () => {
    const { EMBEDDINGGEMMA_2 } = require("@regenic/embedding-provider");
    let broken = true;
    let unhealthy = false;
    const server = createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      response.setHeader("content-type", "application/json");
      if (unhealthy || (broken && request.url === "/embed")) {
        response.statusCode = 409;
        response.end(JSON.stringify({ error: "private raw error never exposed" }));
      } else response.end(JSON.stringify({ descriptor: EMBEDDINGGEMMA_2,
        ...(request.url === "/tokens" ? { counts: input.texts.map(() => 10) }
          : { vectors: input.texts.map(() => [1, ...Array(767).fill(0)]) }) }));
    });
    await listenServer(server);
    servers.push(server);
    const { origin } = await startApi(await createRoot(), { driver: "none" }, `http://127.0.0.1:${server.address().port}`);
    assert.equal(JSON.parse((await postJson(`${origin}/v1/me/context/embedding/index`, {})).text).failed, 1);
    const status = JSON.parse((await getJson(`${origin}/v1/me/context/embedding/status`)).text);
    const generation = status.generations[0];
    assert.deepEqual(generation.failures, [{ code: "model_mismatch", failed: 0, quarantined: 1 }]);
    assert.ok(!JSON.stringify(status).includes("private raw"));
    for (const body of [{}, { generation: generation.id, limit: 0 }, { generation: generation.id, limit: 21 },
      { generation: generation.id, limit: 1.5 }, { generation: generation.id, org_id: "other" }]) {
      assert.equal((await postJson(`${origin}/v1/me/context/embedding/retry`, body)).response.status, 400);
    }
    assert.equal((await postJson(`${origin}/v1/me/context/embedding/retry`, { generation: "unknown" })).response.status, 404);
    unhealthy = true;
    assert.equal((await postJson(`${origin}/v1/me/context/embedding/retry`, { generation: generation.id })).response.status, 503);
    const offline = JSON.parse((await getJson(`${origin}/v1/me/context/embedding/status`)).text);
    assert.equal(offline.provider_issue, "model_mismatch");
    unhealthy = false; broken = false;
    const retried = await postJson(`${origin}/v1/me/context/embedding/retry`, { generation: generation.id, limit: 1 });
    assert.equal(retried.response.status, 200, retried.text);
    assert.deepEqual(JSON.parse(retried.text), { retried: 1 });
    assert.equal(JSON.parse((await postJson(`${origin}/v1/me/context/embedding/retry`, { generation: generation.id })).text).retried, 0);
    assert.equal(JSON.parse((await postJson(`${origin}/v1/me/context/embedding/index`, {})).text).processed, 1);
    const repaired = JSON.parse((await getJson(`${origin}/v1/me/context/embedding/status`)).text).generations[0];
    assert.equal(repaired.jobs.succeeded, 1);
    assert.deepEqual(repaired.failures, []);
  });

  it("indexes one bounded job and reports aggregate coverage without exposing content or URLs", async () => {
    const { EMBEDDINGGEMMA_2 } = require("@regenic/embedding-provider");
    const server = createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        descriptor: EMBEDDINGGEMMA_2,
        ...(request.url === "/tokens" ? { counts: input.texts.map(() => 10) }
          : { vectors: input.texts.map(() => [1, ...Array(767).fill(0)]) }),
      }));
    });
    await listenServer(server);
    servers.push(server);
    const root = await createRoot();
    const { origin } = await startApi(root, { driver: "none" }, `http://127.0.0.1:${server.address().port}`);
    const indexed = await postJson(`${origin}/v1/me/context/embedding/index`, {});
    assert.equal(indexed.response.status, 200, indexed.text);
    assert.equal(JSON.parse(indexed.text).processed, 1);
    const status = await getJson(`${origin}/v1/me/context/embedding/status`);
    assert.equal(status.response.status, 200, status.text);
    const value = JSON.parse(status.text);
    assert.equal(value.configured, true);
    assert.equal(value.healthy, true);
    assert.equal(value.vector_status, "ready");
    assert.equal(value.generations.filter((generation) => generation.active).length, 1);
    assert.equal(value.generations.find((generation) => generation.active).jobs.succeeded, 1);
    assert.ok(!status.text.includes("http://") && !status.text.includes("release is approved"));
    const search = await postJson(`${origin}/v1/me/context/search`, { query: "release" });
    assert.equal(search.response.status, 200, search.text);
    assert.ok(JSON.parse(search.text).generation);
  });
  it("reports disabled embeddings safely and strictly rejects unavailable indexing and injected fields", async () => {
    const root = await createRoot();
    const { origin } = await startApi(root);
    const status = await getJson(`${origin}/v1/me/context/embedding/status`);
    assert.equal(status.response.status, 200, status.text);
    assert.deepEqual(JSON.parse(status.text), {
      configured: false, healthy: false, vector_status: "disabled", generations: [],
    });
    const index = await postJson(`${origin}/v1/me/context/embedding/index`, {});
    assert.equal(index.response.status, 503, index.text);
    assert.equal(JSON.parse(index.text).error.code, "retrieval_unavailable");
    for (const body of [{ org_id: "other" }, { limit: 1000 }, { base_url: "http://example.com" }]) {
      const rejected = await postJson(`${origin}/v1/me/context/embedding/index`, body);
      assert.equal(rejected.response.status, 400, rejected.text);
    }
  });
  it("searches without completion, pins display snapshots and validates the strict public protocol", async () => {
    const root = await createRoot();
    const { origin, eventId } = await startApi(root);
    const searched = await postJson(`${origin}/v1/me/context/search`, { query: "release approved", limit: 1 });
    assert.equal(searched.response.status, 200, searched.text);
    const result = JSON.parse(searched.text);
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].event_id, eventId);
    assert.equal(result.items[0].rank, 1);
    assert.equal(result.items[0].snippet, "The release is approved for Monday.");
    assert.match(result.items[0].content_hash, /^[a-f0-9]{64}$/);
    assert.equal(result.generation, null);
    assert.ok(result.request_id && result.snapshot_id && result.read_epoch && result.retrieval_profile);
    assert.equal((await getJson(`${origin}/v1/me/context/snapshots/${result.snapshot_id}`)).response.status, 200);
    const empty = await postJson(`${origin}/v1/me/context/search`, { query: "zzzznonexistent", limit: 1 });
    assert.equal(empty.response.status, 200);
    assert.deepEqual(JSON.parse(empty.text).items, []);
    for (const body of [
      {}, { query: " " }, { query: "x".repeat(8001) },
      { query: "release", limit: 0 }, { query: "release", limit: 101 }, { query: "release", limit: 1.1 },
      { query: "release", filters: {} }, { query: "release", filters: { secret: "x" } },
      { query: "release", filters: { sources: ["x", "x"] } },
      { query: "release", filters: { occurred_after: "bad" } },
      { query: "release", temporal: { mode: "history" } },
      { query: "release", temporal: { mode: "as_of", recorded_at: "2026-08-30T00:00:00.000Z" } },
      ...["org_id", "principal", "purpose", "budget", "generation", "vectors", "base_url"].map((key) =>
        ({ query: "release", [key]: "injected" })),
    ]) {
      const invalid = await postJson(`${origin}/v1/me/context/search`, body);
      assert.equal(invalid.response.status, 400, invalid.text);
    }
    const filtered = await postJson(`${origin}/v1/me/context/search`, {
      query: "release", filters: { sources: ["not-authorized-source"] },
    });
    assert.deepEqual(JSON.parse(filtered.text).items, []);
  });
  it("expands a search hit into a bounded conversation with stable message and reply locators", async () => {
    const root = await createRoot();
    const { origin } = await startApi(
      root,
      { driver: "none" },
      undefined,
      ingestConversationEvidence,
    );
    const expanded = await postJson(`${origin}/v1/me/context/search/expand`, {
      query: "pending-answer-question",
      limit: 1,
      context: { before: 1, after: 1, reply_depth: 8, max_messages: 3 },
    });
    assert.equal(expanded.response.status, 200, expanded.text);
    const result = JSON.parse(expanded.text);
    assert.equal(result.items.length, 1);
    assert.equal(result.conversations.length, 1);
    assert.equal(result.conversations[0].thread_id, "synthetic-chat:customer-a");
    assert.equal(typeof result.conversations[0].channel_label, "string");
    assert.ok("title" in result.conversations[0]);
    assert.ok(result.conversations[0].messages.every((message) => "actor_label" in message));
    assert.deepEqual(result.conversations[0].anchor_event_ids, [result.items[0].event_id]);
    assert.deepEqual(
      result.conversations[0].messages.map((message) => message.external_id),
      ["customer-a:1", "customer-a:2", "customer-a:3"],
    );
    assert.deepEqual(
      result.conversations[0].messages.map((message) => message.selection_reason),
      ["neighbor", "hit", "neighbor"],
    );
    assert.equal(result.conversations[0].messages[2].parent_external_id, "customer-a:1");
    assert.equal(
      result.conversations[0].messages[2].reply_to_event_id,
      result.conversations[0].messages[0].event_id,
    );
    assert.equal(result.conversations[0].continuation.before, null);
    assert.equal(result.conversations[0].continuation.after, null);
    assert.deepEqual(result.conversations[0].continuation.gaps, []);
    assert.equal(result.conversations[0].truncated, false);
    assert.deepEqual(result.expansion, {
      returned_messages: 3,
      max_messages: 3,
      message_content: "complete_or_explicitly_omitted",
      local_read_scope: "bounded",
      source_sync: "unknown",
    });

    const replyChain = await postJson(`${origin}/v1/me/context/search/expand`, {
      query: "identity-follow-up",
      limit: 1,
      context: { before: 0, after: 0, reply_depth: 8, max_messages: 2 },
    });
    assert.equal(replyChain.response.status, 200, replyChain.text);
    const chain = JSON.parse(replyChain.text).conversations[0];
    assert.deepEqual(
      chain.messages.map((message) => message.selection_reason),
      ["reply_target", "hit"],
    );
    assert.equal(chain.truncated, true);
    assert.equal(chain.continuation.gaps.length, 1);
    assert.equal(chain.continuation.gaps[0].after.event_id, chain.messages[0].event_id);
    assert.equal(chain.continuation.gaps[0].before.event_id, chain.messages[1].event_id);

    for (const body of [
      { query: "pending-answer-question", context: { unknown: true } },
      { query: "pending-answer-question", context: { before: 13 } },
      { query: "pending-answer-question", limit: 2, context: { max_messages: 1 } },
      { query: "pending-answer-question", limit: 21, context: { max_messages: 40 } },
    ]) {
      const invalid = await postJson(`${origin}/v1/me/context/search/expand`, body);
      assert.equal(invalid.response.status, 400, invalid.text);
    }
  });
  it("expands around attachment-only neighbors instead of failing the search", async () => {
    const root = await createRoot();
    const { origin } = await startApi(
      root,
      { driver: "none" },
      undefined,
      ingestAttachmentConversation,
    );
    const expanded = await postJson(`${origin}/v1/me/context/search/expand`, {
      query: "photo-caption-question",
      limit: 1,
      context: { before: 2, after: 2, reply_depth: 0, max_messages: 5 },
    });
    assert.equal(expanded.response.status, 200, expanded.text);
    const [conversation] = JSON.parse(expanded.text).conversations;
    assert.deepEqual(
      conversation.messages.map((message) => [message.external_id, message.text, message.attachments]),
      [
        ["customer-b:1", "opening-line before the photos", undefined],
        ["customer-b:2", "", [{ media_type: "image/png", filename: "image.png" }]],
        ["customer-b:3", "photo-caption-question: which one?", undefined],
        ["customer-b:4", "", [{ media_type: "application/pdf", filename: "brief.pdf" }]],
        ["customer-b:5", "closing-line after the photos", undefined],
      ],
    );
    assert.deepEqual(conversation.continuation.gaps, []);
    assert.equal(conversation.truncated, false);
  });
  it("loads more messages around a search card from its continuation boundaries", async () => {
    const root = await createRoot();
    const { origin } = await startApi(root, { driver: "none" }, undefined, ingestConversationEvidence);
    const expanded = JSON.parse((await postJson(`${origin}/v1/me/context/search/expand`, {
      query: "identity-follow-up",
      limit: 1,
      context: { before: 0, after: 0, reply_depth: 0, max_messages: 1 },
    })).text).conversations[0];
    assert.equal(expanded.messages.length, 1);
    assert.ok(expanded.continuation.before);

    const earlier = await postJson(`${origin}/v1/me/context/search/window?locale=en`, {
      thread_id: expanded.thread_id,
      read_epoch: expanded.read_epoch,
      direction: "before",
      boundary: expanded.continuation.before,
      limit: 1,
    });
    assert.equal(earlier.response.status, 200, earlier.text);
    const page = JSON.parse(earlier.text);
    assert.deepEqual(page.messages.map((message) => message.external_id), ["customer-a:2"]);
    assert.equal(page.has_more, true);
    assert.ok("actor_label" in page.messages[0]);

    const rest = JSON.parse((await postJson(`${origin}/v1/me/context/search/window`, {
      thread_id: expanded.thread_id,
      read_epoch: expanded.read_epoch,
      direction: "before",
      boundary: { occurred_at: page.messages[0].occurred_at, event_id: page.messages[0].event_id },
      limit: 10,
    })).text);
    assert.deepEqual(rest.messages.map((message) => message.external_id), ["customer-a:1"]);
    assert.equal(rest.has_more, false);

    const between = JSON.parse((await postJson(`${origin}/v1/me/context/search/window`, {
      thread_id: expanded.thread_id,
      read_epoch: expanded.read_epoch,
      direction: "after",
      boundary: { occurred_at: rest.messages[0].occurred_at, event_id: rest.messages[0].event_id },
      until: expanded.continuation.before,
      limit: 10,
    })).text);
    assert.deepEqual(between.messages.map((message) => message.external_id), ["customer-a:2"]);

    const stale = await postJson(`${origin}/v1/me/context/search/window`, {
      thread_id: expanded.thread_id,
      read_epoch: "stale-epoch",
      direction: "before",
      boundary: expanded.continuation.before,
    });
    assert.equal(stale.response.status, 409, stale.text);
    assert.equal(JSON.parse(stale.text).error.code, "context_changed");

    for (const body of [
      { thread_id: expanded.thread_id, read_epoch: expanded.read_epoch, direction: "sideways", boundary: expanded.continuation.before },
      { thread_id: expanded.thread_id, read_epoch: expanded.read_epoch, direction: "before", boundary: { occurred_at: "x" } },
      { thread_id: expanded.thread_id, read_epoch: expanded.read_epoch, direction: "before", boundary: expanded.continuation.before, limit: 51 },
    ]) {
      const invalid = await postJson(`${origin}/v1/me/context/search/window`, body);
      assert.equal(invalid.response.status, 400, invalid.text);
    }
  });
  it("answers a search through an installed executor and maps its bracket citations", async () => {
    const root = await createRoot();
    const executor = await startExecutorStub("Alice and Bob were selected [1]; Alice is creator-1 [3]. [9]");
    const { origin } = await startApi(root, { driver: "none" }, undefined, ingestConversationEvidence);
    const executorType = await installHttpExecutor(origin, executor.baseUrl);
    const conversation = JSON.parse((await postJson(`${origin}/v1/me/context/search/expand`, {
      query: "pending-answer-question",
      limit: 1,
      context: { before: 1, after: 1, reply_depth: 8, max_messages: 3 },
    })).text).conversations[0];
    const eventIds = conversation.messages.map((message) => message.event_id);

    const started = await postJson(`${origin}/v1/me/context/search/answers`, {
      query: "Who was selected?",
      conversations: [{ thread_id: conversation.thread_id, event_ids: eventIds }],
      executor_type: executorType,
    });
    assert.equal(started.response.status, 202, started.text);
    const job = JSON.parse(started.text);
    assert.equal(job.status, "running");
    assert.equal(job.executor_type, executorType);

    const run = executor.requests.find((request) => request.method === "POST" && request.url === "/v1/runs");
    assert.match(run.body.executor_config.prompt, /bracket numbers/);
    assert.match(run.body.evidence_text, /\n\nQUESTION\nWho was selected\?\n\nCONVERSATIONS\n## /);
    assert.match(run.body.evidence_text, /\[1\] 2026-08-30 00:00 UTC · .+: Customer customer-a selected Alice and Bob\./);
    assert.match(run.body.evidence_text, /\[3\] .+ \(reply to \[1\]\): identity-follow-up/);

    const finished = JSON.parse((await fetch(`${origin}/v1/me/context/search/answers/${job.answer_id}`).then((r) => r.text())));
    assert.equal(finished.status, "completed");
    assert.equal(finished.agent_thread_id, "dsh:answer-1");
    const ledger = new SqliteAuthorityStore(join(root, "authority.db"));
    const persisted = await ledger.getSearchAnswer("local-owner", job.answer_id);
    assert.equal(persisted.query, "Who was selected?");
    assert.deepEqual(persisted.event_ids, eventIds);
    const item = await ledger.getWorkItem("local-owner", persisted.work_item_id);
    const runs = await ledger.listWorkRuns("local-owner", persisted.work_item_id);
    assert.equal(item.status, "done");
    assert.equal(runs[0].status, "completed");
    assert.equal(runs[0].result.summary, "Alice and Bob were selected [1]; Alice is creator-1 [3]. [9]");
    assert.ok((await ledger.listHiddenExecutorThreadIds("local-owner")).includes("dsh:answer-1"));
    const systemRecipeId = item.recipe_id;
    ledger.close();
    const visibleRecipes = await (await fetch(`${origin}/v1/me/recipes`)).json();
    assert.ok(visibleRecipes.every((recipe) => !recipe.id.startsWith("system:")));
    const systemRecipeUrl = `${origin}/v1/me/recipes/${encodeURIComponent(systemRecipeId)}`;
    assert.equal((await postJson(systemRecipeUrl, {})).response.status, 404);
    assert.equal((await postJson(`${systemRecipeUrl}/try`, {})).response.status, 404);
    assert.equal((await fetch(systemRecipeUrl, { method: "DELETE" })).status, 404);
    assert.equal(finished.answer, "Alice and Bob were selected [1]; Alice is creator-1 [3]. [9]");
    assert.deepEqual(finished.citations, [
      { ref: 1, event_id: eventIds[0] },
      { ref: 3, event_id: eventIds[2] },
    ]);

    const unknown = await postJson(`${origin}/v1/me/context/search/answers`, {
      query: "Who was selected?",
      conversations: [{ thread_id: conversation.thread_id, event_ids: eventIds }],
      executor_type: "missing-executor",
    });
    assert.equal(unknown.response.status, 409, unknown.text);
    assert.equal(JSON.parse(unknown.text).error.code, "executor_unavailable");
    const missing = await fetch(`${origin}/v1/me/context/search/answers/not-an-answer`);
    assert.equal(missing.status, 404);
    const changed = await postJson(`${origin}/v1/me/context/search/answers`, {
      query: "Who was selected?",
      conversations: [{
        thread_id: conversation.thread_id,
        event_ids: [eventIds[0], "forged-event"],
      }],
      executor_type: executorType,
    });
    assert.equal(changed.response.status, 409, changed.text);
    assert.equal(JSON.parse(changed.text).error.code, "context_changed");
    for (const body of [
      { query: "x", conversations: [] },
      { query: "x", conversations: [{ thread_id: conversation.thread_id, event_ids: [] }] },
      { query: "x", conversations: [{ thread_id: conversation.thread_id, event_ids: [eventIds[0], eventIds[0]] }] },
      { query: " ", conversations: [{ thread_id: conversation.thread_id, event_ids: eventIds }] },
      { query: "x", conversations: [{ thread_id: conversation.thread_id, event_ids: eventIds }], model: "x" },
    ]) {
      const invalid = await postJson(`${origin}/v1/me/context/search/answers`, body);
      assert.equal(invalid.response.status, 400, invalid.text);
    }
  });
  it("removes answer metadata when executor startup fails definitively", async () => {
    const root = await createRoot();
    const { origin } = await startApi(
      root,
      { driver: "none" },
      undefined,
      ingestConversationEvidence,
    );
    const conversation = JSON.parse((await postJson(
      `${origin}/v1/me/context/search/expand`,
      { query: "pending-answer-question", limit: 1 },
    )).text).conversations[0];
    const failed = await postJson(
      `${origin}/v1/me/context/search/answers`,
      {
        query: "Who was selected?",
        conversations: [{
          thread_id: conversation.thread_id,
          event_ids: [conversation.messages[0].event_id],
        }],
      },
    );
    assert.equal(failed.response.status, 501, failed.text);
    assert.equal(
      JSON.parse(failed.text).error.code,
      "executor_session_unavailable",
    );
    const ledger = new SqliteAuthorityStore(join(root, "authority.db"));
    try {
      const failedItem = (await ledger.listWorkItems("local-owner"))
        .find((item) => item.id.startsWith("search-answer:"));
      assert.ok(failedItem);
      assert.equal(failedItem.status, "failed");
      assert.equal(
        await ledger.getSearchAnswer(
          "local-owner",
          failedItem.id.slice("search-answer:".length),
        ),
        null,
      );
    } finally {
      ledger.close();
    }
  });
  it("recovers an in-flight executor answer after the API restarts", async () => {
    const root = await createRoot();
    const executor = await startExecutorStub("Recovered answer [1].");
    const first = await startApi(
      root,
      { driver: "none" },
      undefined,
      ingestConversationEvidence,
    );
    const executorType = await installHttpExecutor(first.origin, executor.baseUrl);
    const conversation = JSON.parse((await postJson(
      `${first.origin}/v1/me/context/search/expand`,
      { query: "pending-answer-question", limit: 1 },
    )).text).conversations[0];
    const eventId = conversation.messages[0].event_id;
    const started = JSON.parse((await postJson(
      `${first.origin}/v1/me/context/search/answers`,
      {
        query: "Who was selected?",
        conversations: [{
          thread_id: conversation.thread_id,
          event_ids: [eventId],
        }],
        executor_type: executorType,
      },
    )).text);
    assert.equal(started.status, "running");
    await first.app.close();
    apps.splice(apps.indexOf(first.app), 1);

    const second = await startApi(
      root,
      { driver: "none" },
      undefined,
      null,
    );
    const recovered = await fetch(
      `${second.origin}/v1/me/context/search/answers/${started.answer_id}`,
    );
    assert.equal(recovered.status, 200);
    const result = await recovered.json();
    assert.equal(result.status, "completed");
    assert.equal(result.answer, "Recovered answer [1].");
    assert.deepEqual(result.citations, [{ ref: 1, event_id: eventId }]);
  });
  it("cancels a running executor answer", async () => {
    const root = await createRoot();
    const executor = await startExecutorStub();
    const { origin } = await startApi(root, { driver: "none" }, undefined, ingestConversationEvidence);
    const executorType = await installHttpExecutor(origin, executor.baseUrl);
    const conversation = JSON.parse((await postJson(`${origin}/v1/me/context/search/expand`, {
      query: "pending-answer-question",
      limit: 1,
    })).text).conversations[0];
    const job = JSON.parse((await postJson(`${origin}/v1/me/context/search/answers`, {
      query: "Who was selected?",
      conversations: [{ thread_id: conversation.thread_id, event_ids: [conversation.messages[0].event_id] }],
      executor_type: executorType,
    })).text);
    const polled = JSON.parse(await fetch(`${origin}/v1/me/context/search/answers/${job.answer_id}`).then((r) => r.text()));
    assert.equal(polled.status, "running");
    const cancelled = await postJson(`${origin}/v1/me/context/search/answers/${job.answer_id}/cancel`, {});
    assert.equal(JSON.parse(cancelled.text).status, "cancelled");
    assert.ok(executor.requests.some((request) => request.url === "/v1/runs/run-1/cancel"));
  });
  it("skips an unreadable neighbor without reporting it as omitted context", async () => {
    const root = await createRoot();
    const { origin } = await startApi(
      root,
      { driver: "none" },
      undefined,
      ingestConversationMetadataOnly,
    );
    const expanded = await postJson(`${origin}/v1/me/context/search/expand`, {
      query: "identity-follow-up",
      limit: 1,
      context: { before: 2, after: 1, reply_depth: 0, max_messages: 4 },
    });
    assert.equal(expanded.response.status, 200, expanded.text);
    const [conversation] = JSON.parse(expanded.text).conversations;
    assert.deepEqual(
      conversation.messages.map((message) => message.external_id),
      ["customer-a:1", "customer-a:2", "customer-a:3"],
    );
    assert.deepEqual(conversation.continuation.gaps, []);
    assert.equal(conversation.continuation.after, null);
    assert.equal(conversation.truncated, false);
  });
  it("reviews a snapshot-pinned Proposal and atomically commits one Decision", async () => {
    const root = await createRoot();
    const { origin, eventId } = await startApi(root);
    const assembled = await postJson(`${origin}/v1/me/context/assemble`, assembleBody());
    assert.equal(assembled.response.status, 201);
    const snapshotId = JSON.parse(assembled.text).snapshot.id;
    const proposalBody = {
      client_request_id: "decision-request-1",
      title: "Approve the release",
      summary: "Approve the bounded release plan.",
      rights_level: "coach",
      boundary: "Release decision only",
      context_snapshot_id: snapshotId,
      evidence: [{ kind: "document", uri_or_ref: `event:${eventId}` }],
    };
    const created = await postJson(`${origin}/v1/me/context/proposals`, proposalBody);
    assert.equal(created.response.status, 201);
    const proposal = JSON.parse(created.text);
    assert.equal(proposal.kind, "decision");
    const missingEvidence = await postJson(`${origin}/v1/me/context/proposals`, {
      ...proposalBody,
      client_request_id: "missing-evidence",
      evidence: [{ kind: "document", uri_or_ref: "event:missing" }],
    });
    assert.equal(missingEvidence.response.status, 400);
    assert.equal(JSON.parse((await postJson(`${origin}/v1/me/context/proposals`, proposalBody)).text).id, proposal.id);
    assert.equal(JSON.parse((await postJson(`${origin}/v1/me/context/proposals/${encodeURIComponent(proposal.id)}/submit`, {})).text).status, "submitted");
    assert.equal(JSON.parse((await postJson(`${origin}/v1/me/context/proposals/${encodeURIComponent(proposal.id)}/review`, {})).text).status, "in_review");
    const decisionBody = {
      summary: "Proceed with the release.",
      rationale: "The pinned evidence supports the bounded release.",
    };
    const committed = await postJson(`${origin}/v1/me/context/proposals/${encodeURIComponent(proposal.id)}/decision`, decisionBody);
    assert.equal(committed.response.status, 201);
    const result = JSON.parse(committed.text);
    assert.equal(result.proposal.status, "accepted");
    assert.deepEqual(result.proposal.outcome_ref, { outcome_kind: "decision", ref_id: result.decision.id });
    assert.equal(result.decision.context_snapshot_id, snapshotId);
    const repeated = await postJson(`${origin}/v1/me/context/proposals/${encodeURIComponent(proposal.id)}/decision`, decisionBody);
    assert.equal(JSON.parse(repeated.text).decision.id, result.decision.id);
    const changed = await postJson(`${origin}/v1/me/context/proposals/${encodeURIComponent(proposal.id)}/decision`, {
      ...decisionBody, rationale: "Changed after commit.",
    });
    assert.equal(changed.response.status, 409);
    assert.equal((await (await fetch(`${origin}/v1/me/context/decisions`)).json())[0].id, result.decision.id);
    assert.equal((await (await fetch(`${origin}/v1/me/context/decisions/${encodeURIComponent(result.decision.id)}`)).json()).proposal_id, proposal.id);
    const reviewBody = {
      client_request_id: "decision-review-1",
      result: "falsified",
      severity: "bad_news",
      evidence: [{ kind: "data", uri_or_ref: `event:${eventId}` }],
      recommended_action: "revise_standard",
    };
    const reviewed = await postJson(`${origin}/v1/me/context/decisions/${encodeURIComponent(result.decision.id)}/reviews`, reviewBody);
    assert.equal(reviewed.response.status, 201);
    const review = JSON.parse(reviewed.text);
    assert.equal(review.subject_id, result.decision.id);
    assert.equal(review.context_snapshot_id, snapshotId);
    assert.equal(review.recommended_action, "revise_standard");
    assert.equal(JSON.parse((await postJson(`${origin}/v1/me/context/decisions/${encodeURIComponent(result.decision.id)}/reviews`, reviewBody)).text).id, review.id);
    const changedReview = await postJson(`${origin}/v1/me/context/decisions/${encodeURIComponent(result.decision.id)}/reviews`, {
      ...reviewBody, result: "inconclusive",
    });
    assert.equal(changedReview.response.status, 409);
    const missingReviewEvidence = await postJson(`${origin}/v1/me/context/decisions/${encodeURIComponent(result.decision.id)}/reviews`, {
      ...reviewBody, client_request_id: "missing-review-evidence",
      evidence: [{ kind: "data", uri_or_ref: "event:missing" }],
    });
    assert.equal(missingReviewEvidence.response.status, 400);
    const invalidReview = await postJson(`${origin}/v1/me/context/decisions/${encodeURIComponent(result.decision.id)}/reviews`, {
      ...reviewBody, client_request_id: "invalid-review", recommended_action: "solidify",
    });
    assert.equal(invalidReview.response.status, 400);
    assert.deepEqual((await (await fetch(`${origin}/v1/me/context/decisions/${encodeURIComponent(result.decision.id)}/reviews`)).json()).map(({ id }) => id), [review.id]);
    assert.equal((await (await fetch(`${origin}/v1/me/context/reviews/${encodeURIComponent(review.id)}`)).json()).result, "falsified");
    const reviewGap = await postJson(`${origin}/v1/me/context/reviews/${encodeURIComponent(review.id)}/standard-gap`, {
      summary: "The release decision exposed a missing standard.",
      proposed_uncertainty: "Can a release gate prevent this failure?",
    });
    assert.equal(reviewGap.response.status, 201);
    assert.equal(JSON.parse(reviewGap.text).source_ref, review.id);
    const rejectedCreated = await postJson(`${origin}/v1/me/context/proposals`, {
      ...proposalBody, client_request_id: "decision-request-rejected", title: "Reject another release",
    });
    const rejectedId = JSON.parse(rejectedCreated.text).id;
    const mismatchedHandoff = await postJson(`${origin}/v1/me/context/handoffs`, {
      client_request_id: "mismatched-handoff",
      direction: "human_to_agent",
      agent_id: "agent-1",
      reason: "set_boundary",
      proposal_id: rejectedId,
      decision_id: result.decision.id,
      context_snapshot_id: snapshotId,
      payload: { boundary: "Release only" },
    });
    assert.equal(mismatchedHandoff.response.status, 400);
    await postJson(`${origin}/v1/me/context/proposals/${encodeURIComponent(rejectedId)}/submit`, {});
    await postJson(`${origin}/v1/me/context/proposals/${encodeURIComponent(rejectedId)}/review`, {});
    const rejected = await postJson(`${origin}/v1/me/context/proposals/${encodeURIComponent(rejectedId)}/reject`, {});
    assert.equal(JSON.parse(rejected.text).status, "rejected");
  });

  it("moves explicit human-agent Handoffs through acknowledgement", async () => {
    const root = await createRoot();
    const { origin } = await startApi(root);
    const assembled = await postJson(`${origin}/v1/me/context/assemble`, assembleBody());
    const snapshotId = JSON.parse(assembled.text).snapshot.id;
    const inboundBody = {
      client_request_id: "handoff-inbound-1",
      direction: "agent_to_human",
      agent_id: "agent-1",
      reason: "evidence_conflict",
      context_snapshot_id: snapshotId,
      standard_bindings: [],
      payload: { summary: "Two cited claims disagree." },
    };
    const created = await postJson(`${origin}/v1/me/context/handoffs`, inboundBody);
    assert.equal(created.response.status, 201);
    const handoff = JSON.parse(created.text);
    assert.equal(handoff.status, "open");
    assert.equal(handoff.from.actor_type, "agent");
    assert.equal(handoff.to.actor_type, "human");
    assert.equal(JSON.parse((await postJson(`${origin}/v1/me/context/handoffs`, inboundBody)).text).id, handoff.id);
    const changed = await postJson(`${origin}/v1/me/context/handoffs`, {
      ...inboundBody, payload: { summary: "Changed after creation." },
    });
    assert.equal(changed.response.status, 409);
    const invalidReason = await postJson(`${origin}/v1/me/context/handoffs`, {
      ...inboundBody, client_request_id: "handoff-invalid-reason", reason: "set_boundary",
    });
    assert.equal(invalidReason.response.status, 400);
    const missingSnapshot = await postJson(`${origin}/v1/me/context/handoffs`, {
      ...inboundBody, client_request_id: "handoff-missing-snapshot", context_snapshot_id: "missing",
    });
    assert.equal(missingSnapshot.response.status, 404);
    assert.equal((await (await fetch(`${origin}/v1/me/context/handoffs?status=open&direction=agent_to_human`)).json())[0].id, handoff.id);
    assert.equal((await (await fetch(`${origin}/v1/me/context/handoffs/${encodeURIComponent(handoff.id)}`)).json()).status, "open");
    const prematureResolve = await postJson(`${origin}/v1/me/context/handoffs/${encodeURIComponent(handoff.id)}/resolve`, {});
    assert.equal(prematureResolve.response.status, 409);
    assert.equal(JSON.parse((await postJson(`${origin}/v1/me/context/handoffs/${encodeURIComponent(handoff.id)}/ack`, {})).text).status, "acked");
    const resolved = JSON.parse((await postJson(`${origin}/v1/me/context/handoffs/${encodeURIComponent(handoff.id)}/resolve`, {})).text);
    assert.equal(resolved.status, "resolved");
    assert.ok(resolved.resolved_at);
    assert.equal((await postJson(`${origin}/v1/me/context/handoffs/${encodeURIComponent(handoff.id)}/cancel`, {})).response.status, 409);

    const outbound = JSON.parse((await postJson(`${origin}/v1/me/context/handoffs`, {
      client_request_id: "handoff-outbound-1",
      direction: "human_to_agent",
      agent_id: "agent-1",
      reason: "set_boundary",
      context_snapshot_id: snapshotId,
      payload: { boundary: "Release only" },
    })).text);
    assert.equal(outbound.from.actor_type, "human");
    assert.equal(outbound.to.actor_type, "agent");
    assert.equal(JSON.parse((await postJson(`${origin}/v1/me/context/handoffs/${encodeURIComponent(outbound.id)}/cancel`, {})).text).status, "cancelled");
    assert.equal((await (await fetch(`${origin}/v1/me/context/handoffs?status=cancelled&direction=human_to_agent`)).json())[0].id, outbound.id);
  });

  it("commits and promotes governed Standard versions", async () => {
    const root = await createRoot();
    const { origin, eventId } = await startApi(root);
    const assembled = await postJson(`${origin}/v1/me/context/assemble`, assembleBody());
    const snapshotId = JSON.parse(assembled.text).snapshot.id;
    const uncertainty = "Can this release process prevent regressions?";
    const proposalBody = {
      client_request_id: "standard-proposal-1",
      kind: "new_standard",
      title: "Create release safety standard",
      summary: "Create a bounded release safety standard.",
      rights_level: "coach",
      boundary: "Release governance only",
      context_snapshot_id: snapshotId,
      single_uncertainty: uncertainty,
      evidence: [{ kind: "document", uri_or_ref: `event:${eventId}` }],
    };
    const proposal = JSON.parse((await postJson(`${origin}/v1/me/context/proposals`, proposalBody)).text);
    await postJson(`${origin}/v1/me/context/proposals/${encodeURIComponent(proposal.id)}/submit`, {});
    await postJson(`${origin}/v1/me/context/proposals/${encodeURIComponent(proposal.id)}/review`, {});
    const gate = {
      single_uncertainty: uncertainty,
      target_user_tier: "early_adopter",
      consensus_hypothesis: "Teams need a bounded release check.",
      value_metric: "Escaped regressions per release",
      cost_budget: "Two engineer-days",
      validation_window: "14 days",
      stop_condition: "Stop after one severe regression.",
      stable_core_preserved: true,
      compat_and_rollback: "Keep the previous release path available.",
      learning_output: "new_standard",
    };
    const versionBody = {
      slug: "release-safety",
      title: "Release safety",
      layer: "adjacent",
      scope: { decision_kinds: ["release"] },
      version: "1.0.0",
      condition: "A release changes production behavior.",
      action: "Run the bounded release check.",
      acceptance: "No severe regression escapes during the validation window.",
      boundary: "Escalate when rollback is unavailable.",
      revision_trigger: "A severe regression escapes the check.",
      gate,
      trial: {
        audience: { team_ids: ["team-1"], decision_kinds: ["release"] },
        starts_at: "2026-09-19T00:00:00.000Z",
        ends_at: "2026-10-03T00:00:00.000Z",
        success_metric: "Zero severe escaped regressions",
        stop_condition: "Stop after one severe escaped regression.",
      },
    };
    const committed = await postJson(`${origin}/v1/me/context/proposals/${encodeURIComponent(proposal.id)}/standard-version`, versionBody);
    assert.equal(committed.response.status, 201);
    const first = JSON.parse(committed.text);
    assert.equal(first.proposal.status, "accepted");
    assert.deepEqual(first.proposal.outcome_ref, { outcome_kind: "standard_version", ref_id: first.version.id });
    assert.equal(first.version.status, "draft");
    assert.equal(JSON.parse((await postJson(`${origin}/v1/me/context/proposals/${encodeURIComponent(proposal.id)}/standard-version`, versionBody)).text).version.id, first.version.id);
    const changed = await postJson(`${origin}/v1/me/context/proposals/${encodeURIComponent(proposal.id)}/standard-version`, {
      ...versionBody, action: "Changed after commit.",
    });
    assert.equal(changed.response.status, 409);
    const noEvidence = await postJson(`${origin}/v1/me/context/standard-versions/${encodeURIComponent(first.version.id)}/publish-active`, {});
    assert.equal(noEvidence.response.status, 409);
    assert.equal(JSON.parse((await postJson(`${origin}/v1/me/context/standard-versions/${encodeURIComponent(first.version.id)}/publish-trial`, {})).text).status, "trial");
    const upgradeEvidence = {
      core_value_revalidated: true,
      delivery_standardized: true,
      unit_economics_or_roi_ok: true,
      next_tier_behavioral_evidence: true,
      rollback_safe: true,
    };
    assert.equal(JSON.parse((await postJson(`${origin}/v1/me/context/standard-versions/${encodeURIComponent(first.version.id)}/promote`, {
      upgrade_evidence: upgradeEvidence,
    })).text).status, "active");
    assert.equal((await (await fetch(`${origin}/v1/me/context/standards`)).json())[0].id, first.standard.id);
    assert.equal((await (await fetch(`${origin}/v1/me/context/standards/${encodeURIComponent(first.standard.id)}`)).json()).current_version_id, first.version.id);

    const revisionGap = JSON.parse((await postJson(`${origin}/v1/me/context/standard-gaps`, {
      client_request_id: "standard-revision-gap",
      summary: "The release standard needs a revision.",
      proposed_uncertainty: uncertainty,
    })).text);
    const revisionConversionBody = {
      kind: "revise_standard",
      title: "Revise release safety standard",
      summary: "Publish the bounded release result.",
      rights_level: "coach",
      boundary: "Release governance only",
      context_snapshot_id: snapshotId,
      standard_id: first.standard.id,
      version_id: first.version.id,
      evidence: [{ kind: "document", uri_or_ref: `event:${eventId}` }],
    };
    const revisionProposal = JSON.parse((await postJson(`${origin}/v1/me/context/standard-gaps/${encodeURIComponent(revisionGap.id)}/proposal`, revisionConversionBody)).text).proposal;
    await postJson(`${origin}/v1/me/context/proposals/${encodeURIComponent(revisionProposal.id)}/submit`, {});
    await postJson(`${origin}/v1/me/context/proposals/${encodeURIComponent(revisionProposal.id)}/review`, {});
    const revisionBody = {
      target_standard_id: first.standard.id,
      supersedes_version_id: first.version.id,
      version: "1.1.0",
      condition: versionBody.condition,
      action: "Run the bounded release check and publish its result.",
      acceptance: versionBody.acceptance,
      boundary: versionBody.boundary,
      revision_trigger: versionBody.revision_trigger,
      gate: { ...gate, learning_output: "revision" },
    };
    const revision = JSON.parse((await postJson(`${origin}/v1/me/context/proposals/${encodeURIComponent(revisionProposal.id)}/standard-version`, revisionBody)).text);
    assert.equal(revision.version.supersedes_version_id, first.version.id);
    assert.equal(JSON.parse((await postJson(`${origin}/v1/me/context/standard-versions/${encodeURIComponent(revision.version.id)}/publish-active`, {
      upgrade_evidence: upgradeEvidence,
    })).text).status, "active");
    const historicalRunBody = {
      client_request_id: "agent-run-historical-retry",
      agent_id: "agent-1",
      intent: "Apply the pinned release standard.",
      context_snapshot_id: snapshotId,
      standard_bindings: [{ standard_id: first.standard.id, version_id: first.version.id }],
      input: { release_id: "release-historical" },
    };
    const historicalRun = JSON.parse((await postJson(`${origin}/v1/me/context/runs`, historicalRunBody)).text);
    const deprecated = JSON.parse((await postJson(`${origin}/v1/me/context/standard-versions/${encodeURIComponent(first.version.id)}/deprecate`, {
      superseded_by_version_id: revision.version.id,
    })).text);
    assert.equal(deprecated.status, "deprecated");
    assert.equal(deprecated.superseded_by_version_id, revision.version.id);
    const retriedConversion = await postJson(`${origin}/v1/me/context/standard-gaps/${encodeURIComponent(revisionGap.id)}/proposal`, revisionConversionBody);
    assert.equal(retriedConversion.response.status, 201);
    assert.equal(JSON.parse(retriedConversion.text).proposal.status, "accepted");
    assert.equal(JSON.parse((await postJson(`${origin}/v1/me/context/runs`, historicalRunBody)).text).id, historicalRun.id);
    assert.deepEqual((await (await fetch(`${origin}/v1/me/context/standards/${encodeURIComponent(first.standard.id)}/versions`)).json()).map(({ status }) => status), ["deprecated", "active"]);
    assert.equal((await (await fetch(`${origin}/v1/me/context/standard-versions/${encodeURIComponent(revision.version.id)}`)).json()).status, "active");

    const runBody = {
      client_request_id: "agent-run-1",
      agent_id: "agent-1",
      intent: "Apply the active release standard.",
      context_snapshot_id: snapshotId,
      standard_bindings: [{ standard_id: first.standard.id, version_id: revision.version.id }],
      input: { release_id: "release-1" },
    };
    const queuedResponse = await postJson(`${origin}/v1/me/context/runs`, runBody);
    assert.equal(queuedResponse.response.status, 202);
    const run = JSON.parse(queuedResponse.text);
    assert.equal(run.status, "queued");
    assert.equal(run.agent.actor_type, "agent");
    assert.equal(run.on_behalf_of.actor_type, "human");
    assert.equal(JSON.parse((await postJson(`${origin}/v1/me/context/runs`, runBody)).text).id, run.id);
    assert.equal(JSON.parse((await postJson(`${origin}/v1/me/context/runs/${encodeURIComponent(run.id)}/usage/project`, {})).text)[0].source_id, run.id);
    const runUsageUrl = `${origin}/v1/me/context/standards/${encodeURIComponent(first.standard.id)}/usage?version_id=${encodeURIComponent(revision.version.id)}&source_kind=agent_run`;
    assert.deepEqual((await (await fetch(runUsageUrl)).json()).map(({ source_id }) => source_id), [run.id]);
    const usageDecisionProposal = JSON.parse((await postJson(`${origin}/v1/me/context/proposals`, {
      client_request_id: "usage-decision-proposal",
      kind: "decision",
      title: "Approve usage-ledger release",
      summary: "Approve one release under the active StandardVersion.",
      rights_level: "coach",
      boundary: "Release decision only",
      context_snapshot_id: snapshotId,
      standard_bindings: [{ standard_id: first.standard.id, version_id: revision.version.id }],
      evidence: [{ kind: "document", uri_or_ref: `event:${eventId}` }],
    })).text);
    await postJson(`${origin}/v1/me/context/proposals/${encodeURIComponent(usageDecisionProposal.id)}/submit`, {});
    await postJson(`${origin}/v1/me/context/proposals/${encodeURIComponent(usageDecisionProposal.id)}/review`, {});
    const usageDecision = JSON.parse((await postJson(`${origin}/v1/me/context/proposals/${encodeURIComponent(usageDecisionProposal.id)}/decision`, {
      summary: "Proceed under the active release standard.",
      rationale: "The pinned evidence supports the bounded release.",
    })).text).decision;
    assert.equal(JSON.parse((await postJson(`${origin}/v1/me/context/decisions/${encodeURIComponent(usageDecision.id)}/usage/project`, {})).text)[0].source_id, usageDecision.id);
    const decisionUsage = await (await fetch(`${origin}/v1/me/context/standards/${encodeURIComponent(first.standard.id)}/usage?source_kind=decision`)).json();
    assert.deepEqual(decisionUsage.map(({ source_id }) => source_id), [usageDecision.id]);
    assert.equal((await (await fetch(`${origin}/v1/me/context/standards/${encodeURIComponent(first.standard.id)}`)).json()).citation_count, 3);
    const recentObservedAt = new Date(Date.now() + 60_000).toISOString();
    const recentHealth = await fetch(`${origin}/v1/me/context/standards/health?observed_at=${encodeURIComponent(recentObservedAt)}&stale_after_days=30`);
    assert.equal(recentHealth.status, 200);
    assert.deepEqual(await recentHealth.json(), { candidates: [], next_after: null });
    const staleObservedAt = new Date(Date.parse(recentObservedAt) + 31 * 24 * 60 * 60 * 1_000).toISOString();
    const staleHealth = await fetch(`${origin}/v1/me/context/standards/health?observed_at=${encodeURIComponent(staleObservedAt)}&stale_after_days=30`);
    assert.equal(staleHealth.status, 200);
    const { candidates: [healthCandidate], next_after: nextHealthAfter } = await staleHealth.json();
    assert.equal(nextHealthAfter, null);
    assert.equal(healthCandidate.standard_id, first.standard.id);
    assert.equal(healthCandidate.version_id, revision.version.id);
    assert.equal(healthCandidate.reason, "stale_usage");
    assert.equal(healthCandidate.recommendation, "review_deprecate_or_merge");
    assert.ok(healthCandidate.standard_citation_count >= healthCandidate.citation_count);
    assert.equal((await fetch(`${origin}/v1/me/context/standards/health?stale_after_days=0`)).status, 400);
    assert.equal((await fetch(`${origin}/v1/me/context/standards/health?observed_at=${encodeURIComponent("2027-12-31T00:00:00")}`)).status, 400);
    assert.equal((await (await fetch(`${origin}/v1/me/context/standard-versions/${encodeURIComponent(revision.version.id)}`)).json()).status, "active");
    const reviewBody = {
      client_request_id: "agent-run-review-1",
      result: "falsified",
      severity: "bad_news",
      evidence: [{ kind: "data", uri_or_ref: `event:${eventId}` }],
      recommended_action: "revise_standard",
    };
    assert.equal((await postJson(`${origin}/v1/me/context/runs/${encodeURIComponent(run.id)}/reviews`, reviewBody)).response.status, 409);
    const deprecatedBinding = await postJson(`${origin}/v1/me/context/runs`, {
      ...runBody, client_request_id: "agent-run-deprecated",
      standard_bindings: [{ standard_id: first.standard.id, version_id: first.version.id }],
    });
    assert.equal(deprecatedBinding.response.status, 409);
    assert.equal((await postJson(`${origin}/v1/me/context/runs`, {
      ...runBody,
      client_request_id: "agent-run-duplicate-binding",
      standard_bindings: [runBody.standard_bindings[0], runBody.standard_bindings[0]],
    })).response.status, 400);
    assert.equal(JSON.parse((await postJson(`${origin}/v1/me/context/runs/${encodeURIComponent(run.id)}/start`, {})).text).status, "running");
    const output = {
      summary: "The release check passed.",
      artifacts: [{ kind: "report", ref: "artifact-1" }],
      applied_standard_version_ids: [revision.version.id],
      context_snapshot_id: snapshotId,
      acceptance_check: "pass",
      exceptions: [],
      confidence: 0.9,
    };
    const completed = await postJson(`${origin}/v1/me/context/runs/${encodeURIComponent(run.id)}/complete`, {
      status: "succeeded", output,
    });
    assert.equal(JSON.parse(completed.text).status, "succeeded");
    assert.equal(JSON.parse((await postJson(`${origin}/v1/me/context/runs/${encodeURIComponent(run.id)}/complete`, {
      status: "succeeded", output,
    })).text).finished_at, JSON.parse(completed.text).finished_at);
    assert.equal((await postJson(`${origin}/v1/me/context/runs/${encodeURIComponent(run.id)}/complete`, {
      status: "failed", output: { ...output, acceptance_check: "fail" },
    })).response.status, 409);
    const invalidOutputRun = JSON.parse((await postJson(`${origin}/v1/me/context/runs`, {
      ...runBody, client_request_id: "agent-run-invalid-output", input: { release_id: "release-invalid" },
    })).text);
    await postJson(`${origin}/v1/me/context/runs/${encodeURIComponent(invalidOutputRun.id)}/start`, {});
    assert.equal((await postJson(`${origin}/v1/me/context/runs/${encodeURIComponent(invalidOutputRun.id)}/complete`, {
      status: "succeeded", output: { ...output, acceptance_check: "bogus" },
    })).response.status, 400);
    assert.equal((await (await fetch(`${origin}/v1/me/context/runs?status=succeeded`)).json())[0].id, run.id);
    assert.equal((await (await fetch(`${origin}/v1/me/context/runs/${encodeURIComponent(run.id)}`)).json()).output.context_snapshot_id, snapshotId);
    const reviewedResponse = await postJson(`${origin}/v1/me/context/runs/${encodeURIComponent(run.id)}/reviews`, reviewBody);
    assert.equal(reviewedResponse.response.status, 201);
    const runReview = JSON.parse(reviewedResponse.text);
    assert.equal(runReview.subject_kind, "agent_run");
    assert.equal(runReview.subject_id, run.id);
    assert.equal(runReview.context_snapshot_id, snapshotId);
    assert.equal(runReview.evidence[0].uri_or_ref, `agent-run:${run.id}`);
    assert.equal((await postJson(`${origin}/v1/me/context/runs/${encodeURIComponent(run.id)}/reviews`, {
      ...reviewBody, client_request_id: "agent-run-review-other-only",
      evidence: [{ kind: "other", uri_or_ref: `event:${eventId}` }],
    })).response.status, 400);
    const outsideEventId = await ingestEvidence(
      join(root, "authority.db"), join(root, "blobs"), "outside-run-snapshot",
    );
    assert.equal((await postJson(`${origin}/v1/me/context/runs/${encodeURIComponent(run.id)}/reviews`, {
      ...reviewBody, client_request_id: "agent-run-review-outside-snapshot",
      evidence: [{ kind: "data", uri_or_ref: `event:${outsideEventId}` }],
    })).response.status, 400);
    assert.equal(JSON.parse((await postJson(`${origin}/v1/me/context/runs/${encodeURIComponent(run.id)}/reviews`, reviewBody)).text).id, runReview.id);
    assert.equal((await postJson(`${origin}/v1/me/context/runs/${encodeURIComponent(run.id)}/reviews`, {
      ...reviewBody, result: "inconclusive",
    })).response.status, 409);
    assert.equal((await (await fetch(`${origin}/v1/me/context/runs/${encodeURIComponent(run.id)}/reviews`)).json())[0].id, runReview.id);
    const runGap = JSON.parse((await postJson(`${origin}/v1/me/context/reviews/${encodeURIComponent(runReview.id)}/standard-gap`, {
      summary: "The run falsified the current release standard.",
      proposed_uncertainty: "Can publishing the check result prevent this failure?",
    })).text);
    const otherSnapshot = JSON.parse((await postJson(`${origin}/v1/me/context/assemble`, {
      ...assembleBody(), consumer_id: "context-api-other-snapshot",
    })).text).snapshot.id;
    assert.equal((await postJson(`${origin}/v1/me/context/standard-gaps/${encodeURIComponent(runGap.id)}/proposal`, {
      kind: "revise_standard",
      title: "Wrong snapshot revision",
      summary: "This conversion must not change snapshots.",
      rights_level: "coach",
      boundary: "Release governance only",
      context_snapshot_id: otherSnapshot,
      standard_id: first.standard.id,
      version_id: revision.version.id,
      evidence: [{ kind: "data", uri_or_ref: `event:${eventId}` }],
    })).response.status, 409);
    assert.equal((await postJson(`${origin}/v1/me/context/standard-gaps/${encodeURIComponent(runGap.id)}/proposal`, {
      kind: "revise_standard",
      title: "Wrong binding revision",
      summary: "This conversion must not change bindings.",
      rights_level: "coach",
      boundary: "Release governance only",
      context_snapshot_id: snapshotId,
      standard_id: first.standard.id,
      version_id: first.version.id,
      evidence: [{ kind: "data", uri_or_ref: `event:${eventId}` }],
    })).response.status, 409);
    const runGapConversion = JSON.parse((await postJson(`${origin}/v1/me/context/standard-gaps/${encodeURIComponent(runGap.id)}/proposal`, {
      kind: "revise_standard",
      title: "Revise release safety after run failure",
      summary: "Revise the standard using the failed run evidence.",
      rights_level: "coach",
      boundary: "Release governance only",
      context_snapshot_id: snapshotId,
      standard_id: first.standard.id,
      version_id: revision.version.id,
      evidence: [{ kind: "data", uri_or_ref: `event:${eventId}` }],
    })).text);
    assert.equal(runGapConversion.gap.status, "converted");
    assert.equal(runGapConversion.proposal.kind, "revise_standard");
    assert.equal(runGapConversion.proposal.gap_id, runGap.id);

    const failedRunIds = [];
    for (const suffix of ["one", "two", "three"]) {
      const failedRun = JSON.parse((await postJson(`${origin}/v1/me/context/runs`, {
        ...runBody,
        client_request_id: `agent-run-drift-${suffix}`,
        input: { release_id: `release-drift-${suffix}` },
      })).text);
      failedRunIds.push(failedRun.id);
      await postJson(`${origin}/v1/me/context/runs/${encodeURIComponent(failedRun.id)}/start`, {});
      const failed = await postJson(`${origin}/v1/me/context/runs/${encodeURIComponent(failedRun.id)}/complete`, {
        status: "failed",
        output: {
          summary: "The release standard acceptance check failed.",
          artifacts: [],
          applied_standard_version_ids: [revision.version.id],
          context_snapshot_id: snapshotId,
          acceptance_check: "fail",
          exceptions: ["Acceptance failed."],
        },
      });
      assert.equal(JSON.parse(failed.text).status, "failed");
      const scan = await postJson(`${origin}/v1/me/context/runs/drift-scan`, { minimum_failures: 2 });
      assert.equal(scan.response.status, 201);
      if (suffix === "one") assert.deepEqual(JSON.parse(scan.text), []);
    }
    assert.equal((await postJson(`${origin}/v1/me/context/runs/drift-scan`, { minimum_failures: 1 })).response.status, 400);
    const [driftReview] = JSON.parse((await postJson(`${origin}/v1/me/context/runs/drift-scan`, {
      minimum_failures: 2,
    })).text);
    assert.equal(driftReview.subject_kind, "standard_version");
    assert.equal(driftReview.subject_id, revision.version.id);
    assert.equal(driftReview.severity, "bad_news");
    assert.equal(driftReview.author.actor_type, "system");
    assert.deepEqual(driftReview.evidence.map(({ uri_or_ref }) => uri_or_ref), failedRunIds.slice(0, 2).map((id) => `agent-run:${id}`));
    assert.equal(JSON.parse((await postJson(`${origin}/v1/me/context/runs/drift-scan`, {})).text)[0].id, driftReview.id);
    const [higherThresholdReview] = JSON.parse((await postJson(`${origin}/v1/me/context/runs/drift-scan`, {
      minimum_failures: 3,
    })).text);
    assert.notEqual(higherThresholdReview.id, driftReview.id);
    assert.deepEqual(higherThresholdReview.evidence.map(({ uri_or_ref }) => uri_or_ref), failedRunIds.map((id) => `agent-run:${id}`));
    const driftGap = JSON.parse((await postJson(`${origin}/v1/me/context/reviews/${encodeURIComponent(driftReview.id)}/standard-gap`, {
      summary: "Repeated Run failures indicate Standard drift.",
      proposed_uncertainty: "Can revised acceptance prevent repeated failures?",
    })).text);
    const driftConversionBody = {
      kind: "revise_standard",
      title: "Revise drifting release standard",
      summary: "Revise the standard after repeated acceptance failures.",
      rights_level: "coach",
      boundary: "Release governance only",
      context_snapshot_id: snapshotId,
      standard_id: first.standard.id,
      version_id: revision.version.id,
      evidence: [{ kind: "data", uri_or_ref: `event:${eventId}` }],
    };
    assert.equal((await postJson(`${origin}/v1/me/context/standard-gaps/${encodeURIComponent(driftGap.id)}/proposal`, {
      ...driftConversionBody, version_id: first.version.id,
    })).response.status, 409);
    const driftConversion = JSON.parse((await postJson(`${origin}/v1/me/context/standard-gaps/${encodeURIComponent(driftGap.id)}/proposal`, driftConversionBody)).text);
    assert.equal(driftConversion.proposal.standard_bindings[0].version_id, revision.version.id);

    const handoffRun = JSON.parse((await postJson(`${origin}/v1/me/context/runs`, {
      ...runBody, client_request_id: "agent-run-handoff", input: { release_id: "release-2" },
    })).text);
    await postJson(`${origin}/v1/me/context/runs/${encodeURIComponent(handoffRun.id)}/start`, {});
    const handoffBody = { reason: "evidence_conflict", payload: { summary: "Two claims disagree." } };
    assert.equal((await postJson(`${origin}/v1/me/context/runs/${encodeURIComponent(handoffRun.id)}/handoff`, {
      ...handoffBody, reason: "retry_with_binding",
    })).response.status, 400);
    const handedOff = JSON.parse((await postJson(`${origin}/v1/me/context/runs/${encodeURIComponent(handoffRun.id)}/handoff`, handoffBody)).text);
    assert.equal(handedOff.run.status, "handed_off");
    assert.equal(handedOff.handoff.agent_run_id, handoffRun.id);
    assert.equal(handedOff.handoff.context_snapshot_id, snapshotId);
    assert.equal(JSON.parse((await postJson(`${origin}/v1/me/context/runs/${encodeURIComponent(handoffRun.id)}/handoff`, handoffBody)).text).handoff.id, handedOff.handoff.id);
    assert.equal((await postJson(`${origin}/v1/me/context/runs/${encodeURIComponent(handoffRun.id)}/handoff`, {
      ...handoffBody, payload: { summary: "Changed after handoff." },
    })).response.status, 409);
    assert.equal((await (await fetch(`${origin}/v1/me/context/handoffs/${encodeURIComponent(handedOff.handoff.id)}`)).json()).agent_run_id, handoffRun.id);

    const cancelledRun = JSON.parse((await postJson(`${origin}/v1/me/context/runs`, {
      ...runBody, client_request_id: "agent-run-cancel", input: { release_id: "release-3" },
    })).text);
    assert.equal(JSON.parse((await postJson(`${origin}/v1/me/context/runs/${encodeURIComponent(cancelledRun.id)}/cancel`, {})).text).status, "cancelled");
    assert.equal(JSON.parse((await postJson(`${origin}/v1/me/context/runs/${encodeURIComponent(cancelledRun.id)}/cancel`, {})).text).status, "cancelled");
  });

  it("converts one StandardGap into one governed Proposal", async () => {
    const root = await createRoot();
    const { origin, eventId } = await startApi(root);
    const assembled = await postJson(`${origin}/v1/me/context/assemble`, assembleBody());
    const snapshotId = JSON.parse(assembled.text).snapshot.id;
    const gapBody = {
      client_request_id: "manual-gap-1",
      summary: "Release safety is not covered.",
      proposed_uncertainty: "Can a release gate prevent regressions?",
    };
    const created = await postJson(`${origin}/v1/me/context/standard-gaps`, gapBody);
    assert.equal(created.response.status, 201);
    const gap = JSON.parse(created.text);
    assert.equal(gap.status, "open");
    assert.equal(JSON.parse((await postJson(`${origin}/v1/me/context/standard-gaps`, gapBody)).text).id, gap.id);
    const changed = await postJson(`${origin}/v1/me/context/standard-gaps`, {
      ...gapBody, summary: "Changed after intake.",
    });
    assert.equal(changed.response.status, 409);
    assert.equal((await (await fetch(`${origin}/v1/me/context/standard-gaps?status=open`)).json())[0].id, gap.id);
    assert.equal((await (await fetch(`${origin}/v1/me/context/standard-gaps/${encodeURIComponent(gap.id)}`)).json()).source_kind, "manual");
    const conversionBody = {
      kind: "new_standard",
      title: "Create release safety standard",
      summary: "Create a bounded release safety standard.",
      rights_level: "coach",
      boundary: "Release governance only",
      context_snapshot_id: snapshotId,
      evidence: [{ kind: "document", uri_or_ref: `event:${eventId}` }],
    };
    const convertedResponse = await postJson(`${origin}/v1/me/context/standard-gaps/${encodeURIComponent(gap.id)}/proposal`, conversionBody);
    assert.equal(convertedResponse.response.status, 201);
    const converted = JSON.parse(convertedResponse.text);
    assert.equal(converted.gap.status, "converted");
    assert.equal(converted.proposal.gap_id, gap.id);
    assert.equal(converted.proposal.single_uncertainty, gap.proposed_uncertainty);
    assert.equal(converted.proposal.evidence[0].uri_or_ref, `standard-gap:${gap.id}`);
    await postJson(`${origin}/v1/me/context/proposals/${encodeURIComponent(converted.proposal.id)}/submit`, {});
    assert.equal(JSON.parse((await postJson(`${origin}/v1/me/context/standard-gaps/${encodeURIComponent(gap.id)}/proposal`, conversionBody)).text).proposal.status, "submitted");
    assert.equal((await postJson(`${origin}/v1/me/context/standard-gaps/${encodeURIComponent(gap.id)}/dismiss`, {})).response.status, 409);
    assert.equal(JSON.parse((await postJson(`${origin}/v1/me/context/standard-gaps`, gapBody)).text).status, "converted");

    const dismissedGap = JSON.parse((await postJson(`${origin}/v1/me/context/standard-gaps`, {
      ...gapBody, client_request_id: "manual-gap-2", summary: "A duplicate gap is not actionable.",
    })).text);
    assert.equal(JSON.parse((await postJson(`${origin}/v1/me/context/standard-gaps/${encodeURIComponent(dismissedGap.id)}/dismiss`, {})).text).status, "dismissed");
    assert.equal(JSON.parse((await postJson(`${origin}/v1/me/context/standard-gaps/${encodeURIComponent(dismissedGap.id)}/dismiss`, {})).text).status, "dismissed");
  });

  it("lists and resolves coverage alerts without exposing source event identity", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    const eventId = await ingestEvidence(database, blobRoot);
    const store = new SqliteAuthorityStore(database);
    await store.putDailyDigestCoverageAlert({
      id: "coverage-alert-api", org_id: "local-owner", local_date: "2026-08-30",
      generation: "daily-digest-d0-v3", event_id: eventId,
      reason_code: "omitted_high_signal", status: "open", created_at: "2026-08-30T01:00:00.000Z",
    });
    store.close();
    const { origin } = await startApi(root);
    const response = await fetch(`${origin}/v1/me/context/daily-digests/coverage-alerts`);
    assert.equal(response.status, 200);
    const [alert] = await response.json();
    assert.equal(alert.id, "coverage-alert-api");
    assert.equal("event_id" in alert, false);
    assert.equal("org_id" in alert, false);
    const resolved = await fetch(`${origin}/v1/me/context/daily-digests/coverage-alerts/coverage-alert-api/resolve`, { method: "POST" });
    assert.equal(resolved.status, 201);
    assert.equal((await resolved.json()).status, "resolved");
    assert.deepEqual(await (await fetch(`${origin}/v1/me/context/daily-digests/coverage-alerts`)).json(), []);
    const missing = await fetch(`${origin}/v1/me/context/daily-digests/coverage-alerts/missing/resolve`, { method: "POST" });
    assert.equal(missing.status, 404);
  });

  it("lists safe daily digest job status without matching the date route", async () => {
    const root = await createRoot();
    const { origin } = await startApi(root);
    const response = await fetch(`${origin}/v1/me/context/daily-digests/jobs`);
    assert.equal(response.status, 200);
    const jobs = await response.json();
    assert.ok(Array.isArray(jobs));
    for (const job of jobs) {
      assert.equal("lease_owner" in job, false);
      assert.equal("last_error" in job, false);
    }
  });

  it("reads and updates only the current organization's validated daily digest policy", async () => {
    const root = await createRoot();
    const { origin } = await startApi(root);
    const initial = await fetch(`${origin}/v1/me/context/daily-digests/policy`);
    assert.equal(initial.status, 200);
    assert.deepEqual((await initial.json()).enabled_directions, [
      "product", "sales", "customer", "org", "finance", "risk",
    ]);
    const policy = {
      version: 1,
      time_zone: "UTC",
      enabled_directions: ["product"],
      max_items_per_direction: 2,
      bad_news_terms: ["watchlist"],
      hypothesis_min_score: 2,
      role_tier_threshold: 4,
      evidence_weights: {
        metric: 4, demo: 3, user_verbatim: 2.5, decision_record: 2.5, opinion: 1,
      },
    };
    const updated = await postJson(`${origin}/v1/me/context/daily-digests/policy`, { policy });
    assert.equal(updated.response.status, 201);
    assert.deepEqual(JSON.parse(updated.text), policy);
    const fetched = await fetch(`${origin}/v1/me/context/daily-digests/policy`);
    assert.deepEqual(await fetched.json(), policy);
    const invalid = await postJson(`${origin}/v1/me/context/daily-digests/policy`, {
      policy: { ...policy, enabled_directions: ["untrusted"] },
    });
    assert.equal(invalid.response.status, 400);
  });

  it("projects a UTC daily digest and exposes it only after artifact acceptance", async () => {
    const root = await createRoot();
    const { origin, eventId } = await startApi(root);
    const proposed = await postJson(`${origin}/v1/me/context/daily-digests/project`, {
      utc_date: "2026-08-30",
    });
    assert.equal(proposed.response.status, 201, proposed.text);
    const proposal = JSON.parse(proposed.text);
    assert.ok(proposal.artifact_id);
    const beforeAcceptance = await postJson(
      `${origin}/v1/me/context/daily-digests/${encodeURIComponent(proposal.artifact_id)}/proposals`,
      { direction: "product", item_event_id: eventId },
    );
    assert.equal(beforeAcceptance.response.status, 409);
    const before = await fetch(`${origin}/v1/me/context/daily-digests/2026-08-30`);
    assert.deepEqual(await before.json(), []);
    const accepted = await postJson(
      `${origin}/v1/me/context/artifacts/${encodeURIComponent(proposal.artifact_id)}/decision`,
      { status: "accepted" },
    );
    assert.equal(accepted.response.status, 201);
    const after = await fetch(`${origin}/v1/me/context/daily-digests/2026-08-30`);
    assert.equal(after.status, 200);
    assert.equal((await after.json())[0].id, proposal.artifact_id);
    const intake = await postJson(
      `${origin}/v1/me/context/daily-digests/${encodeURIComponent(proposal.artifact_id)}/proposals`,
      { direction: "product", item_event_id: eventId, single_uncertainty: "Should the release proceed?" },
    );
    assert.equal(intake.response.status, 201);
    const draft = JSON.parse(intake.text);
    assert.equal(draft.kind, "hypothesis");
    assert.equal(draft.status, "draft");
    assert.equal(draft.source_digest_id, proposal.artifact_id);
    assert.ok(draft.evidence.some((value) => value.uri_or_ref === `event:${eventId}`));
    const replayedIntake = await postJson(
      `${origin}/v1/me/context/daily-digests/${encodeURIComponent(proposal.artifact_id)}/proposals`,
      { direction: "product", item_event_id: eventId },
    );
    assert.equal(JSON.parse(replayedIntake.text).id, draft.id);
    assert.equal((await (await fetch(`${origin}/v1/me/context/proposals`)).json()).length, 1);
    assert.equal((await (await fetch(`${origin}/v1/me/context/proposals/${encodeURIComponent(draft.id)}`)).json()).id, draft.id);
    const submitted = await postJson(`${origin}/v1/me/context/proposals/${encodeURIComponent(draft.id)}/submit`, {});
    assert.equal(JSON.parse(submitted.text).status, "submitted");
    const duplicateSubmit = await postJson(`${origin}/v1/me/context/proposals/${encodeURIComponent(draft.id)}/submit`, {});
    assert.equal(duplicateSubmit.response.status, 409);
    const withdrawn = await postJson(`${origin}/v1/me/context/proposals/${encodeURIComponent(draft.id)}/withdraw`, {});
    assert.equal(JSON.parse(withdrawn.text).status, "withdrawn");
    const assembled = await postJson(`${origin}/v1/me/context/assemble`, {
      ...assembleBody(),
      query: "release approved",
      requested_kinds: ["artifact"],
      budget: {
        profile: "daily-digest-test",
        max_tokens: 200,
        max_items: 5,
        max_raw_evidence: 5,
      },
    });
    assert.equal(assembled.response.status, 201);
    assert.equal(
      JSON.parse(assembled.text).bundle.sections.find((section) => section.kind === "summaries")?.items[0]?.resource_id,
      proposal.artifact_id,
    );
    const invalid = await postJson(`${origin}/v1/me/context/daily-digests/project`, {
      utc_date: "2026-08-30T00:00:00Z",
    });
    assert.equal(invalid.response.status, 400);
    const local = await postJson(`${origin}/v1/me/context/daily-digests/project`, {
      local_date: "2026-08-30",
    });
    assert.equal(local.response.status, 201);
    const ambiguous = await postJson(`${origin}/v1/me/context/daily-digests/project`, {
      utc_date: "2026-08-30", local_date: "2026-08-30",
    });
    assert.equal(ambiguous.response.status, 400);
    const impossible = await postJson(`${origin}/v1/me/context/daily-digests/project`, {
      utc_date: "2026-02-30",
    });
    assert.equal(impossible.response.status, 400);
  });

  it("accepts a proposed summary and retrieves it only after lifecycle approval", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    const eventId = await ingestEvidence(database, blobRoot);
    const authority = new SqliteAuthorityStore(database);
    const blobs = new FsBlobStore(blobRoot);
    const event = await authority.getEvent("local-owner", eventId);
    const evidence = {
      event_id: eventId, source: "synthetic-chat", external_id: "chat-1:message-1",
      operation: "create", occurred_at: "2026-08-30T00:00:00.000Z",
      content_hash: event.content_hash,
    };
    const body = { schema_version: "1.0", thread_id: "chat-1", messages: [{ text: "Release approved" }] };
    const bodyHash = hashCanonicalContext(body);
    await blobs.put(bodyHash, Buffer.from(canonicalContextJson(body)), "application/vnd.regenic.context-artifact+json");
    await authority.putArtifact({
      id: "summary-api-1", org_id: "local-owner", kind: "thread_summary", schema_version: "1.0",
      algorithm_version: "summary-v1", generation: "generation-1", input_refs: [evidence],
      input_hash: hashContextArtifactInputs({ input_refs: [evidence] }), body_hash: bodyHash,
      status: "proposed", required_scope_ids: event.required_scope_ids, recorded_at: "2026-08-30T01:00:00.000Z", attrs: body,
    });
    authority.close();
    const { origin } = await startApi(root);
    const before = await fetch(`${origin}/v1/me/context/artifacts`);
    assert.equal(before.status, 200);
    assert.equal((await before.json())[0].status, "proposed");
    const summariesResponse = await fetch(`${origin}/v1/me/context/artifact-summaries`);
    assert.equal(summariesResponse.status, 200);
    const summary = (await summariesResponse.json())[0];
    assert.equal(summary.id, "summary-api-1");
    assert.equal(summary.title, "Release approved");
    assert.equal(summary.message_count, 1);
    assert.equal(summary.thread_id, "chat-1");
    assert.equal(summary.messages, undefined);
    const recordResponse = await fetch(
      `${origin}/v1/me/context/artifacts/${encodeURIComponent("summary-api-1")}/record`,
    );
    assert.equal(recordResponse.status, 200);
    const record = await recordResponse.json();
    assert.deepEqual(record.messages, [{ text: "Release approved" }]);
    assert.equal(record.message_total, 1);
    assert.equal(record.message_limit, 40);
    assert.equal(record.input_refs, undefined);
    const accepted = await postJson(`${origin}/v1/me/context/artifacts/summary-api-1/decision`, { status: "accepted" });
    assert.equal(accepted.response.status, 201, accepted.text);
    assert.equal(JSON.parse(accepted.text).status, "accepted");
    const assembled = await postJson(`${origin}/v1/me/context/assemble`, {
      ...assembleBody(), requested_kinds: ["artifact"], query: "release approved",
    });
    assert.equal(assembled.response.status, 201);
    assert.equal(JSON.parse(assembled.text).bundle.sections.find((section) => section.kind === "summaries")?.items.length, 1);
  });

  it("assembles, inspects, replays, and asks over real SQLite evidence", async () => {
    const root = await createRoot();
    const model = await startModelStub();
    const { origin } = await startApi(root, {
      driver: "openai_compatible",
      baseUrl: model.baseUrl,
    });

    const assembledResponse = await postJson(`${origin}/v1/me/context/assemble`, assembleBody());
    assert.equal(assembledResponse.response.status, 201);
    const assembled = JSON.parse(assembledResponse.text);
    const item = assembled.bundle.sections[0].items[0];
    assert.equal(item.text, "The release is approved for Monday.");

    const snapshotResponse = await fetch(
      `${origin}/v1/me/context/snapshots/${encodeURIComponent(assembled.snapshot.id)}`,
    );
    assert.equal(snapshotResponse.status, 200);
    assert.equal((await snapshotResponse.json()).id, assembled.snapshot.id);

    const replayResponse = await postJson(`${origin}/v1/me/context/replay`, {
      snapshot_id: assembled.snapshot.id,
      consumer_id: "context-api-test",
      purpose: "answer a synthetic release question",
      allowed_uses: ["display"],
    });
    assert.equal(replayResponse.response.status, 201);
    assert.equal(JSON.parse(replayResponse.text).content_hash, assembled.bundle.content_hash);

    const askResponse = await postJson(`${origin}/v1/me/context/ask`, {
      question: "What release is approved?",
      consumer_id: "context-api-ask",
    });
    assert.equal(askResponse.response.status, 201);
    const answer = JSON.parse(askResponse.text);
    assert.equal(answer.answer, "The release is approved for Monday.");
    assert.equal(answer.model, "fake-model-response");
    assert.equal(answer.citations[0].event_ids[0], item.evidence[0].event_id);
    assert.equal(model.requests.length, 1);
    assert.equal(model.requests[0].url, "/v1/chat/completions");
    assert.equal(model.requests[0].authorization, "Bearer context-api-test-secret");
    assert.ok(model.requests[0].body.messages[0].content.includes("untrusted evidence data"));
    assert.equal(model.requests[0].body.messages[0].content.includes(item.text), false);
    assert.ok(model.requests[0].body.messages[1].content.includes(item.text));
    assert.equal(assembledResponse.text.includes("context-api-test-secret"), false);
    assert.equal(askResponse.text.includes("context-api-test-secret"), false);

    const forbidden = await postJson(`${origin}/v1/me/context/assemble`, {
      ...assembleBody(),
      principal: { actor_type: "human", actor_id: "other" },
    });
    assert.equal(forbidden.response.status, 400);
    assert.equal(JSON.parse(forbidden.text).error.code, "invalid_request");

    const invalidBudget = await postJson(`${origin}/v1/me/context/ask`, {
      question: "What release is approved?",
      budget: { profile: "invalid", max_tokens: 0, max_items: 1, max_raw_evidence: 1 },
    });
    assert.equal(invalidBudget.response.status, 400);
    assert.equal(JSON.parse(invalidBudget.text).error.code, "invalid_request");
  });

  it("keeps a desktop thread preview scoped to its thread and replays its snapshot", async () => {
    const root = await createRoot();
    const { origin, eventId } = await startApi(root);
    const otherEventId = await ingestEvidence(
      join(root, "authority.db"),
      join(root, "blobs"),
      "other-thread",
      "chat-2",
    );
    const request = {
      consumer_id: "desktop-context-pilot",
      purpose: "display context for the open personal conversation",
      allowed_uses: ["display"],
      filters: { thread_ids: ["synthetic-chat:chat-1"] },
      temporal: { mode: "current" },
      budget: {
        profile: "desktop-thread-preview-v1",
        max_tokens: 2_000,
        max_items: 20,
        max_raw_evidence: 20,
      },
      requested_kinds: ["event"],
    };
    const assembledResponse = await postJson(`${origin}/v1/me/context/assemble`, request);
    assert.equal(assembledResponse.response.status, 201, assembledResponse.text);
    const assembled = JSON.parse(assembledResponse.text);
    const selectedEventIds = assembled.bundle.sections.flatMap((section) =>
      section.items.flatMap((item) => item.evidence.map((evidence) => evidence.event_id)),
    );
    assert.deepEqual(selectedEventIds, [eventId]);
    assert.equal(selectedEventIds.includes(otherEventId), false);

    const replayResponse = await postJson(`${origin}/v1/me/context/replay`, {
      snapshot_id: assembled.snapshot.id,
      consumer_id: request.consumer_id,
      purpose: request.purpose,
      allowed_uses: request.allowed_uses,
    });
    assert.equal(replayResponse.response.status, 201, replayResponse.text);
    const replayed = JSON.parse(replayResponse.text);
    assert.equal(replayed.snapshot_id, assembled.snapshot.id);
    assert.equal(replayed.content_hash, assembled.bundle.content_hash);
  });

  it("diffs two snapshots only through their shared replay grant", async () => {
    const root = await createRoot();
    const { origin, database } = await startApi(root);
    const grant = {
      consumer_id: "desktop-context-pilot",
      purpose: "display context for the open personal conversation",
      allowed_uses: ["display"],
    };
    const request = {
      ...grant,
      filters: { thread_ids: ["synthetic-chat:chat-1"] },
      temporal: { mode: "current" },
      budget: {
        profile: "desktop-thread-preview-v1",
        max_tokens: 2_000,
        max_items: 20,
        max_raw_evidence: 20,
      },
      requested_kinds: ["event"],
    };
    const firstResponse = await postJson(`${origin}/v1/me/context/assemble`, request);
    assert.equal(firstResponse.response.status, 201, firstResponse.text);
    const first = JSON.parse(firstResponse.text);

    const addedEventId = await ingestEvidence(
      database,
      join(root, "blobs"),
      "later",
      "chat-1",
    );
    const secondResponse = await postJson(`${origin}/v1/me/context/assemble`, request);
    assert.equal(secondResponse.response.status, 201, secondResponse.text);
    const second = JSON.parse(secondResponse.text);

    const diffResponse = await postJson(`${origin}/v1/me/context/diff`, {
      from_snapshot_id: first.snapshot.id,
      to_snapshot_id: second.snapshot.id,
      ...grant,
    });
    assert.equal(diffResponse.response.status, 201, diffResponse.text);
    const diff = JSON.parse(diffResponse.text);
    assert.equal(diff.from_snapshot_id, first.snapshot.id);
    assert.equal(diff.to_snapshot_id, second.snapshot.id);
    assert.deepEqual(diff.added.map((item) => item.resource_id), [addedEventId]);
    assert.equal(diff.removed.length, 0);
    assert.equal(diff.unchanged.length, 1);
    assert.equal(diffResponse.text.includes("Additional release evidence"), false);

    const forbidden = await postJson(`${origin}/v1/me/context/diff`, {
      from_snapshot_id: first.snapshot.id,
      to_snapshot_id: second.snapshot.id,
      ...grant,
      consumer_id: "another-consumer",
    });
    assert.equal(forbidden.response.status, 404, forbidden.text);
    assert.equal(JSON.parse(forbidden.text).error.code, "not_found");

    const invalid = await postJson(`${origin}/v1/me/context/diff`, {
      from_snapshot_id: first.snapshot.id,
      to_snapshot_id: second.snapshot.id,
      ...grant,
      principal: { actor_type: "human", actor_id: "other" },
    });
    assert.equal(invalid.response.status, 400, invalid.text);
    assert.equal(JSON.parse(invalid.text).error.code, "invalid_request");
  });

  it("lists only the current principal's desktop snapshot history for one thread", async () => {
    const root = await createRoot();
    const { origin, database } = await startApi(root);
    await ingestEvidence(database, join(root, "blobs"), "other-thread", "chat-2");
    const request = {
      consumer_id: "desktop-context-pilot",
      purpose: "display context for the open personal conversation",
      allowed_uses: ["display"],
      temporal: { mode: "current" },
      budget: {
        profile: "desktop-thread-preview-v1",
        max_tokens: 2_000,
        max_items: 20,
        max_raw_evidence: 20,
      },
      requested_kinds: ["event"],
    };
    const first = await postJson(`${origin}/v1/me/context/assemble`, {
      ...request,
      filters: { thread_ids: ["synthetic-chat:chat-1"] },
    });
    const second = await postJson(`${origin}/v1/me/context/assemble`, {
      ...request,
      filters: { thread_ids: ["synthetic-chat:chat-2"] },
    });
    assert.equal(first.response.status, 201, first.text);
    assert.equal(second.response.status, 201, second.text);

    const authority = new SqliteAuthorityStore(database);
    const visibleEntry = {
      org_id: "local-owner",
      thread_id: "synthetic-chat:chat-1",
      snapshot_id: JSON.parse(first.text).snapshot.id,
      principal: { actor_type: "human", actor_id: "local-owner" },
      consumer_id: "desktop-context-pilot",
      purpose: request.purpose,
      allowed_uses: request.allowed_uses,
      created_at: JSON.parse(first.text).snapshot.created_at,
    };
    await authority.putSnapshotIndex({
      ...visibleEntry,
      snapshot_id: "snapshot-other-principal",
      principal: { actor_type: "human", actor_id: "other-person" },
    });
    await authority.putSnapshotIndex({
      ...visibleEntry,
      snapshot_id: "snapshot-other-consumer",
      consumer_id: "other-consumer",
    });
    await authority.putSnapshotIndex({
      ...visibleEntry,
      snapshot_id: "snapshot-other-purpose",
      purpose: "another desktop operation",
    });
    const olderEntry = {
      ...visibleEntry,
      snapshot_id: "snapshot-older",
      created_at: new Date(Date.parse(visibleEntry.created_at) - 1_000).toISOString(),
    };
    await authority.putSnapshotIndex(olderEntry);
    authority.close();

    const listed = await getJson(
      `${origin}/v1/me/context/snapshots?thread_id=${encodeURIComponent("synthetic-chat:chat-1")}&limit=10`,
    );
    assert.equal(listed.response.status, 200, listed.text);
    assert.deepEqual(JSON.parse(listed.text), [visibleEntry, olderEntry]);
    const firstPage = await getJson(
      `${origin}/v1/me/context/snapshots?thread_id=${encodeURIComponent("synthetic-chat:chat-1")}&limit=1`,
    );
    assert.equal(firstPage.response.status, 200, firstPage.text);
    assert.deepEqual(JSON.parse(firstPage.text), [visibleEntry]);
    const secondPage = await getJson(
      `${origin}/v1/me/context/snapshots?thread_id=${encodeURIComponent("synthetic-chat:chat-1")}`
      + `&limit=1&before_created_at=${encodeURIComponent(visibleEntry.created_at)}`
      + `&before_snapshot_id=${encodeURIComponent(visibleEntry.snapshot_id)}`,
    );
    assert.equal(secondPage.response.status, 200, secondPage.text);
    assert.deepEqual(JSON.parse(secondPage.text), [olderEntry]);
    const otherThread = await getJson(
      `${origin}/v1/me/context/snapshots?thread_id=${encodeURIComponent("synthetic-chat:chat-2")}`,
    );
    assert.equal(otherThread.response.status, 200, otherThread.text);
    assert.equal(JSON.parse(otherThread.text).length, 1);
    assert.equal(JSON.parse(otherThread.text)[0].snapshot_id, JSON.parse(second.text).snapshot.id);
    const invalid = await getJson(
      `${origin}/v1/me/context/snapshots?thread_id=${encodeURIComponent("synthetic-chat:chat-1")}&limit=101`,
    );
    assert.equal(invalid.response.status, 400);
    const incompleteCursor = await getJson(
      `${origin}/v1/me/context/snapshots?thread_id=${encodeURIComponent("synthetic-chat:chat-1")}`
      + `&before_created_at=${encodeURIComponent(visibleEntry.created_at)}`,
    );
    assert.equal(incompleteCursor.response.status, 400);
  });

  it("rejects model citations outside the assembled bundle", async () => {
    const root = await createRoot();
    const model = await startModelStub("invalid-citation");
    const { origin } = await startApi(root, {
      driver: "openai_compatible",
      baseUrl: model.baseUrl,
    });

    const result = await postJson(`${origin}/v1/me/context/ask`, {
      question: "What release is approved?",
    });
    assert.equal(result.response.status, 502);
    assert.equal(JSON.parse(result.text).error.code, "invalid_model_output");
    assert.equal(result.text.includes("context-api-test-secret"), false);
  });

  it("reports the default none provider without making a model request", async () => {
    const root = await createRoot();
    const { origin } = await startApi(root);
    const result = await postJson(`${origin}/v1/me/context/ask`, {
      question: "What release is approved?",
    });
    assert.equal(result.response.status, 503);
    assert.equal(JSON.parse(result.text).error.code, "model_unavailable");
  });

  it("degrades invalid model environment without blocking context assembly", async () => {
    const root = await createRoot();
    const { origin } = await startApi(root, { driver: "invalid-driver" });
    const assembled = await postJson(
      `${origin}/v1/me/context/assemble`,
      assembleBody(),
    );
    assert.equal(assembled.response.status, 201);

    const answer = await postJson(`${origin}/v1/me/context/ask`, {
      question: "What release is approved?",
    });
    assert.equal(answer.response.status, 503);
    assert.equal(JSON.parse(answer.text).error.code, "model_unavailable");
  });
});

function setEnv(values) {
  for (const [key, value] of Object.entries(values)) {
    if (!previousEnv.has(key)) {
      previousEnv.set(key, process.env[key]);
    }
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function restoreEnv() {
  for (const [key, value] of previousEnv) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  previousEnv.clear();
}

function listenServer(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });
}
