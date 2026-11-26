import { t, type Translate } from "../../shared/i18n.ts";
import type { HostStats, HostWatchKind } from "../../shared/host-watch.ts";
import type { ConnectorAlert } from "./connector-alerts.ts";
import {
  aggregateInstallationSync,
  chipLabel,
  diskWatchCopy,
  formatChatTime,
  memoryWatchCopy,
  networkWatchHint,
  networkWatchLabel,
  pullStatusLabel,
  syncEtaSummary,
  syncFreshnessSummary,
  syncProgressSummary,
  syncProgressTone,
  syncReadinessTone,
} from "./format.ts";
import type { EngineChipState, PersonalEngineView } from "./types.ts";

export type StatusTone = "ok" | "warn" | "risk";

export interface ShellStatusRow {
  label: string;
  value: string;
  tone?: StatusTone;
  mono?: boolean;
}

export interface ShellStatus {
  chip: EngineChipState;
  tone: StatusTone;
  /** Older history or attachments are still catching up; not a problem. */
  syncing: boolean;
  rows: ShellStatusRow[];
  meta: ShellStatusRow[];
  hints: string[];
  errors: string[];
  alerts: ConnectorAlert[];
}

function hostTone(kind: HostWatchKind | undefined): StatusTone | undefined {
  if (kind === "critical") return "risk";
  if (kind === "attention") return "warn";
  return undefined;
}

function networkTone(kind: string | undefined): StatusTone | undefined {
  if (kind === "blocked") return "risk";
  if (kind === "proxy") return "warn";
  return undefined;
}

function quiet(tone: StatusTone | undefined): StatusTone | undefined {
  return tone === "ok" ? undefined : tone;
}

export function buildShellStatus(
  engine: PersonalEngineView | null,
  host: HostStats | null,
  chip: EngineChipState,
  alerts: ConnectorAlert[],
  translate: Translate = t,
  titles: ReadonlyArray<{ id: string; title: string }> = [],
): ShellStatus {
  const rows: ShellStatusRow[] = [];
  const meta: ShellStatusRow[] = [];
  const hints: string[] = [];
  const errors: string[] = [];
  if (engine) {
    const pull = engine.pull;
    const coverage = aggregateInstallationSync(engine.installations);
    rows.push(
      {
        label: translate("engine.livePull"),
        value: [
          pullStatusLabel(pull, titles),
          pull?.last_tick_at ? formatChatTime(pull.last_tick_at) : "",
          pull?.last_accepted_count ? `+${pull.last_accepted_count}` : "",
        ]
          .filter(Boolean)
          .join(" · "),
        tone: pull?.last_error
          ? "risk"
          : pull?.phase === "pulling" || (pull?.catching_up_count ?? 0) > 0
            ? "warn"
            : undefined,
      },
      {
        label: translate("engine.coverage"),
        value: coverage ? syncProgressSummary(coverage) : "—",
        tone: quiet(syncProgressTone(coverage)),
      },
      {
        label: translate("engine.freshness"),
        value: syncFreshnessSummary(engine.sync_readiness),
      },
      {
        label: translate("engine.eta"),
        value: syncEtaSummary(engine.sync_readiness),
        tone: quiet(syncReadinessTone(engine.sync_readiness)),
      },
      {
        label: translate("engine.network"),
        value: [
          networkWatchLabel(pull?.network?.kind),
          pull?.network?.kind !== "ok" && pull?.network?.proxy ? pull.network.proxy : "",
        ]
          .filter(Boolean)
          .join(" · "),
        tone: networkTone(pull?.network?.kind),
      },
    );
    meta.push(
      { label: translate("engine.org"), value: engine.org_id, mono: true },
      { label: translate("engine.database"), value: engine.database_path ?? "—", mono: true },
      { label: translate("engine.pluginDir"), value: engine.plugin_dir ?? "—", mono: true },
    );
    if (pull?.last_error) errors.push(pull.last_error);
    const networkHint = networkWatchHint(pull?.last_error_hint ?? pull?.network?.hint);
    if (networkHint) hints.push(networkHint);
  }
  if (host) {
    rows.push(
      {
        label: translate("engine.memory"),
        value: memoryWatchCopy(host.memory),
        tone: hostTone(host.memory.kind),
      },
      {
        label: translate("engine.disk"),
        value: diskWatchCopy(host.disk),
        tone: hostTone(host.disk.kind),
      },
    );
    if (host.disk.hint) hints.push(host.disk.hint);
    if (host.memory.hint) hints.push(host.memory.hint);
  }
  const tone: StatusTone =
    chip === "error" || chip === "stopped"
      ? "risk"
      : chip === "degraded" ||
          hostTone(host?.memory.kind) ||
          hostTone(host?.disk.kind) ||
          networkTone(engine?.pull?.network?.kind)
        ? "warn"
        : "ok";
  const syncing =
    engine?.pull?.phase === "pulling" || (engine?.pull?.catching_up_count ?? 0) > 0;
  return { chip, tone, syncing, rows, meta, hints, errors, alerts };
}

export function statusSummary(status: ShellStatus, translate: Translate = t): string {
  if (status.tone === "ok") {
    return status.syncing ? translate("chip.syncing") : translate("shell.status.ok");
  }
  return status.chip === "running"
    ? translate("shell.status.attention")
    : chipLabel(status.chip, translate);
}
