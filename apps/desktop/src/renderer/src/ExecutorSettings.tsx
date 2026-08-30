import { useEffect, useState } from "react";
import type { MessageKey } from "../../shared/i18n.ts";
import { installationStatusLabel } from "./format";
import { useLocale } from "./LocaleContext";
import type {
  EngineExecutorView,
  ExecutorKindCatalogItem,
} from "./types";

export function ExecutorKind({
  kind,
  installations,
  busyId,
  installing,
  onOpenInstall,
  onCloseInstall,
  onInstall,
  onToggle,
  onUpdate,
  onUninstall,
}: {
  kind: ExecutorKindCatalogItem;
  installations: EngineExecutorView[];
  busyId: string | null;
  installing: boolean;
  onOpenInstall: () => void;
  onCloseInstall: () => void;
  onInstall: (config: Record<string, string>) => void;
  onToggle: (installation: EngineExecutorView) => void;
  onUpdate: (
    installation: EngineExecutorView,
    config: Record<string, string>,
  ) => Promise<boolean>;
  onUninstall: (installation: EngineExecutorView) => void;
}) {
  const { t } = useLocale();
  const [editingId, setEditingId] = useState<string | null>(null);
  const title =
    kind.kind === "http" ? t("executor.kind.http") : t("executor.kind.local");
  const description =
    kind.kind === "http"
      ? t("executor.kind.httpLead")
      : t("executor.kind.localLead");
  return (
    <div className={`connector-kind${kind.installed ? " is-installed" : ""}`}>
      <div className="install">
        <div>
          <strong>{title}</strong>
          <div className="muted">{description}</div>
          <div className="install-meta">
            <span className={`chip ${kind.installed ? "running" : ""}`.trim()}>
              {kind.installed
                ? t("connector.installed", { count: kind.instance_count })
                : t("connector.notInstalled")}
            </span>
            <span className="muted">
              {t("connector.credentials", { hint: credentialHint(kind.kind, t) })}
            </span>
          </div>
        </div>
        <div className="install-actions">
          <button
            type="button"
            className={kind.installed ? "ghost" : "primary"}
            disabled={busyId !== null || (kind.kind === "local_connector" && !kind.setup_ready)}
            onClick={onOpenInstall}
            title={
              kind.kind === "local_connector" && !kind.setup_ready
                ? t("executor.needConnector")
                : undefined
            }
          >
            {t("connector.install")}
          </button>
        </div>
      </div>
      {kind.kind === "local_connector" && !kind.setup_ready ? (
        <p className="muted">{t("executor.needConnector")}</p>
      ) : null}
      {installing ? (
        <ExecutorSettingsDialog
          title={t("executor.installTitle", { title })}
          kind={kind}
          busy={busyId === `ex:${kind.kind}`}
          submitLabel={t("connector.install")}
          busyLabel={t("connector.installing")}
          onSubmit={onInstall}
          onClose={onCloseInstall}
        />
      ) : null}
      {installations.map((installation) => (
        <ExecutorRow
          key={installation.id}
          kind={kind}
          installation={installation}
          busy={busyId === `ex:${installation.id}`}
          editing={editingId === installation.id}
          onEdit={() =>
            setEditingId((current) =>
              current === installation.id ? null : installation.id,
            )
          }
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

function ExecutorRow({
  kind,
  installation,
  busy,
  editing,
  onEdit,
  onToggle,
  onSave,
  onUninstall,
}: {
  kind: ExecutorKindCatalogItem;
  installation: EngineExecutorView;
  busy: boolean;
  editing: boolean;
  onEdit: () => void;
  onToggle: () => void;
  onSave: (config: Record<string, string>) => void;
  onUninstall: () => void;
}) {
  const { t } = useLocale();
  return (
    <div className="install-row">
      <div>
        <strong>{installation.label}</strong>
        <div className="muted">
          {[
            installationStatusLabel(installation.status),
            executorDetail(installation.detail, t),
          ]
            .filter(Boolean)
            .join(" · ")}
        </div>
      </div>
      <div className="install-actions">
        <button type="button" className="ghost" disabled={busy} onClick={onEdit}>
          {t("executor.edit")}
        </button>
        <button type="button" className="ghost" disabled={busy} onClick={onToggle}>
          {installation.status === "disabled"
            ? t("connector.enable")
            : t("connector.disable")}
        </button>
        <button type="button" className="ghost" disabled={busy} onClick={onUninstall}>
          {t("connector.uninstall")}
        </button>
      </div>
      {editing ? (
        <ExecutorSettingsForm
          kind={kind}
          busy={busy}
          initialValues={valuesFromInstallation(installation)}
          optionalPin={installation.id === "dsh"}
          submitLabel={t("connector.save")}
          busyLabel={t("connector.saving")}
          onSubmit={onSave}
        />
      ) : null}
    </div>
  );
}

function ExecutorSettingsDialog({
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
  kind: ExecutorKindCatalogItem;
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
        <ExecutorSettingsForm
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

function ExecutorSettingsForm({
  kind,
  busy,
  initialValues,
  optionalPin,
  submitLabel,
  busyLabel,
  onSubmit,
}: {
  kind: ExecutorKindCatalogItem;
  busy: boolean;
  initialValues?: Record<string, string>;
  optionalPin?: boolean;
  submitLabel: string;
  busyLabel: string;
  onSubmit: (config: Record<string, string>) => void;
}) {
  const { t } = useLocale();
  const [values, setValues] = useState<Record<string, string>>(() => ({
    ...defaultValues(kind),
    ...initialValues,
  }));
  const missingRequired = kind.fields.some((field) => {
    if (optionalPin && field.key === "installation_id") {
      return false;
    }
    return field.required && !(values[field.key] ?? "").trim();
  });
  return (
    <form
      className="install-form"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(values);
      }}
    >
      {kind.fields.map((field) => {
        const copy = fieldCopy(kind.kind, field.key, t);
        return (
          <label key={field.key} className="field">
            <span>
              {copy.label}
              {field.required && !(optionalPin && field.key === "installation_id")
                ? " *"
                : ""}
            </span>
            {field.options ? (
              <select
                value={values[field.key] ?? ""}
                onChange={(event) =>
                  setValues((current) => ({
                    ...current,
                    [field.key]: event.target.value,
                  }))
                }
              >
                <option value="">{t("executor.chooseConnector")}</option>
                {field.options.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            ) : (
              <input
                value={values[field.key] ?? ""}
                placeholder={copy.placeholder}
                required={
                  field.required && !(optionalPin && field.key === "installation_id")
                }
                onChange={(event) =>
                  setValues((current) => ({
                    ...current,
                    [field.key]: event.target.value,
                  }))
                }
              />
            )}
            {copy.hint ? <span className="muted">{copy.hint}</span> : null}
          </label>
        );
      })}
      <div className="install-actions">
        <button type="submit" className="primary" disabled={busy || missingRequired}>
          {busy ? busyLabel : submitLabel}
        </button>
      </div>
    </form>
  );
}

function defaultValues(kind: ExecutorKindCatalogItem): Record<string, string> {
  return Object.fromEntries(kind.fields.map((field) => [field.key, ""]));
}

function credentialHint(
  kind: ExecutorKindCatalogItem["kind"],
  translate: (key: MessageKey) => string,
): string {
  return kind === "http"
    ? translate("executor.credential.http")
    : translate("executor.credential.local");
}

function executorDetail(
  detail: string | null,
  translate: (key: MessageKey) => string,
): string | null {
  if (detail === "Auto · first creatable connector") {
    return translate("executor.detail.autoFirst");
  }
  if (detail === "Connector missing") {
    return translate("executor.detail.connectorMissing");
  }
  return detail;
}

function fieldCopy(
  kind: ExecutorKindCatalogItem["kind"],
  key: string,
  translate: (key: MessageKey) => string,
): { label: string; placeholder?: string; hint?: string } {
  if (key === "name") {
    return {
      label: translate("executor.field.name"),
      placeholder: translate(
        kind === "http"
          ? "executor.field.nameHttpPlaceholder"
          : "executor.field.nameLocalPlaceholder",
      ),
    };
  }
  if (key === "installation_id") {
    return { label: translate("executor.field.connector") };
  }
  if (key === "base_url") {
    return {
      label: translate("executor.field.baseUrl"),
      placeholder: translate("executor.field.baseUrlPlaceholder"),
    };
  }
  if (key === "auth_env") {
    return {
      label: translate("executor.field.authEnv"),
      placeholder: translate("executor.field.authEnvPlaceholder"),
      hint: translate("executor.field.authEnvHint"),
    };
  }
  return { label: key };
}

function valuesFromInstallation(
  installation: EngineExecutorView,
): Record<string, string> {
  return {
    name: installation.name,
    installation_id: installation.connector_id ?? "",
    base_url: installation.base_url ?? "",
    auth_env: installation.auth_env ?? "",
  };
}
