import { useRef, useState } from "react";
import {
  installConnector,
  installExecutor,
  setConnectorStatus,
  setExecutorStatus,
  syncConnector,
  uninstallConnector,
  uninstallExecutor,
  updateConnectorConfig,
  updateExecutorConfig,
} from "./api";
import { CatalogDocs, uniqueCatalogDocs } from "./CatalogDocs";
import { ConnectorKind } from "./ConnectorSettings";
import { ExecutorKind } from "./ExecutorSettings";
import {
  connectorActionError,
  diskWatchCopy,
  formatChatTime,
  memoryWatchCopy,
  networkWatchLabel,
  pullStatusLabel,
} from "./format";
import type { HostStats } from "../../shared/host-watch.ts";
import { useLocale } from "./LocaleContext";
import type { PersonalEngineView } from "./types";

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
  const [pairingCodes, setPairingCodes] = useState<Record<string, string>>({});
  const [pendingUninstallIds, setPendingUninstallIds] = useState<string[]>([]);
  const [installingExecutor, setInstallingExecutor] = useState<string | null>(
    null,
  );
  const [actionError, setActionError] = useState<string | null>(null);
  const actionLock = useRef(false);

  const runAction = async (id: string, action: () => Promise<void>) => {
    if (actionLock.current) {
      return false;
    }
    actionLock.current = true;
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
      actionLock.current = false;
    }
  };

  if (error || !engine) {
    return (
      <div className="page page-wide">
        <header className="page-hero">
          <p className="page-eyebrow">{t("engine.eyebrow")}</p>
          <h1>{t("engine.title")}</h1>
          <p className="page-lead">{error ?? t("engine.disconnected")}</p>
        </header>
      </div>
    );
  }

  const unsignedPlugins = unsignedPluginCount(engine);
  const failedPlugins = failedPluginCount(engine);
  const syncable = engine.installations.filter((item) => item.syncable);
  const pullCopy = [
    pullStatusLabel(engine.pull),
    engine.pull?.last_tick_at ? formatChatTime(engine.pull.last_tick_at) : "",
    engine.pull?.last_accepted_count ? `+${engine.pull.last_accepted_count}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const networkCopy = [
    networkWatchLabel(engine.pull?.network?.kind),
    engine.pull?.network?.kind !== "ok" && engine.pull?.network?.proxy
      ? engine.pull.network.proxy
      : "",
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="page page-wide">
      <header className="page-hero">
        <p className="page-eyebrow">{t("engine.eyebrow")}</p>
        <h1>{t("engine.title")}</h1>
        <p className="page-lead">{t("engine.lead")}</p>
      </header>
      <section className="card engine-kernel">
        <div className="card-head">
          <h2>{t("engine.kernel")}</h2>
          <span className={`chip ${engine.kernel === "running" ? "running" : "stopped"}`}>
            <span className="dot" />
            {engine.kernel === "running" ? t("engine.running") : t("engine.stopped")}
          </span>
        </div>
        <div className="engine-stats">
          <EngineStat
            label={t("engine.currentWork")}
            value={String(engine.inbox_count)}
            tone="ok"
          />
          <EngineStat
            label={t("engine.livePull")}
            value={pullCopy}
            tone={
              engine.pull?.last_error
                ? "risk"
                : engine.pull?.phase === "pulling" ||
                    (engine.pull?.catching_up_count ?? 0) > 0
                  ? "warn"
                  : "ok"
            }
          />
          <EngineStat
            label={t("engine.network")}
            value={networkCopy}
            tone={watchTone(engine.pull?.network?.kind)}
          />
          <EngineStat
            label={t("engine.disk")}
            value={host ? diskWatchCopy(host.disk) : "—"}
            tone={watchTone(host?.disk.kind)}
          />
          <EngineStat
            label={t("engine.memory")}
            value={host ? memoryWatchCopy(host.memory) : "—"}
            tone={watchTone(host?.memory.kind)}
          />
        </div>
        <dl className="engine-meta">
          <div>
            <dt>{t("engine.org")}</dt>
            <dd>{engine.org_id}</dd>
          </div>
          <div>
            <dt>{t("engine.database")}</dt>
            <dd>
              <code>{engine.database_path ?? "—"}</code>
            </dd>
          </div>
          <div>
            <dt>{t("engine.pluginDir")}</dt>
            <dd>
              <code>{engine.plugin_dir ?? "—"}</code>
            </dd>
          </div>
        </dl>
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
      <section className="card engine-connectors">
        <div className="card-head">
          <div className="card-title">
            <h2>{t("engine.connectors")}</h2>
            <CatalogDocs docs={uniqueCatalogDocs(engine.catalog ?? [])} />
          </div>
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
        {unsignedPlugins > 0 ? (
          <p className="action-hint">
            {t("engine.unsignedPlugins", { count: unsignedPlugins })}
          </p>
        ) : null}
        {failedPlugins > 0 ? (
          <p className="action-error">
            {t("engine.failedPlugins", { count: failedPlugins })}
          </p>
        ) : null}
        {(engine.catalog ?? []).map((kind) => (
          <ConnectorKind
            key={kind.connector_type}
            kind={kind}
            installations={engine.installations.filter(
              (item) =>
                item.connector_type === kind.connector_type &&
                !pendingUninstallIds.includes(item.id),
            )}
            busyId={busyId}
            syncingAll={syncingAll}
            installing={installingType === kind.connector_type}
            pendingUninstall={engine.installations.some(
              (item) =>
                item.connector_type === kind.connector_type &&
                pendingUninstallIds.includes(item.id),
            )}
            pairingCode={pairingCodes}
            onOpenInstall={() => {
              if (actionLock.current || busyId !== null || syncingAll) {
                return;
              }
              setInstallingType(kind.connector_type);
            }}
            onCloseInstall={() => {
              if (actionLock.current || busyId === kind.connector_type) {
                return;
              }
              setInstallingType(null);
            }}
            onInstall={(config) =>
              void runAction(kind.connector_type, async () => {
                const installed = await installConnector(
                  kind.connector_type,
                  config,
                );
                if (installed.pairing_code?.trim()) {
                  setPairingCodes((current) => ({
                    ...current,
                    [installed.id]: installed.pairing_code!.trim(),
                  }));
                }
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
            onRefresh={onChanged}
            onPairingCode={(id, code) => {
              setPairingCodes((current) => ({ ...current, [id]: code }));
            }}
            onUninstall={(installation) => {
              if (
                actionLock.current ||
                busyId !== null ||
                pendingUninstallIds.includes(installation.id)
              ) {
                return;
              }
              if (
                !window.confirm(
                  t("engine.uninstallConfirm", {
                    type: kind.title,
                    name: installation.label,
                  }),
                )
              ) {
                return;
              }
              setPendingUninstallIds((current) =>
                current.includes(installation.id)
                  ? current
                  : [...current, installation.id],
              );
              void runAction(installation.id, async () => {
                await uninstallConnector(installation.id);
                setPairingCodes((current) => {
                  const next = { ...current };
                  delete next[installation.id];
                  return next;
                });
              }).then((ok) => {
                if (!ok) {
                  setPendingUninstallIds((current) =>
                    current.filter((id) => id !== installation.id),
                  );
                }
              });
            }}
          />
        ))}
        {actionError ? <p className="action-error">{actionError}</p> : null}
      </section>
      <section className="card engine-connectors">
        <div className="card-head">
          <div className="card-title">
            <h2>{t("engine.executors")}</h2>
            <CatalogDocs docs={uniqueCatalogDocs(engine.executor_catalog ?? [])} />
          </div>
        </div>
        <p className="muted">{t("engine.executorsLead")}</p>
        {(engine.executor_catalog ?? []).map((kind) => (
          <ExecutorKind
            key={kind.kind}
            kind={kind}
            installations={(engine.executor_installations ?? []).filter(
              (item) => item.kind === kind.kind,
            )}
            busyId={busyId}
            installing={installingExecutor === kind.kind}
            onOpenInstall={() => setInstallingExecutor(kind.kind)}
            onCloseInstall={() => setInstallingExecutor(null)}
            onInstall={(config) =>
              void runAction(`ex:${kind.kind}`, async () => {
                await installExecutor(kind.kind, config);
                setInstallingExecutor(null);
              })
            }
            onToggle={(installation) =>
              void runAction(`ex:${installation.id}`, async () => {
                await setExecutorStatus(
                  installation.id,
                  installation.status === "disabled" ? "enabled" : "disabled",
                );
              })
            }
            onUpdate={(installation, config) =>
              runAction(`ex:${installation.id}`, async () => {
                await updateExecutorConfig(installation.id, config);
              })
            }
            onUninstall={(installation) => {
              if (
                !window.confirm(
                  t("engine.uninstallExecutorConfirm", {
                    name: installation.label,
                  }),
                )
              ) {
                return;
              }
              void runAction(`ex:${installation.id}`, async () => {
                await uninstallExecutor(installation.id);
              });
            }}
          />
        ))}
      </section>
    </div>
  );
}

function EngineStat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "ok" | "warn" | "risk";
}) {
  return (
    <div className={`engine-stat${tone ? ` is-${tone}` : ""}`}>
      <span className="engine-stat-label">{label}</span>
      <strong className="engine-stat-value">{value}</strong>
    </div>
  );
}

function unsignedPluginCount(engine: PersonalEngineView): number {
  return (engine.plugins ?? []).filter(
    (item) =>
      item.origin === "extra" &&
      item.trust === "unsigned" &&
      item.status === "loaded",
  ).length;
}

function failedPluginCount(engine: PersonalEngineView): number {
  return (engine.plugins ?? []).filter((item) => item.status === "failed").length;
}

function watchTone(kind?: string): "ok" | "warn" | "risk" | undefined {
  if (kind === "critical" || kind === "blocked") {
    return "risk";
  }
  if (kind === "attention" || kind === "proxy") {
    return "warn";
  }
  if (kind === "ok") {
    return "ok";
  }
  return undefined;
}
