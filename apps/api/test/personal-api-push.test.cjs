const assert = require("node:assert/strict");
const { join } = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { describe, it } = require("node:test");
const {
  PERSONAL_API_KEY,
  createRoot,
  startPersonalApi,
} = require("./personal-api-harness.cjs");

const PLUGIN = join(__dirname, "fixtures/extra-push-driver");
const owner = { "x-regenic-personal-key": PERSONAL_API_KEY };

function event(externalId, source = "pushed") {
  return {
    operation: "create",
    source,
    external_id: externalId,
    occurred_at: "2026-11-16T00:00:00.000Z",
    actor: { id: "peer" },
    scope: { id: "room-1" },
    type: "message",
    content: [{ role: "body", media_type: "text/plain", text: `hello ${externalId}` }],
  };
}

async function call(origin, path, { method = "GET", headers = {}, body } = {}) {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null };
}

async function install(origin, connectorType) {
  const created = await call(origin, "/v1/me/connectors", {
    method: "POST",
    headers: owner,
    body: { connector_type: connectorType, config: {} },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.id;
}

describe("personal connector push ingest", { concurrency: 1 }, () => {
  it("acks persisted pushes, dedupes replays, and scopes ingest tokens to one installation", async () => {
    const root = await createRoot();
    const { app, origin } = await startPersonalApi(join(root, "authority.db"), join(root, "blobs"), {
      LISTEN_HOST: "0.0.0.0",
      REGENIC_PERSONAL_API: "1",
      REGENIC_CHANNEL_PLUGIN: PLUGIN,
    });
    try {
      const pushId = await install(origin, "extra-push");
      const silentId = await install(origin, "extra-silent");

      const minted = await call(origin, `/v1/me/connectors/${pushId}/ingest-token`, {
        method: "POST",
        headers: owner,
      });
      assert.equal(minted.status, 200, JSON.stringify(minted.body));
      assert.equal(minted.body.header, "x-regenic-ingest-token");
      const connector = { "x-regenic-ingest-token": minted.body.token };

      const batch = {
        stream_key: "room-1",
        batch_id: "b-1",
        events: [event("m-1"), event("m-2")],
        watermark: "cursor-2",
      };
      const first = await call(origin, `/v1/me/connectors/${pushId}/ingest`, {
        method: "POST",
        headers: connector,
        body: batch,
      });
      assert.equal(first.status, 200, JSON.stringify(first.body));
      assert.equal(first.body.accepted_count, 2);
      assert.equal(first.body.watermark, "cursor-2");

      const replay = await call(origin, `/v1/me/connectors/${pushId}/ingest`, {
        method: "POST",
        headers: connector,
        body: batch,
      });
      assert.equal(replay.body.duplicate_count, 2);
      assert.equal(replay.body.accepted_count, 0);

      const foreign = await call(origin, `/v1/me/connectors/${pushId}/ingest`, {
        method: "POST",
        headers: connector,
        body: { stream_key: "room-1", events: [event("m-3", "silent")] },
      });
      assert.equal(foreign.status, 403);
      assert.equal(foreign.body.error.code, "connector_mismatch");

      const invalid = await call(origin, `/v1/me/connectors/${pushId}/ingest`, {
        method: "POST",
        headers: connector,
        body: { stream_key: "room-1", events: [] },
      });
      assert.equal(invalid.status, 400);
      assert.equal(invalid.body.error.code, "invalid_envelope");

      const otherInstall = await call(origin, `/v1/me/connectors/${silentId}/ingest`, {
        method: "POST",
        headers: connector,
        body: { stream_key: "room-1", events: [event("m-4", "silent")] },
      });
      assert.equal(otherInstall.status, 401, "a token cannot reach another installation");
      assert.equal((await call(origin, "/v1/me/inbox", { headers: connector })).status, 401);
      assert.equal(
        (await call(origin, `/v1/me/connectors/${pushId}/ingest-token`, {
          method: "POST",
          headers: connector,
        })).status,
        401,
        "a token cannot mint tokens",
      );

      const undeclared = await call(origin, `/v1/me/connectors/${silentId}/ingest`, {
        method: "POST",
        headers: owner,
        body: { stream_key: "room-1", events: [event("m-5", "silent")] },
      });
      assert.equal(undeclared.status, 501);

      const watermarks = await call(origin, `/v1/me/connectors/${pushId}/watermarks`, {
        headers: connector,
      });
      assert.equal(watermarks.status, 200, JSON.stringify(watermarks.body));
      assert.deepEqual(
        watermarks.body.watermarks.map((item) => [item.stream_key, item.watermark]),
        [["room-1", "cursor-2"]],
      );
      const summary = await call(origin, `/v1/me/connectors/${pushId}/watermarks/summary`, {
        headers: connector,
      });
      assert.equal(summary.body.stream_count, 1);
      assert.equal(
        (await call(origin, `/v1/me/connectors/${silentId}/watermarks`, {
          headers: connector,
        })).status,
        401,
      );
    } finally {
      await app.close();
    }
  });

  it("exposes ingest stats and reconciles missing push watermarks", async () => {
    const root = await createRoot();
    const { app, origin } = await startPersonalApi(join(root, "authority.db"), join(root, "blobs"), {
      REGENIC_CHANNEL_PLUGIN: PLUGIN,
      REGENIC_PUSH_RECONCILE_MS: "0",
    });
    try {
      const pushId = await install(origin, "extra-reconcile");
      // Install catchUp may already have reconciled; wait it out, then force again.
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const page = await call(origin, `/v1/me/connectors/${pushId}/watermarks`);
        if (page.body?.watermarks?.some((row) => row.stream_key === "chat-gap")) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const minted = await call(origin, `/v1/me/connectors/${pushId}/ingest-token`, {
        method: "POST",
      });
      const connector = { "x-regenic-ingest-token": minted.body.token };
      const afterCatchUp = await call(origin, `/v1/me/connectors/${pushId}/ingest-stats`, {
        headers: connector,
      });
      assert.equal(afterCatchUp.status, 200, JSON.stringify(afterCatchUp.body));
      assert.ok(afterCatchUp.body.acked_batches >= 1);
      assert.equal(afterCatchUp.body.stream_count, 1);

      const reconciled = await call(origin, `/v1/me/connectors/${pushId}/reconcile-push`, {
        method: "POST",
      });
      assert.equal(reconciled.status, 200, JSON.stringify(reconciled.body));
      assert.equal(reconciled.body.repushed_batches, 0);

      const watermarks = await call(origin, `/v1/me/connectors/${pushId}/watermarks`, {
        headers: connector,
      });
      assert.deepEqual(
        watermarks.body.watermarks.map((item) => [item.stream_key, item.watermark]),
        [["chat-gap", "gap-w1"]],
      );
      const stats = await call(origin, `/v1/me/connectors/${pushId}/ingest-stats`, {
        headers: connector,
      });
      assert.ok(stats.body.last_ack_at);
      assert.equal(typeof stats.body.lag_ms, "number");
      assert.equal(typeof stats.body.watermark_age_ms, "number");
      assert.equal(stats.body.reconcile.status, "ok");
      assert.equal(stats.body.queued, 0);
    } finally {
      await app.close();
    }
  });

  it("opens history backfill on the first hybrid push and leaves a later push in place", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const { app, origin } = await startPersonalApi(database, join(root, "blobs"), {
      REGENIC_CHANNEL_PLUGIN: PLUGIN,
      REGENIC_BOOTSTRAP_PULL_MS: "0",
      REGENIC_CATALOG_PULL_MS: "0",
      REGENIC_PUSH_RECONCILE_MS: "0",
    });
    let pushId;
    try {
      pushId = await install(origin, "extra-hybrid");
      const minted = await call(origin, `/v1/me/connectors/${pushId}/ingest-token`, {
        method: "POST",
      });
      const connector = { "x-regenic-ingest-token": minted.body.token };
      const pushed = await call(origin, `/v1/me/connectors/${pushId}/ingest`, {
        method: "POST",
        headers: connector,
        body: {
          stream_key: "room-9",
          events: [event("h-1", "hybrid-pushed")],
          watermark: "h-1",
          media_pending: true,
        },
      });
      assert.equal(pushed.status, 200, JSON.stringify(pushed.body));

      const again = await call(origin, `/v1/me/connectors/${pushId}/ingest`, {
        method: "POST",
        headers: connector,
        body: {
          stream_key: "room-9",
          events: [event("h-2", "hybrid-pushed")],
          watermark: "h-2",
        },
      });
      assert.equal(again.status, 200, JSON.stringify(again.body));

      const cleared = await call(origin, `/v1/me/connectors/${pushId}/ingest`, {
        method: "POST",
        headers: connector,
        body: {
          stream_key: "room-9",
          events: [event("h-3", "hybrid-pushed")],
          watermark: "h-3",
          media_pending: false,
        },
      });
      assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
      assert.equal(cleared.body.accepted_count, 1, JSON.stringify(cleared.body));
      assert.equal(cleared.body.retryable_count, 0, JSON.stringify(cleared.body));
    } finally {
      await app.close();
    }
    const db = new DatabaseSync(database);
    const phase = db.prepare(
      "SELECT phase, media_pending FROM connector_sync_state WHERE installation_id = ? AND stream_key = ?",
    ).get(pushId, "room-9");
    const lanes = db.prepare(
      "SELECT lane, status FROM connector_sync_work WHERE installation_id = ? AND stream_key = ?",
    ).all(pushId, "room-9");
    const member = db.prepare(
      "SELECT thread_id FROM connector_stream_members WHERE installation_id = ? AND stream_key = ?",
    ).get(pushId, "room-9");
    db.close();
    assert.equal(phase.phase, "history");
    assert.equal(phase.media_pending, 0);
    assert.equal(member.thread_id, "hybrid-pushed:room-9");
    assert.deepEqual(
      lanes.filter((row) => row.status === "pending").map((row) => row.lane),
      ["history"],
    );
    assert.equal(lanes.find((row) => row.lane === "media")?.status, "cancelled");
  });

  it("reads and adjusts connector limits at runtime", async () => {
    const root = await createRoot();
    const { app, origin } = await startPersonalApi(join(root, "authority.db"), join(root, "blobs"), {
      REGENIC_CHANNEL_PLUGIN: PLUGIN,
    });
    try {
      const pushId = await install(origin, "extra-push");
      const adjusted = await call(origin, `/v1/me/connectors/${pushId}/limits`, {
        method: "PUT",
        body: { max_concurrency: 2, page_size: 50, rate: { tokens: 5, window_ms: 60_000 } },
      });
      assert.equal(adjusted.status, 200, JSON.stringify(adjusted.body));
      assert.equal(adjusted.body.effective.max_concurrency, 2);
      assert.equal(adjusted.body.effective.page_size, 50);
      assert.deepEqual(adjusted.body.runtime.rate, { tokens: 5, window_ms: 60_000 });

      const rejected = await call(origin, `/v1/me/connectors/${pushId}/limits`, {
        method: "PUT",
        body: { max_concurrency: 0 },
      });
      assert.equal(rejected.status, 400);

      const cleared = await call(origin, `/v1/me/connectors/${pushId}/limits`, {
        method: "PUT",
        body: {},
      });
      assert.equal(cleared.body.runtime, undefined);
      const read = await call(origin, `/v1/me/connectors/${pushId}/limits`);
      assert.equal(read.status, 200);
      assert.equal(read.body.effective.max_concurrency, undefined);
    } finally {
      await app.close();
    }
  });
});
