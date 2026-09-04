import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { engineChip } from "../src/renderer/src/pull-copy.ts";
import type { PersonalEngineView } from "../src/renderer/src/types.ts";

const baseEngine: PersonalEngineView = {
  kernel: "running",
  org_id: "org-1",
  database_path: "/tmp/regenic.db",
  inbox_count: 1,
  installations: [],
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

describe("engineChip", () => {
  it("keeps running when an installation attempt is in flight", () => {
    const chip = engineChip(
      {
        ...baseEngine,
        installations: [
          {
            id: "feishu-1",
            connector_type: "feishu-chat",
            status: "enabled",
            label: "Feishu",
            detail: null,
            syncable: true,
            can_reply: true,
            can_create: false,
            last_attempt: {
              id: "a1",
              status: "running",
              started_at: "2026-09-04T00:00:00.000Z",
              accepted_count: 0,
              duplicate_count: 0,
              quarantined_count: 0,
              retryable_failure_count: 0,
            },
            sync: null,
          },
        ],
      },
      "live",
    );
    assert.equal(chip, "running");
  });

  it("keeps running when only history catch-up remains", () => {
    const chip = engineChip(
      {
        ...baseEngine,
        pull: {
          ...baseEngine.pull!,
          phase: "pulling",
          catching_up_count: 218,
          streams: [],
        },
      },
      "live",
    );
    assert.equal(chip, "running");
  });

  it("keeps running for a live watermark pull with stream detail", () => {
    const chip = engineChip(
      {
        ...baseEngine,
        pull: {
          ...baseEngine.pull!,
          phase: "pulling",
          catching_up_count: 1,
          streams: [
            {
              stream_key: "feishu-1:chat:oc_1",
              thread_id: "feishu:oc_1",
              label: "Christy",
              phase: "pulling",
              work: "live",
              last_error: null,
            },
          ],
        },
      },
      "live",
    );
    assert.equal(chip, "running");
  });
});
