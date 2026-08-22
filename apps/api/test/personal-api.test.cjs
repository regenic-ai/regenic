const assert = require("node:assert/strict");
const { createServer } = require("node:http");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { afterEach, describe, it } = require("node:test");
const { createHttpApp } = require("../dist/http-app");
const { SqliteAuthorityStore } = require("@regenic/authority-store");
const { FsBlobStore } = require("@regenic/blob-store");
const { INGEST_SCHEMA_VERSION, IngestionService, channelRecord } = require("@regenic/domain");
const { isAllowedPersonalCorsOrigin } = require("@regenic/config");
const { decodeBodyText } = require("../dist/inbox-body");

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
  const echoes = new Map();
  const extras = new Map();
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
      if (url.includes("session.list")) {
        response.end(
          JSON.stringify({
            type: "server-response",
            rpcId: body.rpcId,
            result: {
              ok: true,
              value: {
                items: [{ sessionId: "sess-a" }, { sessionId: "sess-b" }],
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
  await app.listen(0, "127.0.0.1");
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
      assert.equal(engine.pull.interval_ms, 0);
      assert.equal(engine.installations[0].id, "slack-1");
      assert.equal(engine.installations[0].connector_type, "slack-channel");
      assert.equal(engine.installations[0].label, "C123");
      assert.equal(engine.installations[0].syncable, true);
      assert.equal(engine.installations[0].last_attempt, null);
      assert.equal(engine.catalog.length, 2);
      assert.equal(engine.catalog[0].connector_type, "slack-channel");
      assert.equal(engine.catalog[0].installed, true);
      assert.equal(engine.catalog[0].prerequisites[0].key, "REGENIC_SLACK_TOKEN");
      assert.equal(engine.catalog[0].prerequisites[0].ready, false);
      assert.equal(engine.catalog[1].connector_type, "dsh-session");
      assert.equal(engine.catalog[1].installed, false);
      assert.equal(engine.catalog[1].fields[1].key, "session_id");
      assert.equal(engine.catalog[1].fields[1].required, false);
      assert.equal(JSON.stringify(engine).includes("xoxb"), false);
      assert.equal(JSON.stringify(engine).includes("credentials_ref"), false);
      assert.equal(JSON.stringify(engine).includes("access_token"), false);
      assert.equal(health.mode, "personal");
      assert.equal(health.sqlite, "up");
      assert.equal(health.status, "ok");
      assert.equal(health.postgres, undefined);
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

      const inbox = await (await fetch(`${origin}/v1/me/inbox`)).json();
      const slackItem = inbox.find(
        (item) => item.event.external_id === "C123:1710000000.000100",
      );
      assert.equal(Boolean(slackItem), true);
      assert.equal(slackItem.can_send, false);

      const synced = await fetch(`${origin}/v1/me/connectors/slack-1/sync`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const body = await synced.json();
      assert.equal(synced.status, 201);
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

      const engine = await (await fetch(`${origin}/v1/me/engine`)).json();
      assert.equal(
        engine.catalog.find((item) => item.connector_type === "dsh-session")
          .installed,
        true,
      );

      const removed = await fetch(
        `${origin}/v1/me/connectors/${installation.id}`,
        { method: "DELETE" },
      );
      assert.equal(removed.status, 200);
      const after = await (await fetch(`${origin}/v1/me/engine`)).json();
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

      const inbox = await (await fetch(`${origin}/v1/me/inbox`)).json();
      const sessionA = inbox.find((item) => item.event.external_id === "sess-a:1");
      const sessionB = inbox.find((item) => item.event.external_id === "sess-b:1");
      assert.equal(Boolean(sessionA), true);
      assert.equal(Boolean(sessionB), true);
      assert.equal(sessionA.can_send, true);
      assert.equal(sessionB.can_send, true);

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
