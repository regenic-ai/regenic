import { t } from "../../shared/i18n.ts";
import type {
  EngineInstallationView,
  PersonalEngineView,
  PullStatusView,
} from "./types.ts";

export type ConnectorAlert = {
  installationId: string | null;
  name: string;
  message: string;
  hint: string | null;
};

function isActiveInstallation(item: EngineInstallationView): boolean {
  return item.status === "enabled" || item.status === "needs_attention";
}

/** Failures that should surface in the header chip + persistent banner. */
export function connectorAlerts(
  engine: PersonalEngineView | null,
): ConnectorAlert[] {
  if (!engine) {
    return [];
  }
  const alerts: ConnectorAlert[] = [];
  const seen = new Set<string>();
  const push = (alert: ConnectorAlert) => {
    const key = `${alert.installationId ?? ""}|${alert.name}|${alert.message}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    alerts.push(alert);
  };

  const active = engine.installations.filter(isActiveInstallation);

  if (engine.kernel === "stopped" && active.length > 0) {
    for (const installation of active) {
      push({
        installationId: installation.id,
        name: connectorDisplayName(installation),
        message: t("chrome.connectorKernelStopped"),
        hint: null,
      });
    }
  }

  for (const installation of active) {
    if (installation.status === "needs_attention") {
      push({
        installationId: installation.id,
        name: connectorDisplayName(installation),
        message: t("chrome.connectorNeedsAttention"),
        hint: installation.detail,
      });
    }
    if (installation.last_attempt?.status === "failed") {
      push({
        installationId: installation.id,
        name: connectorDisplayName(installation),
        message:
          installation.last_attempt.error_code?.trim() ||
          t("chrome.connectorAttemptFailed"),
        hint: null,
      });
    }
  }

  for (const alert of pullConnectorAlerts(engine.pull, active)) {
    push(alert);
  }

  return alerts;
}

export function hasConnectorFailure(engine: PersonalEngineView | null): boolean {
  return connectorAlerts(engine).length > 0;
}

export function connectorDisplayName(
  installation: Pick<EngineInstallationView, "label" | "channel_label" | "connector_type">,
): string {
  return (
    installation.channel_label?.trim() ||
    installation.label?.trim() ||
    installation.connector_type
  );
}

function pullConnectorAlerts(
  pull: PullStatusView | undefined,
  activeInstallations: EngineInstallationView[],
): ConnectorAlert[] {
  if (!pull) {
    return [];
  }
  const alerts: ConnectorAlert[] = [];
  const byLabel = new Map(
    activeInstallations.map((item) => [
      connectorDisplayName(item).toLowerCase(),
      item,
    ]),
  );

  for (const stream of pull.streams) {
    if (stream.phase !== "error") {
      continue;
    }
    const label = stream.label?.trim() || t("chrome.connectorUnknown");
    const matched = stream.label
      ? byLabel.get(stream.label.trim().toLowerCase())
      : undefined;
    alerts.push({
      installationId: matched?.id ?? null,
      name: matched ? connectorDisplayName(matched) : label,
      message: stream.last_error?.trim() || t("chrome.connectorStreamError"),
      hint: pull.last_error_hint,
    });
  }

  if (pull.last_error?.trim()) {
    // Prefer a failing stream's identity; otherwise stay generic — do not
    // guess installations[0], which may be unrelated or disabled.
    const named = alerts[0] ?? {
      installationId: null,
      name: t("chrome.connectorUnknown"),
    };
    alerts.unshift({
      installationId: named.installationId,
      name: named.name,
      message: pull.last_error.trim(),
      hint: pull.last_error_hint ?? pull.network?.hint ?? null,
    });
  }

  return alerts;
}
