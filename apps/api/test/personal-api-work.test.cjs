const assert = require("node:assert/strict");
const { join } = require("node:path");
const { describe, it } = require("node:test");
const { SqliteAuthorityStore } = require("@regenic/authority-store/sqlite");
const { FsBlobStore } = require("@regenic/blob-store");
const { INGEST_SCHEMA_VERSION, IngestionService, channelRecord } = require("@regenic/domain");
const {
  createRoot,
  ingestActionable,
  seedHostedWork,
  startPersonalApi,
  waitUntil,
} = require("./personal-api-harness.cjs");

describe("personal /v1/me", { concurrency: 1 }, () => {
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
            include_context: true,
          }),
        })
      ).json();
      assert.equal(created.executor_type, "dsh");
      assert.equal(created.can_write_back, true);
      assert.equal(created.include_context, true);
      assert.equal(created.trigger.kind, "push");
      assert.equal(created.trigger.coalesce, true);
      assert.equal(created.executor_config.skill, "review");
      const typed = await (
        await fetch(`${origin}/v1/me/recipes`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: "CRM order review",
            match: { unit_kind: "crm.order_review" },
            executor_type: "dsh",
          }),
        })
      ).json();
      assert.equal(typed.match.unit_kind, "crm.order_review");
      assert.equal(typed.trigger.kind, "push");
      const pullMissing = await fetch(`${origin}/v1/me/recipes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Morning digest",
          match: { record_class: "task" },
          trigger: { kind: "pull", interval_ms: 3_600_000 },
          executor_type: "dsh",
        }),
      });
      assert.equal(pullMissing.status, 400);
      const pulled = await (
        await fetch(`${origin}/v1/me/recipes`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: "Morning digest",
            match: { thread_id: "feishu:oc_chat" },
            trigger: { kind: "pull", interval_ms: 3_600_000 },
            executor_type: "dsh",
          }),
        })
      ).json();
      assert.equal(pulled.trigger.kind, "pull");
      assert.equal(pulled.trigger.interval_ms, 3_600_000);
      assert.equal(pulled.can_write_back, true);
      assert.equal(pulled.include_context, true);
      assert.ok(pulled.next_run_at);
      assert.equal(created.executor_config.prompt, "Reply with a decision.");
      const recipes = await (await fetch(`${origin}/v1/me/recipes`)).json();
      assert.equal(recipes.length, 3);
      const listed = recipes.find((recipe) => recipe.name === "Feishu tasks");
      assert.equal(listed.executor_config.prompt, "Reply with a decision.");
      assert.equal(listed.include_context, true);
      assert.equal(
        recipes.find((recipe) => recipe.name === "CRM order review")?.match.unit_kind,
        "crm.order_review",
      );
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

  it("installs HTTP and local executors and seeds the default DSH binding", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    await ingestActionable(database, blobRoot);
    const { app, origin } = await startPersonalApi(database, blobRoot);
    try {
      const engine = await (await fetch(`${origin}/v1/me/engine`)).json();
      assert.equal(engine.executor_catalog.length, 2);
      assert.equal(engine.executor_catalog[0].kind, "local_connector");
      assert.equal(engine.executor_catalog[1].kind, "http");
      assert.equal(engine.executor_installations[0].id, "dsh");
      assert.equal(engine.executor_installations[0].kind, "local_connector");

      const missingLocal = await fetch(`${origin}/v1/me/executors`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "local_connector", config: {} }),
      });
      assert.equal(missingLocal.status, 400);

      const remote = await fetch(`${origin}/v1/me/executors`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "http",
          name: "Remote agent",
          config: { base_url: "https://agent.example/exec/" },
        }),
      });
      const remoteBody = await remote.json();
      assert.equal(remote.status, 201, JSON.stringify(remoteBody));
      assert.equal(remoteBody.kind, "http");
      assert.equal(remoteBody.base_url, "https://agent.example/exec");

      const catalog = await (await fetch(`${origin}/v1/me/executors`)).json();
      assert.equal(catalog.some((item) => item.executor_type === "dsh"), true);
      assert.equal(
        catalog.some((item) => item.executor_type === remoteBody.id),
        true,
      );

      const disabled = await fetch(
        `${origin}/v1/me/executors/${remoteBody.id}/disable`,
        { method: "POST" },
      );
      assert.equal(disabled.status, 201);
      const afterDisable = await (await fetch(`${origin}/v1/me/executors`)).json();
      assert.equal(
        afterDisable.some((item) => item.executor_type === remoteBody.id),
        false,
      );

      const connector = await fetch(`${origin}/v1/me/connectors`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          connector_type: "dsh-session",
          config: { transport: "web", base_url: "http://127.0.0.1:3080" },
        }),
      });
      const connectorBody = await connector.json();
      assert.equal(connector.status, 201, JSON.stringify(connectorBody));

      const local = await fetch(`${origin}/v1/me/executors`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "local_connector",
          name: "Office DSH",
          config: { installation_id: connectorBody.id },
        }),
      });
      const localBody = await local.json();
      assert.equal(local.status, 201, JSON.stringify(localBody));
      assert.equal(localBody.kind, "local_connector");
      assert.equal(localBody.connector_id, connectorBody.id);

      const recipe = await fetch(`${origin}/v1/me/recipes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Pinned local",
          match: { record_class: "task", source: "feishu" },
          executor_type: localBody.id,
        }),
      });
      const recipeBody = await recipe.json();
      assert.equal(recipe.status, 201, JSON.stringify(recipeBody));
      assert.equal(recipeBody.executor_type, localBody.id);
    } finally {
      await app.close();
    }
  });
});
