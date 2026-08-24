import type { PersonalEngineView } from "./types";

export function engineRevision(
  engine: PersonalEngineView | null,
  detailed: boolean,
): string {
  if (!engine) {
    return "";
  }
  const installs = engine.installations
    .map(
      (item) =>
        `${item.id}:${item.status}:${item.last_attempt?.status ?? ""}:${item.label}`,
    )
    .join(",");
  const catalog = (engine.catalog ?? [])
    .map((item) => `${item.connector_type}:${item.installed}:${item.setup_ready ? 1 : 0}`)
    .join(",");
  return `${engine.kernel}|${engine.inbox_count}|${engine.pull?.phase ?? ""}|${engine.pull?.catching_up_count ?? 0}|${engine.pull?.last_error ?? ""}|${engine.pull?.last_error_hint ?? ""}|${engine.pull?.network?.kind ?? ""}|${pullStreamRevision(engine)}|${installs}|${catalog}${
    detailed ? `|${engine.pull?.last_tick_at ?? ""}` : ""
  }`;
}

function pullStreamRevision(engine: PersonalEngineView): string {
  return (engine.pull?.streams ?? [])
    .map((item) => `${item.thread_id ?? item.stream_key}:${item.phase}`)
    .join(",");
}
