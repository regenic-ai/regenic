import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  connectionErrorForReachability,
  connectionReachability,
  shouldKeepStaleUi,
} from "../src/shared/connection-state.ts";

describe("connection state", () => {
  it("keeps stale ui for degraded reachability", () => {
    assert.equal(shouldKeepStaleUi("degraded"), true);
    assert.equal(shouldKeepStaleUi("offline"), false);
  });

  it("maps latency to degraded instead of offline", () => {
    assert.equal(
      connectionReachability({
        health_ok: true,
        personal_ok: true,
        latency_ms: 9_000,
      }),
      "degraded",
    );
  });

  it("shows different copy for degraded and offline", () => {
    const copy = {
      offline: ({ origin }: { origin: string }) => `offline ${origin}`,
      degraded: ({ origin }: { origin: string }) => `slow ${origin}`,
    };
    assert.match(
      connectionErrorForReachability("degraded", "http://127.0.0.1:4370", copy),
      /slow/,
    );
    assert.match(
      connectionErrorForReachability("offline", "http://127.0.0.1:4370", copy),
      /offline/,
    );
    assert.equal(
      connectionErrorForReachability("live", "http://127.0.0.1:4370", copy),
      null,
    );
  });
});
