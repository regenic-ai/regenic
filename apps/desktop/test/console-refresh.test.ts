import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRefreshJoin, engineRevision } from "../src/renderer/src/console-refresh.ts";
import type { ConnectorCatalogItem, PersonalEngineView } from "../src/renderer/src/types.ts";

function engineWithCatalog(title: string, step: string): PersonalEngineView {
  const catalog: ConnectorCatalogItem = {
    connector_type: "feishu-chat",
    title,
    description: "",
    credential_hint: "",
    installed: false,
    instance_count: 0,
    setup_ready: true,
    singleton: false,
    fields: [],
    prerequisites: [],
    setup_steps: [{ title: step }],
    docs: [],
  };
  return {
    kernel: "running",
    org_id: "local-owner",
    database_path: null,
    inbox_count: 0,
    inbox_hidden_count: 0,
    installations: [],
    catalog: [catalog],
    executor_installations: [],
    executor_catalog: [],
  };
}

describe("refresh join", () => {
  it("waits until the follow-up pass finishes", async () => {
    const join = createRefreshJoin();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let passes = 0;
    const first = join.run(async () => {
      do {
        join.beginPass();
        passes += 1;
        if (passes === 1) await gate;
      } while (join.passRequested());
    });
    await Promise.resolve();
    let secondDone = false;
    const second = join.run(async () => {
      passes += 1;
    }).then(() => {
      secondDone = true;
    });
    await Promise.resolve();
    assert.equal(secondDone, false);
    assert.equal(passes, 1);
    release();
    await first;
    await second;
    assert.equal(passes, 2);
    assert.equal(secondDone, true);
  });

  it("runs the queued pass when another refresh was requested mid-flight", async () => {
    const join = createRefreshJoin();
    let passes = 0;
    await join.run(async () => {
      do {
        join.beginPass();
        passes += 1;
        if (passes === 1) join.requestAgain();
      } while (join.passRequested());
    });
    assert.equal(passes, 2);
  });
});

describe("engineRevision", () => {
  it("changes when resolved catalog copy changes", () => {
    const english = engineRevision(
      engineWithCatalog("Feishu", "Install lark-cli"),
      false,
    );
    const chinese = engineRevision(
      engineWithCatalog("飞书", "安装 lark-cli"),
      false,
    );
    assert.notEqual(english, chinese);
  });

  it("changes when a resolved executor connector label changes", () => {
    const english = engineRevision(
      {
        ...engineWithCatalog("Feishu", "Install lark-cli"),
        executor_installations: [
          {
            id: "ex-1",
            kind: "local_connector",
            name: "Office",
            status: "enabled",
            label: "Office",
            detail: "Feishu",
          },
        ],
      },
      false,
    );
    const chinese = engineRevision(
      {
        ...engineWithCatalog("飞书", "安装 lark-cli"),
        executor_installations: [
          {
            id: "ex-1",
            kind: "local_connector",
            name: "Office",
            status: "enabled",
            label: "Office",
            detail: "飞书",
          },
        ],
      },
      false,
    );
    assert.notEqual(english, chinese);
  });

  it("changes when sync coverage counts change", () => {
    const before = engineRevision(
      {
        ...engineWithCatalog("Feishu", "Install lark-cli"),
        installations: [
          {
            id: "feishu-1",
            connector_type: "feishu-chat",
            status: "enabled",
            label: "All conversations",
            detail: null,
            syncable: true,
            can_reply: true,
            can_create: false,
            last_attempt: null,
            sync: {
              discovered: 34,
              seeded: 12,
              unseeded: 22,
              backfilling: 4,
              media_pending: 0,
              catalog_complete: false,
              bootstrap_pending: 26,
              steady: 8,
            },
          },
        ],
      },
      false,
    );
    const after = engineRevision(
      {
        ...engineWithCatalog("Feishu", "Install lark-cli"),
        installations: [
          {
            id: "feishu-1",
            connector_type: "feishu-chat",
            status: "enabled",
            label: "All conversations",
            detail: null,
            syncable: true,
            can_reply: true,
            can_create: false,
            last_attempt: null,
            sync: {
              discovered: 120,
              seeded: 34,
              unseeded: 86,
              backfilling: 8,
              media_pending: 0,
              catalog_complete: false,
              bootstrap_pending: 94,
              steady: 26,
            },
          },
        ],
      },
      false,
    );
    assert.notEqual(before, after);
  });

  it("changes when a connector receives a new push", () => {
    const installation = {
      id: "push-1",
      connector_type: "dsh-session",
      status: "enabled",
      label: "DSH",
      detail: null,
      syncable: true,
      can_reply: true,
      can_create: false,
      last_attempt: null,
    } as NonNullable<PersonalEngineView["installations"]>[number];
    const base = engineWithCatalog("DSH", "Connect DSH");
    const before = engineRevision(
      { ...base, installations: [installation] },
      false,
    );
    const after = engineRevision(
      {
        ...base,
        installations: [{
          ...installation,
          last_push_at: "2026-11-16T00:00:00.000Z",
        }],
      },
      false,
    );
    assert.notEqual(before, after);
  });

  it("changes when a connector's last check moves", () => {
    const installation = {
      id: "feishu-1",
      connector_type: "feishu-chat",
      status: "enabled" as const,
      label: "All conversations",
      detail: null,
      syncable: true,
      can_reply: true,
      can_create: false,
      last_attempt: null,
      last_checked_at: "2026-11-21T01:45:00.000Z",
    } as NonNullable<PersonalEngineView["installations"]>[number];
    const base = engineWithCatalog("Feishu", "Install lark-cli");
    const before = engineRevision(
      { ...base, installations: [installation] },
      false,
    );
    const after = engineRevision(
      {
        ...base,
        installations: [{
          ...installation,
          last_checked_at: "2026-11-23T02:00:00.000Z",
        }],
      },
      false,
    );
    assert.notEqual(before, after);
  });

  it("changes when freshness or ETA changes", () => {
    const base = engineWithCatalog("Feishu", "Install lark-cli");
    const before = engineRevision(
      {
        ...base,
        sync_readiness: {
          remaining_streams: 10_000,
          freshness_ms: 60_000,
          freshness_source: "poll",
          accepted_count: 0,
          throttle_reason: null,
          eta: { low_ms: 6_240_000, high_ms: 37_440_000 },
        },
      },
      false,
    );
    const after = engineRevision(
      {
        ...base,
        sync_readiness: {
          remaining_streams: 8_000,
          freshness_ms: 60_000,
          freshness_source: "poll",
          accepted_count: 12,
          throttle_reason: null,
          eta: { low_ms: 4_000_000, high_ms: 28_000_000 },
        },
      },
      false,
    );
    assert.notEqual(before, after);
  });

  it("changes when a sync run is deleted or updated", () => {
    const run = {
      id: "run-1",
      org_id: "local-owner",
      installation_id: "inst-1",
      mode: "quick_start",
      status: "failed",
      options: {},
      total_work: 1,
      completed_work: 0,
      failed_work: 1,
      accepted_count: 0,
      last_error: "dsh_api",
      started_at: "2026-11-05T04:21:00.000Z",
      finished_at: "2026-11-05T04:21:01.000Z",
      created_at: "2026-11-05T04:21:00.000Z",
      updated_at: "2026-11-05T04:21:01.000Z",
    } as unknown as NonNullable<PersonalEngineView["sync_runs"]>[number];
    const base = engineWithCatalog("Feishu", "Install lark-cli");
    const withRun = engineRevision({ ...base, sync_runs: [run] }, true);
    assert.notEqual(withRun, engineRevision({ ...base, sync_runs: [] }, true));
    assert.notEqual(
      withRun,
      engineRevision({ ...base, sync_runs: [{ ...run, status: "succeeded" }] }, true),
    );
  });
});
