import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inboxHeadsRequest } from "../src/renderer/src/inbox-list-sync.ts";

describe("inbox heads request", () => {
  it("does not opt into live overlays on full refresh", () => {
    const request = inboxHeadsRequest({
      decision: { mode: "full", replace: true },
      list: "shown",
      previousDigest: null,
    });
    assert.equal(request.live, undefined);
  });

  it("still patches by digest", () => {
    const request = inboxHeadsRequest({
      decision: { mode: "patch", replace: false },
      list: "shown",
      previousDigest: "1:2026-01-01T00:00:00.000Z:evt:0:",
    });
    assert.equal(request.changed, true);
    assert.equal(request.since_digest, "1:2026-01-01T00:00:00.000Z:evt:0:");
  });
});
