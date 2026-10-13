const assert = require("node:assert/strict");
const { join } = require("node:path");
const { describe, it } = require("node:test");
const { SqliteAuthorityStore } = require("@regenic/authority-store/sqlite");
const { FsBlobStore } = require("@regenic/blob-store");
const { INGEST_SCHEMA_VERSION, IngestionService, channelRecord } = require("@regenic/domain");
const {
  dshPromptStoreFor,
  dropDshPromptStore,
  questionPromptId,
} = require("@regenic/connector-host");
const {
  createRoot,
  ingestActionable,
  startDshWebStub,
  startPersonalApi,
  waitUntil,
} = require("./personal-api-harness.cjs");

describe("personal /v1/me", { concurrency: 1 }, () => {
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

  it("titles DSH list heads from the first user message", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    const authority = new SqliteAuthorityStore(database);
    const service = new IngestionService(new FsBlobStore(blobRoot), authority);
    await authority.createInstallation({
      id: "dsh-1",
      org_id: "local-owner",
      connector_type: "dsh-session",
      status: "enabled",
      config: { transport: "web", base_url: "http://127.0.0.1:9" },
      created_at: "2026-08-21T00:00:00.000Z",
    });
    await service.ingest({
      schema_version: INGEST_SCHEMA_VERSION,
      connector_id: "dsh-session",
      org_id: "local-owner",
      delivery_id: "dsh-prompt-1",
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
        channelRecord({
          channel: "dsh",
          kind: "user",
          direction: "outbound",
          external_id: "session-x:50",
          occurred_at: "2026-08-21T00:00:02.000Z",
          actor_id: "user",
          scope_id: "session-x",
          text: "再来一句",
        }),
      ],
    });
    authority.close();
    const { app, origin } = await startPersonalApi(database, blobRoot);
    try {
      const heads = await (await fetch(`${origin}/v1/me/inbox?heads=1`)).json();
      assert.equal(heads.length, 1);
      assert.equal(heads[0].list_title, "prompt");
      assert.equal(heads[0].conversation_label, "只用一句话回复：pong");
      assert.equal(heads[0].body_text, undefined);
      assert.equal(heads[0].event.external_id, "session-x:50");
    } finally {
      await app.close();
    }
  });

  it("titles DSH list heads from the first user message after system injects", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    const authority = new SqliteAuthorityStore(database);
    const service = new IngestionService(new FsBlobStore(blobRoot), authority);
    await authority.createInstallation({
      id: "dsh-1",
      org_id: "local-owner",
      connector_type: "dsh-session",
      status: "enabled",
      config: { transport: "web", base_url: "http://127.0.0.1:9" },
      created_at: "2026-08-21T00:00:00.000Z",
    });
    const injects = Array.from({ length: 30 }, (_, index) =>
      channelRecord({
        channel: "dsh",
        kind: "system",
        direction: "inbound",
        external_id: `session-long:${index + 1}`,
        occurred_at: `2026-08-21T00:00:${String(index).padStart(2, "0")}.000Z`,
        actor_id: "plugin",
        scope_id: "session-long",
        text: `injected context ${index + 1}: skill and memory preamble`,
      }),
    );
    await service.ingest({
      schema_version: INGEST_SCHEMA_VERSION,
      connector_id: "dsh-session",
      org_id: "local-owner",
      delivery_id: "dsh-prompt-injects-1",
      received_at: "2026-08-21T00:01:00.000Z",
      records: [
        ...injects,
        channelRecord({
          channel: "dsh",
          kind: "user",
          direction: "outbound",
          external_id: "session-long:31",
          occurred_at: "2026-08-21T00:00:31.000Z",
          actor_id: "user",
          scope_id: "session-long",
          text: "只用一句话回复：pong",
        }),
        channelRecord({
          channel: "dsh",
          kind: "assistant",
          direction: "inbound",
          external_id: "session-long:32",
          occurred_at: "2026-08-21T00:00:32.000Z",
          actor_id: "assistant",
          scope_id: "session-long",
          text: "pong",
        }),
      ],
    });
    authority.close();
    const { app, origin } = await startPersonalApi(database, blobRoot);
    try {
      const heads = await (await fetch(`${origin}/v1/me/inbox?heads=1`)).json();
      assert.equal(heads.length, 1);
      assert.equal(heads[0].list_title, "prompt");
      assert.equal(heads[0].conversation_label, "只用一句话回复：pong");
      assert.equal(heads[0].body_text, undefined);
      assert.equal(heads[0].event.external_id, "session-long:32");
    } finally {
      await app.close();
    }
  });

  it("keeps a DSH list face when the first user prompt is still missing", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    const authority = new SqliteAuthorityStore(database);
    const service = new IngestionService(new FsBlobStore(blobRoot), authority);
    await authority.createInstallation({
      id: "dsh-1",
      org_id: "local-owner",
      connector_type: "dsh-session",
      status: "enabled",
      config: { transport: "web", base_url: "http://127.0.0.1:9" },
      created_at: "2026-08-21T00:00:00.000Z",
    });
    await service.ingest({
      schema_version: INGEST_SCHEMA_VERSION,
      connector_id: "dsh-session",
      org_id: "local-owner",
      delivery_id: "dsh-prompt-missing-1",
      received_at: "2026-08-21T00:00:00.000Z",
      records: [
        channelRecord({
          channel: "dsh",
          kind: "system",
          direction: "inbound",
          external_id: "session-bare:1",
          occurred_at: "2026-08-21T00:00:00.000Z",
          actor_id: "plugin",
          scope_id: "session-bare",
          text: "injected skill context",
        }),
        channelRecord({
          channel: "dsh",
          kind: "assistant",
          direction: "inbound",
          external_id: "session-bare:2",
          occurred_at: "2026-08-21T00:00:01.000Z",
          actor_id: "assistant",
          scope_id: "session-bare",
          text: "这是对方给我的初稿：一、Bioby AI品牌端介绍",
        }),
      ],
    });
    authority.close();
    const { app, origin } = await startPersonalApi(database, blobRoot);
    try {
      const heads = await (await fetch(`${origin}/v1/me/inbox?heads=1`)).json();
      assert.equal(heads.length, 1);
      assert.equal(heads[0].list_title, "prompt");
      assert.equal(heads[0].conversation_label, null);
      assert.equal(
        heads[0].body_text,
        "这是对方给我的初稿：一、Bioby AI品牌端介绍",
      );
    } finally {
      await app.close();
    }
  });

  it("persists a conversation title and pin across inbox reads", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    const authority = new SqliteAuthorityStore(database);
    const service = new IngestionService(new FsBlobStore(blobRoot), authority);
    await service.ingest({
      schema_version: INGEST_SCHEMA_VERSION,
      connector_id: "dsh-session",
      org_id: "local-owner",
      delivery_id: "dsh-title",
      received_at: "2026-08-21T00:00:00.000Z",
      records: [
        channelRecord({
          channel: "dsh",
          kind: "user",
          direction: "outbound",
          external_id: "session-title:7",
          occurred_at: "2026-08-21T00:00:00.000Z",
          actor_id: "user",
          scope_id: "session-title",
          text: "只用一句话回复：pong",
        }),
        channelRecord({
          channel: "dsh",
          kind: "assistant",
          direction: "inbound",
          external_id: "session-title:8",
          occurred_at: "2026-08-21T00:00:30.000Z",
          actor_id: "assistant",
          scope_id: "session-title",
          text: "pong",
        }),
      ],
    });
    authority.close();
    const { app, origin } = await startPersonalApi(database, blobRoot);
    try {
      const before = await (await fetch(`${origin}/v1/me/engine?detail=0`)).json();
      const created = await (
        await fetch(`${origin}/v1/me/conversations/prefs`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            thread_id: "dsh:session-title",
            title: "  Release desk  ",
            pinned: true,
          }),
        })
      ).json();
      assert.equal(created.title, "Release desk");
      assert.equal(created.pinned, true);
      const after = await (await fetch(`${origin}/v1/me/engine?detail=0`)).json();
      assert.equal(after.inbox_count, before.inbox_count);
      assert.notEqual(after.inbox_digest, before.inbox_digest);

      const inbox = await (await fetch(`${origin}/v1/me/inbox`)).json();
      assert.equal(inbox[0].thread_id, "dsh:session-title");
      assert.equal(inbox[0].title, "Release desk");
      assert.equal(inbox[0].pinned, true);

      const cleared = await (
        await fetch(`${origin}/v1/me/conversations/prefs`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            thread_id: "dsh:session-title",
            title: "",
          }),
        })
      ).json();
      assert.equal(cleared.title, null);
      assert.equal(cleared.pinned, true);

      const again = await (await fetch(`${origin}/v1/me/inbox`)).json();
      assert.equal(again[0].title, null);
      assert.equal(again[0].pinned, true);

      const invalid = await fetch(`${origin}/v1/me/conversations/prefs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "x" }),
      });
      assert.equal(invalid.status, 400);

      assert.equal(
        again.find((item) => item.event.external_id === "session-title:8")?.unread,
        true,
      );
      const read = await fetch(`${origin}/v1/me/conversations/attention`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          thread_id: "dsh:session-title",
          last_read_at: "2026-08-21T00:00:00.000Z",
          last_read_external_id: "session-title:8",
        }),
      });
      const readBody = await read.json();
      assert.ok(read.ok, JSON.stringify(readBody));
      assert.equal(readBody.last_read_external_id, "session-title:8");
      const afterRead = await (await fetch(`${origin}/v1/me/inbox`)).json();
      assert.equal(
        afterRead.find((item) => item.event.external_id === "session-title:8")?.unread,
        false,
      );

      const slackPrompt = await fetch(`${origin}/v1/me/conversations/prompts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          thread_id: "slack:C123",
          prompt_id: "q:nope",
          answers: [{ id: "go", selected: ["Yes"] }],
        }),
      });
      assert.equal(slackPrompt.status, 501);
    } finally {
      await app.close();
    }
  });

  it("answers a live DSH prompt through respond, not session.prompt", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    await ingestActionable(database, blobRoot);
    const dsh = await startDshWebStub();
    const { app, origin } = await startPersonalApi(database, blobRoot);
    let installation;
    try {
      const created = await fetch(`${origin}/v1/me/connectors`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          connector_type: "dsh-session",
          config: { transport: "web", base_url: dsh.origin },
        }),
      });
      installation = await created.json();
      assert.equal(created.status, 201, JSON.stringify(installation));
      const promptId = questionPromptId("rpc-q");
      dshPromptStoreFor(installation.id).put("sess-a", {
        prompt_id: promptId,
        presentation: "choice",
        questions: [{ id: "go", prompt: "Continue?", options: [{ label: "Yes" }] }],
      });
      await waitUntil("dsh sess-a after install", async () => {
        const heads = await (await fetch(`${origin}/v1/me/inbox?heads=1`)).json();
        return heads.some((item) => item.thread_id === "dsh:sess-a");
      });
      const engine = await (await fetch(`${origin}/v1/me/engine?detail=0`)).json();
      assert.match(engine.inbox_digest, /&s=/);
      const heads = await (await fetch(`${origin}/v1/me/inbox?heads=1`)).json();
      const sess = heads.find((item) => item.thread_id === "dsh:sess-a");
      assert.equal(sess.unread, true);
      assert.equal(sess.prompts[0].prompt_id, promptId);

      const answered = await fetch(`${origin}/v1/me/conversations/prompts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          thread_id: "dsh:sess-a",
          prompt_id: promptId,
          answers: [{ id: "go", selected: ["Yes"] }],
        }),
      });
      const body = await answered.json();
      assert.ok(answered.ok, JSON.stringify(body));
      assert.equal(body.accepted, true);
      assert.equal(dsh.responds.length, 1);
      assert.equal(dsh.responds[0].type, "client-response");
      assert.equal(dsh.responds[0].rpcId, "rpc-q");
      assert.equal(dsh.prompts.length, 0);
      const after = await (await fetch(`${origin}/v1/me/inbox?heads=1`)).json();
      assert.equal(
        (after.find((item) => item.thread_id === "dsh:sess-a")?.prompts ?? []).length,
        0,
      );
    } finally {
      if (installation?.id) {
        dropDshPromptStore(installation.id);
      }
      await app.close();
      await dsh.close();
    }
  });

  it("rejects conversation create when no connector can open a thread", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    await ingestActionable(database, blobRoot);
    const { app, origin } = await startPersonalApi(database, blobRoot);
    try {
      const created = await fetch(`${origin}/v1/me/conversations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      assert.equal(created.status, 501);
    } finally {
      await app.close();
    }
  });
});
