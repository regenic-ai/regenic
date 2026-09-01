import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  liveReceiptFocusRequest,
  mediaDrainFocusRequest,
  openThreadFocusRequest,
  pullOlderFocusRequest,
} from "../src/shared/conversation-focus.ts";

describe("conversation focus requests", () => {
  it("builds open, live, and pull-older payloads", () => {
    assert.deepEqual(openThreadFocusRequest("feishu:oc_1", true), {
      thread_id: "feishu:oc_1",
      hydrate: true,
      present: true,
    });
    assert.deepEqual(openThreadFocusRequest("feishu:oc_1", false), {
      thread_id: "feishu:oc_1",
      hydrate: false,
      present: true,
    });
    assert.deepEqual(liveReceiptFocusRequest("feishu:oc_1"), {
      thread_id: "feishu:oc_1",
      live: true,
      present: true,
    });
    assert.deepEqual(
      pullOlderFocusRequest("feishu:oc_1", "2026-01-01T00:00:00.000Z", "e1"),
      {
        thread_id: "feishu:oc_1",
        pull_older: true,
        before: "2026-01-01T00:00:00.000Z",
        before_id: "e1",
        present: true,
      },
    );
    assert.deepEqual(mediaDrainFocusRequest("feishu:oc_1"), {
      thread_id: "feishu:oc_1",
      media: true,
      present: true,
    });
  });
});
