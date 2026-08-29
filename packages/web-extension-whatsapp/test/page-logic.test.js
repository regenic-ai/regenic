import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  commandTargetsActiveChat,
  firstChatTitleFromLines,
  isFromMeByDataId,
  isLoopbackApiOrigin,
  isWhatsAppChatId,
  parseWhatsAppChatId,
  isPresenceText,
  isSendAriaLabel,
  normalizeLoopbackApiOrigin,
  parseWhatsAppTimestamp,
  slug,
  stableMessageId,
} from "../dist/page-logic.js";

describe("whatsapp page logic", () => {
  it("extracts WhatsApp JIDs and rejects title slugs", () => {
    assert.equal(isWhatsAppChatId("15550001@c.us"), true);
    assert.equal(isWhatsAppChatId("example-contact"), false);
    assert.equal(parseWhatsAppChatId("true_15550001@c.us_3EB0abc"), "15550001@c.us");
    assert.equal(parseWhatsAppChatId("Example Contact"), null);
  });

  it("slugs visible titles and collides on case", () => {
    assert.equal(slug("Example Contact"), "example-contact");
    assert.equal(slug("Alice"), slug("alice"));
    assert.equal(slug("!!!"), "active-chat");
  });

  it("treats localized presence lines as non-titles", () => {
    assert.equal(isPresenceText("online"), true);
    assert.equal(isPresenceText("last seen today"), true);
    assert.equal(isPresenceText("在线"), true);
    assert.equal(isPresenceText("正在输入"), true);
    assert.equal(isPresenceText("Example Contact"), false);
    assert.equal(firstChatTitleFromLines("", ["E", "Example Contact", "online"]), "Example Contact");
  });

  it("aborts a command after the open chat changes", () => {
    assert.equal(commandTargetsActiveChat("alice", "alice"), true);
    assert.equal(commandTargetsActiveChat("alice", "bob"), false);
    assert.equal(commandTargetsActiveChat("alice", null), false);
  });

  it("classifies outgoing WhatsApp data-id values", () => {
    assert.equal(isFromMeByDataId("true_123"), true);
    assert.equal(isFromMeByDataId("false_true_hidden"), true);
    assert.equal(isFromMeByDataId("false_123"), false);
  });

  it("prefers the raw WhatsApp data-id over a hashed fallback", () => {
    assert.equal(
      stableMessageId({
        chatId: "alice",
        text: "hello",
        fromMe: false,
        dataId: "false_ABC",
      }),
      "false_ABC",
    );
    assert.equal(
      stableMessageId({
        chatId: "alice",
        text: "hello",
        fromMe: true,
        messageContext: "[10:30, 8/21/2026] You: ",
      }),
      "out:alice:[10:30, 8/21/2026] You: :hello",
    );
  });

  it("parses WhatsApp pre-plain-text timestamps", () => {
    assert.equal(
      parseWhatsAppTimestamp("[10:30 AM, 8/21/2026] Alice: ", () => "now"),
      new Date("10:30 AM, 8/21/2026").toISOString(),
    );
    const european = new Date(parseWhatsAppTimestamp("[22:15, 21/08/2026] Alice: ", () => "now"));
    assert.equal(european.getFullYear(), 2026);
    assert.equal(european.getMonth(), 7);
    assert.equal(european.getDate(), 21);
    assert.equal(parseWhatsAppTimestamp("", () => "now"), "now");
  });

  it("accepts localized send labels and loopback API origins only", () => {
    assert.equal(isSendAriaLabel("Send"), true);
    assert.equal(isSendAriaLabel("发送"), true);
    assert.equal(isSendAriaLabel("Search"), false);
    assert.equal(isLoopbackApiOrigin("http://127.0.0.1:4370"), true);
    assert.equal(isLoopbackApiOrigin("http://localhost:5173"), true);
    assert.equal(isLoopbackApiOrigin("https://evil.example"), false);
    assert.equal(isLoopbackApiOrigin("http://127.0.0.1.evil.com"), false);
    assert.equal(
      normalizeLoopbackApiOrigin("https://evil.example", "http://127.0.0.1:4370"),
      "http://127.0.0.1:4370",
    );
  });
});
