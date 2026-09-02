import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setActiveLocale } from "../src/shared/i18n.ts";
import {
  connectorActionError,
  networkWatchHint,
} from "../src/renderer/src/connector-errors.ts";
import { formatChatTime } from "../src/renderer/src/format.ts";
import {
  engineChip,
  pullStatusLabel,
  threadSyncLabel,
  threadSyncTone,
} from "../src/renderer/src/pull-copy.ts";
import {
  aggregateInstallationSync,
  syncProgressSummary,
  syncProgressTone,
} from "../src/renderer/src/sync-copy.ts";
import type {
  EngineInstallationView,
  PersonalEngineView,
  PullStatusView,
  SyncProgressView,
} from "../src/renderer/src/types.ts";

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

describe("sync coverage copy", () => {
  it("keeps discovered, seeded, and backfilling visible together", () => {
    const sync: SyncProgressView = {
      discovered: 120,
      seeded: 34,
      unseeded: 86,
      backfilling: 8,
      media_pending: 0,
      catalog_complete: false,
      bootstrap_pending: 94,
      steady: 26,
    };
    assert.equal(
      syncProgressSummary(sync),
      "Listed 120+ · bootstrap 94 · steady 26",
    );
    assert.equal(syncProgressTone(sync), "warn");
    setActiveLocale("zh");
    try {
      assert.equal(
        syncProgressSummary(sync),
        "已列出 120+ · 补齐中 94 · 已就绪 26",
      );
    } finally {
      setActiveLocale("en");
    }
  });

  it("does not treat current-work count as the discovered set", () => {
    const installs: EngineInstallationView[] = [
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
    ];
    const coverage = aggregateInstallationSync(installs);
    assert.equal(coverage?.discovered, 120);
    assert.equal(coverage?.seeded, 34);
    assert.notEqual(coverage?.discovered, 34);
  });
});

describe("connector action errors", () => {
  it("maps install failures onto the active desktop catalog", () => {
    setActiveLocale("zh");
    try {
      assert.equal(
        connectorActionError(
          "Feishu install requires at least one conversation when choosing conversations",
        ),
        "选全部会话，或勾选要同步的会话",
      );
      assert.equal(
        connectorActionError("Slack install requires channel_id"),
        "Slack 需要填写频道 ID",
      );
      assert.equal(
        networkWatchHint(
          "Local network looks blocked. Check the VPN or firewall, then retry.",
        ),
        "本机网络看起来被拦住了。检查 VPN 或防火墙后再试。",
      );
    } finally {
      setActiveLocale("en");
    }
    assert.equal(
      connectorActionError("feishu-chat is already installed"),
      "This connector is already installed",
    );
  });
});

describe("formatChatTime", () => {
  it("shows time only for same-day messages", () => {
    setActiveLocale("en");
    const now = new Date("2026-09-02T12:00:00");
    assert.equal(
      formatChatTime("2026-09-02T15:44:00", now),
      "3:44 PM",
    );
  });

  it("omits the year for earlier dates in the same year", () => {
    setActiveLocale("en");
    const now = new Date("2026-09-02T12:00:00");
    const formatted = formatChatTime("2026-04-21T18:28:00", now);
    assert.match(formatted, /4\/21/);
    assert.doesNotMatch(formatted, /2026/);
  });

  it("includes the year for messages from a previous year", () => {
    setActiveLocale("en");
    const now = new Date("2026-09-02T12:00:00");
    const formatted = formatChatTime("2025-04-21T18:28:00", now);
    assert.match(formatted, /2025/);
    assert.match(formatted, /4\/21/);
  });
});
