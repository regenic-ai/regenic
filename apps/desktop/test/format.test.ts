import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setActiveLocale } from "../src/shared/i18n.ts";
import {
  connectorActionError,
  networkWatchHint,
} from "../src/renderer/src/connector-errors.ts";
import { KernelRequestError } from "../src/renderer/src/kernel-request.ts";
import { attemptSummary, formatChatTime } from "../src/renderer/src/format.ts";
import {
  engineChip,
  namedPullProgress,
  pullStatusLabel,
  releaseOtherLivePulls,
  threadSyncLabel,
  threadSyncTone,
  threadIsSyncing,
} from "../src/renderer/src/pull-copy.ts";
import {
  aggregateInstallationSync,
  connectorCardMode,
  SYNC_CHECK_STALE_MS,
  syncEtaSummary,
  syncFreshnessSummary,
  syncProgressSummary,
  syncProgressTone,
  syncWorkSettled,
} from "../src/renderer/src/sync-copy.ts";
import type {
  EngineInstallationView,
  PersonalEngineView,
  PullStatusView,
  SyncProgressView,
  SyncReadinessView,
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
    inbox_hidden_count: 0,
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
    assert.equal(engineChip(view), "running");
    assert.equal(pullStatusLabel(view.pull), "Earlier messages · 熊峰");
    assert.equal(threadSyncLabel("feishu:oc_1", view.pull), "Syncing earlier messages");
    assert.equal(threadSyncTone("feishu:oc_1", view.pull), "syncing");
  });

  it("does not call a push nudge new-message sync", () => {
    const view = engine({
      pull: pull({
        phase: "pulling",
        catching_up_count: 0,
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
    assert.equal(pullStatusLabel(view.pull), "Syncing");
    assert.equal(threadSyncLabel("feishu:oc_1", view.pull), null);
    assert.equal(threadSyncTone("feishu:oc_1", view.pull), null);
    assert.equal(threadIsSyncing("feishu:oc_1", view.pull), false);
    assert.equal(namedPullProgress(view.pull, [{ id: "feishu:oc_1", title: "Christy" }]), null);
    assert.equal(pullStatusLabel(pull({ interval_ms: 10_000 })), "Idle");
  });

  it("names an attachment download separately from older messages", () => {
    const status = pull({
      phase: "pulling",
      streams: [
        {
          stream_key: "feishu-1:chat:oc_1",
          thread_id: "feishu:oc_1",
          label: "Christy",
          phase: "pulling",
          work: "media",
          last_error: null,
        },
      ],
    });
    assert.equal(pullStatusLabel(status), "Attachments · Christy");
    assert.equal(threadSyncLabel("feishu:oc_1", status), "Syncing attachments");
    assert.equal(threadSyncTone("feishu:oc_1", status), "syncing");
    assert.equal(threadIsSyncing("feishu:oc_1", status), true);
    assert.equal(
      namedPullProgress(status, [{ id: "feishu:oc_1", title: "熊峰" }]),
      "Attachments · 熊峰",
    );
  });

  it("does not count the current wave as the conversations still left", () => {
    const status = pull({
      phase: "pulling",
      catching_up_count: 4,
      streams: [
        {
          stream_key: "feishu-1:chat:oc_1",
          thread_id: "feishu:oc_1",
          label: "甲",
          phase: "pulling",
          work: "history",
          last_error: null,
        },
        {
          stream_key: "feishu-1:chat:oc_2",
          thread_id: "feishu:oc_2",
          label: "乙",
          phase: "pulling",
          work: "history",
          last_error: null,
        },
      ],
    });
    assert.equal(pullStatusLabel(status), "Earlier messages · 甲");
    assert.equal(pullStatusLabel(status).includes("4"), false);
  });

  it("names one known chat when several history streams are moving", () => {
    const status = pull({
      phase: "pulling",
      catching_up_count: 4,
      streams: [
        {
          stream_key: "feishu-1:chat:oc_1",
          thread_id: "feishu:oc_1",
          label: null,
          phase: "pulling",
          work: "history",
          last_error: null,
        },
        {
          stream_key: "feishu-1:chat:oc_2",
          thread_id: "feishu:oc_2",
          label: "oc_2",
          phase: "pulling",
          work: "history",
          last_error: null,
        },
      ],
    });
    assert.equal(pullStatusLabel(status), "Earlier messages");
    assert.equal(
      pullStatusLabel(status, [{ id: "feishu:oc_2", title: "乙" }]),
      "Earlier messages · 乙",
    );
  });

  it("names the titlebar chip from the inbox thread when the stream label is blank", () => {
    const status = pull({
      phase: "pulling",
      streams: [
        {
          stream_key: "feishu-1:chat:oc_1",
          thread_id: "feishu:oc_1",
          label: null,
          phase: "pulling",
          work: "history",
          last_error: null,
        },
      ],
    });
    assert.equal(pullStatusLabel(status), "Earlier messages");
    assert.equal(
      pullStatusLabel(status, [{ id: "feishu:oc_1", title: "熊峰" }]),
      "Earlier messages · 熊峰",
    );
    assert.equal(
      namedPullProgress(status, [{ id: "feishu:oc_1", title: "熊峰" }]),
      "Earlier messages · 熊峰",
    );
  });

  it("clears the previous conversation's live sync mark when another is opened", () => {
    const status = pull({
      phase: "pulling",
      streams: [
        {
          stream_key: "feishu-1:chat:oc_old",
          thread_id: "feishu:oc_old",
          label: "熊志健",
          phase: "pulling",
          work: "live",
          last_error: null,
        },
        {
          stream_key: "feishu-1:chat:oc_new",
          thread_id: "feishu:oc_new",
          label: "林晨",
          phase: "pulling",
          work: "live",
          last_error: null,
        },
      ],
    });
    const next = releaseOtherLivePulls(status, "feishu:oc_new");
    assert.equal(next?.streams.find((item) => item.thread_id === "feishu:oc_old")?.phase, "idle");
    assert.equal(next?.streams.find((item) => item.thread_id === "feishu:oc_new")?.phase, "pulling");
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
    assert.equal(threadSyncLabel("feishu:oc_1", status), "Sync paused · retrying");
    assert.equal(threadSyncTone("feishu:oc_1", status), "error");
    assert.equal(pullStatusLabel(status), "Connection dropped · retrying");
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
      "120+ found · 94 loading older messages · 26 current",
    );
    assert.equal(syncProgressTone(sync), "warn");
    assert.equal(syncWorkSettled(sync), false);
    setActiveLocale("zh");
    try {
      assert.equal(
        syncProgressSummary(sync),
        "已发现 120+ · 正在补旧消息 94 · 已跟上 26",
      );
    } finally {
      setActiveLocale("en");
    }
  });

  it("treats a fully current open catalog as caught up", () => {
    const sync: SyncProgressView = {
      discovered: 889,
      seeded: 889,
      unseeded: 0,
      backfilling: 0,
      media_pending: 0,
      catalog_complete: false,
      bootstrap_pending: 0,
      steady: 889,
    };
    assert.equal(syncWorkSettled(sync), true);
    assert.equal(syncProgressTone(sync), "ok");
    assert.equal(syncWorkSettled({ ...sync, media_pending: 3 }), false);
    assert.equal(syncProgressTone({ ...sync, media_pending: 3 }), "warn");
    assert.equal(
      syncProgressSummary({ ...sync, media_pending: 3 }),
      "889+ found · 0 loading older messages · 889 current",
    );
    assert.equal(
      syncProgressSummary(sync),
      "Up to date with all 889 found so far",
    );
    setActiveLocale("zh");
    try {
      assert.equal(syncProgressSummary(sync), "目前发现的 889 个都已跟上");
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

  it("shows poll freshness and an ETA range without a fake percent", () => {
    const readiness: SyncReadinessView = {
      remaining_streams: 10_000,
      freshness_ms: 3_600_000,
      freshness_source: "poll",
      accepted_count: 12,
      throttle_reason: null,
      eta: { low_ms: 6_240_000, high_ms: 37_440_000 },
    };
    assert.equal(syncFreshnessSummary(readiness), "1h ago");
    assert.equal(syncEtaSummary(readiness), "2h – 10h");
    assert.equal(
      syncEtaSummary({
        ...readiness,
        throttle_reason: "source_429",
      }),
      "Rate limited",
    );
    assert.equal(syncFreshnessSummary(null), "Not checked yet");
    assert.equal(syncEtaSummary({ ...readiness, eta: null }), "—");
  });
});

describe("connector action errors", () => {
  it("maps structured kernel codes onto the active desktop catalog", () => {
    setActiveLocale("zh");
    try {
      assert.equal(
        connectorActionError(new KernelRequestError("ignored", "conversation_required")),
        "至少选一个会话，或改为同步全部。",
      );
      assert.equal(
        connectorActionError(new KernelRequestError("ignored", "channel_required")),
        "Slack 需要填写频道 ID",
      );
      assert.equal(
        networkWatchHint(
          "Local network looks blocked. Check the VPN or firewall, then retry.",
        ),
        "本机网络看起来被拦住了。检查 VPN 或防火墙后再试。",
      );
      assert.equal(
        connectorActionError(
          new KernelRequestError(
            "Connector teardown has not completed; retry stopping first",
            "lifecycle_failed",
          ),
        ),
        "应用仍在关闭，请稍后重试。",
      );
      assert.match(
        connectorActionError(new Error("public_url_required")),
        /REGENIC_PUBLIC_URL/,
      );
    } finally {
      setActiveLocale("en");
    }
    assert.equal(
      connectorActionError(new KernelRequestError("feishu-chat is already installed", "already_installed")),
      "This app is already installed",
    );
  });
});

describe("connector attempt summaries", () => {
  it("keeps polling connectors' empty state and explains push connectors", () => {
    setActiveLocale("en");
    assert.equal(attemptSummary(null), "No messages yet");
    assert.equal(attemptSummary(null, "webhook"), "Waiting for the first update");
    assert.equal(attemptSummary(null, "hybrid"), "Waiting for the first update");
  });

  it("describes webhook activity as received updates in both locales", () => {
    const attempt = {
      status: "succeeded",
      accepted_count: 3,
      started_at: "2026-09-02T12:00:00.000Z",
    };
    setActiveLocale("en");
    assert.match(attemptSummary(attempt, "webhook"), /^3 updates received · /);

    setActiveLocale("zh");
    assert.match(attemptSummary(attempt, "webhook"), /^已接收更新 · 3 条 · /);
    setActiveLocale("en");
  });

  it("describes a shared body write as still loading, not a failure", () => {
    setActiveLocale("en");
    assert.match(
      attemptSummary({
        status: "failed",
        accepted_count: 0,
        started_at: "2026-09-02T12:00:00.000Z",
        error_code: "blob_reservation_conflict",
      }),
      /^Loading older messages · /,
    );
    setActiveLocale("zh");
    assert.match(
      attemptSummary({
        status: "failed",
        accepted_count: 0,
        started_at: "2026-09-02T12:00:00.000Z",
        error_code: "blob_reservation_conflict",
      }),
      /^正在补旧消息 · /,
    );
    setActiveLocale("en");
  });

  it("describes a timed-out page as a retry, not older-message catch-up", () => {
    setActiveLocale("en");
    assert.match(
      attemptSummary({
        status: "failed",
        accepted_count: 0,
        started_at: "2026-09-02T12:00:00.000Z",
        error_code: "deadline_exceeded",
      }),
      /^Connection dropped · retrying · /,
    );
    setActiveLocale("zh");
    assert.match(
      attemptSummary({
        status: "failed",
        accepted_count: 0,
        started_at: "2026-09-02T12:00:00.000Z",
        error_code: "lease_unavailable",
      }),
      /^连接中断，正在重试 · /,
    );
    setActiveLocale("en");
  });

  it("uses singular English copy for one received update", () => {
    setActiveLocale("en");
    assert.match(
      attemptSummary(
        {
          status: "succeeded",
          accepted_count: 1,
          started_at: "2026-09-02T12:00:00.000Z",
        },
        "webhook",
      ),
      /^1 update received · /,
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

describe("connector card health", () => {
  const now = Date.parse("2026-11-23T02:00:00.000Z");
  const fresh = new Date(now - 60_000).toISOString();
  const stale = new Date(now - SYNC_CHECK_STALE_MS).toISOString();
  const succeeded = {
    status: "succeeded",
    started_at: "2026-11-21T01:45:00.000Z",
    finished_at: "2026-11-21T01:45:00.000Z",
  };

  it("stays quiet when a caught-up connector was checked recently, even if the last attempt accepted nothing", () => {
    assert.deepEqual(
      connectorCardMode({
        status: "enabled",
        syncable: true,
        hasConversations: true,
        lastAttempt: succeeded,
        lastCheckedAt: fresh,
        nowMs: now,
      }),
      { mode: "quiet", staleChip: false },
    );
  });

  it("replaces the caught-up chip once the last check is a quarter hour old", () => {
    assert.deepEqual(
      connectorCardMode({
        status: "enabled",
        syncable: true,
        hasConversations: true,
        lastAttempt: succeeded,
        lastCheckedAt: stale,
        nowMs: now,
      }),
      { mode: "stale", staleChip: true },
    );
  });

  it("keeps a receive failure on the card until a later check moves past it", () => {
    const failed = {
      status: "failed",
      started_at: "2026-11-23T01:00:00.000Z",
      finished_at: "2026-11-23T01:00:00.000Z",
    };
    assert.equal(
      connectorCardMode({
        status: "enabled",
        syncable: true,
        hasConversations: true,
        lastAttempt: failed,
        lastCheckedAt: "2026-11-23T00:30:00.000Z",
        nowMs: now,
      }).mode,
      "attempt",
    );
    assert.deepEqual(
      connectorCardMode({
        status: "enabled",
        syncable: true,
        hasConversations: true,
        lastAttempt: failed,
        lastCheckedAt: fresh,
        nowMs: now,
      }),
      { mode: "quiet", staleChip: false },
    );
  });

  it("does not call a quiet connector stale while an attempt is still running", () => {
    assert.equal(
      connectorCardMode({
        status: "enabled",
        syncable: true,
        hasConversations: true,
        lastAttempt: {
          status: "running",
          started_at: stale,
        },
        lastCheckedAt: stale,
        nowMs: now,
      }).mode,
      "attempt",
    );
  });

  it("waits for the first update instead of warning when nothing has been stored", () => {
    assert.equal(
      connectorCardMode({
        status: "enabled",
        syncable: true,
        hasConversations: false,
        lastAttempt: null,
        lastCheckedAt: stale,
        nowMs: now,
      }).mode,
      "waiting",
    );
  });

  it("leaves a disabled installation alone", () => {
    assert.deepEqual(
      connectorCardMode({
        status: "disabled",
        syncable: false,
        hasConversations: true,
        lastAttempt: succeeded,
        lastCheckedAt: stale,
        nowMs: now,
      }),
      { mode: "quiet", staleChip: false },
    );
  });
});
