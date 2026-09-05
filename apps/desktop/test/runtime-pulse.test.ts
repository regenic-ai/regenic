import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyHeartbeatToEngine } from "../src/renderer/src/runtime-pulse.ts";
import type {
  PersonalEngineView,
  PersonalHeartbeatView,
} from "../src/renderer/src/types.ts";

const baseEngine: PersonalEngineView = {
  kernel: "running",
  org_id: "org-1",
  database_path: "/tmp/regenic.db",
  inbox_count: 3,
  inbox_digest: "3:old",
  installations: [
    {
      id: "feishu-1",
      connector_type: "feishu-chat",
      status: "enabled",
      label: "Feishu",
      channel: "feishu",
      channel_label: "Feishu",
      detail: null,
      last_attempt: null,
      syncable: true,
      can_reply: true,
      can_create: false,
      create_with_task: false,
    },
  ],
  catalog: [],
  executor_installations: [],
  executor_catalog: [],
  pull: {
    interval_ms: 3000,
    last_tick_at: null,
    last_error: null,
    last_error_hint: null,
    network: { kind: "ok", proxy: null, hint: null },
    phase: "idle",
    catching_up_count: 0,
    last_accepted_count: 0,
    last_pages: 0,
    streams: [],
  },
};

const heartbeat: PersonalHeartbeatView = {
  kernel: "running",
  org_id: "org-1",
  inbox_count: 913,
  inbox_digest: "913:new",
  memory: { rss_bytes: 100, heap_used_bytes: 200 },
  pressure: {
    level: "elevated",
    interactive_ready: true,
    throttle_history: true,
    throttle_media: false,
  },
  reachability: "degraded",
  pull: {
    phase: "pulling",
    catching_up_count: 218,
    last_tick_at: "2026-01-01T00:00:00.000Z",
    last_accepted_count: 7,
  },
  installations: [
    {
      id: "feishu-1",
      sync: {
        discovered: 40,
        seeded: 12,
        unseeded: 28,
        backfilling: 12,
        media_pending: 2,
        catalog_complete: false,
        bootstrap_pending: 40,
        steady: 0,
      },
      last_attempt: {
        id: "attempt-1",
        org_id: "org-1",
        connector_installation_id: "feishu-1",
        stream_key: "chat:oc_1",
        delivery_id: "delivery-1",
        started_at: "2026-01-01T00:00:00.000Z",
        finished_at: "2026-01-01T00:00:01.000Z",
        status: "succeeded",
        accepted_count: 3,
        duplicate_count: 0,
        quarantined_count: 0,
        retryable_failure_count: 0,
      },
    },
  ],
};

describe("runtime pulse", () => {
  it("updates counts and pull without dropping installations", () => {
    const next = applyHeartbeatToEngine(baseEngine, heartbeat);
    assert.equal(next.inbox_count, 913);
    assert.equal(next.inbox_digest, "913:new");
    assert.equal(next.installations.length, 1);
    assert.equal(next.pull?.phase, "pulling");
    assert.equal(next.pull?.catching_up_count, 218);
    assert.equal(next.database_path, "/tmp/regenic.db");
    assert.equal(next.pressure?.level, "elevated");
    assert.equal(next.installations[0]?.sync?.backfilling, 12);
    assert.equal(next.installations[0]?.last_attempt?.status, "succeeded");
  });

  it("does not blank coverage when heartbeat has no sync snapshot yet", () => {
    const current = {
      ...baseEngine,
      installations: [
        {
          ...baseEngine.installations[0],
          sync: {
            discovered: 326,
            seeded: 326,
            unseeded: 0,
            backfilling: 115,
            media_pending: 168,
            catalog_complete: false,
            bootstrap_pending: 115,
            steady: 211,
          },
        },
      ],
    };
    const emptyPulse: PersonalHeartbeatView = {
      ...heartbeat,
      installations: [{ id: "feishu-1", sync: null }],
    };
    const next = applyHeartbeatToEngine(current, emptyPulse);
    assert.equal(next.installations[0]?.sync?.discovered, 326);
    assert.equal(next.installations[0]?.sync?.bootstrap_pending, 115);
  });
});
