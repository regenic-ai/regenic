const assert = require("node:assert/strict");
const { createServer } = require("node:http");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { afterEach, describe, it } = require("node:test");
const { NestFactory } = require("@nestjs/core");
const { SqliteAuthorityStore } = require("@regenic/authority-store");
const { FsBlobStore } = require("@regenic/blob-store");
const { INGEST_SCHEMA_VERSION, IngestionService } = require("@regenic/domain");
const { isAllowedPersonalCorsOrigin } = require("@regenic/config");
const { AppModule } = require("../dist/app.module");
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

async function startPersonalApi(database, blobRoot, extraEnv = {}) {
  setEnv({
    REGENIC_DATABASE: database,
    REGENIC_BLOB_ROOT: blobRoot,
    REGENIC_ORG: "local-owner",
    PORT: "4370",
    LISTEN_HOST: "127.0.0.1",
    ...extraEnv,
  });
  const app = await NestFactory.create(AppModule, { logger: false });
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
      assert.equal(item.event.id, eventId);
      assert.equal(item.body_text, "Please confirm the release.");
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
      assert.equal(engine.installations[0].id, "slack-1");
      assert.equal(engine.installations[0].connector_type, "slack-channel");
      assert.equal(engine.installations[0].label, "C123");
      assert.equal(engine.installations[0].syncable, true);
      assert.equal(engine.installations[0].last_attempt, null);
      assert.equal(engine.catalog.length, 2);
      assert.equal(engine.catalog[0].connector_type, "slack-channel");
      assert.equal(engine.catalog[0].installed, true);
      assert.equal(engine.catalog[1].connector_type, "dsh-session");
      assert.equal(engine.catalog[1].installed, false);
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

      const synced = await fetch(`${origin}/v1/me/connectors/slack-1/sync`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const body = await synced.json();
      assert.equal(synced.status, 201);
      assert.equal(body.installation_id, "slack-1");
      assert.equal(body.last_run_status, "completed");
      assert.equal(body.accepted_count, 1);
      assert.equal(body.installation.label, "C123");
      assert.equal(JSON.stringify(body).includes("xoxb-test-token"), false);
      assert.equal(JSON.stringify(body).includes("credentials_ref"), false);

      const inbox = await (await fetch(`${origin}/v1/me/inbox`)).json();
      assert.equal(
        inbox.some((item) => item.event.external_id === "C123:1710000000.000100"),
        true,
      );

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
    const app = await NestFactory.create(AppModule, { logger: false });
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
