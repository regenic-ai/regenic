const assert = require("node:assert/strict");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { afterEach, describe, it } = require("node:test");
const { SqliteAuthorityStore } = require("@regenic/authority-store");
const { runLocalCli } = require("../dist/main");

const roots = [];
const now = () => "2026-08-13T00:00:00.000Z";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

async function createRoot() {
  const root = await mkdtemp(join(tmpdir(), "regenic-local-cli-"));
  roots.push(root);
  return root;
}

async function run(args, options = {}) {
  let output = "";
  await runLocalCli(args, {
    now,
    createId: () => "generated-id",
    stdout: { write(chunk) { output += chunk; return true; } },
    ...options,
  });
  return JSON.parse(output);
}

describe("regenic-local", () => {
  it("installs Slack without persisting its token and reports safe status", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const installation = await run([
      "slack-install", "--database", database, "--org", "local-owner",
      "--channel", "C123", "--channel-name", "engineering", "--id", "slack-1",
    ]);
    const status = await run(["status", "--database", database, "--org", "local-owner"]);

    assert.equal(installation.id, "slack-1");
    assert.deepEqual(installation.config, { channel_id: "C123", channel_name: "engineering" });
    assert.equal(installation.credentials_ref, "env:REGENIC_SLACK_TOKEN");
    assert.equal(JSON.stringify(status).includes("token"), false);
    assert.deepEqual(status[0].attempts, []);
  });

  it("syncs one Slack page using an environment token and records its attempt", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    await run([
      "slack-install", "--database", database, "--org", "local-owner",
      "--channel", "C123", "--id", "slack-1",
    ]);
    const synced = await run([
      "slack-sync", "--database", database, "--blob-root", blobRoot,
      "--installation", "slack-1",
    ], {
      env: { REGENIC_SLACK_TOKEN: "runtime-only-token" },
      async fetch(url, init) {
        assert.match(url, /channel=C123/);
        assert.equal(init.headers.authorization, "Bearer runtime-only-token");
        return {
          ok: true,
          async json() {
            return {
              ok: true,
              messages: [{ ts: "1723420800.000001", user: "U123", text: "Message" }],
              response_metadata: { next_cursor: "cursor-2" },
            };
          },
        };
      },
    });
    const status = await run(["status", "--database", database, "--org", "local-owner"]);

    assert.equal(synced.status, "completed");
    assert.equal(synced.result.records[0].status, "accepted");
    assert.equal(status[0].attempts[0].status, "succeeded");
    assert.equal(JSON.stringify(status).includes("runtime-only-token"), false);
  });

  it("reports quarantine diagnostics without content bodies", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    await run([
      "slack-install", "--database", database, "--org", "local-owner",
      "--channel", "C123", "--id", "slack-1",
    ]);
    const store = new SqliteAuthorityStore(database);
    await store.acquireLease({
      installation_id: "slack-1", stream_key: "channel:C123", lease_owner: "worker-a",
      now: now(), lease_duration_ms: 30_000,
    });
    await store.beginAttempt({
      id: "attempt-1", org_id: "local-owner", connector_installation_id: "slack-1",
      stream_key: "channel:C123", delivery_id: "page-1", started_at: now(),
    });
    await store.settleAttempt({
      attempt_id: "attempt-1", installation_id: "slack-1", stream_key: "channel:C123",
      lease_owner: "worker-a", finished_at: now(), accepted_count: 0, duplicate_count: 0,
      quarantined_count: 1, retryable_failure_count: 0, quarantines: [{
        id: "quarantine-1", record_external_id: "C123:bad", reason_code: "content_unavailable",
        safe_metadata: { source_kind: "message" }, created_at: now(),
      }],
    });
    store.close();

    const quarantines = await run([
      "quarantines", "--database", database, "--installation", "slack-1",
    ]);

    assert.deepEqual(quarantines, [{
      id: "quarantine-1", attempt_id: "attempt-1", connector_installation_id: "slack-1",
      stream_key: "channel:C123", record_external_id: "C123:bad",
      reason_code: "content_unavailable", safe_metadata: { source_kind: "message" },
      created_at: now(),
    }]);
  });
});