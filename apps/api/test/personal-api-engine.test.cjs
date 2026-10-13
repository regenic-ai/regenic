const assert = require("node:assert/strict");
const { createServer } = require("node:http");
const { join } = require("node:path");
const { describe, it } = require("node:test");
const {
  createRoot,
  ingestActionable,
  startPersonalApi,
} = require("./personal-api-harness.cjs");

describe("personal /v1/me", { concurrency: 1 }, () => {
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
      assert.equal(engine.catalog.length, 5);
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
      assert.equal(engine.catalog[2].fields[0].key, "sync_mode");
      assert.equal(engine.catalog[2].fields[1].key, "selection");
      assert.equal(engine.catalog[2].fields[2].key, "kinds");
      assert.equal(engine.catalog[2].fields[2].default, "group,p2p");
      assert.equal(engine.catalog[2].fields[3].key, "chat_ids");
      assert.equal(engine.catalog[2].fields[3].multiple, true);
      assert.equal(engine.catalog[2].prerequisites[0].key, "lark-cli");
      assert.equal(engine.catalog[3].connector_type, "cursor-agent");
      assert.equal(engine.catalog[3].installed, false);
      assert.equal(engine.catalog[3].fields[0].key, "api_key");
      assert.equal(engine.catalog[3].fields[0].secret, true);
      assert.equal(engine.catalog[3].fields[1].key, "model");
      assert.equal(engine.catalog[3].fields[1].default, "composer-2.5");
      assert.equal(engine.catalog[3].fields[1].options[0].value, "composer-2.5");
      assert.equal(engine.catalog[3].prerequisites[0].key, "CURSOR_API_KEY");
      assert.equal(engine.catalog[3].prerequisites[0].required, false);
      assert.equal(engine.catalog[4].connector_type, "whatsapp-web-live");
      assert.equal(engine.catalog[4].installed, false);
      assert.equal(engine.catalog[4].singleton, true);
      assert.equal(engine.catalog[4].setup_ready, true);
      assert.deepEqual(engine.catalog[4].prerequisites, []);
      assert.match(engine.catalog[4].credential_hint, /Pairing code/);
      assert.equal(engine.catalog[4].setup_steps[0].title, "Install this connector");
      assert.equal(engine.catalog[4].import_files.accept.includes(".csv"), true);
      assert.equal(engine.catalog[4].import_files.max_bytes, 20 * 1024 * 1024);
      assert.equal(engine.catalog[0].import_files, undefined);
      assert.equal(engine.catalog[0].singleton, false);
      const firstParty = engine.plugins.filter((item) => item.origin === "first_party");
      assert.equal(firstParty.length, 5);
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
