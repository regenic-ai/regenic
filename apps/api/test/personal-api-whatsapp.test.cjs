const assert = require("node:assert/strict");
const { join } = require("node:path");
const { describe, it } = require("node:test");
const { SqliteAuthorityStore } = require("@regenic/authority-store/sqlite");
const { FsBlobStore } = require("@regenic/blob-store");
const { INGEST_SCHEMA_VERSION, IngestionService } = require("@regenic/domain");
const { createPurrWhatsAppImport } = require("@regenic/connector-host");
const {
  createRoot,
  startPersonalApi,
} = require("./personal-api-harness.cjs");

describe("personal /v1/me", { concurrency: 1 }, () => {
  it("imports an explicit WhatsApp Personal Export v1 file without egress", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    const { app, origin } = await startPersonalApi(database, blobRoot);
    try {
      const imported = await fetch(`${origin}/v1/me/imports/whatsapp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          content: `${JSON.stringify({
            schema_version: "1.0",
            kind: "whatsapp_personal_message",
            message_id: "message-1",
            chat_id: "chat-1",
            chat_name: "Family",
            sender_id: "contact-1",
            sender_name: "Alex",
            direction: "incoming",
            sent_at: "2026-08-21T00:00:00.000Z",
            text: "Please call me.",
          })}\n`,
        }),
      });
      const result = await imported.json();
      assert.equal(imported.status, 201, JSON.stringify(result));
      assert.equal(result.accepted_count, 1);
      assert.equal(result.invalid_line_count, 0);

      const inbox = await (await fetch(`${origin}/v1/me/inbox`)).json();
      const item = inbox.find((entry) => entry.event.source === "whatsapp-personal");
      assert.equal(item.body_text, "Please call me.");
      assert.equal(item.can_send, false);

      const generic = await fetch(`${origin}/v1/me/imports`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          connector_type: "whatsapp-web-live",
          content: `${JSON.stringify({
            schema_version: "1.0",
            kind: "whatsapp_personal_message",
            message_id: "message-2",
            chat_id: "chat-1",
            sender_id: "contact-1",
            direction: "incoming",
            sent_at: "2026-08-21T00:01:00.000Z",
            text: "Second line.",
          })}\n`,
        }),
      });
      const genericBody = await generic.json();
      assert.equal(generic.status, 201, JSON.stringify(genericBody));
      assert.equal(genericBody.accepted_count, 1);
    } finally {
      await app.close();
    }
  });

  it("ingests WhatsApp Web live messages through the connector webhook and replies through egress", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    const { app, origin } = await startPersonalApi(database, blobRoot, {
      REGENIC_PERSONAL_LIVE_KEY: "live-key",
    });
    const auth = { "content-type": "application/json", "x-regenic-live-key": "live-key" };
    try {
      const installed = await (
        await fetch(`${origin}/v1/me/connectors`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ connector_type: "whatsapp-web-live" }),
        })
      ).json();
      assert.equal(installed.connector_type, "whatsapp-web-live");
      assert.equal(installed.can_reply, true);
      assert.equal(typeof installed.pairing_code, "string");
      assert.ok(installed.pairing_code.length >= 16);
      const installId = installed.id;
      const engine = await (await fetch(`${origin}/v1/me/engine`)).json();
      assert.equal(
        JSON.stringify(engine).includes(installed.pairing_code),
        false,
      );

      const unauthorized = await fetch(`${origin}/v1/me/connectors/${installId}/webhook`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "chrome-extension://abcdefghijklmnop",
        },
        body: JSON.stringify({ type: "poll" }),
      });
      assert.equal(unauthorized.status, 401);

      const skippedSlug = await fetch(`${origin}/v1/me/connectors/${installId}/webhook`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          chat_id: "example-contact",
          chat_title: "Example Contact",
          message_id: "slug-1",
          text: "Should not ingest a title slug",
          from_me: false,
        }),
      });
      const skippedBody = await skippedSlug.json();
      assert.equal(skippedSlug.status, 201, JSON.stringify(skippedBody));
      assert.equal(skippedBody.accepted_count, 0);

      const accepted = await fetch(`${origin}/v1/me/connectors/${installId}/webhook`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          chat_id: "15550001@c.us",
          chat_title: "Example Contact",
          message_id: "live-1",
          sender_id: "15550001@c.us",
          sender_name: "Example Contact",
          text: "Are you there?",
          timestamp: "2026-08-21T00:00:00.000Z",
          from_me: false,
        }),
      });
      const acceptedBody = await accepted.json();
      assert.equal(accepted.status, 201, JSON.stringify(acceptedBody));
      assert.equal(acceptedBody.accepted_count, 1);

      const inbox = await (await fetch(`${origin}/v1/me/inbox`)).json();
      const item = inbox.find((entry) => entry.event.external_id === "15550001@c.us:live-1");
      assert.equal(item.body_text, "Are you there?");
      assert.equal(item.direction, "inbound");
      assert.equal(item.actor_label, "Example Contact");
      assert.equal(item.conversation_label, "Example Contact");
      assert.equal(item.conversation_kind, "direct");
      assert.equal(item.can_send, true);
      assert.equal(item.event.source, "whatsapp-personal");

      const replied = await fetch(`${origin}/v1/me/replies`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          thread_id: "whatsapp-personal:15550001@c.us",
          text: "Draft reply",
        }),
      });
      const repliedBody = await replied.json();
      assert.equal(replied.status, 201, JSON.stringify(repliedBody));
      assert.equal(repliedBody.item.event.external_id.startsWith("15550001@c.us:out:"), true);

      const commands = await (
        await fetch(`${origin}/v1/me/connectors/${installId}/egress`, {
          headers: { "x-regenic-live-key": "live-key" },
        })
      ).json();
      assert.equal(commands.commands.length, 1);
      assert.equal(commands.commands[0].chat_id, "15550001@c.us");
      assert.equal(commands.commands[0].text, "Draft reply");
      assert.equal(commands.commands[0].send_now, true);

      const ack = await fetch(
        `${origin}/v1/me/connectors/${installId}/egress/${commands.commands[0].id}/ack`,
        { method: "POST", headers: { "x-regenic-live-key": "live-key" } },
      );
      assert.equal(ack.status, 201);
      const afterAck = await (
        await fetch(`${origin}/v1/me/connectors/${installId}/egress`, {
          headers: { "x-regenic-live-key": "live-key" },
        })
      ).json();
      assert.equal(afterAck.commands.length, 0);

      for (let index = 0; index < 100; index += 1) {
        const queuedAtCapacity = await fetch(`${origin}/v1/me/replies`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            thread_id: `whatsapp-personal:queue-${index}@c.us`,
            text: `Draft ${index}`,
          }),
        });
        assert.equal(queuedAtCapacity.status, 201, `queue ${index}`);
      }
      const queueFull = await fetch(`${origin}/v1/me/replies`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          thread_id: "whatsapp-personal:queue-overflow@c.us",
          text: "Overflow draft",
          client_request_id: "overflow-retry",
        }),
      });
      assert.equal(queueFull.status, 429);
      const fullQueue = await (await fetch(`${origin}/v1/me/connectors/${installId}/egress`, {
        headers: { "x-regenic-live-key": "live-key" },
      })).json();
      assert.equal(fullQueue.commands.length, 100);
      const freed = await fetch(
        `${origin}/v1/me/connectors/${installId}/egress/${fullQueue.commands[0].id}/ack`,
        { method: "POST", headers: { "x-regenic-live-key": "live-key" } },
      );
      assert.equal(freed.status, 201);
      const retry = async () => fetch(`${origin}/v1/me/replies`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          thread_id: "whatsapp-personal:queue-overflow@c.us",
          text: "Overflow draft",
          client_request_id: "overflow-retry",
        }),
      });
      const retried = await retry();
      const retriedBody = await retried.json();
      assert.equal(retried.status, 201, JSON.stringify(retriedBody));
      const replayed = await retry();
      assert.equal(replayed.status, 201);
      assert.equal((await replayed.json()).item.event.id, retriedBody.item.event.id);
      const afterRetry = await (await fetch(`${origin}/v1/me/connectors/${installId}/egress`, {
        headers: { "x-regenic-live-key": "live-key" },
      })).json();
      assert.equal(afterRetry.commands.length, 100);
      assert.equal(afterRetry.commands.filter((command) => command.chat_id === "queue-overflow@c.us").length, 1);
    } finally {
      await app.close();
    }
  });

  it("requires a configured live key for WhatsApp Web webhook browser origins", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    const { app, origin } = await startPersonalApi(database, blobRoot);
    try {
      const installed = await (
        await fetch(`${origin}/v1/me/connectors`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ connector_type: "whatsapp-web-live" }),
        })
      ).json();
      const webhook = `${origin}/v1/me/connectors/${installed.id}/webhook`;
      const body = JSON.stringify({ type: "poll" });

      const browserPage = await fetch(webhook, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://web.whatsapp.com" },
        body,
      });
      assert.equal(browserPage.status, 403);

      const extensionPage = await fetch(webhook, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "chrome-extension://abcdefghijklmnop",
        },
        body,
      });
      assert.equal(extensionPage.status, 401);

      const localCli = await fetch(webhook, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      assert.equal(localCli.status, 201);

      const revealed = await (
        await fetch(`${origin}/v1/me/connectors/${installed.id}/pairing-code`)
      ).json();
      assert.equal(typeof revealed.pairing_code, "string");
      const paired = await fetch(webhook, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "chrome-extension://abcdefghijklmnop",
          "x-regenic-live-key": revealed.pairing_code,
        },
        body,
      });
      assert.equal(paired.status, 201);

      const extensionEngine = await fetch(`${origin}/v1/me/engine`, {
        headers: {
          origin: "chrome-extension://abcdefghijklmnop",
          "x-regenic-live-key": revealed.pairing_code,
        },
      });
      assert.equal(extensionEngine.status, 200);

      const liveKeyCannotReadInbox = await fetch(`${origin}/v1/me/inbox`, {
        headers: {
          origin: "chrome-extension://abcdefghijklmnop",
          "x-regenic-live-key": revealed.pairing_code,
        },
      });
      assert.equal(liveKeyCannotReadInbox.status, 401);

      const liveKeyCannotAskContext = await fetch(`${origin}/v1/me/context/ask`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "chrome-extension://abcdefghijklmnop",
          "x-regenic-live-key": revealed.pairing_code,
        },
        body: JSON.stringify({ question: "Reveal context" }),
      });
      assert.equal(liveKeyCannotAskContext.status, 401);

      const egress = await fetch(`${origin}/v1/me/connectors/${installed.id}/egress`, {
        headers: {
          origin: "chrome-extension://abcdefghijklmnop",
        },
      });
      assert.equal(egress.status, 401);
    } finally {
      await app.close();
    }
  });

  it("imports a user-selected Purr WA CSV without egress", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    const content = [
      "datetime,sender,fromMe,type,text",
      '"21/08/2026 14:30","Alex",0,chat,"Please call me."',
      '"21/08/2026 14:31","You",1,chat,"Calling now."',
    ].join("\n");
    const fileName = "Family_15550001_c_us.csv";
    const converted = createPurrWhatsAppImport({
      data: content,
      file_name: fileName,
      org_id: "local-owner",
      local_principal_id: "local-owner",
      received_at: "2026-08-21T15:00:00.000Z",
    });
    const authority = new SqliteAuthorityStore(database);
    const service = new IngestionService(new FsBlobStore(blobRoot), authority);
    await service.ingest({
      ...converted.batches[0],
      records: converted.batches[0].records.map((record) => ({
        ...record,
        content: record.content.filter((part) => part.role === "body"),
      })),
    });
    authority.close();

    const { app, origin } = await startPersonalApi(database, blobRoot);
    try {
      const imported = await fetch(`${origin}/v1/me/imports/whatsapp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          content,
          file_name: fileName,
        }),
      });
      const result = await imported.json();
      assert.equal(imported.status, 201, JSON.stringify(result));
      assert.equal(result.accepted_count, 2);
      assert.equal(result.invalid_line_count, 0);

      const inbox = await (await fetch(`${origin}/v1/me/inbox`)).json();
      const items = inbox.filter(
        (entry) => entry.event.source === "whatsapp-personal",
      );
      assert.equal(items.length, 2);
      assert.equal(items.every((item) => item.can_send === false), true);
      const incoming = items.find((item) => item.direction === "inbound");
      const outgoing = items.find((item) => item.direction === "outbound");
      assert.equal(incoming.kind, "user");
      assert.equal(incoming.actor_label, "Alex");
      assert.equal(incoming.conversation_label, "Family");
      assert.equal(incoming.conversation_kind, "direct");
      assert.equal(outgoing.kind, "user");
      assert.equal(outgoing.actor_label, null);

      const replayed = await fetch(`${origin}/v1/me/imports/whatsapp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          content,
          file_name: fileName,
        }),
      });
      const replayedResult = await replayed.json();
      assert.equal(replayed.status, 201, JSON.stringify(replayedResult));
      assert.equal(replayedResult.accepted_count, 0);
      assert.equal(replayedResult.duplicate_count, 2);
    } finally {
      await app.close();
    }
  });

  it("rejects WhatsApp import content larger than 20 MiB", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    const { app, origin } = await startPersonalApi(database, blobRoot);
    try {
      const response = await fetch(`${origin}/v1/me/imports/whatsapp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "x".repeat(20 * 1024 * 1024 + 1) }),
      });
      const body = await response.json();

      assert.equal(response.status, 413, JSON.stringify(body));
      assert.equal(body.error.code, "invalid_config");
    } finally {
      await app.close();
    }
  });

  it("rejects a Purr CSV file with no valid message batch", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    const { app, origin } = await startPersonalApi(database, blobRoot);
    try {
      const response = await fetch(`${origin}/v1/me/imports/whatsapp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          content: "time,sender,fromMe,type,text\n21/08/2026 14:30,Alex,0,chat,Hello",
          file_name: "Family_15550001_c_us.csv",
        }),
      });
      const body = await response.json();

      assert.equal(response.status, 400, JSON.stringify(body));
      assert.equal(body.error.code, "invalid_config");
    } finally {
      await app.close();
    }
  });
});
