const assert = require("node:assert/strict");
const { mkdtemp, readFile, rm, writeFile } = require("node:fs/promises");
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

    assert.equal(synced.pages_attempted, 1);
    assert.equal(synced.runs[0].status, "completed");
    assert.equal(synced.runs[0].result.records[0].status, "accepted");
    assert.equal(status[0].attempts[0].status, "succeeded");
    assert.equal(JSON.stringify(status).includes("runtime-only-token"), false);
  });

  it("syncs bounded Slack pages until the remote cursor is exhausted", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    await run([
      "slack-install", "--database", database, "--org", "local-owner",
      "--channel", "C123", "--id", "slack-1",
    ]);
    const cursors = [];
    const synced = await run([
      "slack-sync", "--database", database, "--blob-root", blobRoot,
      "--installation", "slack-1", "--max-pages", "3",
    ], {
      env: { REGENIC_SLACK_TOKEN: "runtime-only-token" },
      async fetch(url) {
        const cursor = new URL(url).searchParams.get("cursor");
        cursors.push(cursor);
        return {
          ok: true,
          async json() {
            return cursor
              ? {
                  ok: true,
                  messages: [{ ts: "1723420860.000001", user: "U123", text: "Second" }],
                  response_metadata: {},
                }
              : {
                  ok: true,
                  messages: [{ ts: "1723420800.000001", user: "U123", text: "First" }],
                  response_metadata: { next_cursor: "cursor-2" },
                };
          },
        };
      },
    });
    const status = await run(["status", "--database", database, "--org", "local-owner"]);

    assert.deepEqual(cursors, [null, "cursor-2"]);
    assert.equal(synced.pages_attempted, 2);
    assert.equal(synced.stopped_at_page_limit, false);
    assert.deepEqual(status[0].attempts.map((attempt) => attempt.status), ["succeeded", "succeeded"]);
  });

  it("stops at the configured Slack page limit", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    await run([
      "slack-install", "--database", database, "--org", "local-owner",
      "--channel", "C123", "--id", "slack-1",
    ]);
    const synced = await run([
      "slack-sync", "--database", database, "--blob-root", blobRoot,
      "--installation", "slack-1", "--max-pages", "1",
    ], {
      env: { REGENIC_SLACK_TOKEN: "runtime-only-token" },
      async fetch() {
        return {
          ok: true,
          async json() {
            return {
              ok: true,
              messages: [{ ts: "1723420800.000001", user: "U123", text: "First" }],
              response_metadata: { next_cursor: "cursor-2" },
            };
          },
        };
      },
    });

    assert.equal(synced.pages_attempted, 1);
    assert.equal(synced.stopped_at_page_limit, true);
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

  it("imports valid CSV rows, isolates invalid rows, and converges on replay", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    const file = join(root, "messages.csv");
    const mapping = join(root, "mapping.json");
    await writeFile(file, [
      "id,timestamp,body,author",
      "message-1,2026-08-12T23:00:00.000Z,First,U123",
      "message-2,not-a-timestamp,Bad,U456",
    ].join("\n"));
    await writeFile(mapping, JSON.stringify({
      mapping: { external_id: "id", occurred_at: "timestamp", text: "body", actor_id: "author" },
      defaults: { actor_id: "local-owner", scope_id: "personal", type: "text" },
    }));
    const args = [
      "import-file", "--database", database, "--blob-root", blobRoot,
      "--file", file, "--mapping", mapping, "--format", "csv",
      "--org", "local-owner", "--source", "fixture-csv",
    ];

    const first = await run(args);
    const replay = await run(args);

    assert.equal(first.batches[0].records[0].status, "accepted");
    assert.equal(replay.batches[0].records[0].status, "duplicate");
    assert.deepEqual(first.errors, [{
      line: 3, code: "invalid_row", message: "Invalid datetime",
    }]);
  });

  it("imports JSONL through the same explicit mapping contract", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    const file = join(root, "messages.jsonl");
    const mapping = join(root, "mapping.json");
    await writeFile(file, '{"id":"message-1","timestamp":"2026-08-12T23:00:00.000Z","body":"First"}\n');
    await writeFile(mapping, JSON.stringify({
      mapping: { external_id: "id", occurred_at: "timestamp", text: "body" },
      defaults: { actor_id: "local-owner", scope_id: "personal", type: "text" },
    }));

    const imported = await run([
      "import-file", "--database", database, "--blob-root", blobRoot,
      "--file", file, "--mapping", mapping, "--format", "jsonl",
      "--org", "local-owner", "--source", "fixture-jsonl",
    ]);

    assert.equal(imported.batches[0].records[0].status, "accepted");
    assert.deepEqual(imported.errors, []);
  });

  it("exports append-only Event metadata as JSONL without content bodies", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    const file = join(root, "messages.jsonl");
    const mapping = join(root, "mapping.json");
    const output = join(root, "events.jsonl");
    await writeFile(file, '{"id":"message-1","timestamp":"2026-08-12T23:00:00.000Z","body":"Private body"}\n');
    await writeFile(mapping, JSON.stringify({
      mapping: { external_id: "id", occurred_at: "timestamp", text: "body" },
      defaults: { actor_id: "local-owner", scope_id: "personal", type: "text" },
    }));
    await run([
      "import-file", "--database", database, "--blob-root", blobRoot,
      "--file", file, "--mapping", mapping, "--format", "jsonl",
      "--org", "local-owner", "--source", "fixture-jsonl",
    ]);

    const exported = await run([
      "export-jsonl", "--database", database, "--org", "local-owner", "--output", output,
    ]);
    const line = JSON.parse((await readFile(output, "utf8")).trim());

    assert.equal(exported.exported_event_count, 1);
    assert.equal(line.schema_version, "1.0");
    assert.equal(line.kind, "event");
    assert.equal(line.event.external_id, "message-1");
    assert.match(line.event.content_hash, /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(line).includes("Private body"), false);
  });

  it("renders a Markdown digest with Event and Blob evidence", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    const file = join(root, "messages.jsonl");
    const mapping = join(root, "mapping.json");
    const output = join(root, "digest.md");
    await writeFile(file, '{"id":"message-1","timestamp":"2026-08-12T23:00:00.000Z","body":"Digest body"}\n');
    await writeFile(mapping, JSON.stringify({
      mapping: { external_id: "id", occurred_at: "timestamp", text: "body" },
      defaults: { actor_id: "local-owner", scope_id: "personal", type: "text" },
    }));
    await run([
      "import-file", "--database", database, "--blob-root", blobRoot,
      "--file", file, "--mapping", mapping, "--format", "jsonl",
      "--org", "local-owner", "--source", "fixture-jsonl",
    ]);

    const rendered = await run([
      "render-digest", "--database", database, "--blob-root", blobRoot,
      "--org", "local-owner", "--output", output,
    ]);
    const digest = await readFile(output, "utf8");

    assert.equal(rendered.rendered_event_count, 1);
    assert.match(digest, /# Regenic Digest/);
    assert.match(digest, /## 2026-08-12/);
    assert.match(digest, /Digest body/);
    assert.match(digest, /Event: `[-a-f0-9]+`/);
    assert.match(digest, /Blob: `[a-f0-9]{64}`/);
  });
});