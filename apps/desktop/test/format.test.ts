import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  engineChip,
  pullStatusLabel,
  threadSyncLabel,
  threadSyncTone,
} from "../src/renderer/src/pull-copy.ts";
import type { PersonalEngineView, PullStatusView } from "../src/renderer/src/types.ts";

function pull(overrides: Partial<PullStatusView> = {}): PullStatusView {
  return {
    interval_ms: 3000,
    last_tick_at: "2026-08-24T03:00:00.000Z",
    last_error: null,
    last_error_hint: null,
    network: { kind: "ok", proxy: null, hint: null },
    phase: "idle",
    catching_up_count: 0,
    last_accepted_count: 0,
    last_pages: 0,
    streams: [],
    ...overrides,
  };
}

function engine(overrides: Partial<PersonalEngineView> = {}): PersonalEngineView {
  return {
    kernel: "running",
    org_id: "local-owner",
    database_path: null,
    inbox_count: 1,
    installations: [],
    catalog: [],
    pull: pull(),
    ...overrides,
  };
}

describe("engine chip and pull copy", () => {
  it("shows older-message copy only while history is actually pulling", () => {
    const view = engine({
      pull: pull({
        phase: "pulling",
        catching_up_count: 1,
        streams: [
          {
            stream_key: "feishu-1:chat:oc_1",
            thread_id: "feishu:oc_1",
            label: "熊峰",
            phase: "pulling",
            work: "history",
            last_error: null,
          },
        ],
      }),
    });
    assert.equal(engineChip(view), "syncing");
    assert.equal(pullStatusLabel(view.pull), "Syncing 熊峰");
    assert.equal(threadSyncLabel("feishu:oc_1", view.pull), "Syncing older messages");
    assert.equal(threadSyncTone("feishu:oc_1", view.pull), "syncing");
  });

  it("does not call a live watermark pull older-message sync", () => {
    const view = engine({
      pull: pull({
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
      }),
    });
    assert.equal(engineChip(view), "running");
    assert.equal(pullStatusLabel(view.pull), "Syncing Christy");
    assert.equal(threadSyncLabel("feishu:oc_1", view.pull), null);
    assert.equal(threadSyncTone("feishu:oc_1", view.pull), null);
  });

  it("names a dropped sync so the open thread can show it", () => {
    const status = pull({
      last_error: "lark-cli timed out after 60000ms",
      streams: [
        {
          stream_key: "feishu-1:chat:oc_1",
          thread_id: "feishu:oc_1",
          label: "熊峰",
          phase: "error",
          last_error: "lark-cli timed out after 60000ms",
        },
      ],
    });
    assert.equal(threadSyncLabel("feishu:oc_1", status), "Sync interrupted · retrying");
    assert.equal(threadSyncTone("feishu:oc_1", status), "error");
    assert.equal(pullStatusLabel(status), "Retrying after a drop");
  });
});
