const assert = require("node:assert/strict");
const { describe, it, afterEach } = require("node:test");
const {
  clearOrgSyncPhaseIndex,
  loadOrgSyncPhaseIndex,
  shouldDeferProjectionForPhase,
  shouldDeferWorkForThread,
  syncPhaseForThread,
  syncPhaseFromIndex,
} = require("../dist/personal-sync-phase");

afterEach(() => {
  clearOrgSyncPhaseIndex();
});

function authority(membersByInstallation, statesByInstallation) {
  let catalogLoads = 0;
  return {
    catalogLoads: () => catalogLoads,
    async listInstallations() {
      return [{ id: "feishu-1", status: "enabled" }];
    },
    async getSyncCatalog(installationId) {
      catalogLoads += 1;
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
    assert.equal(shouldDeferProjectionForPhase(phase), false);
  });

  it("does not defer when catalog has no matching thread", async () => {
    const store = authority({ "feishu-1": [] }, { "feishu-1": [] });
    assert.equal(await syncPhaseForThread(store, "example-org", "feishu:1"), undefined);
    assert.equal(
      await shouldDeferWorkForThread(store, "example-org", "feishu:1"),
      false,
    );
  });

  it("loads the org catalog once per tick window", async () => {
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
          {
            installation_id: "feishu-1",
            stream_key: "chat:2",
            thread_id: "feishu:2",
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
          {
            installation_id: "feishu-1",
            stream_key: "chat:2",
            phase: "live",
            media_pending: false,
            generation: 1,
            updated_at: "2026-08-31T00:00:00.000Z",
            live_cursor: "{}",
            history_cursor: "{}",
          },
        ],
      },
    );
    const index = await loadOrgSyncPhaseIndex(store, "example-org", 1_000);
    assert.equal(store.catalogLoads(), 1);
    assert.equal(syncPhaseFromIndex(index, "feishu:1"), "history");
    assert.equal(syncPhaseFromIndex(index, "feishu:2"), "live");
    await loadOrgSyncPhaseIndex(store, "example-org", 1_500);
    assert.equal(store.catalogLoads(), 1);
    await loadOrgSyncPhaseIndex(store, "example-org", 4_000);
    assert.equal(store.catalogLoads(), 2);
  });

  it("defers projection only while unseeded", () => {
    assert.equal(shouldDeferProjectionForPhase("unseeded"), true);
    assert.equal(shouldDeferProjectionForPhase("history"), false);
    assert.equal(shouldDeferProjectionForPhase("live"), false);
    assert.equal(shouldDeferProjectionForPhase(undefined), false);
  });
});
