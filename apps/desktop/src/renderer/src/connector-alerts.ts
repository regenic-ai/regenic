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

/**
 * A later successful page replaces these attempts, so they stay off the banner.
 * Shared-body contention is still catch-up. A timeout or lost lease is a retry.
 */
export function softSyncTone(
  errorCode: string | null | undefined,
): "catchup" | "retry" | null {
  const code = errorCode?.trim();
  if (code === "blob_reservation_conflict") {
    return "catchup";
  }
  if (code === "deadline_exceeded" || code === "lease_unavailable") {
    return "retry";
  }
  return null;
}

export function isSoftSyncFailure(errorCode: string | null | undefined): boolean {
  return softSyncTone(errorCode) != null;
}

type FailureClock = {
  id?: string;
  status: string;
  started_at: string;
  finished_at?: string;
  error_code?: string;
};

/** A successful check is strictly newer than the failure. */
export function laterCheckMovedPast(
  checkedAt: string | null | undefined,
  attempt: { started_at: string; finished_at?: string },
): boolean {
  const checked = checkedAt ? Date.parse(checkedAt) : Number.NaN;
  const at = Date.parse(attempt.finished_at ?? attempt.started_at);
  return Number.isFinite(checked) && Number.isFinite(at) && checked > at;
}

/** Newest hard failure on the card. Soft misses are not a durable fault. */
export function resolveHardFailure(input: {
  lastAttempt: FailureClock | null;
  hardFailure?: FailureClock | null;
}): FailureClock | null {
  const candidate = input.hardFailure
    ?? (input.lastAttempt?.status === "failed" ? input.lastAttempt : null);
  if (!candidate || candidate.status !== "failed" || isSoftSyncFailure(candidate.error_code)) {
    return null;
  }
  return candidate;
}

/**
 * Settled only after a later attempt succeeds. A newer sync touch or push
 * watermark does not recover a failure that is still the latest attempt.
 * `needs_attention` stays until that status is cleared on purpose.
 */
export function hardFailureSettled(input: {
  status: "enabled" | "disabled" | "needs_attention";
  lastCheckedAt?: string | null;
  lastAttempt: { id?: string; status: string } | null;
  hardFailure: FailureClock;
}): boolean {
  if (input.status === "needs_attention") {
    return false;
  }
  const latest = input.lastAttempt;
  if (!latest || latest.status !== "succeeded") {
    return false;
  }
  if (latest.id && input.hardFailure.id) {
    return latest.id !== input.hardFailure.id;
  }
  return laterCheckMovedPast(input.lastCheckedAt, input.hardFailure);
}

/** Soft poll miss — keep in sync with domain `looksLikeSyncSoftMissMessage`. */
function looksLikeSyncSoftMissMessage(message: string): boolean {
  const text = message.trim();
  if (/\btimed out after \d+ms\b/i.test(text)) {
    return true;
  }
  if (text.startsWith("Blob reservation is busy or unavailable")) {
    return true;
  }
  const lower = text.toLowerCase();
  return (
    lower.includes("already leased") ||
    lower.includes("already syncing") ||
    lower.includes("lease_unavailable")
  );
}

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
    const hard = resolveHardFailure({
      lastAttempt: installation.last_attempt,
      hardFailure: installation.last_hard_failure,
    });
    if (
      hard &&
      !hardFailureSettled({
        status: installation.status,
        lastCheckedAt: installation.last_checked_at,
        lastAttempt: installation.last_attempt,
        hardFailure: hard,
      })
    ) {
      push({
        installationId: installation.id,
        name: connectorDisplayName(installation),
        message: hard.error_code?.trim() || t("chrome.connectorAttemptFailed"),
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

  for (const stream of pull.streams) {
    if (stream.phase !== "error") {
      continue;
    }
    const error =
      stream.last_error?.trim() || t("chrome.connectorStreamError");
    // Poll deadlines and lease contention are soft misses; do not sticky-banner.
    if (looksLikeSyncSoftMissMessage(error)) {
      continue;
    }
    const matched = matchStreamInstallation(stream, activeInstallations);
    const streamLabel = stream.label?.trim() || null;
    // stream.label is usually a conversation title (e.g. 陈静), not the
    // connector — keep it in the message, name the connector instead.
    const message =
      streamLabel && matched
        ? `${streamLabel}: ${error}`
        : error;
    alerts.push({
      installationId: matched?.id ?? null,
      name: matched
        ? connectorDisplayName(matched)
        : t("chrome.connectorUnknown"),
      message,
      hint: pull.last_error_hint,
    });
  }

  if (pull.last_error?.trim()) {
    const top = pull.last_error.trim();
    if (looksLikeSyncSoftMissMessage(top)) {
      return alerts;
    }
    // Prefer a failing stream's identity; otherwise stay generic — do not
    // guess installations[0], which may be unrelated or disabled.
    const named = alerts[0] ?? {
      installationId: null,
      name: t("chrome.connectorUnknown"),
    };
    alerts.unshift({
      installationId: named.installationId,
      name: named.name,
      message: top,
      hint: pull.last_error_hint ?? pull.network?.hint ?? null,
    });
  }

  return alerts;
}

/** Prefer stream_key → installation id; label is often a thread title. */
function matchStreamInstallation(
  stream: Pick<PullStatusView["streams"][number], "stream_key" | "label">,
  installations: EngineInstallationView[],
): EngineInstallationView | undefined {
  const key = stream.stream_key.trim();
  if (key) {
    const byKey = installations.find(
      (item) => key === item.id || key.startsWith(`${item.id}:`),
    );
    if (byKey) {
      return byKey;
    }
  }
  const label = stream.label?.trim().toLowerCase();
  if (!label) {
    return undefined;
  }
  return installations.find(
    (item) => connectorDisplayName(item).toLowerCase() === label,
  );
}
