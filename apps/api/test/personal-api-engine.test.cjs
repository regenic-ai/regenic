const assert = require("node:assert/strict");
const { createServer } = require("node:http");
const { join } = require("node:path");
const { describe, it } = require("node:test");
const {
  createRoot,
  ingestActionable,
  startPersonalApi,
} = require("./personal-api-harness.cjs");
const { SqliteAuthorityStore } = require("@regenic/authority-store/sqlite");
const {
  PUSH_BACKPRESSURE_PREF_KEY,
} = require("../dist/personal-push-backpressure");

describe("personal /v1/me", { concurrency: 1 }, () => {
  it("includes durable push activity in the main engine view", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    await ingestActionable(database, blobRoot);
    const authority = new SqliteAuthorityStore(database);
    await authority.createInstallation({
      id: "dsh-push",
      org_id: "local-owner",
      connector_type: "dsh-session",
      status: "enabled",
      config: { transport: "web", base_url: "http://127.0.0.1:3080" },
      created_at: "2026-11-16T00:00:00.000Z",
    });
    await authority.recordPushWatermark({
      installation_id: "dsh-push",
      stream_key: "session:one",
      watermark: "cursor-1",
      batch_id: "batch-1",
      updated_at: "2026-11-16T00:01:00.000Z",
    });
    const now = new Date().toISOString();
    await authority.putUiPref(
      "local-owner",
      PUSH_BACKPRESSURE_PREF_KEY,
      new Date(Date.now() + 60_000).toISOString(),
      now,
    );
    authority.close();
    const { app, origin } = await startPersonalApi(database, blobRoot, {
      REGENIC_CONNECTOR_MARKET_INDEX_URL: "off",
    });
    try {
      const engine = await (await fetch(`${origin}/v1/me/engine`)).json();
      const installation = engine.installations.find(
        (item) => item.id === "dsh-push",
      );
      assert.equal(
        installation.last_push_at,
        "2026-11-16T00:01:00.000Z",
      );
      assert.equal(engine.sync_readiness.throttle_reason, "throttled");
    } finally {
      await app.close();
    }
  });

  it("reports engine status without connector credentials", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    await ingestActionable(database, blobRoot);
    const { app, origin } = await startPersonalApi(database, blobRoot, {
      REGENIC_CONNECTOR_MARKET_INDEX_URL: "off",
    });
    try {
      const engine = await (await fetch(`${origin}/v1/me/engine`)).json();
      const market = await (
        await fetch(`${origin}/v1/me/connector-market`)
      ).json();
      const health = await (await fetch(`${origin}/health`)).json();

      assert.deepEqual(market, {
        configured: false,
        title: null,
        connectors: [],
      });
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
      assert.equal(engine.installations[0].label, "slack-1");
      assert.equal(engine.installations[0].syncable, false);
      assert.equal(engine.installations[0].can_reply, false);
      assert.equal(engine.installations[0].can_create, false);
      assert.equal(engine.installations[0].last_attempt, null);
      assert.equal(engine.catalog.length, 4);
      const legacySync = await fetch(`${origin}/v1/me/connectors/slack-1/sync`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      assert.equal(legacySync.status, 409);
      assert.equal((await legacySync.json()).error.code, "unsupported_connector");
      assert.equal(engine.catalog[0].connector_type, "dsh-session");
      assert.equal(engine.catalog[0].installed, false);
      assert.equal(engine.catalog[0].fields[1].key, "session_id");
      assert.equal(engine.catalog[0].fields[1].required, false);
      assert.equal(engine.catalog[1].connector_type, "feishu-chat");
      assert.equal(engine.catalog[1].installed, false);
      assert.equal(engine.catalog[1].fields[0].key, "sync_mode");
      assert.equal(engine.catalog[1].fields[1].key, "selection");
      assert.equal(engine.catalog[1].fields[2].key, "kinds");
      assert.deepEqual(engine.catalog[1].fields[2].default, ["group", "p2p"]);
      assert.equal(engine.catalog[1].fields[3].key, "chat_ids");
      assert.equal(engine.catalog[1].fields[3].multiple, true);
      assert.equal(engine.catalog[1].prerequisites[0].key, "lark-cli");
      assert.equal(engine.catalog[2].connector_type, "cursor-agent");
      assert.equal(engine.catalog[2].installed, false);
      assert.equal(engine.catalog[2].fields[0].key, "api_key");
      assert.equal(engine.catalog[2].fields[0].secret, true);
      assert.equal(engine.catalog[2].fields[1].key, "model");
      assert.equal(engine.catalog[2].fields[1].default, "composer-2.5");
      assert.equal(engine.catalog[2].fields[1].options[0].value, "composer-2.5");
      assert.equal(engine.catalog[2].prerequisites[0].key, "CURSOR_API_KEY");
      assert.equal(engine.catalog[2].prerequisites[0].required, false);
      assert.equal(engine.catalog[3].connector_type, "server-app");
      assert.equal(engine.catalog[3].installed, false);
      assert.equal(engine.catalog[3].fields[0].key, "base_url");
      assert.equal(engine.catalog[3].fields[0].required, true);
      assert.equal(engine.catalog[3].fields[1].key, "token");
      assert.equal(engine.catalog[3].fields[1].secret, true);
      assert.equal(engine.catalog[0].import_files, undefined);
      assert.equal(engine.catalog[0].singleton, false);
      const firstParty = engine.plugins.filter((item) => item.origin === "first_party");
      assert.equal(firstParty.length, 4);
      assert.ok(firstParty.every((item) => item.trust === "core" && item.status === "loaded"));
      assert.equal(typeof engine.plugin_dir, "string");
      const listed = await (await fetch(`${origin}/v1/me/plugins`)).json();
      assert.deepEqual(
        listed.map((item) => item.id),
        engine.plugins.map((item) => item.id),
      );
      assert.equal(
        engine.catalog.some((item) => item.connector_type.startsWith("crm-")),
        false,
      );
      assert.equal(engine.installations[0].settings.channel_id, "C123");
      assert.equal(JSON.stringify(engine).includes("xoxb"), false);
      assert.equal(JSON.stringify(engine).includes("credentials_ref"), false);
      assert.equal(JSON.stringify(engine).includes("access_token"), false);
      assert.equal(health.mode, "personal");
      assert.equal(health.sqlite, "up");
      assert.equal(health.authority, "authority-sqlite");
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
      assert.equal(health.authority, "authority-sqlite");
      assert.equal(health.status, "ok");
      assert.equal(health.dsh, undefined);
    } finally {
      await app.close();
      hanging.close();
    }
  });
});
