import type { ChannelConnector, ConnectorSourceMode } from "./ingestion";

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
