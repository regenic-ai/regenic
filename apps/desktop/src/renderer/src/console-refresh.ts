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
        `${item.id}:${item.status}:${item.last_attempt?.status ?? ""}:${item.label}:${item.channel_label ?? ""}:${item.sync?.discovered ?? ""}:${item.sync?.bootstrap_pending ?? ""}:${item.sync?.steady ?? ""}:${item.sync?.catalog_complete ? 1 : 0}`,
    )
    .join(",");
  const catalog = (engine.catalog ?? [])
    .map((item) =>
      [
        item.connector_type,
        item.installed ? 1 : 0,
        item.setup_ready ? 1 : 0,
        item.title,
        item.credential_hint,
        (item.setup_steps ?? []).map((step) => step.title).join("/"),
        (item.fields ?? []).map((field) => field.label).join("/"),
        (item.prerequisites ?? []).map((row) => `${row.label}:${row.hint ?? ""}`).join("/"),
      ].join(":"),
    )
    .join(",");
  const executors = (engine.executor_installations ?? [])
    .map((item) => `${item.id}:${item.label}:${item.detail ?? ""}`)
    .join(",");
  const executorCatalog = (engine.executor_catalog ?? [])
    .map((item) =>
      (item.fields ?? [])
        .flatMap((field) => (field.options ?? []).map((option) => option.label))
        .join("/"),
    )
    .join(",");
  return `${engine.kernel}|${engine.inbox_count}|${engine.pull?.phase ?? ""}|${engine.pull?.catching_up_count ?? 0}|${engine.pull?.last_error ?? ""}|${engine.pull?.last_error_hint ?? ""}|${engine.pull?.network?.kind ?? ""}|${pullStreamRevision(engine)}|${installs}|${catalog}|${executors}|${executorCatalog}${
    detailed ? `|${engine.pull?.last_tick_at ?? ""}` : ""
  }`;
}

function pullStreamRevision(engine: PersonalEngineView): string {
  return (engine.pull?.streams ?? [])
    .map((item) => `${item.thread_id ?? item.stream_key}:${item.phase}`)
    .join(",");
}
