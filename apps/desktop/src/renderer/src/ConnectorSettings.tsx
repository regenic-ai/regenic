import { useCallback, useEffect, useRef, useState } from "react";
import { fetchConnectorPairingCode, fetchCatalogFieldOptions, fetchConnectorCredentials, importConnectorFile } from "./api";
import { ConnectorFormFields } from "./ConnectorFormFields";
import { InfoTip } from "./InfoTip";
import {
  importConnectorFiles,
  connectorImportSummary,
} from "./connector-import";
import {
  resolveCatalogFieldOptions,
} from "./connector-config";
import {
  connectorFieldMissing,
  connectorFieldInvalid,
  connectorFormPayload,
  initialConnectorValues,
  initialConnectorOptions,
  type ConnectorFormValues,
} from "./connector-form";
import {
  catalogInstallConfirm,
  matchesCatalogFieldWhen,
} from "./connector-install-guard";
import {
  attemptSummary,
  connectorActionError,
  installationStatusLabel,
  syncProgressSummary,
} from "./format";
import { openExternal } from "./CatalogDocs";
import { useLocale } from "./LocaleContext";
import type {
  ConnectorCatalogItem,
  ConnectorSetupStep,
  ConnectorFieldOption,
  EngineInstallationView,
  SyncRunMode,
} from "./types";

export function ConnectorKind({
  kind,
  installations,
  busyId,
  syncingAll,
  installing,
  pendingUninstall,
  pairingCode,
  error,
  onOpenInstall,
  onCloseInstall,
  onInstall,
  onSync,
  onRetryQuarantines,
  onEnable,
  onUpdate,
  onRefresh,
  onUninstall,
  onPairingCode,
}: {
  kind: ConnectorCatalogItem;
  installations: EngineInstallationView[];
  busyId: string | null;
  syncingAll: boolean;
  installing: boolean;
  pendingUninstall: boolean;
  pairingCode?: Record<string, string>;
  error?: string | null;
  onOpenInstall: () => void;
  onCloseInstall: () => void;
  onInstall: (config: ConnectorFormValues) => void;
  onSync: (id: string, mode: SyncRunMode) => void;
  onRetryQuarantines: (id: string) => void;
  onEnable: (installation: EngineInstallationView) => void;
  onUpdate: (
    installation: EngineInstallationView,
    config: ConnectorFormValues,
  ) => Promise<boolean>;
  onRefresh?: () => Promise<void>;
  onUninstall: (installation: EngineInstallationView) => void;
  onPairingCode?: (id: string, code: string) => void;
}) {
  const { t } = useLocale();
  const [editingId, setEditingId] = useState<string | null>(null);
  return (
    <div
      id={`connector-type-${kind.connector_type}`}
      className={`connector-kind${kind.installed ? " is-installed" : ""}`}
    >
      <div className="install">
        <div>
          <span className="settings-label">
            <strong>{kind.title}</strong>
            {kind.description || kind.credential_hint || kind.import_files ? (
              <InfoTip label={kind.title}>
                {kind.description ? <p>{kind.description}</p> : null}
                {kind.credential_hint ? <p>{t("connector.credentials", { hint: kind.credential_hint })}</p> : null}
                {kind.import_files ? <p>{kind.import_files.description ?? kind.import_files.title}</p> : null}
              </InfoTip>
            ) : null}
          </span>
          <div className="install-meta">
            <span className={`chip ${kind.installed ? "running" : ""}`.trim()}>
              {kind.installed
                ? t("connector.installed", { count: kind.instance_count })
                : t("connector.notInstalled")}
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
              disabled={busyId !== null || syncingAll || installing}
              onClick={onOpenInstall}
            >
              {busyId === kind.connector_type
                ? t("connector.installing")
                : kind.setup_ready
                  ? t("connector.install")
                  : t("connector.setup")}
            </button>
          ) : null}
        </div>
      </div>
      {kind.import_files ? (
        <ConnectorFileImport
          kind={kind}
          disabled={busyId !== null || syncingAll || installing}
          onImported={onRefresh}
        />
      ) : null}
      {pendingUninstall && installations.length === 0 ? (
        <p className="muted">{t("connector.uninstalling")}</p>
      ) : null}
      {installing ? (
        <ConnectorSettingsDialog
          title={t(
            kind.setup_ready ? "connector.installTitle" : "connector.setupTitle",
            { title: kind.title },
          )}
          kind={kind}
          busy={busyId === kind.connector_type}
          error={error}
          submitLabel={t("connector.install")}
          busyLabel={t("connector.installing")}
          showSetup
          onSubmit={onInstall}
          onClose={onCloseInstall}
        />
      ) : null}
      {installations.map((installation) => (
        <ConnectorRow
          key={installation.id}
          id={`connector-installation-${installation.id}`}
          kind={kind}
          installation={installation}
          busy={busyId === installation.id || syncingAll}
          editing={editingId === installation.id}
          pairingCode={pairingCode?.[installation.id]}
          error={error}
          onEdit={() =>
            setEditingId((current) =>
              current === installation.id ? null : installation.id,
            )
          }
          onSync={(mode) => onSync(installation.id, mode)}
          onRetryQuarantines={() => onRetryQuarantines(installation.id)}
          onEnable={() => onEnable(installation)}
          onSave={(config) => {
            void onUpdate(installation, config).then((saved) => {
              if (saved) {
                setEditingId(null);
              }
            });
          }}
          onUninstall={() => onUninstall(installation)}
          onPairingCode={onPairingCode}
        />
      ))}
    </div>
  );
}

function ConnectorFileImport({
  kind,
  disabled,
  onImported,
}: {
  kind: ConnectorCatalogItem;
  disabled: boolean;
  onImported?: () => Promise<void>;
}) {
  const { t } = useLocale();
  const fileRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const spec = kind.import_files;
  if (!spec) {
    return null;
  }
  return (
    <div className="connector-import">
      <button
        type="button"
        className="ghost"
        disabled={disabled || importing}
        onClick={() => fileRef.current?.click()}
      >
        {importing ? t("connector.importing") : t("connector.import")}
      </button>
      <input
        ref={fileRef}
        type="file"
        multiple
        accept={spec.accept}
        hidden
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = "";
          if (files.length === 0) {
            return;
          }
          void (async () => {
            setImporting(true);
            setError(null);
            setStatus(null);
            try {
              const result = await importConnectorFiles(files, (content, fileName) =>
                importConnectorFile(kind.connector_type, content, fileName),
              );
              setStatus(connectorImportSummary(result));
              if (result.completed_files > 0) {
                await onImported?.();
              }
              if (result.failures.length > 0) {
                const first = result.failures[0];
                setError(
                  t("connector.importFileFailures", {
                    count: result.failures.length,
                    file: first.file_name,
                    message: connectorActionError(first.message),
                  }),
                );
              }
            } catch (caught) {
              setError(
                caught instanceof Error
                  ? connectorActionError(caught)
                  : t("connector.importFailed"),
              );
            } finally {
              setImporting(false);
            }
          })();
        }}
      />
      {status ? <p className="action-ok">{status}</p> : null}
      {error ? <p className="action-error">{error}</p> : null}
    </div>
  );
}

function ConnectorSettingsDialog({
  title,
  kind,
  busy,
  error,
  initialValues,
  installationId,
  submitLabel,
  busyLabel,
  showSetup = false,
  onSubmit,
  onClose,
}: {
  title: string;
  kind: ConnectorCatalogItem;
  busy: boolean;
  error?: string | null;
  initialValues?: ConnectorFormValues;
  installationId?: string;
  submitLabel: string;
  busyLabel: string;
  showSetup?: boolean;
  onSubmit: (config: ConnectorFormValues) => void;
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
          error={error}
          initialValues={initialValues}
          installationId={installationId}
          submitLabel={submitLabel}
          busyLabel={busyLabel}
          showSetup={showSetup}
          onSubmit={onSubmit}
        />
      </div>
    </div>
  );
}

function ConnectorSettingsForm({
  kind,
  busy,
  error,
  initialValues,
  installationId,
  submitLabel,
  busyLabel,
  showSetup = false,
  onSubmit,
}: {
  kind: ConnectorCatalogItem;
  busy: boolean;
  error?: string | null;
  initialValues?: ConnectorFormValues;
  installationId?: string;
  submitLabel: string;
  busyLabel: string;
  showSetup?: boolean;
  onSubmit: (config: ConnectorFormValues) => void;
}) {
  const { t } = useLocale();
  const [values, setValues] = useState<ConnectorFormValues>(() =>
    initialConnectorValues(kind.fields, initialValues),
  );
  const [installConfirmed, setInstallConfirmed] = useState(false);
  const installConfirm = catalogInstallConfirm(kind, values);
  const [remoteOptions, setRemoteOptions] = useState<
    Record<string, ConnectorFieldOption[]>
  >(() => initialConnectorOptions(kind.fields, initialValues));
  const [loadingOptions, setLoadingOptions] = useState(false);
  const [optionsError, setOptionsError] = useState(false);
  const [optionsAttempt, setOptionsAttempt] = useState(0);
  const [credentials, setCredentials] = useState<Record<string, boolean>>({});
  const [credentialsPending, setCredentialsPending] = useState(Boolean(installationId));
  const [credentialsError, setCredentialsError] = useState(false);
  const [credentialsAttempt, setCredentialsAttempt] = useState(0);
  useEffect(() => {
    if (!installationId) return;
    let cancelled = false;
    setCredentialsPending(true);
    setCredentialsError(false);
    void fetchConnectorCredentials(installationId).then((value) => {
      if (!cancelled) setCredentials(value);
    }).catch(() => {
      if (!cancelled) setCredentialsError(true);
    }).finally(() => {
      if (!cancelled) setCredentialsPending(false);
    });
    return () => { cancelled = true; };
  }, [installationId, credentialsAttempt]);
  const rememberOptions = useCallback((key: string, options: ConnectorFieldOption[]) => {
    setRemoteOptions((current) => ({
      ...current,
      [key]: [...new Map([...(current[key] ?? []), ...options].map((option) => [option.value, option])).values()],
    }));
  }, []);
  const prerequisites = visiblePrerequisites(kind, values);
  const prerequisitesReady = prerequisites.every(
    (item) => !item.required || item.ready,
  );
  const needsRemote = kind.fields
    .filter((field) => matchesCatalogFieldWhen(field.visible_when, values))
    .some((field) => !field.dynamic_options && fieldNeedsRemoteOptions(field));
  useEffect(() => {
    if (!installConfirm && installConfirmed) {
      setInstallConfirmed(false);
    }
  }, [installConfirm, installConfirmed]);
  useEffect(() => {
    if (!needsRemote || !prerequisitesReady) {
      return;
    }
    let cancelled = false;
    setLoadingOptions(true);
    setOptionsError(false);
    void fetchCatalogFieldOptions(kind.connector_type)
      .then((options) => {
        if (!cancelled) {
          setRemoteOptions(options);
        }
      })
      .catch(() => {
        if (!cancelled) setOptionsError(true);
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingOptions(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [kind.connector_type, needsRemote, prerequisitesReady, optionsAttempt]);
  const resolvedFields = kind.fields.map((field) => ({
      ...field,
      options: resolveCatalogFieldOptions(
        field,
        field.options,
        remoteOptions[field.key],
        values,
      ),
    }));
  const fields = resolvedFields.filter((field) =>
    matchesCatalogFieldWhen(field.visible_when, values),
  );
  const blocked = prerequisites.some((item) => item.required && !item.ready);
  const missingRequired = fields.some(
    (field) => connectorFieldMissing(field, values[field.key], credentials[field.key]),
  );
  const invalid = fields.some((field) => connectorFieldInvalid(field, values[field.key]));
  const guardBlocked = installConfirm !== undefined && !installConfirmed;
  return (
    <form
      className="install-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (busy || guardBlocked) {
          return;
        }
        if (blocked || missingRequired || invalid || credentialsPending || credentialsError) return;
        onSubmit(connectorFormPayload(resolvedFields, values));
      }}
    >
      {showSetup ? (
        <SetupStepList
          steps={kind.setup_steps ?? []}
          values={values}
          collapsible={kind.setup_ready}
        />
      ) : null}
      <PrerequisiteList items={prerequisites} />
      {optionsError && needsRemote ? (
        <div className="action-error" role="alert">
          {t("connector.optionsFailed")}{" "}
          <button type="button" className="ghost" onClick={() => setOptionsAttempt((attempt) => attempt + 1)}>
            {t("connector.retryOptions")}
          </button>
        </div>
      ) : null}
      {credentialsError ? <div className="action-error" role="alert">{t("connector.credentialsFailed")}{" "}
        <button type="button" className="ghost" onClick={() => setCredentialsAttempt((value) => value + 1)}>
          {t("connector.retryOptions")}
        </button>
      </div> : null}
      <ConnectorFormFields connectorType={kind.connector_type} fields={fields} values={values}
        credentials={credentials} busy={busy || credentialsPending} loading={loadingOptions}
        optionsEnabled={prerequisitesReady}
        onChange={(key, value) => setValues((current) => ({ ...current, [key]: value }))}
        onOptions={rememberOptions}
      />
      {installConfirm ? (
        <div className="install-guard">
          <p className="action-error">{installConfirm.warning}</p>
          <label className="check-item">
            <input
              type="checkbox"
              checked={installConfirmed}
              onChange={(event) => setInstallConfirmed(event.target.checked)}
            />
            <span>{installConfirm.ack}</span>
          </label>
        </div>
      ) : null}
      {error ? <p className="action-error" role="alert">{error}</p> : null}
      <button
        type="submit"
        className="primary"
        disabled={busy || blocked || missingRequired || invalid || guardBlocked || credentialsPending || credentialsError}
      >
        {busy
          ? busyLabel
          : guardBlocked
            ? t("connector.installConfirmRequired")
            : blocked
              ? t("connector.prereqFirst")
              : invalid
                ? t("connector.invalidFields")
              : missingRequired
                ? t("connector.fillRequired")
                : submitLabel}
      </button>
    </form>
  );
}

function fieldNeedsRemoteOptions(
  field: ConnectorCatalogItem["fields"][number],
): boolean {
  return field.dynamic_options === true ||
    (field.multiple === true && field.type === undefined && (field.options?.length ?? 0) === 0);
}

function SetupStepList({
  steps,
  values,
  collapsible,
}: {
  steps: ConnectorSetupStep[];
  values: ConnectorFormValues;
  collapsible: boolean;
}) {
  const { t } = useLocale();
  const [copied, setCopied] = useState<string | null>(null);
  // React 19 DetailsHTMLAttributes only has `open` (no defaultOpen).
  const [stepsOpen, setStepsOpen] = useState(true);
  const visible = steps.filter((step) =>
    matchesCatalogFieldWhen(step.visible_when, values),
  );
  if (visible.length === 0) {
    return null;
  }
  const list = (
    <ol className="setup-step-list">
      {visible.map((step, index) => {
        const copyKey = `${index}:${step.command ?? ""}`;
        const title = step.title;
        const body = step.body;
        const href = step.href;
        return (
          <li key={`${index}:${step.title}`}>
            {href ? (
              <a
                className="setup-step-link"
                href={href}
                target="_blank"
                rel="noreferrer"
                onClick={(event) => {
                  event.preventDefault();
                  openExternal(href);
                }}
              >
                {title}
              </a>
            ) : (
              <strong>{title}</strong>
            )}
            {body ? <div className="muted">{body}</div> : null}
            {step.command ? (
              <div className="setup-step-command">
                <code>{step.command}</code>
                <button
                  type="button"
                  className="ghost"
                  onClick={() => {
                    void navigator.clipboard?.writeText(step.command!).then(
                      () => {
                        setCopied(copyKey);
                        window.setTimeout(() => {
                          setCopied((current) =>
                            current === copyKey ? null : current,
                          );
                        }, 1500);
                      },
                      () => undefined,
                    );
                  }}
                >
                  {copied === copyKey
                    ? t("connector.copied")
                    : t("connector.copy")}
                </button>
              </div>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
  if (!collapsible) {
    return (
      <div className="setup-steps">
        <h3>{t("connector.setupSteps")}</h3>
        {list}
      </div>
    );
  }
  return (
    <details
      className="setup-steps"
      open={stepsOpen}
      onToggle={(event) => setStepsOpen(event.currentTarget.open)}
    >
      <summary>{t("connector.setupSteps")}</summary>
      {list}
    </details>
  );
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

function defaultFieldValues(kind: ConnectorCatalogItem): ConnectorFormValues {
  return initialConnectorValues(kind.fields);
}

function visiblePrerequisites(
  kind: ConnectorCatalogItem,
  values: ConnectorFormValues,
): ConnectorCatalogItem["prerequisites"] {
  return (kind.prerequisites ?? []).filter((item) =>
    matchesCatalogFieldWhen(item.visible_when, values),
  );
}

function ConnectorRow({
  id,
  kind,
  installation,
  busy,
  editing,
  pairingCode,
  error,
  onEdit,
  onSync,
  onRetryQuarantines,
  onEnable,
  onSave,
  onUninstall,
  onPairingCode,
}: {
  id: string;
  kind: ConnectorCatalogItem;
  installation: EngineInstallationView;
  busy: boolean;
  editing: boolean;
  pairingCode?: string;
  error?: string | null;
  onEdit: () => void;
  onSync: (mode: SyncRunMode) => void;
  onRetryQuarantines: () => void;
  onEnable: () => void;
  onSave: (config: ConnectorFormValues) => void;
  onUninstall: () => void;
  onPairingCode?: (id: string, code: string) => void;
}) {
  const { t } = useLocale();
  const [syncMode, setSyncMode] = useState<SyncRunMode>("quick_start");
  const statusChip =
    installation.status === "enabled"
      ? "running"
      : installation.status === "needs_attention"
        ? "stopped"
        : "";
  const syncUnavailableHint = installation.status === "enabled" && !installation.syncable
    ? kind.sync_unavailable_hint
    : undefined;
  const activeSourceMode =
    installation.status === "enabled" ? installation.source_mode : "poll";
  const attemptSourceMode = installation.last_attempt
    ? installation.source_mode
    : activeSourceMode;
  return (
    <div id={id} className="install-block">
      <div className="install install-instance">
        <div>
          <strong title={installation.id}>
            {kind.title} · {installation.label}
          </strong>
          <div className="install-meta">
            <span className={`chip ${statusChip}`.trim()}>
              {installationStatusLabel(installation.status)}
            </span>
            {activeSourceMode === "webhook" || activeSourceMode === "hybrid" ? (
              <span className="connector-mode-chip">
                {t(
                  activeSourceMode === "webhook"
                    ? "connector.mode.push"
                    : "connector.mode.hybrid",
                )}
              </span>
            ) : null}
            {installation.detail ? (
              <span className="muted">{installation.detail}</span>
            ) : null}
          </div>
          <div className={activeSourceMode === "webhook" ? "connector-activity" : "muted"}>
            {attemptSummary(installation.last_attempt, attemptSourceMode)}
          </div>
          {!installation.last_attempt && activeSourceMode === "webhook" ? (
            <p className="muted connector-next">{t("connector.push.waitingHint")}</p>
          ) : null}
          {!installation.last_attempt && activeSourceMode === "hybrid" ? (
            <p className="muted connector-next">{t("connector.hybrid.waitingHint")}</p>
          ) : null}
          {syncUnavailableHint ? (
            <p className="muted connector-next">{syncUnavailableHint}</p>
          ) : null}
          {installation.sync ? (
            <div className="muted">{syncProgressSummary(installation.sync)}</div>
          ) : null}
          {installation.can_pair ? (
            <PairingCodeCard
              installationId={installation.id}
              pairingCode={pairingCode}
              onPairingCode={onPairingCode}
            />
          ) : null}
        </div>
        <div className="install-actions">
          {syncUnavailableHint ? null : (
            <>
              <select
                value={syncMode}
                disabled={busy || !installation.syncable}
                aria-label={t("sync.mode")}
                onChange={(event) =>
                  setSyncMode(event.target.value as SyncRunMode)
                }
              >
                <option value="quick_start">{t("sync.mode.quick")}</option>
                <option value="continuous">{t("sync.mode.continuous")}</option>
                <option value="archive">{t("sync.mode.archive")}</option>
              </select>
              <button
                type="button"
                className="primary"
                disabled={busy || !installation.syncable}
                onClick={() => onSync(syncMode)}
              >
                {busy ? t("engine.syncing") : t("connector.sync")}
              </button>
            </>
          )}
          {(installation.last_attempt?.quarantined_count ?? 0) > 0 ? (
            <button
              type="button"
              className="ghost"
              disabled={busy}
              onClick={onRetryQuarantines}
            >
              {t("sync.retryQuarantine")}
            </button>
          ) : null}
          {installation.status === "disabled" ? (
            <button type="button" className="ghost" disabled={busy} onClick={onEnable}>
              {t("connector.enable")}
            </button>
          ) : null}
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
          error={error}
          initialValues={installation.settings}
          installationId={installation.id}
          submitLabel={t("connector.save")}
          busyLabel={t("connector.saving")}
          onSubmit={onSave}
          onClose={onEdit}
        />
      ) : null}
    </div>
  );
}

function PairingCodeCard({
  installationId,
  pairingCode,
  onPairingCode,
}: {
  installationId: string;
  pairingCode?: string;
  onPairingCode?: (id: string, code: string) => void;
}) {
  const { t } = useLocale();
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const code = pairingCode?.trim() ?? "";

  return (
    <div className="pairing-card">
      <strong>{t("connector.pairingCode")}</strong>
      <p className="muted">{t("connector.pairingHint")}</p>
      {code ? (
        <div className="setup-step-command">
          <code>{code}</code>
          <button
            type="button"
            className="ghost"
            onClick={() => {
              void navigator.clipboard?.writeText(code).then(
                () => {
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1500);
                },
                () => undefined,
              );
            }}
          >
            {copied ? t("connector.copied") : t("connector.copy")}
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="ghost"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setError(null);
            void fetchConnectorPairingCode(installationId)
              .then((next) => {
                onPairingCode?.(installationId, next);
              })
              .catch((caught) => {
                setError(
                  caught instanceof Error
                    ? connectorActionError(caught)
                    : t("engine.actionFailed"),
                );
              })
              .finally(() => setBusy(false));
          }}
        >
          {t("connector.showPairing")}
        </button>
      )}
      {error ? <p className="action-error">{error}</p> : null}
    </div>
  );
}
