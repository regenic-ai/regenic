import { useRef, useState } from "react";
import {
  importWhatsAppExport,
  installConnector,
  setConnectorStatus,
  syncConnector,
  uninstallConnector,
  updateConnectorConfig,
} from "./api";
import { ConnectorKind } from "./ConnectorSettings";
import {
  connectorActionError,
  connectorLabel,
  diskWatchCopy,
  formatChatTime,
  memoryWatchCopy,
  networkWatchLabel,
  pullStatusLabel,
} from "./format";
import type { HostStats } from "../../shared/host-watch.ts";
import { useLocale } from "./LocaleContext";
import type { PersonalEngineView } from "./types";
import {
  importWhatsAppFiles,
  whatsAppImportSummary,
} from "./whatsapp-import";

export function EnginePage({
  engine,
  host,
  error,
  onChanged,
}: {
  engine: PersonalEngineView | null;
  host: HostStats | null;
  error: string | null;
  onChanged: () => Promise<void>;
}) {
  const { t } = useLocale();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [syncingAll, setSyncingAll] = useState(false);
  const [installingType, setInstallingType] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [whatsAppStatus, setWhatsAppStatus] = useState<string | null>(null);
  const [importingWhatsApp, setImportingWhatsApp] = useState(false);
  const whatsAppFileRef = useRef<HTMLInputElement>(null);

  const runAction = async (id: string, action: () => Promise<void>) => {
    setBusyId(id);
    setActionError(null);
    try {
      await action();
      await onChanged();
      return true;
    } catch (caught) {
      setActionError(
        caught instanceof Error ? connectorActionError(caught.message) : t("engine.actionFailed"),
      );
      return false;
    } finally {
      setBusyId(null);
    }
  };

  if (error || !engine) {
    return (
      <div className="page">
        <h1>{t("engine.title")}</h1>
        <p className="muted">{error ?? t("engine.disconnected")}</p>
      </div>
    );
  }

  const syncable = engine.installations.filter((item) => item.syncable);

  return (
    <div className="page page-wide">
      <header className="page-hero">
        <h1>{t("engine.title")}</h1>
        <p className="page-lead">{t("engine.lead")}</p>
      </header>
      <section className="card">
        <h2>{t("engine.kernel")}</h2>
        <div className="kv">
          <span>{t("engine.status")}</span>
          <strong>{engine.kernel === "running" ? t("engine.running") : t("engine.stopped")}</strong>
          <span>{t("engine.org")}</span>
          <strong>{engine.org_id}</strong>
          <span>{t("engine.database")}</span>
          <strong>
            <code>{engine.database_path ?? "—"}</code>
          </strong>
          <span>{t("engine.currentWork")}</span>
          <strong>{engine.inbox_count}</strong>
          <span>{t("engine.livePull")}</span>
          <strong>
            {pullStatusLabel(engine.pull)}
            {engine.pull?.last_tick_at
              ? ` · ${formatChatTime(engine.pull.last_tick_at)}`
              : ""}
            {engine.pull?.last_accepted_count
              ? ` · +${engine.pull.last_accepted_count}`
              : ""}
          </strong>
          <span>{t("engine.network")}</span>
          <strong>
            {networkWatchLabel(engine.pull?.network?.kind)}
            {engine.pull?.network?.kind !== "ok" && engine.pull?.network?.proxy
              ? ` · ${engine.pull.network.proxy}`
              : ""}
          </strong>
          <span>{t("engine.disk")}</span>
          <strong>{host ? diskWatchCopy(host.disk) : "—"}</strong>
          <span>{t("engine.memory")}</span>
          <strong>{host ? memoryWatchCopy(host.memory) : "—"}</strong>
        </div>
        {engine.pull?.last_error ? (
          <p className="action-error">{engine.pull.last_error}</p>
        ) : null}
        {engine.pull?.last_error_hint || engine.pull?.network?.hint ? (
          <p className="action-hint">
            {engine.pull.last_error_hint ?? engine.pull.network?.hint}
          </p>
        ) : null}
        {host?.disk.hint ? <p className="action-hint">{host.disk.hint}</p> : null}
        {host?.memory.hint ? (
          <p className="action-hint">{host.memory.hint}</p>
        ) : null}
      </section>
      <section className="card">
        <div className="card-head">
          <h2>{t("engine.whatsapp.title")}</h2>
          <button
            type="button"
            className="ghost"
            disabled={importingWhatsApp}
            onClick={() => whatsAppFileRef.current?.click()}
          >
            {importingWhatsApp
              ? t("engine.whatsapp.importing")
              : t("engine.whatsapp.import")}
          </button>
        </div>
        <p className="muted">{t("engine.whatsapp.lead")}</p>
        <input
          ref={whatsAppFileRef}
          type="file"
          multiple
          accept=".csv,.jsonl,.ndjson,text/csv,application/x-ndjson,application/json"
          hidden
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files ?? []);
            event.currentTarget.value = "";
            if (files.length === 0) {
              return;
            }
            void (async () => {
              setImportingWhatsApp(true);
              setActionError(null);
              setWhatsAppStatus(null);
              try {
                const result = await importWhatsAppFiles(
                  files,
                  importWhatsAppExport,
                );
                setWhatsAppStatus(whatsAppImportSummary(result));
                if (result.completed_files > 0) {
                  await onChanged();
                }
                if (result.failures.length > 0) {
                  const first = result.failures[0];
                  setActionError(
                    t("engine.whatsapp.fileFailures", {
                      count: result.failures.length,
                      file: first.file_name,
                      message: connectorActionError(first.message),
                    }),
                  );
                }
              } catch (caught) {
                setActionError(
                  caught instanceof Error
                    ? connectorActionError(caught.message)
                    : t("engine.whatsapp.failed"),
                );
              } finally {
                setImportingWhatsApp(false);
              }
            })();
          }}
        />
        {whatsAppStatus ? <p className="action-hint">{whatsAppStatus}</p> : null}
      </section>
      <section className="card">
        <div className="card-head">
          <h2>{t("engine.connectors")}</h2>
          {syncable.length > 1 ? (
            <button
              type="button"
              className="ghost"
              disabled={busyId !== null || syncingAll}
              onClick={() => {
                void (async () => {
                  setSyncingAll(true);
                  setActionError(null);
                  try {
                    for (const item of syncable) {
                      await syncConnector(item.id);
                    }
                    await onChanged();
                  } catch (caught) {
                    setActionError(
                      caught instanceof Error
                        ? connectorActionError(caught.message)
                        : t("engine.syncFailed"),
                    );
                  } finally {
                    setSyncingAll(false);
                  }
                })();
              }}
            >
              {syncingAll ? t("engine.syncing") : t("engine.syncAll")}
            </button>
          ) : null}
        </div>
        <p className="muted">
          {t("engine.connectorsLead")}
        </p>
        {(engine.catalog ?? []).map((kind) => (
          <ConnectorKind
            key={kind.connector_type}
            kind={kind}
            installations={engine.installations.filter(
              (item) => item.connector_type === kind.connector_type,
            )}
            busyId={busyId}
            syncingAll={syncingAll}
            installing={installingType === kind.connector_type}
            onOpenInstall={() => setInstallingType(kind.connector_type)}
            onCloseInstall={() => setInstallingType(null)}
            onInstall={(config) =>
              void runAction(kind.connector_type, async () => {
                await installConnector(kind.connector_type, config);
                setInstallingType(null);
              })
            }
            onSync={(id) =>
              void runAction(id, async () => {
                await syncConnector(id);
              })
            }
            onToggle={(installation) =>
              void runAction(installation.id, async () => {
                await setConnectorStatus(
                  installation.id,
                  installation.status === "disabled" ? "enabled" : "disabled",
                );
              })
            }
            onUpdate={(installation, config) =>
              runAction(installation.id, async () => {
                await updateConnectorConfig(installation.id, config);
              })
            }
            onUninstall={(installation) => {
              if (
                !window.confirm(
                  t("engine.uninstallConfirm", {
                    type: connectorLabel(installation.connector_type),
                    name: installation.label,
                  }),
                )
              ) {
                return;
              }
              void runAction(installation.id, async () => {
                await uninstallConnector(installation.id);
              });
            }}
          />
        ))}
        {actionError ? <p className="action-error">{actionError}</p> : null}
      </section>
    </div>
  );
}
