const assert = require("node:assert/strict");
const { access } = require("node:fs/promises");
const { mkdir, mkdtemp, readFile, rm, writeFile } = require("node:fs/promises");
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

  it("manages connector status and resets a committed cursor within its organization", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    await run([
      "slack-install", "--database", database, "--org", "local-owner",
      "--channel", "C123", "--id", "slack-1",
    ]);
    await run([
      "slack-sync", "--database", database, "--blob-root", blobRoot,
      "--installation", "slack-1",
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
    const disabled = await run([
      "connector-disable", "--database", database, "--org", "local-owner",
      "--installation", "slack-1",
    ]);
    await assert.rejects(
      () => run([
        "slack-sync", "--database", database, "--blob-root", blobRoot,
        "--installation", "slack-1",
      ], {
        env: { REGENIC_SLACK_TOKEN: "runtime-only-token" },
        async fetch() {
          throw new Error("disabled connector must not poll Slack");
        },
      }),
      /Slack installation is disabled/,
    );
    const enabled = await run([
      "connector-enable", "--database", database, "--org", "local-owner",
      "--installation", "slack-1",
    ]);
    const reset = await run([
      "reset-cursor", "--database", database, "--org", "local-owner",
      "--installation", "slack-1", "--stream", "channel:C123",
    ]);

    assert.equal(disabled.status, "disabled");
    assert.equal(enabled.status, "enabled");
    assert.equal(reset.cursor, undefined);
    assert.equal(reset.cursor_version, 3);
  });

  it("reports quarantine diagnostics without content bodies", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    const digestOutput = join(root, "digest.md");
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
    const rendered = await run([
      "render-digest", "--database", database, "--blob-root", blobRoot,
      "--org", "local-owner", "--output", digestOutput,
    ]);
    const digest = await readFile(digestOutput, "utf8");

    assert.deepEqual(quarantines, [{
      id: "quarantine-1", attempt_id: "attempt-1", connector_installation_id: "slack-1",
      stream_key: "channel:C123", record_external_id: "C123:bad",
      reason_code: "content_unavailable", safe_metadata: { source_kind: "message" },
      created_at: now(),
    }]);
    assert.equal(rendered.open_quarantine_count, 1);
    assert.match(digest, /## Quarantines/);
    assert.match(digest, /content_unavailable/);
    assert.match(digest, /C123:bad/);
    assert.equal(digest.includes("source_kind"), false);
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

  it("imports an explicit WhatsApp Personal Export v1 file without browser credentials", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    const file = join(root, "whatsapp.jsonl");
    await writeFile(file, JSON.stringify({
      schema_version: "1.0",
      kind: "whatsapp_personal_message",
      message_id: "message-1",
      chat_id: "chat-1",
      sender_id: "15550001",
      direction: "incoming",
      sent_at: "2026-08-21T00:00:00.000Z",
      text: "Please confirm the plan.",
    }));

    const imported = await run([
      "whatsapp-import", "--database", database, "--blob-root", blobRoot,
      "--file", file, "--org", "local-owner", "--local-principal", "local-user",
    ]);

    assert.equal(imported.batches[0].records[0].status, "accepted");
    assert.deepEqual(imported.errors, []);
  });

  it("lists only current-work messages in the inbox", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    const file = join(root, "messages.jsonl");
    const mapping = join(root, "mapping.json");
    await writeFile(file, [
      '{"id":"ask-1","timestamp":"2026-08-12T23:00:00.000Z","body":"Please confirm the release."}',
      '{"id":"ack-1","timestamp":"2026-08-12T23:01:00.000Z","body":"ok"}',
    ].join("\n"));
    await writeFile(mapping, JSON.stringify({
      mapping: { external_id: "id", occurred_at: "timestamp", text: "body" },
      defaults: { actor_id: "local-owner", scope_id: "personal", type: "text" },
    }));
    await run([
      "import-file", "--database", database, "--blob-root", blobRoot,
      "--file", file, "--mapping", mapping, "--format", "jsonl",
      "--org", "local-owner", "--source", "fixture-jsonl",
    ]);

    const inbox = await run(["inbox", "--database", database, "--org", "local-owner"]);

    assert.equal(inbox.length, 1);
    assert.equal(inbox[0].event.external_id, "ask-1");
    assert.equal(inbox[0].decision.disposition, "current_work");
    assert.deepEqual(inbox[0].decision.reason_codes, ["actionable"]);
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

  it("publishes a bounded evidence bundle without Blob bodies", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    const file = join(root, "messages.jsonl");
    const mapping = join(root, "mapping.json");
    const output = join(root, "bundles.jsonl");
    await writeFile(file, [
      '{"id":"message-1","timestamp":"2026-08-12T23:00:00.000Z","body":"Private body"}',
      '{"id":"message-2","timestamp":"2026-08-12T23:01:00.000Z","body":"Second body"}',
    ].join("\n"));
    await writeFile(mapping, JSON.stringify({
      mapping: { external_id: "id", occurred_at: "timestamp", text: "body" },
      defaults: { actor_id: "local-owner", scope_id: "personal", type: "text" },
    }));
    await run([
      "import-file", "--database", database, "--blob-root", blobRoot,
      "--file", file, "--mapping", mapping, "--format", "jsonl",
      "--org", "local-owner", "--source", "fixture-jsonl",
    ]);

    const published = await run([
      "publish-evidence-bundle", "--database", database, "--org", "local-owner",
      "--consumer", "teamily-workspace", "--purpose", "research-context",
      "--max-events", "1", "--output", output,
    ]);
    const bundle = JSON.parse((await readFile(output, "utf8")).trim());

    assert.equal(published.published_event_count, 1);
    assert.equal(bundle.consumer_id, "teamily-workspace");
    assert.equal(bundle.purpose, "research-context");
    assert.equal(bundle.evidence[0].external_id, "message-2");
    assert.match(bundle.evidence[0].content_hash, /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(bundle).includes("Private body"), false);
    assert.equal(JSON.stringify(bundle).includes("Second body"), false);
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
    assert.match(digest, /## Processing Status/);
    assert.match(digest, /Events: 1/);
    assert.match(digest, /Creates: 1/);
    assert.match(digest, /Open quarantines: 0/);
    assert.match(digest, /## 2026-08-12/);
    assert.match(digest, /Digest body/);
    assert.match(digest, /Event: `[-a-f0-9]+`/);
    assert.match(digest, /Blob: `[a-f0-9]{64}`/);
  });

  it("installs DSH without persisting a token and reports safe status", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const installation = await run([
      "dsh-install", "--database", database, "--org", "local-owner",
      "--transport", "cli", "--mailbox", "dsh-main", "--id", "dsh-1",
    ]);
    const status = await run(["status", "--database", database, "--org", "local-owner"]);

    assert.equal(installation.id, "dsh-1");
    assert.deepEqual(installation.config, {
      transport: "cli",
      mailbox: "dsh-main",
      command: "dsh",
      profile: "headless",
      run_log: join(root, "dsh-runs", "dsh-1.jsonl"),
    });
    assert.equal(installation.credentials_ref, undefined);
    assert.equal(JSON.stringify(status).includes("token"), false);
  });

  it("syncs journaled DSH CLI runs without starting dsh web", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    await run([
      "dsh-install", "--database", database, "--org", "local-owner",
      "--transport", "cli", "--mailbox", "dsh-main", "--id", "dsh-1",
    ]);
    const runLog = join(root, "dsh-runs", "dsh-1.jsonl");
    await mkdir(join(root, "dsh-runs"), { recursive: true });
    await writeFile(runLog, `${JSON.stringify({
      run_id: "run-1",
      seq: 0,
      task: "Hello",
      stdout: "Hi",
      started_at: "2026-08-21T00:00:00.000Z",
      finished_at: "2026-08-21T00:00:01.000Z",
    })}\n`);
    const synced = await run([
      "dsh-sync", "--database", database, "--blob-root", blobRoot,
      "--installation", "dsh-1",
    ]);
    const status = await run(["status", "--database", database, "--org", "local-owner"]);

    assert.equal(synced.pages_attempted, 1);
    assert.equal(synced.runs[0].status, "completed");
    assert.equal(synced.runs[0].result.records[0].status, "accepted");
    assert.equal(status[0].attempts[0].status, "succeeded");
  });

  it("sends a DSH prompt through the headless CLI", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    await run([
      "dsh-install", "--database", database, "--org", "local-owner",
      "--transport", "cli", "--mailbox", "dsh-main", "--id", "dsh-1",
    ]);
    const calls = [];
    const sent = await run([
      "dsh-send", "--database", database, "--installation", "dsh-1",
      "--text", "Follow up",
    ], {
      async spawn(input) {
        calls.push(input.command);
        return { stdout: "On it", stderr: "", exit_code: 0 };
      },
    });

    assert.deepEqual(calls, [["dsh", "--profile", "headless", "Follow up"]]);
    assert.equal(sent.accepted, true);
    assert.equal(typeof sent.rpc_id, "string");
  });

  it("installs and syncs DSH through web HTTP when transport is web", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    const installation = await run([
      "dsh-install", "--database", database, "--org", "local-owner",
      "--transport", "web", "--session", "sess-1", "--id", "dsh-1",
    ]);
    const synced = await run([
      "dsh-sync", "--database", database, "--blob-root", blobRoot,
      "--installation", "dsh-1",
    ], {
      async fetch(url, init) {
        assert.equal(url, "http://127.0.0.1:3080/api/session.history");
        const body = JSON.parse(init.body);
        assert.equal(body.payload.sessionId, "sess-1");
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              type: "server-response",
              rpcId: body.rpcId,
              result: {
                ok: true,
                value: {
                  hasMore: false,
                  events: [{
                    type: "user/message",
                    seq: 2,
                    time: 1_724_208_000_000,
                    data: {
                      content: [{ type: "text", text: "Hello" }],
                      source: { kind: "user" },
                    },
                  }],
                },
              },
            };
          },
        };
      },
    });

    assert.deepEqual(installation.config, {
      transport: "web",
      session_id: "sess-1",
      base_url: "http://127.0.0.1:3080",
    });
    assert.equal(synced.runs[0].status, "completed");
    assert.equal(synced.runs[0].result.records[0].status, "accepted");
  });

  it("resolves relative --database against INIT_CWD", async () => {
    const root = await createRoot();
    const previous = process.env.INIT_CWD;
    process.env.INIT_CWD = root;
    try {
      const installation = await run([
        "dsh-install", "--database", "from-shell.db", "--org", "local-owner",
        "--transport", "cli", "--id", "dsh-cwd",
      ]);
      assert.equal(installation.config.run_log, join(root, "dsh-runs", "dsh-cwd.jsonl"));
      await access(join(root, "from-shell.db"));
    } finally {
      if (previous === undefined) {
        delete process.env.INIT_CWD;
      } else {
        process.env.INIT_CWD = previous;
      }
    }
  });
});