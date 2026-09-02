const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  shouldDeferWorkForThread,
  syncPhaseForThread,
} = require("../dist/personal-sync-phase");

function authority(membersByInstallation, statesByInstallation) {
  return {
    async listInstallations() {
      return [{ id: "feishu-1", status: "enabled" }];
    },
    async getSyncCatalog(installationId) {
      return { members: membersByInstallation[installationId] ?? [] };
    },
    async listSyncStates(installationId) {
      return statesByInstallation[installationId] ?? [];
    },
  };
}

describe("personal sync phase", () => {
  it("reads phase from sync catalog, not mounted streams", async () => {
    const store = authority(
      {
        "feishu-1": [
          {
            installation_id: "feishu-1",
            stream_key: "chat:1",
            thread_id: "feishu:1",
            generation: 1,
            discovered_at: "2026-08-31T00:00:00.000Z",
            last_seen_at: "2026-08-31T00:00:00.000Z",
          },
        ],
      },
      {
        "feishu-1": [
          {
            installation_id: "feishu-1",
            stream_key: "chat:1",
            phase: "history",
            media_pending: false,
            generation: 1,
            updated_at: "2026-08-31T00:00:00.000Z",
            live_cursor: "{}",
            history_cursor: "{}",
          },
        ],
      },
    );

    const phase = await syncPhaseForThread(store, "example-org", "feishu:1");
    assert.equal(phase, "history");
    assert.equal(
      await shouldDeferWorkForThread(store, "example-org", "feishu:1"),
      true,
    );
  });

  it("does not defer when catalog has no matching thread", async () => {
    const store = authority({ "feishu-1": [] }, { "feishu-1": [] });
    assert.equal(await syncPhaseForThread(store, "example-org", "feishu:1"), undefined);
    assert.equal(
      await shouldDeferWorkForThread(store, "example-org", "feishu:1"),
      false,
    );
  });
});
