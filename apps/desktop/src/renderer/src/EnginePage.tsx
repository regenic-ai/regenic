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
        caught instanceof Error ? connectorActionError(caught.message) : "Action failed",
      );
      return false;
    } finally {
      setBusyId(null);
    }
  };

  if (error || !engine) {
    return (
      <div className="page">
        <h1>Engine</h1>
        <p className="muted">{error ?? "Kernel is not connected."}</p>
      </div>
    );
  }

  const syncable = engine.installations.filter((item) => item.syncable);

  return (
    <div className="page">
      <h1>Engine</h1>
      <p className="muted">
        Local authority store and connectors. Enabled connectors pull while the kernel is running. Use Sync only to catch up after a miss.
      </p>
      <section className="card">
        <h2>Kernel</h2>
        <div className="kv">
          <span>Status</span>
          <strong>{engine.kernel === "running" ? "Running" : "Stopped"}</strong>
          <span>org</span>
          <strong>{engine.org_id}</strong>
          <span>Database</span>
          <strong>
            <code>{engine.database_path ?? "—"}</code>
          </strong>
          <span>Current work</span>
          <strong>{engine.inbox_count}</strong>
          <span>Live pull</span>
          <strong>
            {pullStatusLabel(engine.pull)}
            {engine.pull?.last_tick_at
              ? ` · ${formatChatTime(engine.pull.last_tick_at)}`
              : ""}
            {engine.pull?.last_accepted_count
              ? ` · +${engine.pull.last_accepted_count}`
              : ""}
          </strong>
          <span>Network</span>
          <strong>
            {networkWatchLabel(engine.pull?.network?.kind)}
            {engine.pull?.network?.kind !== "ok" && engine.pull?.network?.proxy
              ? ` · ${engine.pull.network.proxy}`
              : ""}
          </strong>
          <span>Disk</span>
          <strong>{host ? diskWatchCopy(host.disk) : "—"}</strong>
          <span>Memory</span>
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
          <h2>WhatsApp personal export</h2>
          <button
            type="button"
            className="ghost"
            disabled={importingWhatsApp}
            onClick={() => whatsAppFileRef.current?.click()}
          >
            {importingWhatsApp ? "Importing…" : "Import files"}
          </button>
        </div>
        <p className="muted">
          Import Purr WA CSV or WhatsApp Personal Export v1 JSONL files you selected yourself. This is read-only and never accesses browser cookies or sends messages.
        </p>
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
                    `${result.failures.length} file${result.failures.length === 1 ? "" : "s"} failed. ${first.file_name}: ${connectorActionError(first.message)}`,
                  );
                }
              } catch (caught) {
                setActionError(
                  caught instanceof Error ? connectorActionError(caught.message) : "WhatsApp import failed",
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
          <h2>Connectors</h2>
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
                        : "Sync failed",
                    );
                  } finally {
                    setSyncingAll(false);
                  }
                })();
              }}
            >
              {syncingAll ? "Syncing…" : "Sync all"}
            </button>
          ) : null}
        </div>
        <p className="muted">
          Install or uninstall connectors here. Credentials are read from local environment variables only.
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
                  `Uninstall ${connectorLabel(installation.connector_type)} “${installation.label}”? Ingested messages stay.`,
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
