const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { asConnectorHost, readInstallSecret, setKeychainStoreForTests, verifyChannelDriverConformance } = require("@regenic/domain");
const { conversationId } = require("@regenic/domain");
const {
  isWhatsAppChatId,
  parseWhatsAppChatId,
  parseWhatsAppDataId,
  whatsAppLiveActorId,
  whatsappLiveExternalId,
  whatsappThreadId,
  whatsappWebLiveDriver,
} = require("../dist");

function fakeHost() {
  return asConnectorHost({
    get(name) {
      if (name === "connectors" || name === "egress") {
        return {};
      }
      throw new Error(`Service is not available: ${name}`);
    },
    async plugin() {
      return { ready: async () => undefined, dispose: async () => undefined };
    },
  });
}

function withTestKeychain() {
  const store = new Map();
  setKeychainStoreForTests({
    write(service, account, secret) {
      store.set(`${service}:${account}`, secret);
    },
    async read(service, account) {
      return store.get(`${service}:${account}`);
    },
  });
  return store;
}

describe("whatsapp ids", () => {
  it("accepts JIDs and rejects title slugs", () => {
    assert.equal(isWhatsAppChatId("15550001@c.us"), true);
    assert.equal(isWhatsAppChatId("120363000000000000@g.us"), true);
    assert.equal(isWhatsAppChatId("123@lid"), true);
    assert.equal(isWhatsAppChatId("example-contact"), false);
    assert.equal(parseWhatsAppChatId("true_15550001@c.us_3EB0abc"), "15550001@c.us");
    assert.equal(parseWhatsAppDataId("false_12036300@g.us_3Axyz")?.from_me, false);
    assert.equal(whatsAppLiveActorId({ chatId: "1555@c.us", fromMe: true }), "local-owner");
    assert.equal(
      whatsAppLiveActorId({ chatId: "1555@c.us", fromMe: false, senderId: "1555@c.us" }),
      "1555@c.us",
    );
    assert.equal(
      whatsAppLiveActorId({
        chatId: "12036300@g.us",
        fromMe: false,
        senderId: "34603369879@c.us",
      }),
      "34603369879@c.us",
    );
    assert.equal(
      whatsAppLiveActorId({
        chatId: "12036300@g.us",
        fromMe: false,
        senderId: "participant:12036300@g.us:alex-diaz",
      }),
      "participant:12036300@g.us:alex-diaz",
    );
    assert.equal(
      whatsAppLiveActorId({ chatId: "12036300@g.us", fromMe: false, senderId: "" }),
      undefined,
    );
    assert.equal(
      conversationId("whatsapp-personal", whatsappLiveExternalId("12036300@g.us", "3EB0abc")),
      whatsappThreadId("12036300@g.us"),
    );
    assert.equal(
      conversationId(
        "whatsapp-personal",
        whatsappLiveExternalId(
          "12036300@g.us",
          "in:12036300@g.us:[10:07 PM, 8/29/2026] Alex: :Thanks Alex.",
        ),
      ),
      whatsappThreadId("12036300@g.us"),
    );
    assert.notEqual(
      conversationId(
        "whatsapp-personal",
        "12036300@g.us:in:12036300@g.us:[10:07 PM, 8/29/2026] Alex: :Thanks Alex.",
      ),
      whatsappThreadId("12036300@g.us"),
    );
  });
});

describe("whatsapp-web-live driver", () => {
  it("conforms to the channel driver contract", () => {
    verifyChannelDriverConformance({
      driver: whatsappWebLiveDriver,
      enabled: {
        id: "wa-1",
        org_id: "local-owner",
        connector_type: "whatsapp-web-live",
        status: "enabled",
        config: {},
        created_at: "2026-08-21T00:00:00.000Z",
      },
      disabled: {
        id: "wa-1",
        org_id: "local-owner",
        connector_type: "whatsapp-web-live",
        status: "disabled",
        config: {},
        created_at: "2026-08-21T00:00:00.000Z",
      },
    });
    assert.equal(whatsappWebLiveDriver.source_mode, "webhook");
    assert.equal(whatsappWebLiveDriver.source, "whatsapp-personal");
    assert.equal(typeof whatsappWebLiveDriver.parseImport, "function");
    assert.ok(whatsappWebLiveDriver.installCatalog().import_files.accept.includes(".csv"));
  });

  it("maps fromMe to local-owner and group peers to phone JID plus display name", async () => {
    withTestKeychain();
    try {
      const installed = whatsappWebLiveDriver.install({
        id: "wa-1",
        org_id: "local-owner",
        config: {},
        now: "2026-08-21T00:00:00.000Z",
      });
      const bound = await whatsappWebLiveDriver.bindWebhook(
        installed,
        fakeHost(),
        { LISTEN_HOST: "127.0.0.1" },
      );
      const own = await bound.handleWebhook({
        body: new TextEncoder().encode(JSON.stringify({
          chat_id: "15558659220652@c.us",
          chat_title: "+1 (858) 922-0652",
          message_id: "3EB0own",
          sender_id: "local-owner",
          sender_name: "Jeson Li",
          text: "Hello, Biobyai here.",
          timestamp: "2025-07-09T18:58:00.000Z",
          from_me: true,
        })),
        verified_at: "2026-08-21T00:00:00.000Z",
      });
      assert.equal(own.records[0].actor.id, "local-owner");
      assert.equal(own.records[0].actor.display_name, undefined);
      assert.deepEqual(own.records[0].direction_tags, ["outbound"]);
      const peer = await bound.handleWebhook({
        body: new TextEncoder().encode(JSON.stringify({
          chat_id: "12036300@g.us",
          chat_title: "Bioby&konectnetwork",
          message_id: "3EB0peer",
          sender_id: "34603369879@c.us",
          sender_name: "Alex Diaz",
          text: "Thank you so much Jenson",
          timestamp: "2026-08-29T22:07:00.000Z",
          from_me: false,
        })),
        verified_at: "2026-08-21T00:00:00.000Z",
      });
      assert.equal(peer.records[0].actor.id, "34603369879@c.us");
      assert.equal(peer.records[0].actor.display_name, "Alex Diaz");
      assert.deepEqual(peer.records[0].direction_tags, ["inbound"]);
    } finally {
      setKeychainStoreForTests();
    }
  });

  it("revises an existing Purr CSV id and leaves a fresh export as create", () => {
    const fileName = "Family_15550001_c_us.csv";
    const content = [
      "datetime,sender,fromMe,type,text",
      '"21/08/2026 14:30","Alex",0,chat,"Please call me."',
    ].join("\n");
    const input = {
      content,
      file_name: fileName,
      org_id: "local-owner",
      local_principal_id: "local-owner",
      received_at: "2026-08-21T15:00:00.000Z",
    };
    const first = whatsappWebLiveDriver.parseImport(input);
    assert.equal(first.batches[0].records[0].operation, "create");
    const existing = first.batches[0].records[0].external_id;
    const replay = whatsappWebLiveDriver.parseImport({
      ...input,
      existing_external_ids: [existing],
    });
    assert.equal(replay.batches[0].records[0].operation, "revise");
    assert.equal(replay.batches[0].records[0].revision_id, "purr-wa-surface-v1");
  });

  it("creates a pairing code on install and does not block the catalog", async () => {
    withTestKeychain();
    try {
      const catalog = whatsappWebLiveDriver.installCatalog();
      assert.equal(catalog.prerequisites, undefined);
      assert.match(catalog.credential_hint, /Pairing code/);
      assert.equal(catalog.setup_steps[0].title, "Install this connector");
      assert.equal(catalog.setup_steps[0].title_zh, "安装这个连接器");
      const installed = whatsappWebLiveDriver.install({
        id: "wa-1",
        org_id: "local-owner",
        config: {},
        now: "2026-08-21T00:00:00.000Z",
      });
      const pairing = await readInstallSecret(
        "whatsapp-web-live",
        "wa-1",
        "pairing_code",
      );
      assert.equal(typeof pairing, "string");
      assert.ok(pairing.length >= 16);
      const bound = await whatsappWebLiveDriver.bindWebhook(
        installed,
        fakeHost(),
        { LISTEN_HOST: "127.0.0.1" },
      );
      const verified = await bound.verifyWebhook({
        headers: {
          origin: "chrome-extension://abcdefghijklmnop",
          "x-regenic-live-key": pairing,
        },
        body: new Uint8Array(),
        received_at: "2026-08-21T00:00:00.000Z",
      });
      assert.equal(verified.verified_at, "2026-08-21T00:00:00.000Z");
      await assert.rejects(
        () =>
          bound.verifyWebhook({
            headers: { origin: "chrome-extension://abcdefghijklmnop" },
            body: new Uint8Array(),
            received_at: "2026-08-21T00:00:00.000Z",
          }),
        /live connector API key/i,
      );
    } finally {
      setKeychainStoreForTests();
    }
  });
});
