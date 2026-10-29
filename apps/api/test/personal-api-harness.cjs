const { createServer } = require("node:http");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { afterEach } = require("node:test");
const {
  createHttpApp,
  enablePersonalCors,
  listenHttpApp,
} = require("../dist/http-app");
const { SqliteAuthorityStore } = require("@regenic/authority-store/sqlite");
const { FsBlobStore } = require("@regenic/blob-store");
const { INGEST_SCHEMA_VERSION, IngestionService, setKeychainStoreForTests } = require("@regenic/domain");

const roots = [];
const previousEnv = {};
const PERSONAL_API_KEY = "test-personal-api-key";

afterEach(async () => {
  restoreEnv();
  setKeychainStoreForTests();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

async function waitForSyncRun(origin, runId, timeoutMs = 8_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const response = await fetch(`${origin}/v1/me/sync-runs/${runId}`);
    const body = await response.json();
    if (
      response.ok &&
      (body.status === "succeeded" ||
        body.status === "failed" ||
        body.status === "cancelled")
    ) {
      return body;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`sync run ${runId} did not finish`);
}

async function createRoot() {
  const root = await mkdtemp(join(tmpdir(), "regenic-personal-api-"));
  roots.push(root);
  return root;
}

function setEnv(overrides) {
  for (const key of Object.keys(overrides)) {
    previousEnv[key] = process.env[key];
    if (overrides[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = overrides[key];
    }
  }
}

function restoreEnv() {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
    delete previousEnv[key];
  }
}

async function ingestActionable(database, blobRoot) {
  const authority = new SqliteAuthorityStore(database);
  const blobs = new FsBlobStore(blobRoot);
  const service = new IngestionService(blobs, authority);
  const result = await service.ingest({
    schema_version: INGEST_SCHEMA_VERSION,
    connector_id: "native-local",
    org_id: "local-owner",
    delivery_id: "delivery-1",
    received_at: "2026-08-21T00:00:00.000Z",
    records: [
      {
        operation: "create",
        source: "regenic",
        external_id: "ask-1",
        occurred_at: "2026-08-21T00:00:00.000Z",
        actor: { id: "local-owner" },
        scope: { id: "personal" },
        type: "text",
        content: [
          {
            role: "body",
            media_type: "text/plain",
            text: "Please confirm the release.",
          },
        ],
      },
      {
        operation: "create",
        source: "regenic",
        external_id: "ack-1",
        occurred_at: "2026-08-21T00:01:00.000Z",
        actor: { id: "local-owner" },
        scope: { id: "personal" },
        type: "text",
        content: [{ role: "body", media_type: "text/plain", text: "ok" }],
      },
    ],
  });
  await authority.createInstallation({
    id: "slack-1",
    org_id: "local-owner",
    connector_type: "slack-channel",
    status: "enabled",
    config: { channel_id: "C123" },
    created_at: "2026-08-21T00:00:00.000Z",
  });
  authority.close();
  return result.records[0].event_id;
}

async function startDshWebStub() {
  const prompts = [];
  const responds = [];
  const echoes = new Map();
  const extras = new Map();
  const created = [];
  let createdCount = 0;
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      const url = String(request.url ?? "");
      const sessionId = body.payload?.sessionId;
      response.setHeader("content-type", "application/json");
      if (url.includes("/api/respond") || /\/respond(?:\?|$)/.test(url)) {
        responds.push(body);
        response.end(JSON.stringify({ accepted: true }));
        return;
      }
      if (url.includes("session.prompt")) {
        prompts.push(body);
        const text = (body.payload?.content ?? [])
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("");
        echoes.set(sessionId, {
          text,
          time: Date.now(),
        });
        response.end(
          JSON.stringify({
            type: "server-response",
            rpcId: body.rpcId,
            result: { ok: true, value: { accepted: true } },
          }),
        );
        return;
      }
      if (url.includes("session.create")) {
        createdCount += 1;
        const sessionId = `created-${createdCount}`;
        created.push(sessionId);
        response.end(
          JSON.stringify({
            type: "server-response",
            rpcId: body.rpcId,
            result: { ok: true, value: { sessionId } },
          }),
        );
        return;
      }
      if (url.includes("session.list")) {
        response.end(
          JSON.stringify({
            type: "server-response",
            rpcId: body.rpcId,
            result: {
              ok: true,
              value: {
                items: [
                  { sessionId: "sess-a" },
                  { sessionId: "sess-b" },
                  ...created.map((sessionId) => ({ sessionId })),
                ],
                hasMore: false,
              },
            },
          }),
        );
        return;
      }
      const echo = echoes.get(sessionId);
      const events = [
        {
          type: "user/message",
          seq: 1,
          time: Date.parse("2026-08-21T00:00:00.000Z"),
          data: {
            content: [
              {
                type: "text",
                text:
                  sessionId === "sess-a"
                    ? "Need a decision from session A."
                    : "Need a decision from session B.",
              },
            ],
            source: { kind: "user" },
          },
        },
      ];
      if (echo) {
        events.push(
          {
            type: "user/message",
            seq: 2,
            time: echo.time,
            data: {
              content: [{ type: "text", text: echo.text }],
              source: { kind: "user" },
            },
          },
          {
            type: "assistant/message",
            seq: 3,
            time: echo.time + 1,
            data: {
              message: { content: [{ type: "text", text: "pong" }] },
            },
          },
        );
      }
      events.push(...(extras.get(sessionId) ?? []));
      response.end(
        JSON.stringify({
          type: "server-response",
          rpcId: body.rpcId,
          result: {
            ok: true,
            value: {
              hasMore: false,
              events,
            },
          },
        }),
      );
    });
  });
  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    origin: `http://127.0.0.1:${address.port}`,
    prompts,
    responds,
    created,
    push(sessionId, event) {
      const current = extras.get(sessionId) ?? [];
      current.push(event);
      extras.set(sessionId, current);
    },
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

async function waitUntil(label, probe, timeoutMs = 4000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await probe()) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 150);
    });
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function seedHostedWork(authority, input) {
  const now = "2026-08-25T00:00:00.000Z";
  await authority.putRecipe({
    id: input.recipeId,
    org_id: "local-owner",
    name: "Seed recipe",
    match: { record_class: "task", source: "feishu" },
    trigger: { kind: "push", coalesce: true },
    executor_type: "dsh",
    executor_config: {},
    can_write_back: true,
    include_context: false,
    enabled: true,
    created_at: now,
    updated_at: now,
  });
  await authority.putWorkItem({
    id: input.workId,
    org_id: "local-owner",
    thread_id: input.threadId,
    unit_key: input.eventId,
    head_event_id: input.eventId,
    record_class: "task",
    thread_facet: "ticket",
    status: input.status,
    recipe_id: input.recipeId,
    created_at: now,
    updated_at: now,
  });
  await authority.putWorkRun({
    id: input.runId,
    org_id: "local-owner",
    work_item_id: input.workId,
    recipe_id: input.recipeId,
    executor_type: "dsh",
    external_run_id: "dsh:seed-sysout",
    agent_thread_id: "dsh:seed-sysout",
    status: "running",
    created_at: now,
    updated_at: now,
  });
}

async function startPersonalApi(database, blobRoot, extraEnv = {}) {
  const secrets = new Map();
  setKeychainStoreForTests({
    write(service, account, secret) {
      secrets.set(`${service}:${account}`, secret);
    },
    async read(service, account) {
      return secrets.get(`${service}:${account}`);
    },
  });
  setEnv({
    REGENIC_AUTHORITY_DRIVER: "sqlite",
    REGENIC_DATABASE: database,
    REGENIC_BLOB_ROOT: blobRoot,
    REGENIC_ORG: "local-owner",
    PORT: "4370",
    LISTEN_HOST: "127.0.0.1",
    REGENIC_CONNECTOR_PULL_MS: "0",
    REGENIC_PERSONAL_API: undefined,
    REGENIC_PERSONAL_API_KEY: PERSONAL_API_KEY,
    REGENIC_PERSONAL_LIVE_KEY: undefined,
    HOME: join(database, ".."),
    USERPROFILE: join(database, ".."),
    ...extraEnv,
  });
  const app = await createHttpApp({ logger: false });
  enablePersonalCors(app);
  await listenHttpApp(app, 0, "127.0.0.1");
  return { app, origin: await app.getUrl() };
}

module.exports = {
  PERSONAL_API_KEY,
  waitForSyncRun,
  createRoot,
  setEnv,
  restoreEnv,
  ingestActionable,
  startDshWebStub,
  waitUntil,
  seedHostedWork,
  startPersonalApi,
};
