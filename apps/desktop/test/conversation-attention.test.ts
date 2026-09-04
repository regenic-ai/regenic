import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { conversationPresencePayload } from "../src/shared/conversation-attention.ts";

const lookingAtInbox = {
  surface: "console" as const,
  visible: true,
  minimized: false,
  visibilityState: "visible",
  idleState: "active" as const,
  screenLocked: false,
  nav: "inbox",
  threadId: "feishu:oc_1",
};

describe("conversation attention", () => {
  it("looks at an open inbox thread only when the console is on screen and the session is live", () => {
    assert.deepEqual(conversationPresencePayload(lookingAtInbox), {
      looking: true,
      thread_id: "feishu:oc_1",
    });
  });

  it("keeps looking when the window is visible but unfocused", () => {
    assert.equal(conversationPresencePayload(lookingAtInbox).looking, true);
  });

  it("stops looking when the console is hidden, minimized, or occluded", () => {
    assert.equal(
      conversationPresencePayload({ ...lookingAtInbox, visible: false }).looking,
      false,
    );
    assert.equal(
      conversationPresencePayload({ ...lookingAtInbox, minimized: true }).looking,
      false,
    );
    assert.equal(
      conversationPresencePayload({
        ...lookingAtInbox,
        visibilityState: "hidden",
      }).looking,
      false,
    );
  });

  it("stops looking when the system is idle, locked, or suspended", () => {
    assert.equal(
      conversationPresencePayload({ ...lookingAtInbox, idleState: "idle" }).looking,
      false,
    );
    assert.equal(
      conversationPresencePayload({ ...lookingAtInbox, idleState: "locked" })
        .looking,
      false,
    );
    assert.equal(
      conversationPresencePayload({ ...lookingAtInbox, screenLocked: true })
        .looking,
      false,
    );
    assert.equal(
      conversationPresencePayload({ ...lookingAtInbox, suspended: true }).looking,
      false,
    );
  });

  it("does not treat the tray, engine page, or empty inbox as looking", () => {
    assert.equal(
      conversationPresencePayload({ ...lookingAtInbox, surface: "tray" }).looking,
      false,
    );
    assert.equal(
      conversationPresencePayload({ ...lookingAtInbox, nav: "engine" }).looking,
      false,
    );
    assert.equal(
      conversationPresencePayload({ ...lookingAtInbox, threadId: null }).looking,
      false,
    );
  });

  it("treats an unknown idle API as still attended", () => {
    assert.deepEqual(
      conversationPresencePayload({ ...lookingAtInbox, idleState: "unknown" }),
      { looking: true, thread_id: "feishu:oc_1" },
    );
  });
});
