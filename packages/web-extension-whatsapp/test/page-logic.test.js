import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  commandTargetsActiveChat,
  firstChatTitleFromLines,
  firstWhatsAppChatIdFromValues,
  isAuthorLabelText,
  isFromMeByDataId,
    isIgnorableChatListTitle,
    isLoadOlderMessagesText,
    isLoopbackApiOrigin,
    isOneShotScanResult,
    isPresenceText,
    isSendAriaLabel,
    isWhatsAppChatId,
    jidFromReactLikeValue,
    conversationJidFromCandidates,
    liveMessageBelongsToOpenChat,
    chatIdFromPhoneDisplayTitle,
    bubbleLooksOutgoing,
    fromMeFromPrePlainText,
    groupSenderFromDomTexts,
    namedChatFromRecord,
    opaqueWhatsAppLiveMessageId,
    parseWhatsAppChatId,
    parseWhatsAppDataId,
    parseWhatsAppTimestamp,
    phoneDigitsFromDisplayTitle,
    phoneDigitsFromWhatsAppChatId,
    normalizeLoopbackApiOrigin,
    senderNameFromPrePlainText,
    stableGroupParticipantId,
    stableMessageId,
    titlesReferToSameChat,
    uniqueJidForDisplayName,
} from "../dist/page-logic.js";

describe("whatsapp page logic", () => {
  it("extracts WhatsApp JIDs and rejects title slugs", () => {
    assert.equal(isWhatsAppChatId("15550001@c.us"), true);
    assert.equal(isWhatsAppChatId("example-contact"), false);
    assert.equal(parseWhatsAppChatId("true_15550001@c.us_3EB0abc"), "15550001@c.us");
    assert.equal(parseWhatsAppChatId("Example Contact"), null);
    assert.equal(
      firstWhatsAppChatIdFromValues(["hexonly", "true_12036300@g.us_3Axyz", "name"]),
      "12036300@g.us",
    );
    assert.equal(
      conversationJidFromCandidates(["1794@lid", "12036300@g.us", "1555@c.us"]),
      "12036300@g.us",
    );
    assert.equal(conversationJidFromCandidates(["1794@lid", "1555@c.us"]), null);
    assert.equal(conversationJidFromCandidates(["1555@c.us", "1555@c.us"]), "1555@c.us");
    assert.equal(liveMessageBelongsToOpenChat("12036300@g.us", "1794@lid"), true);
    assert.equal(liveMessageBelongsToOpenChat("12036300@g.us", "12036300@g.us"), true);
    assert.equal(liveMessageBelongsToOpenChat("12036300@g.us", "12036399@g.us"), false);
    assert.equal(liveMessageBelongsToOpenChat("1555@c.us", "1794@lid"), true);
    assert.equal(liveMessageBelongsToOpenChat("1555@c.us", "12036300@g.us"), false);
    assert.equal(parseWhatsAppChatId("https://wa.me/15550001234"), "15550001234@c.us");
    assert.equal(parseWhatsAppChatId("https://web.whatsapp.com/send/?phone=15550001234"), "15550001234@c.us");
  });

  it("treats localized presence lines as non-titles", () => {
    assert.equal(isPresenceText("online"), true);
    assert.equal(isPresenceText("last seen today"), true);
    assert.equal(isPresenceText("在线"), true);
    assert.equal(isPresenceText("正在输入"), true);
    assert.equal(isPresenceText("Example Contact"), false);
    assert.equal(firstChatTitleFromLines("", ["E", "Example Contact", "online"]), "Example Contact");
    assert.equal(firstChatTitleFromLines("", ["TL", "Trista Li", "last seen yesterday"]), "Trista Li");
  });

  it("resolves a unique display name to a JID and rejects title slugs", () => {
    assert.equal(
      uniqueJidForDisplayName("Trista Li", [
        { id: "15550001@c.us", names: ["Trista Li"] },
        { id: "15550002@c.us", names: ["Alex"] },
      ]),
      "15550001@c.us",
    );
    assert.equal(
      uniqueJidForDisplayName("Trista Li", [
        { id: "15550001@c.us", names: ["Trista Li"] },
        { id: "15550009@c.us", names: ["Trista Li"] },
      ]),
      null,
    );
    assert.equal(
      namedChatFromRecord({
        id: { _serialized: "15550001@c.us" },
        name: "Trista Li",
      })?.id,
      "15550001@c.us",
    );
    assert.equal(jidFromReactLikeValue({ id: { $1: "12036300@g.us" } }), "12036300@g.us");
    assert.equal(isIgnorableChatListTitle("Archived"), true);
    assert.equal(isIgnorableChatListTitle("Get WhatsApp for Mac"), true);
    assert.equal(isIgnorableChatListTitle("Trista Li"), false);
    assert.equal(phoneDigitsFromWhatsAppChatId("15550001234@c.us"), "15550001234");
    assert.equal(phoneDigitsFromWhatsAppChatId("12036300@g.us"), null);
    assert.equal(phoneDigitsFromDisplayTitle("+86 156 4034 8237"), "8615640348237");
    assert.equal(phoneDigitsFromDisplayTitle("+86 156 4034..."), "861564034");
    assert.equal(phoneDigitsFromDisplayTitle("Trista Li"), null);
    assert.equal(chatIdFromPhoneDisplayTitle("+1 (820) 206-5650"), "18202065650@c.us");
    assert.equal(fromMeFromPrePlainText("[10:27 AM, 7/9/2025] You: "), true);
    assert.equal(fromMeFromPrePlainText("[10:27 AM, 7/9/2025] 你: "), true);
    assert.equal(fromMeFromPrePlainText("[10:07 PM, 8/29/2026] Jeson Li: "), null);
    assert.equal(fromMeFromPrePlainText("[10:07 PM, 8/29/2026] Jeson Li: ", ["Jeson Li"]), true);
    assert.equal(fromMeFromPrePlainText(""), null);
    assert.deepEqual(
      groupSenderFromDomTexts(["~ Alex Diaz", "+34 603 36 98 79", "Thank you so much Jenson"]),
      { name: "Alex Diaz", phone: "+34 603 36 98 79" },
    );
    assert.equal(chatIdFromPhoneDisplayTitle("+34 603 36 98 79"), "34603369879@c.us");
    assert.equal(bubbleLooksOutgoing({ left: 0, width: 1000 }, { left: 420, width: 520 }), true);
    assert.equal(bubbleLooksOutgoing({ left: 0, width: 1000 }, { left: 16, width: 520 }), false);
    assert.equal(bubbleLooksOutgoing({ left: 0, width: 1000 }, { left: 0, width: 1000 }), null);
    assert.equal(bubbleLooksOutgoing({ left: 0, width: 1000 }, { left: 180, width: 800 }), true);
    assert.equal(titlesReferToSameChat("+86 156 4034 8237", "+86 156 4034..."), true);
    assert.equal(titlesReferToSameChat("+1 (914) 490-5793", "+1 (914) 490-5793"), true);
    assert.equal(titlesReferToSameChat("Trista Li", "Monique"), false);
    assert.equal(
      uniqueJidForDisplayName("+86 156 4034...", [
        { id: "8615640348237@c.us", names: ["+86 156 4034 8237"] },
      ]),
      "8615640348237@c.us",
    );
    assert.equal(
      senderNameFromPrePlainText("[10:07 PM, 8/29/2026] Alex Diaz: "),
      "Alex Diaz",
    );
    assert.equal(senderNameFromPrePlainText("[10:07 PM, 8/29/2026] You: "), null);
    assert.equal(isAuthorLabelText("~ Alex Diaz"), true);
    assert.equal(isAuthorLabelText("Thanks Alex."), false);
    assert.equal(isLoadOlderMessagesText("Click here to get older messages from your phone."), true);
    assert.equal(
      stableGroupParticipantId("12036300@g.us", "Alex Diaz", "1794@lid"),
      "1794@lid",
    );
    assert.equal(
      stableGroupParticipantId("12036300@g.us", "Alex Diaz"),
      "participant:12036300@g.us:alex-diaz",
    );
  });

  it("aborts a command after the open chat changes", () => {
    assert.equal(commandTargetsActiveChat("alice", "alice"), true);
    assert.equal(commandTargetsActiveChat("alice", "bob"), false);
    assert.equal(commandTargetsActiveChat("alice", null), false);
  });

  it("classifies outgoing WhatsApp data-id values", () => {
    assert.equal(isFromMeByDataId("true_123"), true);
    assert.equal(isFromMeByDataId("false_true_hidden"), false);
    assert.equal(isFromMeByDataId("false_123"), false);
    assert.equal(isFromMeByDataId("true_15550001@c.us_3EB0abc"), true);
    assert.equal(isFromMeByDataId("false_15550001@c.us_xxx_true_yyy"), false);
    assert.equal(parseWhatsAppDataId("false_15550001@c.us_xxx_true_yyy")?.from_me, false);
  });

  it("keeps live message ids free of colons so Inbox groups by chat", () => {
    assert.equal(
      stableMessageId({
        chatId: "alice",
        text: "hello",
        fromMe: false,
        dataId: "false_ABC",
      }),
      "false_ABC",
    );
    const fallback = stableMessageId({
      chatId: "12036300@g.us",
      text: "Thanks Alex.",
      fromMe: false,
      messageContext: "[10:07 PM, 8/29/2026] Alex Diaz: ",
    });
    assert.equal(fallback.includes(":"), false);
    assert.equal(
      fallback,
      opaqueWhatsAppLiveMessageId(
        "in|12036300@g.us|[10:07 PM, 8/29/2026] Alex Diaz: |Thanks Alex.",
      ),
    );
    assert.match(opaqueWhatsAppLiveMessageId("in:12036300@g.us:ctx:Thanks"), /^h[0-9a-f]{16}$/);
    assert.equal(opaqueWhatsAppLiveMessageId("3EB0abc"), "3EB0abc");
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
    assert.equal(isOneShotScanResult("one-shot no ingest (content script did not respond after injection): visible 1 in +1 (858) 922-0652; not ingested"), true);
    assert.equal(isOneShotScanResult("connected: sent 1 new / 1 visible from +1 (858) 922-0652"), false);
    assert.equal(
      normalizeLoopbackApiOrigin("https://evil.example", "http://127.0.0.1:4370"),
      "http://127.0.0.1:4370",
    );
  });
});
