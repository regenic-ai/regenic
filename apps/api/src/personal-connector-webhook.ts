import {
  ConnectorRunner,
  InProcessConnectorInvoker,
  asConnectorHost,
  connectorPollTimeoutMs,
  connectorSyncTimeoutMs,
  requireWebhookPorts,
  withDeadline,
  type ConnectorWebhookRunResult,
  streamKeysForThreadIds,
  type WebhookRequest,
} from "@regenic/domain";
import {
  PersonalConnectorError,
} from "./personal-errors";

import type { ConnectorWebhookState as ConnectorState } from "./personal-connector-state";
import type { ConnectorWebhookView } from "./personal-connector-types";
import {
  wrapDriverError,
} from "./personal-connector-poll";

export async function ingestWebhook(
  state: ConnectorState,
  installationId: string,
  request: WebhookRequest,
): Promise<ConnectorWebhookView> {
  if (state.maintenanceHold) {
    throw new PersonalConnectorError(
      "disabled",
      "Store maintenance in progress",
      409,
    );
  }
  const host = state.runtime.requireHost();
  const store = host.get("authority");
  const installation = await state.requireInstallation(store, installationId);
  if (installation.status !== "enabled") {
    throw new PersonalConnectorError(
      "disabled",
      "Connector installation is disabled",
      409,
    );
  }
  const driver = state.drivers.get(installation.connector_type);
  if (!driver) {
    throw new PersonalConnectorError(
      "unsupported_connector",
      `Connector type cannot ingest webhooks: ${installation.connector_type}`,
      400,
    );
  }
  try {
    const { bindWebhook } = requireWebhookPorts(driver);
    const connector = await bindWebhook(
      installation,
      asConnectorHost(host),
      process.env,
    );
    const runner = new ConnectorRunner(
      new InProcessConnectorInvoker(connector),
      host.get("ingest"),
      store,
      () => new Date().toISOString(),
      state.quota,
    );
    const run = await withDeadline(
      runner.webhook({
        installation_id: installation.id,
        request,
        timeout_ms: connectorPollTimeoutMs(),
      }),
      connectorSyncTimeoutMs(),
      `webhook ${installation.id}`,
    );
    if (run.status === "unsupported_mode") {
      throw new PersonalConnectorError(
        "unsupported_channel",
        "Webhook ingest is not available",
        501,
      );
    }
    if (run.status === "throttled") {
      throw new PersonalConnectorError(
        "throttled",
        "Connector installation is rate limited",
        429,
      );
    }
    const accepted = run as Extract<
      ConnectorWebhookRunResult,
      { status: "completed" | "retryable_failure" }
    >;
    const summary = summarizeWebhook(accepted);
    if (summary.accepted_count > 0) {
      state.inbox.touchInboxDigest();
    }
    if (accepted.wake_thread_ids?.length) {
      await wakeStreamsForThreads(state, 
        installation.id,
        accepted.wake_thread_ids,
      );
    }
    return {
      installation_id: installation.id,
      ...summary,
      last_run_status: run.status,
    };
  } catch (error) {
    throw wrapDriverError(error, "sync_failed");
  }
}

async function wakeStreamsForThreads(
  state: ConnectorState,
  installationId: string,
  threadIds: readonly string[],
): Promise<void> {
  const streamKeys = streamKeysForThreadIds(threadIds);
  if (streamKeys.length === 0) {
    return;
  }
  const now = new Date().toISOString();
  await state.runtime.requireHost().get("authority").wakeUnassignedSyncWork({
    installation_id: installationId,
    stream_keys: streamKeys,
    now,
  });
}

function summarizeWebhook(run: Extract<
  ConnectorWebhookRunResult,
  { status: "completed" | "retryable_failure" }
>): {
  accepted_count: number;
  duplicate_count: number;
  quarantined_count: number;
} {
  return run.result.records.reduce(
    (acc, record) => {
      if (record.status === "accepted") {
        acc.accepted_count += 1;
      }
      if (record.status === "duplicate") {
        acc.duplicate_count += 1;
      }
      if (record.status === "quarantined") {
        acc.quarantined_count += 1;
      }
      return acc;
    },
    { accepted_count: 0, duplicate_count: 0, quarantined_count: 0 },
  );
}
