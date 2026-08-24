const assert = require("node:assert/strict");
const { afterEach, describe, it } = require("node:test");
const { LOCAL_PROXY_HINT } = require("@regenic/domain");
const {
  applyPullOutcome,
  PREFER_THREAD_MS,
  preferThread,
  preferredThreadId,
  publishPullStreams,
  pullStatus,
  resetPullStatus,
} = require("../dist/personal-pull-status");
const {
  shouldHydrateOpenedInbox,
  shouldPollOpenedHydrate,
  shouldWaitForOpenedHydrate,
} = require("../dist/personal-connector.service");

afterEach(() => {
  resetPullStatus({});
});

describe("pull status network watch", () => {
  it("clears the last error and network hint after a clean tick", async () => {
    pullStatus.last_error = "stale";
    pullStatus.last_error_hint = "stale hint";
    await applyPullOutcome([], { env: {} });
    assert.equal(pullStatus.last_error, null);
    assert.equal(pullStatus.last_error_hint, null);
    assert.equal(pullStatus.network.kind, "ok");
    assert.equal(pullStatus.network.hint, null);
  });

  it("keeps a later success from hiding a transport failure", async () => {
    await applyPullOutcome(
      [
        new Error("Cannot reach service at http://127.0.0.1:3080: fetch failed"),
        new Error("lark-cli missing"),
      ],
      {
        env: {},
        async connect() {
          return "ok";
        },
      },
    );
    assert.match(pullStatus.last_error, /fetch failed/);
    assert.equal(pullStatus.last_error_hint, LOCAL_PROXY_HINT);
    assert.equal(pullStatus.network.kind, "proxy");
  });

  it("keeps the open thread first when publishing pull streams", () => {
    preferThread("feishu:oc_hot");
    publishPullStreams([
      {
        stream_key: "a:chat:oc_old",
        thread_id: "feishu:oc_old",
        label: "Old",
        phase: "catching_up",
        last_error: null,
      },
      {
        stream_key: "a:chat:oc_hot",
        thread_id: "feishu:oc_hot",
        label: "Hot",
        phase: "error",
        last_error: "lark-cli timed out after 60000ms",
      },
    ]);
    assert.equal(preferredThreadId(), "feishu:oc_hot");
    assert.equal(pullStatus.streams[0].thread_id, "feishu:oc_hot");
    assert.equal(pullStatus.catching_up_count, 1);
  });

  it("expires a preferred thread so an old open does not own catch-up", () => {
    preferThread("feishu:oc_hot", 1_000);
    assert.equal(preferredThreadId(1_000), "feishu:oc_hot");
    assert.equal(preferredThreadId(1_000 + PREFER_THREAD_MS), null);
  });
});

describe("opened inbox hydrate", () => {
  it("only hydrates a thread open, not heads or incremental polls", () => {
    assert.equal(shouldHydrateOpenedInbox({ thread_id: "feishu:oc_1" }), true);
    assert.equal(
      shouldHydrateOpenedInbox({ thread_id: "feishu:oc_1", since: "2026-08-24T00:00:00.000Z" }),
      false,
    );
    assert.equal(
      shouldHydrateOpenedInbox({ thread_id: "feishu:oc_1", before: "2026-08-24T00:00:00.000Z" }),
      false,
    );
    assert.equal(shouldHydrateOpenedInbox({ thread_id: "feishu:oc_1", heads: true }), false);
    assert.equal(shouldHydrateOpenedInbox({ heads: true }), false);
    assert.equal(shouldHydrateOpenedInbox({ thread_id: "dsh:session-x" }), true);
  });

  it("does not wait for hydrate when the local thread already has a page", () => {
    assert.equal(shouldWaitForOpenedHydrate(0), true);
    assert.equal(shouldWaitForOpenedHydrate(1), false);
    assert.equal(shouldWaitForOpenedHydrate(23), false);
  });

  it("does not poll hydrate again when the stream is already busy", () => {
    assert.equal(shouldPollOpenedHydrate({ localCount: 0, streamBusy: false }), true);
    assert.equal(shouldPollOpenedHydrate({ localCount: 0, streamBusy: true }), false);
    assert.equal(shouldPollOpenedHydrate({ localCount: 1, streamBusy: false }), false);
  });
});
