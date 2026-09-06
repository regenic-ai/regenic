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

async function ingestEvidence(database, blobRoot) {
  const authority = new SqliteAuthorityStore(database);
  const service = new IngestionService(new FsBlobStore(blobRoot), authority);
  const result = await service.ingest({
    schema_version: INGEST_SCHEMA_VERSION,
    connector_id: "synthetic-chat",
    org_id: "local-owner",
    delivery_id: "delivery-context-api",
    received_at: "2026-08-30T01:00:00.000Z",
    records: [{
      operation: "create",
      source: "synthetic-chat",
      external_id: "chat-1:message-1",
      occurred_at: "2026-08-30T00:00:00.000Z",
      actor: { id: "person-1" },
      scope: { id: "chat-1" },
      type: "message",
      content: [{
        role: "body",
        media_type: "text/plain",
        text: "The release is approved for Monday.",
      }],
    }],
  });
  authority.close();
  return result.records[0].event_id;
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

async function startApi(root, model = { driver: "none" }) {
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
  };
  setEnv(env);
  await ingestEvidence(database, blobRoot);
  const app = await createHttpApp({ logger: false });
  await app.listen(0, "127.0.0.1");
  apps.push(app);
  return { origin: await app.getUrl() };
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

describe("personal context API", () => {
  it("projects a UTC daily digest and exposes it only after artifact acceptance", async () => {
    const root = await createRoot();
    const { origin } = await startApi(root);
    const proposed = await postJson(`${origin}/v1/me/context/daily-digests/project`, {
      utc_date: "2026-08-30",
    });
    assert.equal(proposed.response.status, 201);
    const proposal = JSON.parse(proposed.text);
    assert.ok(proposal.artifact_id);
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
