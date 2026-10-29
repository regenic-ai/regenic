const assert = require("node:assert/strict");
const { createServer } = require("node:http");
const { join } = require("node:path");
const { describe, it } = require("node:test");
const { SqliteAuthorityStore } = require("@regenic/authority-store/sqlite");
const {
  createRoot,
  ingestActionable,
  startDshWebStub,
  startPersonalApi,
  waitForSyncRun,
  waitUntil,
} = require("./personal-api-harness.cjs");

describe("personal /v1/me", { concurrency: 1 }, () => {
  it("pauses and cancels an async connector sync run", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    await ingestActionable(database, blobRoot);
    const hanging = createServer(() => undefined);
    await new Promise((resolve) => {
      hanging.listen(0, "127.0.0.1", resolve);
    });
    const { app, origin } = await startPersonalApi(database, blobRoot, {
      REGENIC_CONNECTOR_POLL_TIMEOUT_MS: "250",
    });
    try {
      const created = await fetch(`${origin}/v1/me/connectors`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          connector_type: "dsh-session",
          config: {
            transport: "web",
            session_id: "desk-1",
            base_url: `http://127.0.0.1:${hanging.address().port}`,
          },
        }),
      });
      const installation = await created.json();
      assert.equal(created.status, 201, JSON.stringify(installation));
      const synced = await fetch(`${origin}/v1/me/connectors/${installation.id}/sync`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "quick_start" }),
      });
      const body = await synced.json();
      assert.equal(synced.status, 201);
      assert.equal(body.installation_id, installation.id);
      assert.ok(["queued", "running"].includes(body.status));

      const paused = await fetch(
        `${origin}/v1/me/sync-runs/${body.id}/pause`,
        { method: "POST" },
      );
      assert.equal(paused.status, 201);
      assert.equal((await paused.json()).status, "paused");

      const cancelled = await fetch(
        `${origin}/v1/me/sync-runs/${body.id}/cancel`,
        { method: "POST" },
      );
      assert.equal(cancelled.status, 201);
      assert.equal((await cancelled.json()).status, "cancelled");
    } finally {
      hanging.closeAllConnections?.();
      hanging.close();
      await app.close();
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
        body: JSON.stringify({ connector_type: "not-a-connector", config: {} }),
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

  it("rejects a second install of a singleton extra connector", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    await ingestActionable(database, blobRoot);
    const { app, origin } = await startPersonalApi(database, blobRoot, {
      REGENIC_CHANNEL_PLUGIN: join(__dirname, "fixtures/extra-review-driver"),
    });
    try {
      const engine = await (await fetch(`${origin}/v1/me/engine?detail=0`)).json();
      const extra = engine.catalog.find(
        (item) => item.connector_type === "extra-review",
      );
      assert.equal(extra.title, "Extra review");
      assert.equal(extra.singleton, true);
      assert.equal(
        engine.plugins.some(
          (item) =>
            item.origin === "extra" &&
            item.trust === "unsigned" &&
            item.status === "loaded" &&
            item.drivers.includes("extra-review"),
        ),
        true,
      );

      const first = await fetch(`${origin}/v1/me/connectors`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          connector_type: "extra-review",
          config: { max_open: "20" },
        }),
      });
      const firstBody = await first.json();
      assert.equal(first.status, 201, JSON.stringify(firstBody));
      assert.equal(firstBody.label, "Extra queue");
      assert.equal(firstBody.detail, "20");

      const second = await fetch(`${origin}/v1/me/connectors`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          connector_type: "extra-review",
          config: { max_open: "40" },
        }),
      });
      const secondBody = await second.json();
      assert.equal(second.status, 409, JSON.stringify(secondBody));
      assert.equal(secondBody.error.code, "already_installed");
    } finally {
      await app.close();
    }
  });

  it("rejects an unknown extra connector and treats uninstall as idempotent", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    await ingestActionable(database, blobRoot);
    const { app, origin } = await startPersonalApi(database, blobRoot);
    try {
      const unknown = await fetch(`${origin}/v1/me/connectors`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          connector_type: "crm-ops-review",
          config: { max_open_tasks: "20" },
        }),
      });
      const unknownBody = await unknown.json();
      assert.equal(unknown.status, 400, JSON.stringify(unknownBody));
      assert.equal(unknownBody.error.code, "unsupported_connector");

      const first = await fetch(`${origin}/v1/me/connectors/missing-install`, {
        method: "DELETE",
      });
      assert.equal(first.status, 200);
      const second = await fetch(`${origin}/v1/me/connectors/missing-install`, {
        method: "DELETE",
      });
      const secondBody = await second.json();
      assert.equal(second.status, 200, JSON.stringify(secondBody));
      assert.equal(secondBody.removed, true);
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
      const run = await waitForSyncRun(origin, body.id);
      assert.equal(run.status, "succeeded");
      assert.equal(run.installation_id, installation.id);
      assert.ok(run.completed_work >= 1);
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

      const store = new SqliteAuthorityStore(database);
      try {
        const installations = await store.listInstallations("local-owner");
        const dsh = installations.find(
          (item) => item.config.mailbox === "box-1",
        );
        assert.equal(dsh.connector_type, "dsh-session");
        assert.equal(dsh.config.command, undefined);
        assert.equal(dsh.config.workdir, undefined);
      } finally {
        store.close();
      }
    } finally {
      await app.close();
    }
  });
});
