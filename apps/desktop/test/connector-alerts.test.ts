import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  connectorAlerts,
  connectorDisplayName,
  hasConnectorFailure,
} from "../src/renderer/src/connector-alerts.ts";
import type {
  EngineInstallationView,
  PersonalEngineView,
  PullStatusView,
} from "../src/renderer/src/types.ts";

function installation(over: Partial<EngineInstallationView> = {}): EngineInstallationView {
  return {
    id: "inst-1",
    connector_type: "feishu",
    status: "enabled",
    label: "Feishu",
    detail: null,
    syncable: true,
    can_reply: true,
    can_create: true,
    last_attempt: null,
    ...over,
  };
}

function pull(over: Partial<PullStatusView> = {}): PullStatusView {
  return {
    interval_ms: 1000,
    last_tick_at: null,
    last_error: null,
    last_error_hint: null,
    network: { kind: "ok", proxy: null, hint: null },
    phase: "idle",
    catching_up_count: 0,
    last_accepted_count: 0,
    last_pages: 0,
    streams: [],
    ...over,
  };
}

function engine(over: Partial<PersonalEngineView> = {}): PersonalEngineView {
  return {
    kernel: "running",
    org_id: "org",
    database_path: null,
    inbox_count: 0,
    installations: [installation()],
    catalog: [],
    executor_installations: [],
    executor_catalog: [],
    ...over,
  };
}

describe("connector alerts", () => {
  it("does not sticky-banner a lease contention soft miss", () => {
    const view = engine({
      pull: pull({
        streams: [
          {
            stream_key: "inst-1:chat:oc_1",
            thread_id: null,
            label: "李必琪",
            phase: "error",
            last_error: "Connector stream is already leased",
          },
        ],
      }),
    });
    assert.equal(connectorAlerts(view).length, 0);
    assert.equal(hasConnectorFailure(view), false);
  });

  it("does not sticky-banner a shared blob write", () => {
    const view = engine({
      pull: pull({
        streams: [
          {
            stream_key: "inst-1:chat:oc_1",
            thread_id: null,
            label: "李必琪",
            phase: "error",
            last_error:
              "Blob reservation is busy or unavailable: d0f13ecbb7b4cba8612ce7978a7cc1e9df33ac5fef335b5304006d8878260eff",
          },
        ],
      }),
    });
    assert.equal(connectorAlerts(view).length, 0);
    assert.equal(hasConnectorFailure(view), false);
  });

  it("does not sticky-banner a poll deadline soft miss", () => {
    const view = engine({
      pull: pull({
        streams: [
          {
            stream_key: "inst-1:chat:oc_1",
            thread_id: null,
            label: "李必琪",
            phase: "error",
            last_error:
              "poll inst-1:chat:oc_1 timed out after 20000ms",
          },
        ],
      }),
    });
    assert.equal(connectorAlerts(view).length, 0);
    assert.equal(hasConnectorFailure(view), false);
  });

  it("flags a durable stream error with the connector name", () => {
    const view = engine({
      pull: pull({
        streams: [
          {
            stream_key: "inst-1:chat:oc_1",
            thread_id: null,
            label: "陈静",
            phase: "error",
            last_error: "token expired",
          },
        ],
      }),
    });
    const alerts = connectorAlerts(view);
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].name, "Feishu");
    assert.equal(alerts[0].installationId, "inst-1");
    assert.equal(alerts[0].message, "陈静: token expired");
    assert.equal(hasConnectorFailure(view), true);
  });

  it("does not treat a shared body write as a failed installation", () => {
    const view = engine({
      installations: [
        installation({
          last_attempt: {
            id: "a1",
            status: "failed",
            accepted_count: 0,
            duplicate_count: 0,
            quarantined_count: 0,
            retryable_failure_count: 1,
            started_at: "2026-09-10T00:00:00Z",
            error_code: "blob_reservation_conflict",
          },
        }),
      ],
    });
    assert.equal(connectorAlerts(view).length, 0);
    assert.equal(hasConnectorFailure(view), false);
  });

  it("flags a failed last attempt", () => {
    const view = engine({
      installations: [
        installation({
          last_attempt: {
            id: "a1",
            status: "failed",
            accepted_count: 0,
            duplicate_count: 0,
            quarantined_count: 0,
            retryable_failure_count: 0,
            started_at: "2026-09-10T00:00:00Z",
            error_code: "missing_credentials",
          },
        }),
      ],
    });
    const alerts = connectorAlerts(view);
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].message, "missing_credentials");
  });

  it("keeps header chrome while the latest attempt is still the hard failure", () => {
    const view = engine({
      installations: [
        installation({
          last_checked_at: "2026-09-10T00:05:00Z",
          last_attempt: {
            id: "a1",
            status: "failed",
            accepted_count: 0,
            duplicate_count: 0,
            quarantined_count: 0,
            retryable_failure_count: 0,
            started_at: "2026-09-10T00:00:00Z",
            finished_at: "2026-09-10T00:00:01Z",
            error_code: "missing_credentials",
          },
        }),
      ],
    });
    assert.equal(connectorAlerts(view)[0]?.message, "missing_credentials");
  });

  it("does not raise header chrome after a later success settled a hard failure", () => {
    const failed = {
      id: "a1",
      status: "failed" as const,
      accepted_count: 0,
      duplicate_count: 0,
      quarantined_count: 0,
      retryable_failure_count: 0,
      started_at: "2026-09-10T00:00:00Z",
      finished_at: "2026-09-10T00:00:01Z",
      error_code: "missing_credentials",
    };
    const view = engine({
      installations: [
        installation({
          last_checked_at: "2026-09-10T00:05:00Z",
          last_attempt: {
            id: "a2",
            status: "succeeded",
            accepted_count: 1,
            duplicate_count: 0,
            quarantined_count: 0,
            retryable_failure_count: 0,
            started_at: "2026-09-10T00:05:00Z",
            finished_at: "2026-09-10T00:05:00Z",
          },
          last_hard_failure: failed,
        }),
      ],
    });
    assert.equal(connectorAlerts(view).length, 0);
    assert.equal(hasConnectorFailure(view), false);
  });

  it("keeps a needs_attention failure after a later check", () => {
    const view = engine({
      installations: [
        installation({
          status: "needs_attention",
          last_checked_at: "2026-09-10T00:05:00Z",
          last_attempt: {
            id: "a1",
            status: "failed",
            accepted_count: 0,
            duplicate_count: 0,
            quarantined_count: 0,
            retryable_failure_count: 0,
            started_at: "2026-09-10T00:00:00Z",
            error_code: "missing_credentials",
          },
        }),
      ],
    });
    const alerts = connectorAlerts(view);
    assert.equal(alerts.length, 2);
    assert.equal(alerts.some((item) => item.message === "missing_credentials"), true);
  });

  it("flags kernel stopped while installations are enabled", () => {
    const view = engine({ kernel: "stopped" });
    const alerts = connectorAlerts(view);
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].name, "Feishu");
  });

  it("does not flag a healthy engine", () => {
    assert.equal(connectorAlerts(engine()).length, 0);
    assert.equal(hasConnectorFailure(engine()), false);
    assert.equal(hasConnectorFailure(null), false);
  });

  it("ignores a failed attempt on a disabled connector", () => {
    const view = engine({
      installations: [
        installation({
          status: "disabled",
          last_attempt: {
            id: "a1",
            status: "failed",
            accepted_count: 0,
            duplicate_count: 0,
            quarantined_count: 0,
            retryable_failure_count: 0,
            started_at: "2026-09-10T00:00:00Z",
            error_code: "missing_credentials",
          },
        }),
      ],
    });
    assert.equal(connectorAlerts(view).length, 0);
  });

  it("keeps pull.last_error generic when no stream names a connector", () => {
    const view = engine({
      installations: [
        installation({ id: "slack-1", label: "Slack", connector_type: "slack" }),
        installation({ id: "feishu-1", label: "Feishu" }),
      ],
      pull: pull({
        last_error: "network down",
        last_error_hint: "check proxy",
      }),
    });
    const alerts = connectorAlerts(view);
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].name, "app");
    assert.equal(alerts[0].message, "network down");
    assert.equal(alerts[0].installationId, null);
  });

  it("prefers channel_label for display names", () => {
    assert.equal(
      connectorDisplayName(installation({ channel_label: "Feishu 飞书" })),
      "Feishu 飞书",
    );
  });
});
