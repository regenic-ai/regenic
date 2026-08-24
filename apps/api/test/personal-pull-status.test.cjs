const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { LOCAL_PROXY_HINT } = require("@regenic/domain");
const {
  applyPullOutcome,
  pullStatus,
} = require("../dist/personal-pull-status");

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
});
