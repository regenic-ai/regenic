import type { ChannelCapabilities, ChannelDriverCore } from "./driver";
import type {
  ChannelConnector,
  ConnectorInstallation,
  ConnectorSourceMode,
} from "./ingest";

export function connectorSourceMode(
  connector?: Pick<ChannelConnector, "source_mode"> | null,
): ConnectorSourceMode {
  return connector?.source_mode ?? "poll";
}

export function connectorPolls(mode: ConnectorSourceMode): boolean {
  return mode === "poll" || mode === "hybrid";
}

export function connectorAcceptsWebhook(mode: ConnectorSourceMode): boolean {
  return mode === "webhook" || mode === "hybrid";
}

export function driverPolls(
  driver?: { source_mode?: ConnectorSourceMode } | null,
): boolean {
  return connectorPolls(connectorSourceMode(driver));
}

export function driverAcceptsWebhook(
  driver?: { source_mode?: ConnectorSourceMode } | null,
): boolean {
  return connectorAcceptsWebhook(connectorSourceMode(driver));
}

/**
 * New messages arrive through push ingest. Core still may poll history and
 * media. Opening a thread nudges that stream's push. Core does not schedule
 * live ticks for any install.
 */
export function driverPushes(
  driver: Pick<ChannelDriverCore, "capabilities"> | null | undefined,
  installation: ConnectorInstallation,
): boolean {
  return driver?.capabilities?.(installation).push === true;
}

/** Persisted hint so owed-work planning can skip live without loading drivers. */
export function liveViaFromConfig(
  config: Record<string, unknown> | null | undefined,
): "push" | "poll" {
  return config && config.live_via === "push" ? "push" : "poll";
}

export function stampLiveViaConfig<T extends Record<string, unknown>>(
  config: T,
  capabilities: Pick<ChannelCapabilities, "push">,
): T {
  if (capabilities.push === true) {
    return config.live_via === "push" ? config : { ...config, live_via: "push" };
  }
  if (config.live_via === undefined) {
    return config;
  }
  const { live_via: _ignored, ...rest } = config;
  return rest as T;
}
