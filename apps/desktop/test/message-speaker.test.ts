import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setActiveLocale } from "../src/shared/i18n.ts";
import {
  messageSpeakerLabel,
  messageSpeakerMark,
  roleLabel,
} from "../src/renderer/src/message-view.ts";

describe("message speaker labels", () => {
  it("shows You only for outbound user messages without a name", () => {
    setActiveLocale("en");
    assert.equal(roleLabel("user", "feishu", null, "outbound"), "You");
    assert.equal(roleLabel("user", "feishu", null, "inbound"), "Member");
    assert.equal(roleLabel("user", "feishu", "夏伟彬", "inbound"), "夏伟彬");
  });

  it("uses a distinct avatar mark for unnamed inbound peers", () => {
    setActiveLocale("en");
    assert.equal(messageSpeakerMark({ kind: "user", direction: "outbound" }), "Y");
    assert.equal(messageSpeakerMark({ kind: "user", direction: "inbound" }), "M");
  });

  it("keeps named peer labels in zh locale", () => {
    setActiveLocale("zh");
    assert.equal(
      messageSpeakerLabel({
        kind: "user",
        channel: "feishu",
        actor_label: null,
        direction: "inbound",
      }),
      "成员",
    );
    assert.equal(
      messageSpeakerLabel({
        kind: "user",
        channel: "feishu",
        actor_label: null,
        direction: "outbound",
      }),
      "你",
    );
  });
});
