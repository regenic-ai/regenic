const assert = require("node:assert/strict");
const { afterEach, describe, it } = require("node:test");
const { DeadlineExceededError, LOCAL_PROXY_HINT } = require("@regenic/domain");
const {
  applyPullOutcome,
  beginPull,
  finishPull,
  PREFER_THREAD_MS,
  preferThread,
  preferredThreadId,
  publishPullStreams,
  pullStatus,
  resetPullStatus,
} = require("../dist/personal-pull-status");
const {
  shouldHydrateOpenedInbox,
} = require("../dist/personal-inbox-query");
const {
  shouldMarkHumanPresent,
  shouldPullOlderFocus,
} = require("../dist/personal-conversation-focus");
const { shouldSkipLiveChannelOverlays } = require("../dist/personal-inbox.service");

afterEach(() => {
  resetPullStatus({});
});

describe("pull status overlapping pulls", () => {
  it("stays pulling until the last overlapping sync finishes", () => {
    beginPull();
    beginPull();
    finishPull({ accepted: 1, pages: 1, catchingUp: 0 });
    assert.equal(pullStatus.phase, "pulling");
    assert.equal(pullStatus.last_accepted_count, 1);
    finishPull({ accepted: 2, pages: 1, catchingUp: 0 });
    assert.equal(pullStatus.phase, "idle");
    assert.equal(pullStatus.last_accepted_count, 2);
  });

  it("clears an in-flight pull count on reset", () => {
    beginPull();
    resetPullStatus({});
    assert.equal(pullStatus.phase, "idle");
    beginPull();
    finishPull({ accepted: 0, pages: 0, catchingUp: 0 });
    assert.equal(pullStatus.phase, "idle");
  });
});

describe("pull status network watch", () => {
  it("does not keep a tick deadline as the last pull error", async () => {
    pullStatus.last_error = "stale";
    pullStatus.last_error_hint = "stale hint";
    await applyPullOutcome(
      [new DeadlineExceededError("sync slack-channel", 30_000)],
      { env: {} },
    );
    assert.equal(pullStatus.last_error, null);
    assert.equal(pullStatus.last_error_hint, null);
  });

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
        work: null,
        last_error: null,
      },
      {
        stream_key: "a:chat:oc_hot",
        thread_id: "feishu:oc_hot",
        label: "Hot",
        phase: "error",
        work: null,
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
    assert.equal(shouldHydrateOpenedInbox({ thread_id: "feishu:oc_1", live: true }), false);
    assert.equal(shouldHydrateOpenedInbox({ heads: true }), false);
    assert.equal(shouldHydrateOpenedInbox({ thread_id: "dsh:session-x" }), true);
  });

  it("pulls older only via explicit focus, not inbox query shape alone", () => {
    assert.equal(
      shouldPullOlderFocus({
        thread_id: "feishu:oc_1",
        pull_older: true,
        before: "2026-08-24T00:00:00.000Z",
      }),
      true,
    );
    assert.equal(
      shouldPullOlderFocus({
        thread_id: "feishu:oc_1",
        before: "2026-08-24T00:00:00.000Z",
      }),
      false,
    );
    assert.equal(
      shouldMarkHumanPresent({ thread_id: "feishu:oc_1" }),
      true,
    );
    assert.equal(
      shouldMarkHumanPresent({ thread_id: "feishu:oc_1", present: false }),
      false,
    );
    assert.equal(
      shouldSkipLiveChannelOverlays({ thread_id: "feishu:oc_1" }),
      true,
    );
    assert.equal(
      shouldSkipLiveChannelOverlays({
        thread_id: "feishu:oc_1",
        since: "2026-08-24T00:00:00.000Z",
      }),
      true,
    );
    assert.equal(
      shouldSkipLiveChannelOverlays({ thread_id: "feishu:oc_1", live: true }),
      false,
    );
    assert.equal(shouldSkipLiveChannelOverlays({ heads: true }), true);
    assert.equal(
      shouldSkipLiveChannelOverlays({
        heads: true,
        before: "2026-08-24T00:00:00.000Z",
      }),
      true,
    );
    assert.equal(
      shouldSkipLiveChannelOverlays({
        heads: true,
        live: true,
      }),
      false,
    );
    assert.equal(
      shouldSkipLiveChannelOverlays({
        heads: true,
        before: "2026-08-24T00:00:00.000Z",
        live: true,
      }),
      false,
    );
  });
});
