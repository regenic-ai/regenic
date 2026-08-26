const assert = require("node:assert/strict");
const { createServer } = require("node:http");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { afterEach, describe, it } = require("node:test");
const { createHttpApp, listenHttpApp } = require("../dist/http-app");
const { SqliteAuthorityStore } = require("@regenic/authority-store");
const { FsBlobStore } = require("@regenic/blob-store");
const { INGEST_SCHEMA_VERSION, IngestionService, channelRecord } = require("@regenic/domain");
const { isAllowedPersonalCorsOrigin } = require("@regenic/config");
const { decodeBodyText, decodeInboxBody } = require("../dist/inbox-body");
const {
  dshPromptStoreFor,
  dropDshPromptStore,
  questionPromptId,
} = require("@regenic/dsh-connector");
const { createPurrWhatsAppImport } = require("@regenic/whatsapp-personal");

const roots = [];
const previousEnv = {};

afterEach(async () => {
  restoreEnv();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

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

async function startSlackHistoryStub() {
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        ok: true,
        messages: [
          {
            ts: "1710000000.000100",
            user: "U1",
            text: "Need a decision from the desk.",
          },
        ],
      }),
    );
  });
  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    endpoint: `http://127.0.0.1:${address.port}/conversations.history`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
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
    executor_type: "dsh",
    executor_config: {},
    can_write_back: true,
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
  setEnv({
    REGENIC_DATABASE: database,
    REGENIC_BLOB_ROOT: blobRoot,
    REGENIC_ORG: "local-owner",
    PORT: "4370",
    LISTEN_HOST: "127.0.0.1",
    REGENIC_CONNECTOR_PULL_MS: "0",
    REGENIC_PERSONAL_API: undefined,
    ...extraEnv,
  });
  const app = await createHttpApp({ logger: false });
  await listenHttpApp(app, 0, "127.0.0.1");
  return { app, origin: await app.getUrl() };
}

describe("personal /v1/me", () => {
  it("lists current-work inbox items with Blob body text", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    const eventId = await ingestActionable(database, blobRoot);
    const { app, origin } = await startPersonalApi(database, blobRoot);
    try {
      const inbox = await (await fetch(`${origin}/v1/me/inbox`)).json();
      const item = await (await fetch(`${origin}/v1/me/inbox/${eventId}`)).json();

      assert.equal(inbox.length, 1);
      assert.equal(inbox[0].event.external_id, "ask-1");
      assert.equal(inbox[0].decision.disposition, "current_work");
      assert.equal(inbox[0].body_text, "Please confirm the release.");
      assert.equal(inbox[0].can_send, false);
      assert.equal(item.event.id, eventId);
      assert.equal(item.body_text, "Please confirm the release.");
    } finally {
      await app.close();
    }
  });

  it("clears local store data and keeps connectors and recipes", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    await ingestActionable(database, blobRoot);
    const { app, origin } = await startPersonalApi(database, blobRoot);
    try {
      const created = await (
        await fetch(`${origin}/v1/me/recipes`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: "Keep me",
            match: { record_class: "task" },
            executor_type: "dsh",
            can_write_back: false,
            enabled: true,
          }),
        })
      ).json();
      assert.equal(created.name, "Keep me");

      const before = await (await fetch(`${origin}/v1/me/store`)).json();
      assert.ok(before.events >= 1);
      assert.ok(before.connectors >= 1);
      assert.equal(before.recipes, 1);

      const cleared = await (
        await fetch(`${origin}/v1/me/store/clear`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        })
      ).json();
      assert.ok(cleared.cleared.events >= 1);
      assert.equal(cleared.kept.recipes, 1);
      assert.ok(cleared.kept.connectors >= 1);

      const inbox = await (await fetch(`${origin}/v1/me/inbox`)).json();
      const after = await (await fetch(`${origin}/v1/me/store`)).json();
      const engine = await (await fetch(`${origin}/v1/me/engine?detail=0`)).json();
      const recipes = await (await fetch(`${origin}/v1/me/recipes`)).json();
      assert.equal(inbox.length, 0);
      assert.equal(after.events, 0);
      assert.equal(after.conversations, 0);
      assert.equal(after.work_items, 0);
      assert.equal(after.recipes, 1);
      assert.ok(after.connectors >= 1);
      assert.equal(engine.inbox_count, 0);
      assert.equal(engine.installations[0].id, "slack-1");
      assert.equal(recipes[0].name, "Keep me");
    } finally {
      await app.close();
    }
  });

  it("returns inbox deltas, heads, and a light engine view", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    const authority = new SqliteAuthorityStore(database);
    const service = new IngestionService(
      new FsBlobStore(blobRoot),
      authority,
    );
    await service.ingest({
      schema_version: INGEST_SCHEMA_VERSION,
      connector_id: "dsh-session",
      org_id: "local-owner",
      delivery_id: "dsh-delta-1",
      received_at: "2026-08-21T00:00:00.000Z",
      records: [
        channelRecord({
          channel: "dsh",
          kind: "user",
          direction: "outbound",
          external_id: "session-x:1",
          occurred_at: "2026-08-21T00:00:00.000Z",
          actor_id: "user",
          scope_id: "session-x",
          text: "first prompt for the desk",
        }),
      ],
    });
    await service.ingest({
      schema_version: INGEST_SCHEMA_VERSION,
      connector_id: "dsh-session",
      org_id: "local-owner",
      delivery_id: "dsh-delta-2",
      received_at: "2026-08-21T00:01:00.000Z",
      records: [
        channelRecord({
          channel: "dsh",
          kind: "assistant",
          direction: "inbound",
          external_id: "session-x:2",
          occurred_at: "2026-08-21T00:01:00.000Z",
          actor_id: "assistant",
          scope_id: "session-x",
          text: "second",
        }),
        channelRecord({
          channel: "dsh",
          kind: "user",
          direction: "outbound",
          external_id: "session-y:1",
          occurred_at: "2026-08-21T00:02:00.000Z",
          actor_id: "user",
          scope_id: "session-y",
          text: "other thread stays current",
        }),
      ],
    });
    authority.close();
    const { app, origin } = await startPersonalApi(database, blobRoot);
    try {
      const all = await (await fetch(`${origin}/v1/me/inbox`)).json();
      assert.ok(all.length >= 2);
      const first = [...all].sort((left, right) => {
        if (left.event.ingested_at === right.event.ingested_at) {
          return left.event.id < right.event.id ? -1 : 1;
        }
        return left.event.ingested_at < right.event.ingested_at ? -1 : 1;
      })[0];
      const delta = await (
        await fetch(
          `${origin}/v1/me/inbox?since=${encodeURIComponent(first.event.ingested_at)}&since_id=${encodeURIComponent(first.event.id)}`,
        )
      ).json();
      assert.ok(delta.every((item) => item.event.id !== first.event.id));
      assert.ok(delta.length < all.length);

      const heads = await (await fetch(`${origin}/v1/me/inbox?heads=1`)).json();
      const threads = new Set(heads.map((item) => item.thread_id));
      assert.equal(heads.length, threads.size);
      assert.ok(heads.length >= 2);
      assert.ok(
        heads.every((item) =>
          (item.attachments ?? []).every((file) => !file.data_base64),
        ),
      );

      const one = await (
        await fetch(`${origin}/v1/me/inbox?thread_id=${encodeURIComponent("dsh:session-x")}`)
      ).json();
      assert.ok(one.length >= 2);
      assert.ok(one.every((item) => item.thread_id === "dsh:session-x"));
      const head = await (
        await fetch(
          `${origin}/v1/me/inbox?heads=1&thread_id=${encodeURIComponent("dsh:session-x")}`,
        )
      ).json();
      assert.equal(head.length, 1);
      assert.equal(head[0].thread_id, "dsh:session-x");
      assert.equal(head[0].event.external_id, "session-x:2");
      assert.equal(head[0].body_text, "second");
      const recent = await (
        await fetch(
          `${origin}/v1/me/inbox?thread_id=${encodeURIComponent("dsh:session-x")}&limit=1`,
        )
      ).json();
      assert.equal(recent.length, 1);
      assert.equal(recent[0].body_text, "second");
      const older = await (
        await fetch(
          `${origin}/v1/me/inbox?thread_id=${encodeURIComponent("dsh:session-x")}&before=${encodeURIComponent(recent[0].event.occurred_at)}&before_id=${encodeURIComponent(recent[0].event.id)}&limit=1`,
        )
      ).json();
      assert.equal(older.length, 1);
      assert.equal(older[0].body_text, "first prompt for the desk");
      for (let index = 1; index < one.length; index += 1) {
        assert.ok(
          one[index - 1].event.occurred_at <= one[index].event.occurred_at,
          "thread messages should be oldest first",
        );
      }

      const light = await (await fetch(`${origin}/v1/me/engine?detail=0`)).json();
      assert.deepEqual(
        light.catalog.map((item) => item.connector_type),
        ["slack-channel", "dsh-session", "feishu-chat"],
      );
      assert.ok(light.installations.every((item) => item.last_attempt == null));
      assert.match(light.inbox_digest, /^\d+:/);

      const full = await (await fetch(`${origin}/v1/me/engine`)).json();
      assert.ok(full.catalog.length >= 1);
    } finally {
      await app.close();
    }
  });

  it("keeps a short DSH agent reply in the same conversation as the prompt", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    const authority = new SqliteAuthorityStore(database);
    const service = new IngestionService(new FsBlobStore(blobRoot), authority);
    await service.ingest({
      schema_version: INGEST_SCHEMA_VERSION,
      connector_id: "dsh-session",
      org_id: "local-owner",
      delivery_id: "dsh-1",
      received_at: "2026-08-21T00:00:00.000Z",
      records: [
        channelRecord({
          channel: "dsh",
          kind: "user",
          direction: "outbound",
          external_id: "session-x:7",
          occurred_at: "2026-08-21T00:00:00.000Z",
          actor_id: "user",
          scope_id: "session-x",
          text: "只用一句话回复：pong",
        }),
        channelRecord({
          channel: "dsh",
          kind: "assistant",
          direction: "inbound",
          external_id: "session-x:49",
          occurred_at: "2026-08-21T00:00:01.000Z",
          actor_id: "assistant",
          scope_id: "session-x",
          text: "pong",
        }),
      ],
    });
    authority.close();
    const { app, origin } = await startPersonalApi(database, blobRoot);
    try {
      const inbox = await (await fetch(`${origin}/v1/me/inbox`)).json();
      const kinds = inbox
        .map((item) => [item.event.external_id, item.kind, item.body_text])
        .sort((left, right) => left[0].localeCompare(right[0]));
      assert.deepEqual(kinds, [
        ["session-x:49", "assistant", "pong"],
        ["session-x:7", "user", "只用一句话回复：pong"],
      ]);
    } finally {
      await app.close();
    }
  });

  it("imports an explicit WhatsApp Personal Export v1 file without egress", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    const { app, origin } = await startPersonalApi(database, blobRoot);
    try {
      const imported = await fetch(`${origin}/v1/me/imports/whatsapp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          content: `${JSON.stringify({
            schema_version: "1.0",
            kind: "whatsapp_personal_message",
            message_id: "message-1",
            chat_id: "chat-1",
            chat_name: "Family",
            sender_id: "contact-1",
            sender_name: "Alex",
            direction: "incoming",
            sent_at: "2026-08-21T00:00:00.000Z",
            text: "Please call me.",
          })}\n`,
        }),
      });
      const result = await imported.json();
      assert.equal(imported.status, 201, JSON.stringify(result));
      assert.equal(result.accepted_count, 1);
      assert.equal(result.invalid_line_count, 0);

      const inbox = await (await fetch(`${origin}/v1/me/inbox`)).json();
      const item = inbox.find((entry) => entry.event.source === "whatsapp-personal");
      assert.equal(item.body_text, "Please call me.");
      assert.equal(item.can_send, false);
    } finally {
      await app.close();
    }
  });

  it("imports a user-selected Purr WA CSV without egress", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    const content = [
      "datetime,sender,fromMe,type,text",
      '"21/08/2026 14:30","Alex",0,chat,"Please call me."',
      '"21/08/2026 14:31","You",1,chat,"Calling now."',
    ].join("\n");
    const fileName = "Family_15550001_c_us.csv";
    const converted = createPurrWhatsAppImport({
      data: content,
      file_name: fileName,
      org_id: "local-owner",
      local_principal_id: "local-owner",
      received_at: "2026-08-21T15:00:00.000Z",
    });
    const authority = new SqliteAuthorityStore(database);
    const service = new IngestionService(new FsBlobStore(blobRoot), authority);
    await service.ingest({
      ...converted.batches[0],
      records: converted.batches[0].records.map((record) => ({
        ...record,
        content: record.content.filter((part) => part.role === "body"),
      })),
    });
    authority.close();

    const { app, origin } = await startPersonalApi(database, blobRoot);
    try {
      const imported = await fetch(`${origin}/v1/me/imports/whatsapp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          content,
          file_name: fileName,
        }),
      });
      const result = await imported.json();
      assert.equal(imported.status, 201, JSON.stringify(result));
      assert.equal(result.accepted_count, 2);
      assert.equal(result.invalid_line_count, 0);

      const inbox = await (await fetch(`${origin}/v1/me/inbox`)).json();
      const items = inbox.filter(
        (entry) => entry.event.source === "whatsapp-personal",
      );
      assert.equal(items.length, 2);
      assert.equal(items.every((item) => item.can_send === false), true);
      const incoming = items.find((item) => item.direction === "inbound");
      const outgoing = items.find((item) => item.direction === "outbound");
      assert.equal(incoming.kind, "user");
      assert.equal(incoming.actor_label, "Alex");
      assert.equal(incoming.conversation_label, "Family");
      assert.equal(incoming.conversation_kind, "direct");
      assert.equal(outgoing.kind, "user");
      assert.equal(outgoing.actor_label, null);

      const replayed = await fetch(`${origin}/v1/me/imports/whatsapp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          content,
          file_name: fileName,
        }),
      });
      const replayedResult = await replayed.json();
      assert.equal(replayed.status, 201, JSON.stringify(replayedResult));
      assert.equal(replayedResult.accepted_count, 0);
      assert.equal(replayedResult.duplicate_count, 2);
    } finally {
      await app.close();
    }
  });

  it("rejects WhatsApp import content larger than 20 MiB", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    const { app, origin } = await startPersonalApi(database, blobRoot);
    try {
      const response = await fetch(`${origin}/v1/me/imports/whatsapp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "x".repeat(20 * 1024 * 1024 + 1) }),
      });
      const body = await response.json();

      assert.equal(response.status, 413, JSON.stringify(body));
      assert.equal(body.error.code, "invalid_config");
    } finally {
      await app.close();
    }
  });

  it("rejects a Purr CSV file with no valid message batch", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    const { app, origin } = await startPersonalApi(database, blobRoot);
    try {
      const response = await fetch(`${origin}/v1/me/imports/whatsapp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          content: "time,sender,fromMe,type,text\n21/08/2026 14:30,Alex,0,chat,Hello",
          file_name: "Family_15550001_c_us.csv",
        }),
      });
      const body = await response.json();

      assert.equal(response.status, 400, JSON.stringify(body));
      assert.equal(body.error.code, "invalid_config");
    } finally {
      await app.close();
    }
  });

  it("titles DSH list heads from the first user message", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    const authority = new SqliteAuthorityStore(database);
    const service = new IngestionService(new FsBlobStore(blobRoot), authority);
    await authority.createInstallation({
      id: "dsh-1",
      org_id: "local-owner",
      connector_type: "dsh-session",
      status: "enabled",
      config: { transport: "web", base_url: "http://127.0.0.1:9" },
      created_at: "2026-08-21T00:00:00.000Z",
    });
    await service.ingest({
      schema_version: INGEST_SCHEMA_VERSION,
      connector_id: "dsh-session",
      org_id: "local-owner",
      delivery_id: "dsh-prompt-1",
      received_at: "2026-08-21T00:00:00.000Z",
      records: [
        channelRecord({
          channel: "dsh",
          kind: "user",
          direction: "outbound",
          external_id: "session-x:7",
          occurred_at: "2026-08-21T00:00:00.000Z",
          actor_id: "user",
          scope_id: "session-x",
          text: "只用一句话回复：pong",
        }),
        channelRecord({
          channel: "dsh",
          kind: "assistant",
          direction: "inbound",
          external_id: "session-x:49",
          occurred_at: "2026-08-21T00:00:01.000Z",
          actor_id: "assistant",
          scope_id: "session-x",
          text: "pong",
        }),
        channelRecord({
          channel: "dsh",
          kind: "user",
          direction: "outbound",
          external_id: "session-x:50",
          occurred_at: "2026-08-21T00:00:02.000Z",
          actor_id: "user",
          scope_id: "session-x",
          text: "再来一句",
        }),
      ],
    });
    authority.close();
    const { app, origin } = await startPersonalApi(database, blobRoot);
    try {
      const heads = await (await fetch(`${origin}/v1/me/inbox?heads=1`)).json();
      assert.equal(heads.length, 1);
      assert.equal(heads[0].list_title, "prompt");
      assert.equal(heads[0].conversation_label, "只用一句话回复：pong");
      assert.equal(heads[0].body_text, undefined);
      assert.equal(heads[0].event.external_id, "session-x:50");
    } finally {
      await app.close();
    }
  });

  it("titles DSH list heads from the first user message after system injects", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    const authority = new SqliteAuthorityStore(database);
    const service = new IngestionService(new FsBlobStore(blobRoot), authority);
    await authority.createInstallation({
      id: "dsh-1",
      org_id: "local-owner",
      connector_type: "dsh-session",
      status: "enabled",
      config: { transport: "web", base_url: "http://127.0.0.1:9" },
      created_at: "2026-08-21T00:00:00.000Z",
    });
    const injects = Array.from({ length: 30 }, (_, index) =>
      channelRecord({
        channel: "dsh",
        kind: "system",
        direction: "inbound",
        external_id: `session-long:${index + 1}`,
        occurred_at: `2026-08-21T00:00:${String(index).padStart(2, "0")}.000Z`,
        actor_id: "plugin",
        scope_id: "session-long",
        text: `injected context ${index + 1}: skill and memory preamble`,
      }),
    );
    await service.ingest({
      schema_version: INGEST_SCHEMA_VERSION,
      connector_id: "dsh-session",
      org_id: "local-owner",
      delivery_id: "dsh-prompt-injects-1",
      received_at: "2026-08-21T00:01:00.000Z",
      records: [
        ...injects,
        channelRecord({
          channel: "dsh",
          kind: "user",
          direction: "outbound",
          external_id: "session-long:31",
          occurred_at: "2026-08-21T00:00:31.000Z",
          actor_id: "user",
          scope_id: "session-long",
          text: "只用一句话回复：pong",
        }),
        channelRecord({
          channel: "dsh",
          kind: "assistant",
          direction: "inbound",
          external_id: "session-long:32",
          occurred_at: "2026-08-21T00:00:32.000Z",
          actor_id: "assistant",
          scope_id: "session-long",
          text: "pong",
        }),
      ],
    });
    authority.close();
    const { app, origin } = await startPersonalApi(database, blobRoot);
    try {
      const heads = await (await fetch(`${origin}/v1/me/inbox?heads=1`)).json();
      assert.equal(heads.length, 1);
      assert.equal(heads[0].list_title, "prompt");
      assert.equal(heads[0].conversation_label, "只用一句话回复：pong");
      assert.equal(heads[0].body_text, undefined);
      assert.equal(heads[0].event.external_id, "session-long:32");
    } finally {
      await app.close();
    }
  });

  it("keeps a DSH list face when the first user prompt is still missing", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    const authority = new SqliteAuthorityStore(database);
    const service = new IngestionService(new FsBlobStore(blobRoot), authority);
    await authority.createInstallation({
      id: "dsh-1",
      org_id: "local-owner",
      connector_type: "dsh-session",
      status: "enabled",
      config: { transport: "web", base_url: "http://127.0.0.1:9" },
      created_at: "2026-08-21T00:00:00.000Z",
    });
    await service.ingest({
      schema_version: INGEST_SCHEMA_VERSION,
      connector_id: "dsh-session",
      org_id: "local-owner",
      delivery_id: "dsh-prompt-missing-1",
      received_at: "2026-08-21T00:00:00.000Z",
      records: [
        channelRecord({
          channel: "dsh",
          kind: "system",
          direction: "inbound",
          external_id: "session-bare:1",
          occurred_at: "2026-08-21T00:00:00.000Z",
          actor_id: "plugin",
          scope_id: "session-bare",
          text: "injected skill context",
        }),
        channelRecord({
          channel: "dsh",
          kind: "assistant",
          direction: "inbound",
          external_id: "session-bare:2",
          occurred_at: "2026-08-21T00:00:01.000Z",
          actor_id: "assistant",
          scope_id: "session-bare",
          text: "这是对方给我的初稿：一、Bioby AI品牌端介绍",
        }),
      ],
    });
    authority.close();
    const { app, origin } = await startPersonalApi(database, blobRoot);
    try {
      const heads = await (await fetch(`${origin}/v1/me/inbox?heads=1`)).json();
      assert.equal(heads.length, 1);
      assert.equal(heads[0].list_title, "prompt");
      assert.equal(heads[0].conversation_label, null);
      assert.equal(
        heads[0].body_text,
        "这是对方给我的初稿：一、Bioby AI品牌端介绍",
      );
    } finally {
      await app.close();
    }
  });

  it("persists a conversation title and pin across inbox reads", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    const authority = new SqliteAuthorityStore(database);
    const service = new IngestionService(new FsBlobStore(blobRoot), authority);
    await service.ingest({
      schema_version: INGEST_SCHEMA_VERSION,
      connector_id: "dsh-session",
      org_id: "local-owner",
      delivery_id: "dsh-title",
      received_at: "2026-08-21T00:00:00.000Z",
      records: [
        channelRecord({
          channel: "dsh",
          kind: "user",
          direction: "outbound",
          external_id: "session-title:7",
          occurred_at: "2026-08-21T00:00:00.000Z",
          actor_id: "user",
          scope_id: "session-title",
          text: "只用一句话回复：pong",
        }),
        channelRecord({
          channel: "dsh",
          kind: "assistant",
          direction: "inbound",
          external_id: "session-title:8",
          occurred_at: "2026-08-21T00:00:30.000Z",
          actor_id: "assistant",
          scope_id: "session-title",
          text: "pong",
        }),
      ],
    });
    authority.close();
    const { app, origin } = await startPersonalApi(database, blobRoot);
    try {
      const before = await (await fetch(`${origin}/v1/me/engine?detail=0`)).json();
      const created = await (
        await fetch(`${origin}/v1/me/conversations/prefs`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            thread_id: "dsh:session-title",
            title: "  Release desk  ",
            pinned: true,
          }),
        })
      ).json();
      assert.equal(created.title, "Release desk");
      assert.equal(created.pinned, true);
      const after = await (await fetch(`${origin}/v1/me/engine?detail=0`)).json();
      assert.equal(after.inbox_count, before.inbox_count);
      assert.notEqual(after.inbox_digest, before.inbox_digest);

      const inbox = await (await fetch(`${origin}/v1/me/inbox`)).json();
      assert.equal(inbox[0].thread_id, "dsh:session-title");
      assert.equal(inbox[0].title, "Release desk");
      assert.equal(inbox[0].pinned, true);

      const cleared = await (
        await fetch(`${origin}/v1/me/conversations/prefs`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            thread_id: "dsh:session-title",
            title: "",
          }),
        })
      ).json();
      assert.equal(cleared.title, null);
      assert.equal(cleared.pinned, true);

      const again = await (await fetch(`${origin}/v1/me/inbox`)).json();
      assert.equal(again[0].title, null);
      assert.equal(again[0].pinned, true);

      const invalid = await fetch(`${origin}/v1/me/conversations/prefs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "x" }),
      });
      assert.equal(invalid.status, 400);

      assert.equal(
        again.find((item) => item.event.external_id === "session-title:8")?.unread,
        true,
      );
      const read = await fetch(`${origin}/v1/me/conversations/attention`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          thread_id: "dsh:session-title",
          last_read_at: "2026-08-21T00:00:00.000Z",
          last_read_external_id: "session-title:8",
        }),
      });
      const readBody = await read.json();
      assert.ok(read.ok, JSON.stringify(readBody));
      assert.equal(readBody.last_read_external_id, "session-title:8");
      const afterRead = await (await fetch(`${origin}/v1/me/inbox`)).json();
      assert.equal(
        afterRead.find((item) => item.event.external_id === "session-title:8")?.unread,
        false,
      );

      const slackPrompt = await fetch(`${origin}/v1/me/conversations/prompts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          thread_id: "slack:C123",
          prompt_id: "q:nope",
          answers: [{ id: "go", selected: ["Yes"] }],
        }),
      });
      assert.equal(slackPrompt.status, 501);
    } finally {
      await app.close();
    }
  });

  it("marks a thread unread from its latest inbound, even when the list face is outbound", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    const authority = new SqliteAuthorityStore(database);
    const service = new IngestionService(new FsBlobStore(blobRoot), authority);
    await service.ingest({
      schema_version: INGEST_SCHEMA_VERSION,
      connector_id: "dsh-session",
      org_id: "local-owner",
      delivery_id: "dsh-unread-head",
      received_at: "2026-08-24T00:00:00.000Z",
      records: [
        channelRecord({
          channel: "dsh",
          kind: "assistant",
          direction: "inbound",
          external_id: "session-unread:in",
          occurred_at: "2026-08-24T10:00:00.000Z",
          actor_id: "assistant",
          scope_id: "session-unread",
          text: "Need a decision",
        }),
        channelRecord({
          channel: "dsh",
          kind: "user",
          direction: "outbound",
          external_id: "session-unread:out:1",
          occurred_at: "2026-08-24T12:00:00.000Z",
          actor_id: "user",
          scope_id: "session-unread",
          text: "Working through the decision now",
        }),
      ],
    });
    authority.close();
    const { app, origin } = await startPersonalApi(database, blobRoot);
    try {
      const heads = await (await fetch(`${origin}/v1/me/inbox?heads=1`)).json();
      const row = heads.find((item) => item.thread_id === "dsh:session-unread");
      assert.equal(row.direction, "outbound");
      assert.equal(row.unread, true);
      assert.equal(row.can_receipt, false);
      assert.equal(row.receipt, undefined);
      const read = await fetch(`${origin}/v1/me/conversations/attention`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          thread_id: "dsh:session-unread",
          last_read_at: "2026-08-24T10:00:00.000Z",
          last_read_external_id: "session-unread:in",
        }),
      });
      assert.ok(read.ok, await read.text());
      const after = await (await fetch(`${origin}/v1/me/inbox?heads=1`)).json();
      assert.equal(
        after.find((item) => item.thread_id === "dsh:session-unread")?.unread,
        false,
      );
    } finally {
      await app.close();
    }
  });

  it("answers a live DSH prompt through respond, not session.prompt", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    await ingestActionable(database, blobRoot);
    const dsh = await startDshWebStub();
    const { app, origin } = await startPersonalApi(database, blobRoot);
    let installation;
    try {
      const created = await fetch(`${origin}/v1/me/connectors`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          connector_type: "dsh-session",
          config: { transport: "web", base_url: dsh.origin },
        }),
      });
      installation = await created.json();
      assert.equal(created.status, 201, JSON.stringify(installation));
      const promptId = questionPromptId("rpc-q");
      dshPromptStoreFor(installation.id).put("sess-a", {
        prompt_id: promptId,
        presentation: "choice",
        questions: [{ id: "go", prompt: "Continue?", options: [{ label: "Yes" }] }],
      });
      await waitUntil("dsh sess-a after install", async () => {
        const heads = await (await fetch(`${origin}/v1/me/inbox?heads=1`)).json();
        return heads.some((item) => item.thread_id === "dsh:sess-a");
      });
      const engine = await (await fetch(`${origin}/v1/me/engine?detail=0`)).json();
      assert.match(engine.inbox_digest, /&s=/);
      const heads = await (await fetch(`${origin}/v1/me/inbox?heads=1`)).json();
      const sess = heads.find((item) => item.thread_id === "dsh:sess-a");
      assert.equal(sess.unread, true);
      assert.equal(sess.prompts[0].prompt_id, promptId);

      const answered = await fetch(`${origin}/v1/me/conversations/prompts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          thread_id: "dsh:sess-a",
          prompt_id: promptId,
          answers: [{ id: "go", selected: ["Yes"] }],
        }),
      });
      const body = await answered.json();
      assert.ok(answered.ok, JSON.stringify(body));
      assert.equal(body.accepted, true);
      assert.equal(dsh.responds.length, 1);
      assert.equal(dsh.responds[0].type, "client-response");
      assert.equal(dsh.responds[0].rpcId, "rpc-q");
      assert.equal(dsh.prompts.length, 0);
      const after = await (await fetch(`${origin}/v1/me/inbox?heads=1`)).json();
      assert.equal(
        (after.find((item) => item.thread_id === "dsh:sess-a")?.prompts ?? []).length,
        0,
      );
    } finally {
      if (installation?.id) {
        dropDshPromptStore(installation.id);
      }
      await app.close();
      await dsh.close();
    }
  });

  it("includes pending siblings once a conversation is already current work", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    const authority = new SqliteAuthorityStore(database);
    const service = new IngestionService(new FsBlobStore(blobRoot), authority);
    await service.ingest({
      schema_version: INGEST_SCHEMA_VERSION,
      connector_id: "dsh-session",
      org_id: "local-owner",
      delivery_id: "dsh-2",
      received_at: "2026-08-21T00:00:00.000Z",
      records: [
        {
          operation: "create",
          source: "dsh",
          external_id: "session-y:1",
          occurred_at: "2026-08-21T00:00:00.000Z",
          actor: { id: "user" },
          scope: { id: "session-y" },
          type: "message",
          content: [{ role: "body", media_type: "text/plain", text: "Please confirm the release." }],
        },
        {
          operation: "create",
          source: "dsh",
          external_id: "session-y:2",
          occurred_at: "2026-08-21T00:00:01.000Z",
          actor: { id: "assistant" },
          scope: { id: "session-y" },
          type: "message",
          content: [{ role: "body", media_type: "text/plain", text: "later" }],
        },
      ],
    });
    authority.close();
    const { app, origin } = await startPersonalApi(database, blobRoot);
    try {
      const inbox = await (await fetch(`${origin}/v1/me/inbox`)).json();
      const texts = inbox.map((item) => item.body_text).sort();
      assert.deepEqual(texts, ["Please confirm the release.", "later"]);
    } finally {
      await app.close();
    }
  });

  it("reports engine status without connector credentials", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    await ingestActionable(database, blobRoot);
    const { app, origin } = await startPersonalApi(database, blobRoot);
    try {
      const engine = await (await fetch(`${origin}/v1/me/engine`)).json();
      const health = await (await fetch(`${origin}/health`)).json();

      assert.equal(engine.kernel, "running");
      assert.equal(engine.org_id, "local-owner");
      assert.equal(engine.database_path, database);
      assert.equal(engine.inbox_count, 1);
      assert.match(engine.inbox_digest, /^1:/);
      assert.equal(engine.pull.interval_ms, 0);
      assert.equal(engine.pull.phase, "idle");
      assert.equal(Array.isArray(engine.pull.streams), true);
      assert.equal(engine.pull.last_error_hint, null);
      assert.equal(engine.pull.network.kind, "ok");
      assert.equal(engine.installations[0].id, "slack-1");
      assert.equal(engine.installations[0].connector_type, "slack-channel");
      assert.equal(engine.installations[0].label, "C123");
      assert.equal(engine.installations[0].syncable, true);
      assert.equal(engine.installations[0].can_reply, false);
      assert.equal(engine.installations[0].can_create, false);
      assert.equal(engine.installations[0].last_attempt, null);
      assert.equal(engine.catalog.length, 3);
      assert.equal(engine.catalog[0].connector_type, "slack-channel");
      assert.equal(engine.catalog[0].installed, true);
      assert.equal(engine.catalog[0].prerequisites[0].key, "REGENIC_SLACK_TOKEN");
      assert.equal(engine.catalog[0].prerequisites[0].ready, false);
      assert.equal(engine.catalog[1].connector_type, "dsh-session");
      assert.equal(engine.catalog[1].installed, false);
      assert.equal(engine.catalog[1].fields[1].key, "session_id");
      assert.equal(engine.catalog[1].fields[1].required, false);
      assert.equal(engine.catalog[2].connector_type, "feishu-chat");
      assert.equal(engine.catalog[2].installed, false);
      assert.equal(engine.catalog[2].fields[0].key, "selection");
      assert.equal(engine.catalog[2].fields[1].key, "kinds");
      assert.equal(engine.catalog[2].fields[1].default, "group,p2p");
      assert.equal(engine.catalog[2].fields[2].key, "chat_ids");
      assert.equal(engine.catalog[2].fields[2].multiple, true);
      assert.equal(engine.catalog[2].prerequisites[0].key, "lark-cli");
      assert.equal(engine.installations[0].settings.channel_id, "C123");
      assert.equal(JSON.stringify(engine).includes("xoxb"), false);
      assert.equal(JSON.stringify(engine).includes("credentials_ref"), false);
      assert.equal(JSON.stringify(engine).includes("access_token"), false);
      assert.equal(health.mode, "personal");
      assert.equal(health.sqlite, "up");
      assert.equal(health.status, "ok");
      assert.equal(health.postgres, undefined);
      assert.equal(health.dsh, undefined);
      assert.equal(typeof health.memory.rss_bytes, "number");
      assert.ok(health.memory.rss_bytes > 0);
      assert.equal(typeof engine.memory.rss_bytes, "number");
      assert.ok(engine.memory.rss_bytes > 0);
    } finally {
      await app.close();
    }
  });

  it("answers /health without waiting on DSH", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    await ingestActionable(database, blobRoot);
    const hanging = createServer(() => undefined);
    await new Promise((resolve) => {
      hanging.listen(0, "127.0.0.1", resolve);
    });
    const dshOrigin = `http://127.0.0.1:${hanging.address().port}`;
    const { app, origin } = await startPersonalApi(database, blobRoot, {
      REGENIC_DSH_BASE_URL: dshOrigin,
    });
    try {
      const started = Date.now();
      const health = await (await fetch(`${origin}/health`)).json();
      assert.ok(Date.now() - started < 500);
      assert.equal(health.mode, "personal");
      assert.equal(health.sqlite, "up");
      assert.equal(health.status, "ok");
      assert.equal(health.dsh, undefined);
    } finally {
      await app.close();
      hanging.close();
    }
  });

  it("rejects conversation create when no connector can open a thread", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    await ingestActionable(database, blobRoot);
    const { app, origin } = await startPersonalApi(database, blobRoot);
    try {
      const created = await fetch(`${origin}/v1/me/conversations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      assert.equal(created.status, 501);
    } finally {
      await app.close();
    }
  });

  it("syncs a slack connector from the personal API", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    await ingestActionable(database, blobRoot);
    const slack = await startSlackHistoryStub();
    const { app, origin } = await startPersonalApi(database, blobRoot, {
      REGENIC_SLACK_TOKEN: "xoxb-test-token",
      REGENIC_SLACK_API_ENDPOINT: slack.endpoint,
    });
    try {
      const missing = await fetch(`${origin}/v1/me/connectors/missing/sync`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      assert.equal(missing.status, 404);

      const synced = await fetch(`${origin}/v1/me/connectors/slack-1/sync`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const body = await synced.json();
      assert.equal(synced.status, 201);
      const inbox = await (await fetch(`${origin}/v1/me/inbox`)).json();
      const slackItem = inbox.find(
        (item) => item.event.external_id === "C123:1710000000.000100",
      );
      assert.equal(Boolean(slackItem), true);
      assert.equal(slackItem.can_send, false);
      assert.equal(slackItem.await_reply, false);
      assert.equal(slackItem.list_title, "conversation");
      assert.equal(body.installation_id, "slack-1");
      assert.equal(body.last_run_status, "completed");
      assert.equal(body.installation.label, "C123");
      assert.equal(JSON.stringify(body).includes("xoxb-test-token"), false);
      assert.equal(JSON.stringify(body).includes("credentials_ref"), false);

      const disabled = await fetch(`${origin}/v1/me/connectors/slack-1/disable`, {
        method: "POST",
      });
      assert.equal(disabled.status, 201);
      assert.equal((await disabled.json()).status, "disabled");
      const blocked = await fetch(`${origin}/v1/me/connectors/slack-1/sync`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      assert.equal(blocked.status, 409);
    } finally {
      await app.close();
      await slack.close();
    }
  });

  it("installs and uninstalls catalog connectors", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    await ingestActionable(database, blobRoot);
    const { app, origin } = await startPersonalApi(database, blobRoot);
    try {
      const invalid = await fetch(`${origin}/v1/me/connectors`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ connector_type: "slack-channel", config: {} }),
      });
      assert.equal(invalid.status, 400);

      const created = await fetch(`${origin}/v1/me/connectors`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          connector_type: "dsh-session",
          config: { transport: "web", session_id: "desk-1" },
        }),
      });
      const installation = await created.json();
      assert.equal(created.status, 201);
      assert.equal(installation.connector_type, "dsh-session");
      assert.equal(installation.label, "desk-1");
      assert.equal(JSON.stringify(installation).includes("credentials"), false);

      const engine = await (await fetch(`${origin}/v1/me/engine?detail=0`)).json();
      assert.equal(
        engine.catalog.find((item) => item.connector_type === "dsh-session")
          .installed,
        true,
      );

      const updated = await fetch(
        `${origin}/v1/me/connectors/${installation.id}/config`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            config: { transport: "web", session_id: "desk-2" },
          }),
        },
      );
      const updatedBody = await updated.json();
      assert.equal(updated.status, 201);
      assert.equal(updatedBody.label, "desk-2");
      assert.equal(updatedBody.id, installation.id);
      assert.equal(updatedBody.settings.session_id, "desk-2");

      const feishu = await fetch(`${origin}/v1/me/connectors`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          connector_type: "feishu-chat",
          config: { selection: "all" },
        }),
      });
      const feishuBody = await feishu.json();
      assert.equal(feishu.status, 201, JSON.stringify(feishuBody));
      assert.equal(feishuBody.label, "All conversations");
      assert.equal(feishuBody.settings.kinds, "group,p2p");

      const feishuUpdated = await fetch(
        `${origin}/v1/me/connectors/${feishuBody.id}/config`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            config: { selection: "all", kinds: "p2p" },
          }),
        },
      );
      const feishuUpdatedBody = await feishuUpdated.json();
      assert.equal(feishuUpdated.status, 201, JSON.stringify(feishuUpdatedBody));
      assert.equal(feishuUpdatedBody.label, "All direct messages");
      assert.equal(feishuUpdatedBody.settings.kinds, "p2p");

      const removed = await fetch(
        `${origin}/v1/me/connectors/${installation.id}`,
        { method: "DELETE" },
      );
      assert.equal(removed.status, 200);
      const after = await (await fetch(`${origin}/v1/me/engine?detail=0`)).json();
      assert.equal(
        after.installations.some((item) => item.id === installation.id),
        false,
      );
      assert.equal(
        after.catalog.find((item) => item.connector_type === "dsh-session")
          .installed,
        false,
      );
    } finally {
      await app.close();
    }
  });

  it("installs DSH without session_id and syncs every listed session", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    await ingestActionable(database, blobRoot);
    const dsh = await startDshWebStub();
    const { app, origin } = await startPersonalApi(database, blobRoot);
    try {
      const created = await fetch(`${origin}/v1/me/connectors`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          connector_type: "dsh-session",
          config: { transport: "web", base_url: dsh.origin },
        }),
      });
      const installation = await created.json();
      assert.equal(created.status, 201);
      assert.equal(installation.label, "All sessions");
      assert.equal(JSON.stringify(installation).includes("credentials"), false);

      await waitUntil("dsh sessions after install", async () => {
        const inbox = await (await fetch(`${origin}/v1/me/inbox`)).json();
        return (
          inbox.some((item) => item.event.external_id === "sess-a:1") &&
          inbox.some((item) => item.event.external_id === "sess-b:1")
        );
      });
      const inbox = await (await fetch(`${origin}/v1/me/inbox`)).json();
      const sessionA = inbox.find((item) => item.event.external_id === "sess-a:1");
      const sessionB = inbox.find((item) => item.event.external_id === "sess-b:1");
      assert.equal(Boolean(sessionA), true);
      assert.equal(Boolean(sessionB), true);
      assert.equal(sessionA.can_send, true);
      assert.equal(sessionB.can_send, true);
      assert.equal(sessionA.await_reply, true);
      assert.equal(sessionB.await_reply, true);
      assert.equal(sessionA.list_title, "prompt");
      assert.equal(sessionB.list_title, "prompt");

      const synced = await fetch(
        `${origin}/v1/me/connectors/${installation.id}/sync`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        },
      );
      const body = await synced.json();
      assert.equal(synced.status, 201);
      assert.equal(body.streams_attempted, 2);
      assert.equal(body.last_run_status, "completed");
    } finally {
      await app.close();
      await dsh.close();
    }
  });

  it("pulls a later DSH message on the live interval without a manual sync", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    await ingestActionable(database, blobRoot);
    const dsh = await startDshWebStub();
    const { app, origin } = await startPersonalApi(database, blobRoot, {
      REGENIC_CONNECTOR_PULL_MS: "1000",
    });
    try {
      const created = await fetch(`${origin}/v1/me/connectors`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          connector_type: "dsh-session",
          config: { transport: "web", base_url: dsh.origin },
        }),
      });
      assert.equal(created.status, 201);
      const engine = await (await fetch(`${origin}/v1/me/engine`)).json();
      assert.equal(engine.pull.interval_ms, 1000);

      dsh.push("sess-a", {
        type: "user/message",
        seq: 10,
        time: Date.now(),
        data: {
          content: [{ type: "text", text: "Late arriving work from DSH." }],
          source: { kind: "user" },
        },
      });

      await waitUntil("live pull of late DSH message", async () => {
        const inbox = await (await fetch(`${origin}/v1/me/inbox`)).json();
        return inbox.some((item) =>
          String(item.body_text ?? "").includes("Late arriving work from DSH."),
        );
      });
    } finally {
      await app.close();
      await dsh.close();
    }
  });

  it("sends a DSH reply with markdown and an image", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    await ingestActionable(database, blobRoot);
    const dsh = await startDshWebStub();
    const { app, origin } = await startPersonalApi(database, blobRoot);
    try {
      const created = await fetch(`${origin}/v1/me/connectors`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          connector_type: "dsh-session",
          config: { transport: "web", base_url: dsh.origin },
        }),
      });
      const createdBody = await created.json();
      assert.equal(created.status, 201, JSON.stringify(createdBody));
      assert.equal(createdBody.can_create, true);
      assert.equal(createdBody.can_reply, true);
      assert.equal(createdBody.channel, "dsh");
      assert.equal(createdBody.channel_label, "DSH");
      await waitUntil("dsh sess-a after install", async () => {
        const inbox = await (await fetch(`${origin}/v1/me/inbox`)).json();
        return inbox.some((item) => item.event.external_id === "sess-a:1");
      });

      const slackOnly = await fetch(`${origin}/v1/me/conversations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ installation_id: "slack-1" }),
      });
      assert.equal(slackOnly.status, 501);

      const opened = await fetch(`${origin}/v1/me/conversations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const openedBody = await opened.json();
      assert.equal(opened.status, 201, JSON.stringify(openedBody));
      assert.equal(openedBody.thread_id, "dsh:created-1");
      assert.equal(openedBody.channel, "dsh");
      assert.equal(openedBody.channel_label, "DSH");
      assert.equal(openedBody.can_send, true);
      assert.equal(openedBody.await_reply, true);
      assert.equal(openedBody.list_title, "prompt");
      assert.deepEqual(dsh.created, ["created-1"]);

      const empty = await fetch(`${origin}/v1/me/replies`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ thread_id: "dsh:sess-a" }),
      });
      assert.equal(empty.status, 400);

      const slack = await fetch(`${origin}/v1/me/replies`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          thread_id: "slack:C123",
          text: "Please take a look",
        }),
      });
      assert.equal(slack.status, 501);

      const replied = await fetch(`${origin}/v1/me/replies`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          thread_id: "dsh:sess-a",
          text: "Please review **this** screenshot.",
          attachments: [
            {
              filename: "shot.png",
              media_type: "image/png",
              data_base64:
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
            },
          ],
        }),
      });
      const body = await replied.json();
      assert.equal(replied.status, 201, JSON.stringify(body));
      assert.equal(body.accepted, true);
      assert.equal(body.thread_id, "dsh:sess-a");
      assert.match(body.item.body_text, /Please review \*\*this\*\* screenshot/);
      assert.equal(body.item.direction, "outbound");
      assert.equal(body.item.can_send, true);
      assert.equal(body.item.attachments[0].filename, "shot.png");
      assert.equal(dsh.prompts.length, 1);
      assert.equal(dsh.prompts[0].method, "session.prompt");
      assert.equal(dsh.prompts[0].payload.sessionId, "sess-a");
      const image = dsh.prompts[0].payload.content.find((part) => part.type === "image");
      assert.equal(image.mimeType, "image/png");
      assert.equal(image.mediaType, "image/png");
      assert.equal(image.name, "shot.png");
      assert.equal(
        image.data,
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      );
      assert.equal(image.url, undefined);
      assert.equal(image.path, undefined);

      const oversized = await fetch(`${origin}/v1/me/replies`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          thread_id: "dsh:sess-a",
          text: "large screenshot",
          attachments: [
            {
              filename: "wide.png",
              media_type: "image/png",
              data_base64: Buffer.alloc(150 * 1024, 7).toString("base64"),
            },
          ],
        }),
      });
      assert.notEqual(oversized.status, 413);
      assert.equal(oversized.status, 201, await oversized.text());

      const inbox = await (await fetch(`${origin}/v1/me/inbox`)).json();
      const userTexts = inbox
        .filter((item) => item.kind === "user" && item.body_text.includes("Please review"))
        .map((item) => item.event.external_id);
      assert.equal(userTexts.length, 1);
      assert.match(userTexts[0], /^sess-a:out:/);
      assert.equal(
        inbox.some((item) => item.kind === "assistant" && item.body_text === "pong"),
        true,
      );

      const synced = await fetch(
        `${origin}/v1/me/connectors/${createdBody.id}/sync`,
        { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
      );
      assert.equal(synced.status, 201);
      const after = await (await fetch(`${origin}/v1/me/inbox`)).json();
      assert.equal(
        after.filter((item) => item.kind === "user" && item.body_text.includes("Please review")).length,
        1,
      );
    } finally {
      await app.close();
      await dsh.close();
    }
  });

  it("lets a hosted kernel reply to DSH sessions through a stored cli install", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    const authority = new SqliteAuthorityStore(database);
    const service = new IngestionService(new FsBlobStore(blobRoot), authority);
    await service.ingest({
      schema_version: INGEST_SCHEMA_VERSION,
      connector_id: "dsh-session",
      org_id: "local-owner",
      delivery_id: "dsh-hosted",
      received_at: "2026-08-21T00:00:00.000Z",
      records: [
        channelRecord({
          channel: "dsh",
          kind: "user",
          direction: "outbound",
          external_id: "session-hosted:1",
          occurred_at: "2026-08-21T00:00:00.000Z",
          actor_id: "user",
          scope_id: "session-hosted",
          text: "只用一个英文单词回复：pong",
        }),
      ],
    });
    await authority.createInstallation({
      id: "dsh-main",
      org_id: "local-owner",
      connector_type: "dsh-session",
      status: "enabled",
      config: { transport: "cli", mailbox: "dsh-main" },
      created_at: "2026-08-21T00:00:00.000Z",
    });
    authority.close();
    const dsh = await startDshWebStub();
    const { app, origin } = await startPersonalApi(database, blobRoot, {
      REGENIC_DSH_BASE_URL: dsh.origin,
    });
    try {
      const inbox = await (await fetch(`${origin}/v1/me/inbox`)).json();
      const item = inbox.find((row) => row.event.source === "dsh");
      assert.equal(Boolean(item), true);
      assert.equal(item.can_send, true);

      const engine = await (await fetch(`${origin}/v1/me/engine`)).json();
      const catalog = engine.catalog.find(
        (entry) => entry.connector_type === "dsh-session",
      );
      assert.equal(
        catalog.fields.some((field) => field.key === "base_url"),
        false,
      );
      assert.equal(
        engine.installations.find((entry) => entry.id === "dsh-main").detail,
        "web",
      );

      const created = await fetch(`${origin}/v1/me/connectors`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          connector_type: "dsh-session",
          config: {
            transport: "web",
            base_url: "https://regenic-dsh.sealosbja.site",
          },
        }),
      });
      const installation = await created.json();
      assert.equal(created.status, 201, JSON.stringify(installation));
      assert.equal(installation.detail, "web");

      const replied = await fetch(`${origin}/v1/me/replies`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          thread_id: "dsh:session-hosted",
          text: "pong",
        }),
      });
      const body = await replied.json();
      assert.equal(replied.status, 201, JSON.stringify(body));
      assert.equal(dsh.prompts[0].payload.sessionId, "session-hosted");
    } finally {
      await app.close();
      await dsh.close();
    }
  });

  it("hides /v1/me when the process is not loopback-bound", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    await ingestActionable(database, blobRoot);
    const { app, origin } = await startPersonalApi(database, blobRoot, {
      LISTEN_HOST: "0.0.0.0",
    });
    try {
      const inbox = await fetch(`${origin}/v1/me/inbox`);
      const engine = await fetch(`${origin}/v1/me/engine`);
      const health = await (await fetch(`${origin}/health`)).json();
      assert.equal(inbox.status, 404);
      assert.equal(engine.status, 404);
      assert.equal(health.mode, "service");
      assert.equal(health.sqlite, "up");
    } finally {
      await app.close();
    }
  });

  it("exposes /v1/me on a public bind when REGENIC_PERSONAL_API=1", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    await ingestActionable(database, blobRoot);
    const { app, origin } = await startPersonalApi(database, blobRoot, {
      LISTEN_HOST: "0.0.0.0",
      REGENIC_PERSONAL_API: "1",
    });
    try {
      const inbox = await fetch(`${origin}/v1/me/inbox`);
      const engine = await fetch(`${origin}/v1/me/engine`);
      const health = await (await fetch(`${origin}/health`)).json();
      assert.equal(inbox.status, 200);
      assert.equal(engine.status, 200);
      assert.equal(health.mode, "personal");
      assert.equal(health.sqlite, "up");
    } finally {
      await app.close();
    }
  });

  it("rejects DSH remote URLs and does not persist command or token_env", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    await ingestActionable(database, blobRoot);
    const { app, origin } = await startPersonalApi(database, blobRoot);
    try {
      const remote = await fetch(`${origin}/v1/me/connectors`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          connector_type: "dsh-session",
          config: {
            transport: "web",
            session_id: "desk-1",
            base_url: "https://example.com",
          },
        }),
      });
      assert.equal(remote.status, 400);

      const cli = await fetch(`${origin}/v1/me/connectors`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          connector_type: "dsh-session",
          config: {
            transport: "cli",
            command: "curl",
            workdir: "/tmp",
            mailbox: "box-1",
          },
        }),
      });
      assert.equal(cli.status, 201);

      const slack = await fetch(`${origin}/v1/me/connectors`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          connector_type: "slack-channel",
          config: { channel_id: "C999", token_env: "DEEPSEEK_API_KEY" },
        }),
      });
      assert.equal(slack.status, 201);

      const store = new SqliteAuthorityStore(database);
      try {
        const installations = await store.listInstallations("local-owner");
        const dsh = installations.find(
          (item) => item.config.mailbox === "box-1",
        );
        const installedSlack = installations.find(
          (item) => item.config.channel_id === "C999",
        );
        assert.equal(dsh.connector_type, "dsh-session");
        assert.equal(dsh.config.command, undefined);
        assert.equal(dsh.config.workdir, undefined);
        assert.equal(installedSlack.credentials_ref, "env:REGENIC_SLACK_TOKEN");
      } finally {
        store.close();
      }
    } finally {
      await app.close();
    }
  });

  it("opens a task work item even when a later utterance is the list head", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    const authority = new SqliteAuthorityStore(database);
    const service = new IngestionService(new FsBlobStore(blobRoot), authority);
    await service.ingest({
      schema_version: INGEST_SCHEMA_VERSION,
      connector_id: "feishu-chat",
      org_id: "local-owner",
      delivery_id: "buried-task",
      received_at: "2026-08-25T00:00:00.000Z",
      records: [
        channelRecord({
          channel: "feishu",
          kind: "user",
          direction: "inbound",
          external_id: "oc_travel:task-1",
          occurred_at: "2026-08-25T00:00:00.000Z",
          actor_id: "u1",
          scope_id: "oc_travel",
          type: "task",
          text: "Approve travel",
        }),
        channelRecord({
          channel: "feishu",
          kind: "user",
          direction: "inbound",
          external_id: "oc_travel:comment-2",
          occurred_at: "2026-08-25T00:05:00.000Z",
          actor_id: "u1",
          scope_id: "oc_travel",
          text: "Please confirm the release.",
        }),
      ],
    });
    authority.close();
    const { app, origin } = await startPersonalApi(database, blobRoot);
    try {
      await waitUntil("buried task opens a work item", async () => {
        const inbox = await (await fetch(`${origin}/v1/me/inbox?heads=1`)).json();
        const row = inbox.find((item) => item.thread_id === "feishu:oc_travel");
        return row?.work?.status === "open" && row?.event?.external_id === "oc_travel:comment-2";
      });
      const inbox = await (await fetch(`${origin}/v1/me/inbox?heads=1`)).json();
      const row = inbox.find((item) => item.thread_id === "feishu:oc_travel");
      assert.equal(row.event.external_id, "oc_travel:comment-2");
      assert.equal(row.work.status, "open");
      assert.equal(row.record_class, "task");
      assert.equal(row.thread_facet, "ticket");
    } finally {
      await app.close();
    }
  });

  it("dismisses a work item without writing back or faking exit", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    const authority = new SqliteAuthorityStore(database);
    const service = new IngestionService(new FsBlobStore(blobRoot), authority);
    const ingested = await service.ingest({
      schema_version: INGEST_SCHEMA_VERSION,
      connector_id: "feishu-chat",
      org_id: "local-owner",
      delivery_id: "dismiss-task",
      received_at: "2026-08-25T00:00:00.000Z",
      records: [
        channelRecord({
          channel: "feishu",
          kind: "user",
          direction: "inbound",
          external_id: "oc_dismiss:task-1",
          occurred_at: "2026-08-25T00:00:00.000Z",
          actor_id: "u1",
          scope_id: "oc_dismiss",
          type: "task",
          text: "Approve travel",
        }),
      ],
    });
    await seedHostedWork(authority, {
      workId: "work-dismiss-1",
      runId: "run-dismiss-1",
      recipeId: "recipe-dismiss",
      threadId: "feishu:oc_dismiss",
      eventId: ingested.records[0].event_id,
      status: "running",
    });
    authority.close();
    const { app, origin } = await startPersonalApi(database, blobRoot);
    try {
      const workId = "work-dismiss-1";
      const dismissed = await fetch(`${origin}/v1/me/work-items/${workId}/dismiss`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      assert.ok(dismissed.ok, `dismiss ${dismissed.status}`);
      const body = await dismissed.json();
      assert.equal(body.work_item.status, "skipped");
      assert.equal(body.work_item.id, workId);
      assert.equal(body.run.status, "cancelled");
      assert.notEqual(body.run.status, "failed");
      const aliased = await (
        await fetch(`${origin}/v1/me/work-items/${workId}/complete`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        })
      ).json();
      assert.equal(aliased.work_item.status, "skipped");
      const inbox = await (await fetch(`${origin}/v1/me/inbox`)).json();
      const texts = inbox
        .filter((item) => item.thread_id === "feishu:oc_dismiss")
        .map((item) => item.body_text ?? "");
      assert.equal(
        texts.some((text) => text === "Done" || /work-back/.test(text)),
        false,
      );
    } finally {
      await app.close();
    }
  });

  it("starts a new inferior after dismiss leaves a leftover active run", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    const authority = new SqliteAuthorityStore(database);
    const service = new IngestionService(new FsBlobStore(blobRoot), authority);
    const ingested = await service.ingest({
      schema_version: INGEST_SCHEMA_VERSION,
      connector_id: "feishu-chat",
      org_id: "local-owner",
      delivery_id: "leftover-run",
      received_at: "2026-08-25T00:00:00.000Z",
      records: [
        channelRecord({
          channel: "feishu",
          kind: "user",
          direction: "inbound",
          external_id: "oc_leftover:task-1",
          occurred_at: "2026-08-25T00:00:00.000Z",
          actor_id: "u1",
          scope_id: "oc_leftover",
          type: "task",
          text: "Approve leftover",
        }),
      ],
    });
    await seedHostedWork(authority, {
      workId: "work-leftover-1",
      runId: "run-leftover-1",
      recipeId: "recipe-leftover",
      threadId: "feishu:oc_leftover",
      eventId: ingested.records[0].event_id,
      status: "skipped",
    });
    authority.close();
    const { app, origin } = await startPersonalApi(database, blobRoot);
    try {
      const started = await fetch(`${origin}/v1/me/work-items/work-leftover-1/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      assert.equal(started.status, 501);
    } finally {
      await app.close();
    }
    const store = new SqliteAuthorityStore(database);
    try {
      const leftover = await store.getWorkRun("local-owner", "run-leftover-1");
      assert.equal(leftover.status, "cancelled");
      const item = await store.getWorkItem("local-owner", "work-leftover-1");
      assert.equal(item.status, "open");
    } finally {
      store.close();
    }
  });

  it("binds a recipe, remembers inbox sort, and exposes executor catalog", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    await ingestActionable(database, blobRoot);
    const { app, origin } = await startPersonalApi(database, blobRoot);
    try {
      const executors = await (await fetch(`${origin}/v1/me/executors`)).json();
      assert.equal(executors[0].executor_type, "dsh");
      assert.equal(executors[0].source, "dsh");
      assert.equal(executors[0].attach, "absentee");
      assert.equal(executors[0].fields[0].key, "skill");
      assert.equal(executors[0].fields[1].key, "prompt");
      assert.equal(executors[0].fields[1].kind, "textarea");
      const emptyMatch = await fetch(`${origin}/v1/me/recipes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Too broad",
          match: {},
          executor_type: "dsh",
        }),
      });
      assert.equal(emptyMatch.status, 400);
      const sourceOnly = await fetch(`${origin}/v1/me/recipes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "All chat",
          match: { source: "feishu" },
          executor_type: "dsh",
        }),
      });
      assert.equal(sourceOnly.status, 400);
      const missingComplete = await fetch(
        `${origin}/v1/me/work-items/work-missing/complete`,
        { method: "POST" },
      );
      assert.equal(missingComplete.status, 404);
      const missingDismiss = await fetch(
        `${origin}/v1/me/work-items/work-missing/dismiss`,
        { method: "POST" },
      );
      assert.equal(missingDismiss.status, 404);
      const created = await (
        await fetch(`${origin}/v1/me/recipes`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: "Feishu tasks",
            match: { record_class: "task", source: "feishu" },
            executor_type: "dsh",
            executor_config: { skill: "review", prompt: "Reply with a decision." },
            can_write_back: true,
          }),
        })
      ).json();
      assert.equal(created.executor_type, "dsh");
      assert.equal(created.can_write_back, true);
      assert.equal(created.executor_config.skill, "review");
      assert.equal(created.executor_config.prompt, "Reply with a decision.");
      const recipes = await (await fetch(`${origin}/v1/me/recipes`)).json();
      assert.equal(recipes.length, 1);
      assert.equal(recipes[0].executor_config.prompt, "Reply with a decision.");
      const prefs = await (
        await fetch(`${origin}/v1/me/prefs`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ inbox_sort: "attention" }),
        })
      ).json();
      assert.equal(prefs.inbox_sort, "attention");
      const remembered = await (await fetch(`${origin}/v1/me/prefs`)).json();
      assert.equal(remembered.inbox_sort, "attention");
      const inbox = await (await fetch(`${origin}/v1/me/inbox`)).json();
      assert.ok(inbox[0].record_class);
      assert.ok(inbox[0].thread_facet);
      assert.ok(inbox[0].attention);
    } finally {
      await app.close();
    }
  });

  it("returns 503 for inbox when the personal kernel is not configured", async () => {
    setEnv({
      REGENIC_DATABASE: undefined,
      REGENIC_BLOB_ROOT: undefined,
      PORT: "4370",
      LISTEN_HOST: "127.0.0.1",
    });
    const app = await createHttpApp({ logger: false });
    await app.listen(0, "127.0.0.1");
    const origin = await app.getUrl();
    try {
      const inbox = await fetch(`${origin}/v1/me/inbox`);
      const engine = await (await fetch(`${origin}/v1/me/engine`)).json();
      assert.equal(inbox.status, 503);
      assert.equal(engine.kernel, "stopped");
      assert.equal(engine.catalog[0].installed, false);
    } finally {
      await app.close();
    }
  });
});

describe("inbox body decode", () => {
  it("reads a single-part text blob and a content-parts envelope", () => {
    assert.equal(
      decodeBodyText(Buffer.from("Hello", "utf8"), "text/plain"),
      "Hello",
    );
    const envelope = Buffer.from(
      JSON.stringify([
        {
          role: "body",
          media_type: "text/plain",
          bytes_base64: Buffer.from("Please confirm", "utf8").toString("base64"),
        },
      ]),
      "utf8",
    );
    assert.equal(
      decodeBodyText(envelope, "application/vnd.regenic.content-parts+json"),
      "Please confirm",
    );
    const withFile = Buffer.from(
      JSON.stringify([
        {
          role: "body",
          media_type: "text/plain",
          bytes_base64: Buffer.from("Please confirm", "utf8").toString("base64"),
        },
        {
          role: "attachment",
          media_type: "image/png",
          source_filename: "shot.png",
          bytes_base64: Buffer.from("fakepng", "utf8").toString("base64"),
        },
      ]),
      "utf8",
    );
    const meta = decodeInboxBody(
      withFile,
      "application/vnd.regenic.content-parts+json",
      "meta",
    );
    assert.equal(meta.attachments[0].data_base64, undefined);
    assert.equal(meta.attachments[0].filename, "shot.png");
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Buffer.alloc(2_000_000, 1)]);
    const large = Buffer.from(
      JSON.stringify([
        {
          role: "attachment",
          media_type: "application/octet-stream",
          source_filename: "image.png",
          bytes_base64: png.toString("base64"),
        },
      ]),
      "utf8",
    );
    const preview = decodeInboxBody(
      large,
      "application/vnd.regenic.content-parts+json",
      "preview",
    );
    assert.equal(preview.attachments[0].media_type, "image/png");
    assert.equal(preview.attachments[0].data_base64, png.toString("base64"));
  });
});

describe("personal CORS origins", () => {
  it("allows file, null, and loopback, and rejects public sites", () => {
    assert.equal(isAllowedPersonalCorsOrigin("null"), true);
    assert.equal(isAllowedPersonalCorsOrigin("file:///Users/local/index.html"), true);
    assert.equal(isAllowedPersonalCorsOrigin("http://localhost:5173"), true);
    assert.equal(isAllowedPersonalCorsOrigin("http://127.0.0.1:4370"), true);
    assert.equal(isAllowedPersonalCorsOrigin("https://example.com"), false);
    assert.equal(isAllowedPersonalCorsOrigin("http://127.0.0.1.evil.com"), false);
    assert.equal(isAllowedPersonalCorsOrigin("http://user@127.0.0.1"), false);
  });
});
