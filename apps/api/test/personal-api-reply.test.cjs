const assert = require("node:assert/strict");
const { join } = require("node:path");
const { describe, it } = require("node:test");
const { SqliteAuthorityStore } = require("@regenic/authority-store/sqlite");
const { FsBlobStore } = require("@regenic/blob-store");
const { INGEST_SCHEMA_VERSION, IngestionService, channelRecord } = require("@regenic/domain");
const {
  createRoot,
  ingestActionable,
  startDshWebStub,
  startPersonalApi,
  waitUntil,
} = require("./personal-api-harness.cjs");

describe("personal /v1/me", { concurrency: 1 }, () => {
  it("sends a DSH reply with markdown and an image", async () => {
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
      const createdBody = await created.json();
      assert.equal(created.status, 201, JSON.stringify(createdBody));
      assert.equal(createdBody.can_create, true);
      assert.equal(createdBody.create_with_task, false);
      assert.equal(createdBody.can_reply, true);
      assert.equal(createdBody.channel, "dsh");
      assert.equal(createdBody.channel_label, "DSH");
      await waitUntil("dsh sess-a after install", async () => {
        const inbox = await (await fetch(`${origin}/v1/me/inbox`)).json();
        return inbox.some((item) => item.event.external_id === "sess-a:1");
      });

      const slackOnly = await fetch(`${origin}/v1/me/conversations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ installation_id: "slack-1" }),
      });
      assert.equal(slackOnly.status, 501);

      const opened = await fetch(`${origin}/v1/me/conversations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const openedBody = await opened.json();
      assert.equal(opened.status, 201, JSON.stringify(openedBody));
      assert.equal(openedBody.thread_id, "dsh:created-1");
      assert.equal(openedBody.channel, "dsh");
      assert.equal(openedBody.channel_label, "DSH");
      assert.equal(openedBody.can_send, true);
      assert.equal(openedBody.await_reply, true);
      assert.equal(openedBody.list_title, "prompt");
      assert.deepEqual(dsh.created, ["created-1"]);

      const tasked = await fetch(`${origin}/v1/me/conversations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          installation_id: createdBody.id,
          text: "Fix the login bug",
        }),
      });
      const taskedBody = await tasked.json();
      assert.equal(tasked.status, 201, JSON.stringify(taskedBody));
      assert.equal(taskedBody.thread_id, "dsh:created-2");
      assert.deepEqual(dsh.created, ["created-1", "created-2"]);
      assert.equal(
        dsh.prompts.some((item) => JSON.stringify(item).includes("Fix the login bug")),
        false,
      );

      const createdBeforeRetry = dsh.created.length;
      const retryBody = {
        installation_id: createdBody.id,
        client_request_id: "draft:dsh-1:same-send",
      };
      const [firstRetry, secondRetry] = await Promise.all([
        fetch(`${origin}/v1/me/conversations`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(retryBody),
        }),
        fetch(`${origin}/v1/me/conversations`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(retryBody),
        }),
      ]);
      const firstRetryBody = await firstRetry.json();
      const secondRetryBody = await secondRetry.json();
      assert.equal(firstRetry.status, 201, JSON.stringify(firstRetryBody));
      assert.equal(secondRetry.status, 201, JSON.stringify(secondRetryBody));
      assert.equal(secondRetryBody.thread_id, firstRetryBody.thread_id);
      assert.equal(dsh.created.length, createdBeforeRetry + 1);

      const empty = await fetch(`${origin}/v1/me/replies`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ thread_id: "dsh:sess-a" }),
      });
      assert.equal(empty.status, 400);

      const slack = await fetch(`${origin}/v1/me/replies`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          thread_id: "slack:C123",
          text: "Please take a look",
        }),
      });
      assert.equal(slack.status, 501);

      const replied = await fetch(`${origin}/v1/me/replies`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          thread_id: "dsh:sess-a",
          text: "Please review **this** screenshot.",
          attachments: [
            {
              filename: "shot.png",
              media_type: "image/png",
              data_base64:
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
            },
          ],
        }),
      });
      const body = await replied.json();
      assert.equal(replied.status, 201, JSON.stringify(body));
      assert.equal(body.accepted, true);
      assert.equal(body.thread_id, "dsh:sess-a");
      assert.match(body.item.body_text, /Please review \*\*this\*\* screenshot/);
      assert.equal(body.item.direction, "outbound");
      assert.equal(body.item.can_send, true);
      assert.equal(body.item.attachments[0].filename, "shot.png");
      const replyPrompt = dsh.prompts.find((item) => item.payload?.sessionId === "sess-a");
      assert.equal(replyPrompt?.method, "session.prompt");
      assert.equal(replyPrompt?.payload.sessionId, "sess-a");
      const image = replyPrompt.payload.content.find((part) => part.type === "image");
      assert.equal(image.mimeType, "image/png");
      assert.equal(image.mediaType, "image/png");
      assert.equal(image.name, "shot.png");
      assert.equal(
        image.data,
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      );
      assert.equal(image.url, undefined);
      assert.equal(image.path, undefined);

      const oversized = await fetch(`${origin}/v1/me/replies`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          thread_id: "dsh:sess-a",
          text: "large screenshot",
          attachments: [
            {
              filename: "wide.png",
              media_type: "image/png",
              data_base64: Buffer.alloc(150 * 1024, 7).toString("base64"),
            },
          ],
        }),
      });
      assert.notEqual(oversized.status, 413);
      assert.equal(oversized.status, 201, await oversized.text());

      await waitUntil("assistant pong after reply", async () => {
        const inbox = await (await fetch(`${origin}/v1/me/inbox`)).json();
        return inbox.some(
          (item) => item.kind === "assistant" && item.body_text === "pong",
        );
      });
      const inbox = await (await fetch(`${origin}/v1/me/inbox`)).json();
      const userTexts = inbox
        .filter((item) => item.kind === "user" && item.body_text.includes("Please review"))
        .map((item) => item.event.external_id);
      assert.equal(userTexts.length, 1);
      assert.match(userTexts[0], /^sess-a:out:/);
      assert.equal(
        inbox.some((item) => item.kind === "assistant" && item.body_text === "pong"),
        true,
      );

      const synced = await fetch(
        `${origin}/v1/me/connectors/${createdBody.id}/sync`,
        { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
      );
      assert.equal(synced.status, 201);
      const after = await (await fetch(`${origin}/v1/me/inbox`)).json();
      assert.equal(
        after.filter((item) => item.kind === "user" && item.body_text.includes("Please review")).length,
        1,
      );
    } finally {
      await app.close();
      await dsh.close();
    }
  });

  it("forwards a DSH message to another writable session", async () => {
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
      const createdBody = await created.json();
      assert.equal(created.status, 201, JSON.stringify(createdBody));
      await waitUntil("dsh sess-a and sess-b after install", async () => {
        const inbox = await (await fetch(`${origin}/v1/me/inbox`)).json();
        return (
          inbox.some((item) => item.thread_id === "dsh:sess-a") &&
          inbox.some((item) => item.thread_id === "dsh:sess-b")
        );
      });

      const replied = await fetch(`${origin}/v1/me/replies`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          thread_id: "dsh:sess-a",
          text: "Please review **this** screenshot.",
          attachments: [
            {
              filename: "shot.png",
              media_type: "image/png",
              data_base64:
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
            },
          ],
        }),
      });
      const replyBody = await replied.json();
      assert.equal(replied.status, 201, JSON.stringify(replyBody));

      const forwarded = await fetch(`${origin}/v1/me/forwards`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          source_thread_id: "dsh:sess-a",
          event_ids: [replyBody.item.event.id],
          target: { thread_id: "dsh:sess-b" },
          mode: "messages",
        }),
      });
      const forwardBody = await forwarded.json();
      assert.equal(forwarded.status, 201, JSON.stringify(forwardBody));
      assert.equal(forwardBody.accepted, true);
      assert.equal(forwardBody.created, false);
      assert.equal(forwardBody.source_thread_id, "dsh:sess-a");
      assert.equal(forwardBody.target_thread_id, "dsh:sess-b");
      assert.equal(forwardBody.item.thread_id, "dsh:sess-b");
      assert.equal(forwardBody.item.direction, "outbound");
      assert.match(forwardBody.item.body_text, /Please review \*\*this\*\* screenshot/);
      assert.match(forwardBody.item.body_text, /\[Attached: shot\.png\]/);
      assert.deepEqual(forwardBody.item.forwarded_from, {
        thread_id: "dsh:sess-a",
        event_ids: [replyBody.item.event.id],
        source: "dsh",
        channel_label: "DSH",
      });
      const sourceItem = await (
        await fetch(`${origin}/v1/me/inbox/${replyBody.item.event.id}`)
      ).json();
      assert.deepEqual(sourceItem.forwarded_to, {
        thread_id: "dsh:sess-b",
        event_ids: [replyBody.item.event.id],
        source: "dsh",
        channel_label: "DSH",
      });
      const sourceThread = await (
        await fetch(`${origin}/v1/me/inbox?thread_id=${encodeURIComponent("dsh:sess-a")}`)
      ).json();
      const sourceRow = sourceThread.find(
        (item) => item.event.id === replyBody.item.event.id,
      );
      assert.deepEqual(sourceRow.forwarded_to, sourceItem.forwarded_to);
      const sourceHeads = await (
        await fetch(`${origin}/v1/me/inbox?heads=1`)
      ).json();
      const sourceHead = sourceHeads.find((item) => item.thread_id === "dsh:sess-a");
      assert.ok(sourceHead);
      assert.notEqual(sourceHead.record_class, "status");
      assert.equal(sourceHead.forwarded_to, undefined);
      const targetPrompt = dsh.prompts.find((item) => item.payload?.sessionId === "sess-b");
      assert.equal(targetPrompt?.method, "session.prompt");
      assert.match(
        JSON.stringify(targetPrompt.payload.content),
        /Please review \*\*this\*\* screenshot/,
      );
      const image = targetPrompt.payload.content.find((part) => part.type === "image");
      assert.equal(image?.name, "shot.png");

      const same = await fetch(`${origin}/v1/me/forwards`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          source_thread_id: "dsh:sess-a",
          event_ids: [replyBody.item.event.id],
          target: { thread_id: "dsh:sess-a" },
          mode: "messages",
        }),
      });
      assert.equal(same.status, 400);

      const slack = await fetch(`${origin}/v1/me/forwards`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          source_thread_id: "dsh:sess-a",
          event_ids: [replyBody.item.event.id],
          target: { thread_id: "slack:C123" },
          mode: "messages",
        }),
      });
      assert.equal(slack.status, 404);

      const createdBefore = dsh.created.length;
      const createdForward = await fetch(`${origin}/v1/me/forwards`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          source_thread_id: "dsh:sess-a",
          mode: "transcript",
          target: { installation_id: createdBody.id, create: true },
        }),
      });
      const createdForwardBody = await createdForward.json();
      assert.equal(createdForward.status, 201, JSON.stringify(createdForwardBody));
      assert.equal(createdForwardBody.accepted, true);
      assert.equal(createdForwardBody.created, true);
      assert.equal(createdForwardBody.source_thread_id, "dsh:sess-a");
      assert.equal(createdForwardBody.target_thread_id, "dsh:created-1");
      assert.equal(createdForwardBody.item.thread_id, "dsh:created-1");
      assert.equal(createdForwardBody.item.direction, "outbound");
      assert.match(createdForwardBody.item.body_text, /Need a decision from session A/);
      assert.deepEqual(createdForwardBody.item.forwarded_from, {
        thread_id: "dsh:sess-a",
        event_ids: createdForwardBody.item.forwarded_from.event_ids,
        source: "dsh",
        channel_label: "DSH",
      });
      assert.ok(createdForwardBody.item.forwarded_from.event_ids.length > 0);
      const sourceAfterCreate = await (
        await fetch(`${origin}/v1/me/inbox/${replyBody.item.event.id}`)
      ).json();
      assert.deepEqual(sourceAfterCreate.forwarded_to, {
        thread_id: "dsh:created-1",
        event_ids: createdForwardBody.item.forwarded_from.event_ids,
        source: "dsh",
        channel_label: "DSH",
      });
      assert.equal(dsh.created.length, createdBefore + 1);
      assert.deepEqual(dsh.created, ["created-1"]);
      const createdPrompt = dsh.prompts.find(
        (item) => item.payload?.sessionId === "created-1",
      );
      assert.equal(createdPrompt?.method, "session.prompt");
      assert.match(
        JSON.stringify(createdPrompt.payload.content),
        /Need a decision from session A/,
      );

      const slackCreate = await fetch(`${origin}/v1/me/forwards`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          source_thread_id: "dsh:sess-a",
          mode: "transcript",
          target: { installation_id: "slack-1", create: true },
        }),
      });
      assert.equal(slackCreate.status, 501);
    } finally {
      await app.close();
      await dsh.close();
    }
  });

  it("lets a hosted kernel reply to DSH sessions through a stored cli install", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    const authority = new SqliteAuthorityStore(database);
    const service = new IngestionService(new FsBlobStore(blobRoot), authority);
    await service.ingest({
      schema_version: INGEST_SCHEMA_VERSION,
      connector_id: "dsh-session",
      org_id: "local-owner",
      delivery_id: "dsh-hosted",
      received_at: "2026-08-21T00:00:00.000Z",
      records: [
        channelRecord({
          channel: "dsh",
          kind: "user",
          direction: "outbound",
          external_id: "session-hosted:1",
          occurred_at: "2026-08-21T00:00:00.000Z",
          actor_id: "user",
          scope_id: "session-hosted",
          text: "只用一个英文单词回复：pong",
        }),
      ],
    });
    await authority.createInstallation({
      id: "dsh-main",
      org_id: "local-owner",
      connector_type: "dsh-session",
      status: "enabled",
      config: { transport: "cli", mailbox: "dsh-main" },
      created_at: "2026-08-21T00:00:00.000Z",
    });
    authority.close();
    const dsh = await startDshWebStub();
    const { app, origin } = await startPersonalApi(database, blobRoot, {
      REGENIC_DSH_BASE_URL: dsh.origin,
    });
    try {
      const inbox = await (await fetch(`${origin}/v1/me/inbox`)).json();
      const item = inbox.find((row) => row.event.source === "dsh");
      assert.equal(Boolean(item), true);
      assert.equal(item.can_send, true);

      const engine = await (await fetch(`${origin}/v1/me/engine`)).json();
      const catalog = engine.catalog.find(
        (entry) => entry.connector_type === "dsh-session",
      );
      assert.equal(
        catalog.fields.some((field) => field.key === "base_url"),
        false,
      );
      assert.equal(
        engine.installations.find((entry) => entry.id === "dsh-main").detail,
        "web",
      );

      const created = await fetch(`${origin}/v1/me/connectors`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          connector_type: "dsh-session",
          config: {
            transport: "web",
            base_url: "https://regenic-dsh.sealosbja.site",
          },
        }),
      });
      const installation = await created.json();
      assert.equal(created.status, 201, JSON.stringify(installation));
      assert.equal(installation.detail, "web");

      const replied = await fetch(`${origin}/v1/me/replies`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          thread_id: "dsh:session-hosted",
          text: "pong",
          client_request_id: "hosted-reply-1",
          attachments: [{
            filename: "proof.png",
            media_type: "image/png",
            data_base64: Buffer.from([1, 2, 3]).toString("base64"),
          }],
        }),
      });
      const body = await replied.json();
      assert.equal(replied.status, 201, JSON.stringify(body));
      assert.equal(dsh.prompts[0].payload.sessionId, "session-hosted");
      assert.equal(body.client_request_id, "hosted-reply-1");
      assert.equal(dsh.prompts[0].payload.content.find((part) => part.type === "image").name, "proof.png");
      const retried = await fetch(`${origin}/v1/me/replies`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          thread_id: "dsh:session-hosted",
          text: "must not be sent again",
          client_request_id: "hosted-reply-1",
        }),
      });
      const replay = await retried.json();
      assert.equal(retried.status, 201, JSON.stringify(replay));
      assert.equal(replay.item.event.id, body.item.event.id);
      assert.equal(replay.rpc_id, body.rpc_id);
      assert.equal(dsh.prompts.length, 1);
    } finally {
      await app.close();
      await dsh.close();
    }
  });
});
