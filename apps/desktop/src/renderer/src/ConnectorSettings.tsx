import { useEffect, useState } from "react";
import {
  attemptSummary,
  installationStatusLabel,
} from "./format";
import { useLocale } from "./LocaleContext";
import type { ConnectorCatalogItem, EngineInstallationView } from "./types";

export function ConnectorKind({
  kind,
  installations,
  busyId,
  syncingAll,
  installing,
  pendingUninstall,
  onOpenInstall,
  onCloseInstall,
  onInstall,
  onSync,
  onToggle,
  onUpdate,
  onUninstall,
}: {
  kind: ConnectorCatalogItem;
  installations: EngineInstallationView[];
  busyId: string | null;
  syncingAll: boolean;
  installing: boolean;
  pendingUninstall: boolean;
  onOpenInstall: () => void;
  onCloseInstall: () => void;
  onInstall: (config: Record<string, string>) => void;
  onSync: (id: string) => void;
  onToggle: (installation: EngineInstallationView) => void;
  onUpdate: (
    installation: EngineInstallationView,
    config: Record<string, string>,
  ) => Promise<boolean>;
  onUninstall: (installation: EngineInstallationView) => void;
}) {
  const { t } = useLocale();
  const [editingId, setEditingId] = useState<string | null>(null);
  return (
    <div className={`connector-kind${kind.installed ? " is-installed" : ""}`}>
      <div className="install">
        <div>
          <strong>{kind.title}</strong>
          <div className="muted">{kind.description}</div>
          <div className="install-meta">
            <span className={`chip ${kind.installed ? "running" : ""}`.trim()}>
              {kind.installed
                ? t("connector.installed", { count: kind.instance_count })
                : t("connector.notInstalled")}
            </span>
            <span className="muted">
              {t("connector.credentials", { hint: kind.credential_hint })}
            </span>
          </div>
          <PrerequisiteList
            items={visiblePrerequisites(kind, defaultFieldValues(kind))}
          />
        </div>
        <div className="install-actions">
          {!kind.singleton || !kind.installed ? (
            <button
              type="button"
              className={kind.installed ? "ghost" : "primary"}
              disabled={
                busyId !== null ||
                syncingAll ||
                !kind.setup_ready ||
                installing
              }
              onClick={onOpenInstall}
            >
              {busyId === kind.connector_type
                ? t("connector.installing")
                : t("connector.install")}
            </button>
          ) : null}
        </div>
      </div>
      {pendingUninstall && installations.length === 0 ? (
        <p className="muted">{t("connector.uninstalling")}</p>
      ) : null}
      {installing ? (
        <ConnectorSettingsDialog
          title={t("connector.installTitle", { title: kind.title })}
          kind={kind}
          busy={busyId === kind.connector_type}
          submitLabel={t("connector.install")}
          busyLabel={t("connector.installing")}
          onSubmit={onInstall}
          onClose={onCloseInstall}
        />
      ) : null}
      {installations.map((installation) => (
        <ConnectorRow
          key={installation.id}
          kind={kind}
          installation={installation}
          busy={busyId === installation.id || syncingAll}
          editing={editingId === installation.id}
          onEdit={() =>
            setEditingId((current) =>
              current === installation.id ? null : installation.id,
            )
          }
          onSync={() => onSync(installation.id)}
          onToggle={() => onToggle(installation)}
          onSave={(config) => {
            void onUpdate(installation, config).then((saved) => {
              if (saved) {
                setEditingId(null);
              }
            });
          }}
          onUninstall={() => onUninstall(installation)}
        />
      ))}
    </div>
  );
}

function ConnectorSettingsDialog({
  title,
  kind,
  busy,
  initialValues,
  submitLabel,
  busyLabel,
  onSubmit,
  onClose,
}: {
  title: string;
  kind: ConnectorCatalogItem;
  busy: boolean;
  initialValues?: Record<string, string>;
  submitLabel: string;
  busyLabel: string;
  onSubmit: (config: Record<string, string>) => void;
  onClose: () => void;
}) {
  const { t } = useLocale();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);
  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) {
          onClose();
        }
      }}
    >
      <div className="dialog" role="dialog" aria-modal="true" aria-label={title}>
        <div className="dialog-head">
          <h2>{title}</h2>
          <button type="button" className="ghost" disabled={busy} onClick={onClose}>
            {t("connector.close")}
          </button>
        </div>
        <ConnectorSettingsForm
          kind={kind}
          busy={busy}
          initialValues={initialValues}
          submitLabel={submitLabel}
          busyLabel={busyLabel}
          onSubmit={onSubmit}
        />
      </div>
    </div>
  );
}

function ConnectorSettingsForm({
  kind,
  busy,
  initialValues,
  submitLabel,
  busyLabel,
  onSubmit,
}: {
  kind: ConnectorCatalogItem;
  busy: boolean;
  initialValues?: Record<string, string>;
  submitLabel: string;
  busyLabel: string;
  onSubmit: (config: Record<string, string>) => void;
}) {
  const { t } = useLocale();
  const [values, setValues] = useState<Record<string, string>>(() => ({
    ...defaultFieldValues(kind),
    ...initialValues,
  }));
  const fields = kind.fields.filter((field) =>
    matchesWhen(field.visible_when, values),
  );
  const prerequisites = visiblePrerequisites(kind, values);
  const blocked = prerequisites.some((item) => item.required && !item.ready);
  const missingRequired = fields.some(
    (field) => field.required && !(values[field.key] ?? "").trim(),
  );
  return (
    <form
      className="install-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (busy) {
          return;
        }
        onSubmit(values);
      }}
    >
      <PrerequisiteList items={prerequisites} />
      {fields.map((field) => {
        const body = field.multiple ? (
          <CheckOptionList
            field={field}
            selected={splitValues(values[field.key])}
            onToggle={(value) =>
              setValues((current) => ({
                ...current,
                [field.key]: toggleCsvValue(current[field.key], value),
              }))
            }
          />
        ) : field.options ? (
          <select
            value={values[field.key] ?? field.default ?? ""}
            onChange={(event) =>
              setValues((current) => ({
                ...current,
                [field.key]: event.target.value,
              }))
            }
          >
            {field.options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        ) : (
          <input
            value={values[field.key] ?? ""}
            placeholder={field.placeholder}
            required={field.required}
            onChange={(event) =>
              setValues((current) => ({
                ...current,
                [field.key]: event.target.value,
              }))
            }
          />
        );
        const heading = (
          <span>
            {field.label}
            {field.required ? " *" : ""}
          </span>
        );
        return field.multiple ? (
          <div key={field.key} className="field">
            {heading}
            {body}
          </div>
        ) : (
          <label key={field.key} className="field">
            {heading}
            {body}
          </label>
        );
      })}
      <button
        type="submit"
        className="primary"
        disabled={busy || blocked || missingRequired}
      >
        {busy
          ? busyLabel
          : blocked
            ? t("connector.prereqFirst")
            : missingRequired
              ? t("connector.fillRequired")
              : submitLabel}
      </button>
    </form>
  );
}

function CheckOptionList({
  field,
  selected,
  onToggle,
}: {
  field: ConnectorCatalogItem["fields"][number];
  selected: string[];
  onToggle: (value: string) => void;
}) {
  const { t } = useLocale();
  const [query, setQuery] = useState("");
  const options = field.options ?? [];
  if (options.length === 0) {
    return (
      <p className="field-empty">{field.placeholder ?? "No options yet"}</p>
    );
  }
  const searchable = options.length > 4;
  const visible = filterCheckOptions(options, query);
  return (
    <div className="check-options">
      {searchable ? (
        <input
          type="search"
          value={query}
          placeholder={t("connector.search", { label: field.label.toLowerCase() })}
          aria-label={t("connector.search", { label: field.label.toLowerCase() })}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
            }
          }}
        />
      ) : null}
      {visible.length === 0 ? (
        <p className="field-empty">{t("connector.noMatches")}</p>
      ) : (
        <ul className="check-list">
          {visible.map((option) => {
            const checked = selected.includes(option.value);
            return (
              <li key={option.value}>
                <label className={`check-item${checked ? " active" : ""}`}>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => onToggle(option.value)}
                  />
                  <span>{option.label}</span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function filterCheckOptions(
  options: { value: string; label: string }[],
  query: string,
): { value: string; label: string }[] {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return options;
  }
  return options.filter(
    (option) =>
      option.label.toLowerCase().includes(needle) ||
      option.value.toLowerCase().includes(needle),
  );
}

function splitValues(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function toggleCsvValue(current: string | undefined, value: string): string {
  const selected = new Set(splitValues(current));
  if (selected.has(value)) {
    selected.delete(value);
  } else {
    selected.add(value);
  }
  return [...selected].join(",");
}

function PrerequisiteList({ items }: { items: ConnectorCatalogItem["prerequisites"] }) {
  const { t } = useLocale();
  if (items.length === 0) {
    return null;
  }
  return (
    <ul className="prereq-list">
      {items.map((item) => (
        <li key={`${item.kind}:${item.key}`}>
          <span className={`chip ${item.ready ? "running" : item.required ? "stopped" : ""}`.trim()}>
            {item.ready
              ? t("connector.ready")
              : item.required
                ? t("connector.needed")
                : t("connector.optional")}
          </span>
          {` ${item.label}`}
          {item.hint ? ` · ${item.hint}` : ""}
        </li>
      ))}
    </ul>
  );
}

function defaultFieldValues(kind: ConnectorCatalogItem): Record<string, string> {
  const initial: Record<string, string> = {};
  for (const field of kind.fields) {
    if (field.default) {
      initial[field.key] = field.default;
    }
  }
  return initial;
}

function visiblePrerequisites(
  kind: ConnectorCatalogItem,
  values: Record<string, string>,
): ConnectorCatalogItem["prerequisites"] {
  return (kind.prerequisites ?? []).filter((item) =>
    matchesWhen(item.visible_when, values),
  );
}

function matchesWhen(
  when: { field: string; value: string } | undefined,
  values: Record<string, string>,
): boolean {
  if (!when) {
    return true;
  }
  return (values[when.field] ?? "") === when.value;
}

function ConnectorRow({
  kind,
  installation,
  busy,
  editing,
  onEdit,
  onSync,
  onToggle,
  onSave,
  onUninstall,
}: {
  kind: ConnectorCatalogItem;
  installation: EngineInstallationView;
  busy: boolean;
  editing: boolean;
  onEdit: () => void;
  onSync: () => void;
  onToggle: () => void;
  onSave: (config: Record<string, string>) => void;
  onUninstall: () => void;
}) {
  const { t } = useLocale();
  const statusChip =
    installation.status === "enabled"
      ? "running"
      : installation.status === "needs_attention"
        ? "stopped"
        : "";
  return (
    <div className="install-block">
      <div className="install install-instance">
        <div>
          <strong title={installation.id}>
            {kind.title} · {installation.label}
          </strong>
          <div className="install-meta">
            <span className={`chip ${statusChip}`.trim()}>
              {installationStatusLabel(installation.status)}
            </span>
            {installation.detail ? (
              <span className="muted">{installation.detail}</span>
            ) : null}
          </div>
          <div className="muted">{attemptSummary(installation.last_attempt)}</div>
        </div>
        <div className="install-actions">
          <button
            type="button"
            className="primary"
            disabled={busy || !installation.syncable}
            onClick={onSync}
          >
            {busy ? t("engine.syncing") : t("connector.sync")}
          </button>
          <button type="button" className="ghost" disabled={busy} onClick={onToggle}>
            {installation.status === "disabled"
              ? t("connector.enable")
              : t("connector.disable")}
          </button>
          {kind.fields.length > 0 ? (
            <button type="button" className="ghost" disabled={busy} onClick={onEdit}>
              {t("connector.editSync")}
            </button>
          ) : null}
          <button
            type="button"
            className="ghost danger"
            disabled={busy}
            onClick={onUninstall}
          >
            {t("connector.uninstall")}
          </button>
        </div>
      </div>
      {editing ? (
        <ConnectorSettingsDialog
          key={`${installation.id}:${JSON.stringify(installation.settings ?? {})}`}
          title={t("connector.editTitle", {
            type: kind.title,
          })}
          kind={kind}
          busy={busy}
          initialValues={installation.settings}
          submitLabel={t("connector.save")}
          busyLabel={t("connector.saving")}
          onSubmit={onSave}
          onClose={onEdit}
        />
      ) : null}
    </div>
  );
}
