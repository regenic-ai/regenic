const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { verifyChannelDriverConformance } = require("@regenic/domain");
const {
  isWhatsAppChatId,
  parseWhatsAppChatId,
  parseWhatsAppDataId,
  whatsappWebLiveDriver,
} = require("../dist");

describe("whatsapp ids", () => {
  it("accepts JIDs and rejects title slugs", () => {
    assert.equal(isWhatsAppChatId("15550001@c.us"), true);
    assert.equal(isWhatsAppChatId("120363000000000000@g.us"), true);
    assert.equal(isWhatsAppChatId("123@lid"), true);
    assert.equal(isWhatsAppChatId("example-contact"), false);
    assert.equal(parseWhatsAppChatId("true_15550001@c.us_3EB0abc"), "15550001@c.us");
    assert.equal(parseWhatsAppDataId("false_12036300@g.us_3Axyz")?.from_me, false);
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
});
