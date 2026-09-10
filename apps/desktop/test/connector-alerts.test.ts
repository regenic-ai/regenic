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
  it("flags a stream in error phase with the connector name", () => {
    const view = engine({
      pull: pull({
        streams: [
          {
            stream_key: "s1",
            thread_id: null,
            label: "Feishu",
            phase: "error",
            last_error: "token expired",
          },
        ],
      }),
    });
    const alerts = connectorAlerts(view);
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].name, "Feishu");
    assert.equal(alerts[0].message, "token expired");
    assert.equal(hasConnectorFailure(view), true);
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
    assert.equal(alerts[0].name, "connector");
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
