import { useCallback, useEffect, useRef, useState } from "react";
import {
  commandSyncRun,
  fetchConnectorMarket,
  fetchConnectorMarketInstall,
  installConnectorFromMarket,
  deleteSyncRun,
  installConnector,
  rollbackConnectorFromMarket,
  retryConnectorMarketRegistration,
  installExecutor,
  retryConnectorQuarantines,
  setConnectorStatus,
  setExecutorStatus,
  syncConnector,
  uninstallConnectorFromMarket,
  uninstallConnector,
  updateConnectorFromMarket,
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
  networkWatchHint,
  networkWatchLabel,
  pullStatusLabel,
  aggregateInstallationSync,
  syncEtaSummary,
  syncFreshnessSummary,
  syncProgressSummary,
  syncProgressTone,
  syncReadinessTone,
} from "./format";
import type { HostStats } from "../../shared/host-watch.ts";
import { useLocale } from "./LocaleContext";
import type {
  ConnectorMarketView,
  ConnectorInstallJob,
  EngineInstallationView,
  PersonalEngineView,
  PluginInventoryItem,
  SyncRunMode,
} from "./types";

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
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
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
        caught instanceof Error ? connectorActionError(caught) : t("engine.actionFailed"),
      );
      return false;
    } finally {
      setBusyId(null);
      actionLock.current = false;
    }
  };

  if (!engine) {
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
  const coverage = aggregateInstallationSync(engine.installations);
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
  const visibleRuns = (engine.sync_runs ?? []).filter((run) =>
    ["queued", "running", "paused", "failed"].includes(run.status),
  );

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
            emphasis
          />
          <EngineStat
            label={t("engine.coverage")}
            value={coverage ? syncProgressSummary(coverage) : "—"}
            tone={syncProgressTone(coverage)}
          />
          <EngineStat
            label={t("engine.freshness")}
            value={syncFreshnessSummary(engine.sync_readiness)}
            tone={
              engine.sync_readiness?.freshness_source === "poll" ? "ok" : undefined
            }
          />
          <EngineStat
            label={t("engine.eta")}
            value={syncEtaSummary(engine.sync_readiness)}
            tone={syncReadinessTone(engine.sync_readiness)}
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
              <code title={engine.database_path ?? undefined}>
                {engine.database_path ?? "—"}
              </code>
            </dd>
          </div>
          <div>
            <dt>{t("engine.pluginDir")}</dt>
            <dd>
              <code title={engine.plugin_dir ?? undefined}>
                {engine.plugin_dir ?? "—"}
              </code>
            </dd>
          </div>
        </dl>
        {engine.pull?.last_error ? (
          <p className="action-error">{engine.pull.last_error}</p>
        ) : null}
        {engine.pull?.last_error_hint || engine.pull?.network?.hint ? (
          <p className="action-hint">
            {networkWatchHint(
              engine.pull.last_error_hint ?? engine.pull.network?.hint,
            )}
          </p>
        ) : null}
        {host?.disk.hint ? <p className="action-hint">{host.disk.hint}</p> : null}
        {host?.memory.hint ? (
          <p className="action-hint">{host.memory.hint}</p>
        ) : null}
      </section>
      {visibleRuns.length > 0 ? (
        <section className="card engine-sync-runs">
          <div className="card-head">
            <h2>{t("sync.runs")}</h2>
          </div>
          <div className="connector-kind">
            {visibleRuns.map((run) => {
              const completed = run.completed_work + run.failed_work;
              const installation = engine.installations.find(
                (item) => item.id === run.installation_id,
              );
              const progress =
                run.total_work > 0
                  ? `${completed}/${run.total_work}`
                  : t("sync.totalUnknown");
              return (
                <div className="install install-instance" key={run.id}>
                  <div>
                    <strong>{t(`sync.mode.${syncModeKey(run.mode)}`)}</strong>
                    <div className="install-meta">
                      <span className="muted">
                        {installation?.channel_label ?? installation?.label ?? run.installation_id}
                      </span>
                      <time
                        className="muted"
                        dateTime={run.created_at}
                        title={new Date(run.created_at).toLocaleString()}
                      >
                        {t("sync.started", { when: formatChatTime(run.started_at ?? run.created_at) })}
                      </time>
                      <span className={`chip ${run.status === "running" ? "running" : ""}`}>
                        {t(`sync.status.${run.status}`)}
                      </span>
                      <span className="muted">{progress}</span>
                      <span className="muted">
                        {t("sync.accepted", { count: run.accepted_count })}
                      </span>
                    </div>
                    {run.last_error ? (
                      <p className="action-error">{run.last_error}</p>
                    ) : null}
                  </div>
                  <div className="install-actions">
                    {run.status === "running" || run.status === "queued" ? (
                      <button
                        type="button"
                        className="ghost"
                        onClick={() =>
                          void runAction(`run:${run.id}`, async () => {
                            await commandSyncRun(run.id, "pause");
                          })
                        }
                      >
                        {t("sync.pause")}
                      </button>
                    ) : null}
                    {run.status === "paused" ? (
                      <button
                        type="button"
                        className="ghost"
                        onClick={() =>
                          void runAction(`run:${run.id}`, async () => {
                            await commandSyncRun(run.id, "resume");
                          })
                        }
                      >
                        {t("sync.resume")}
                      </button>
                    ) : null}
                    {run.status !== "failed" ? (
                      <button
                        type="button"
                        className="ghost danger"
                        onClick={() =>
                          void runAction(`run:${run.id}`, async () => {
                            await commandSyncRun(run.id, "cancel");
                          })
                        }
                      >
                        {t("sync.cancel")}
                      </button>
                    ) : null}
                    {isDeletableRun(run.status) && confirmDeleteId === run.id ? (
                      <button
                        type="button"
                        className="ghost"
                        onClick={() => setConfirmDeleteId(null)}
                      >
                        {t("sync.cancel")}
                      </button>
                    ) : null}
                    {isDeletableRun(run.status) ? (
                      <button
                        type="button"
                        className="ghost danger"
                        disabled={busyId === `run:${run.id}`}
                        onClick={() => {
                          if (confirmDeleteId !== run.id) {
                            setConfirmDeleteId(run.id);
                            return;
                          }
                          void (async () => {
                            const started = await runAction(`run:${run.id}`, async () => {
                              await deleteSyncRun(run.id);
                            });
                            if (started) {
                              setConfirmDeleteId(null);
                            } else if (actionLock.current) {
                              setActionError(t("sync.deleteBusy"));
                            }
                          })();
                        }}
                      >
                        {confirmDeleteId === run.id
                          ? t("sync.deleteConfirm")
                          : t("sync.delete")}
                      </button>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      ) : null}
      <section className="card engine-connectors" id="engine-connector-config">
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
                    await Promise.all(
                      syncable.map((item) =>
                        syncConnector(item.id, { mode: "quick_start" }),
                      ),
                    );
                    await onChanged();
                  } catch (caught) {
                    setActionError(
                      caught instanceof Error
                        ? connectorActionError(caught)
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
            onSync={(id, mode) =>
              void runAction(id, async () => {
                await syncConnector(id, { mode });
              })
            }
            onRetryQuarantines={(id) =>
              void runAction(id, async () => {
                await retryConnectorQuarantines(id);
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
      <ConnectorMarketplace
        plugins={engine.plugins ?? []}
        installations={engine.installations}
        onChanged={onChanged}
      />
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

function ConnectorMarketplace({
  plugins,
  installations,
  onChanged,
}: {
  plugins: PluginInventoryItem[];
  installations: EngineInstallationView[];
  onChanged: () => Promise<void>;
}) {
  const { t } = useLocale();
  const [market, setMarket] = useState<ConnectorMarketView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [installing, setInstalling] = useState<string | null>(null);
  const [installJob, setInstallJob] = useState<ConnectorInstallJob | null>(null);
  const [selectedVersions, setSelectedVersions] = useState<Record<string, string>>({});
  const [installNotice, setInstallNotice] = useState<Record<string, {
    message: string;
    error?: boolean;
    refresh?: boolean;
    driverType?: string;
    retryRegistration?: boolean;
  }>>({});
  const [installedPackages, setInstalledPackages] = useState<Set<string>>(new Set());
  const [uninstalling, setUninstalling] = useState<string | null>(null);
  const [changingVersion, setChangingVersion] = useState<string | null>(null);
  const [retryingRegistration, setRetryingRegistration] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(30);

  const loadMarket = useCallback(async (refresh = false, quiet = false) => {
    if (!quiet) {
      setLoading(true);
      setError(null);
    }
    try {
      setMarket(await fetchConnectorMarket(refresh));
      return true;
    } catch {
      if (!quiet) setError(t("market.unavailable"));
      return false;
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void loadMarket();
  }, [loadMarket]);

  useEffect(() => {
    try {
      const saved = localStorage.getItem("regenic.connector-market.install");
      if (saved) {
        const job = JSON.parse(saved) as ConnectorInstallJob;
        setInstallJob(job);
        setInstalling(job.package_name);
      }
    } catch {
      localStorage.removeItem("regenic.connector-market.install");
    }
  }, []);

  useEffect(() => {
    if (!installJob) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const job = await fetchConnectorMarketInstall(installJob.id);
        if (!active) return;
        if (job.phase === "completed" || job.phase === "failed") {
          localStorage.removeItem("regenic.connector-market.install");
          setInstallJob(null);
          setInstalling(null);
          if (job.installed || job.result?.installed) {
            setInstalledPackages((current) => new Set(current).add(job.package_name));
          }
          if (job.phase === "failed") {
            const message = job.operation === "update"
              ? t(job.error?.includes("restarted")
                  ? "market.updateStatusLost"
                  : job.result?.pending_restart
                    ? "market.updateStatusUnknown"
                    : "market.updateFailed")
              : job.installed
                ? t("market.installRegistrationUnknown")
                : t("market.installFailed");
            setInstallNotice((current) => ({
              ...current,
              [job.package_name]: {
                message,
                error: true,
                refresh: job.installed,
                retryRegistration: job.operation !== "update" && job.installed,
              },
            }));
            if (job.installed) {
              await onChanged().catch(() => undefined);
            }
            return;
          }

          const registered = job.result?.registered === true;
          const isUpdate = job.operation === "update";
          let refreshed = true;
          try {
            await onChanged();
          } catch {
            refreshed = false;
          }
          const marketRefreshed = await loadMarket(true, true);
          const notice = isUpdate
            ? t("market.updateStaged", { version: job.version })
            : registered
              ? t("market.installRegistered", {
                types: job.result?.driver_types.join(", ") ?? "",
              })
              : t("market.installRegistrationFailed");
          const refreshNote = refreshed && marketRefreshed
            ? ""
            : ` ${t(isUpdate
                ? "market.refreshAfterUpdateFailed"
                : "market.refreshAfterInstallFailed")}`;
          setInstallNotice((current) => ({
            ...current,
            [job.package_name]: {
              message: `${notice}${refreshNote}`,
              error: !isUpdate && !registered,
              refresh: (!isUpdate && !registered) || !refreshed || !marketRefreshed,
              driverType: isUpdate ? undefined : job.result?.driver_types[0],
              retryRegistration: !isUpdate && !registered,
            },
          }));
          return;
        }
        setInstallJob(job);
        localStorage.setItem("regenic.connector-market.install", JSON.stringify(job));
        timer = setTimeout(poll, 1200);
      } catch (caught) {
        if (!active) return;
        if (caught instanceof Error && caught.message.endsWith("404")) {
          localStorage.removeItem("regenic.connector-market.install");
          setInstallJob(null);
          setInstalling(null);
          if (installJob.installed) {
            setInstalledPackages((current) => new Set(current).add(installJob.package_name));
          }
          setInstallNotice((current) => ({
            ...current,
            [installJob.package_name]: {
              message: t("market.installStatusLost"),
              error: true,
              refresh: true,
              retryRegistration:
                installJob.operation !== "update" && installJob.installed,
            },
          }));
          return;
        }
        timer = setTimeout(poll, 2500);
      }
    };
    void poll();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [installJob?.id, loadMarket, onChanged, t]);

  const connectors = (market?.connectors ?? []).filter((item) => {
    const query = search.trim().toLocaleLowerCase();
    if (!query) return true;
    const searchable = [
      item.name,
      item.title,
      item.description,
      item.author,
      ...item.keywords,
    ]
      .filter((value): value is string => typeof value === "string");
    return searchable.some((value) => value.toLocaleLowerCase().includes(query));
  });
  const visibleConnectors = connectors.slice(0, visibleCount);

  return (
    <section className="card engine-connectors">
      <div className="card-head">
        <h2>{market?.title ?? t("market.title")}</h2>
        <button
          type="button"
          className="ghost"
          disabled={loading}
          onClick={() => void loadMarket(true)}
        >
          {loading ? t("market.refreshing") : t("market.refresh")}
        </button>
      </div>
      <p className="muted">{t("market.lead")}</p>
      <p className="action-hint">{t("market.readOnly")}</p>
      {loading ? <p className="muted">{t("market.loading")}</p> : null}
      {error ? <p className="action-error">{error}</p> : null}
      {!loading && !error && !market?.configured ? (
        <>
          <p className="muted">{t("market.notConfigured")}</p>
          <p className="muted">{t("market.setupSteps")}</p>
        </>
      ) : null}
      {!loading && !error && market?.configured ? (
        <>
          <label className="field">
            <span>{t("market.search")}</span>
            <input
              type="search"
              value={search}
              placeholder={t("market.searchPlaceholder")}
              onChange={(event) => {
                setSearch(event.currentTarget.value);
                setVisibleCount(30);
              }}
            />
          </label>
          {connectors.length === 0 ? (
            <p className="muted">
              {market.connectors.length > 0
                ? t("market.noResults")
                : t("market.empty")}
            </p>
          ) : null}
          {visibleConnectors.map((item) => {
            const latest = item.versions[0];
            const compatibleReleases = item.versions.filter((release) => release.compatible);
            const defaultInstallRelease = compatibleReleases[0];
            const installRelease = item.versions.find(
              (release) => release.version === selectedVersions[item.name],
            ) ?? defaultInstallRelease;
            const plugin = plugins.find(
              (candidate) =>
                candidate.origin === "extra" &&
                candidate.package_name === item.name,
            );
            const installedInstanceCount = plugin
              ? installations.filter((installation) =>
                  plugin.drivers.includes(installation.connector_type),
                ).length
              : 0;
            const blockingInstallations = plugin
              ? installations.filter((installation) =>
                  plugin.drivers.includes(installation.connector_type),
                )
              : [];
            return (
              <article className="connector-kind" key={item.name}>
                <div className="card-head">
                  <div>
                    <h3>{item.title}</h3>
                    <code>{item.name}</code>
                  </div>
                  {latest ? (
                    <span className="chip">{t("market.latestVersion", { version: latest.version })}</span>
                  ) : null}
                </div>
                {item.description ? <p>{item.description}</p> : null}
                <div className="install-meta">
                  <span className={`chip ${plugin?.status === "loaded" ? "running" : "stopped"}`}>
                    {plugin?.status === "loaded"
                      ? t("market.pluginLoaded")
                      : plugin
                        ? plugin.status === "uninstall_pending"
                          ? t("market.uninstallPendingRestart")
                          : plugin.status === "update_pending"
                            ? t("market.versionChangePendingRestart", {
                                version: plugin.pending_version ?? "",
                              })
                          : plugin.status === "skipped"
                            ? t("market.pluginSkipped")
                            : t("market.pluginLoadFailed")
                        : t("market.pluginNotFound")}
                  </span>
                  {plugin ? (
                    <span>{plugin.install_source === "market"
                      ? t("market.sourceMarket")
                      : plugin.install_source === "local"
                        ? t("market.sourceLocal")
                        : t("market.sourceBuiltIn")}</span>
                  ) : null}
                  {plugin?.version ? (
                    <span>{t("market.localVersion", { version: plugin.version })}</span>
                  ) : null}
                  {plugin?.drivers.length ? (
                    <span>{t("market.driverTypes", { types: plugin.drivers.join(", ") })}</span>
                  ) : null}
                  {plugin?.version && installRelease && plugin.version !== installRelease.version ? (
                    <span>{t("market.availableVersion", { version: installRelease.version })}</span>
                  ) : null}
                  {plugin?.pending_operation ? (
                    <span>{plugin.pending_operation === "rollback"
                      ? t("market.rollbackPending")
                      : t("market.updatePending")}</span>
                  ) : null}
                  {item.author ? <span>{t("market.author", { name: item.author })}</span> : null}
                  {latest ? (
                    <span className={`chip ${latest.compatible ? "running" : "stopped"}`}>
                      {latest.compatible
                        ? t("market.supportedProtocol")
                        : t("market.unsupportedProtocol", {
                            version: latest.engines_regenic,
                          })}
                    </span>
                  ) : null}
                  {!plugin && !installedPackages.has(item.name) && installRelease ? (
                    <span>{t("market.installTargetVersion", { version: installRelease.version })}</span>
                  ) : null}
                  <span>{t("market.releaseCount", { count: item.versions.length })}</span>
                </div>
                {plugin?.error ? (
                  <p className="action-error">{plugin.error}</p>
                ) : null}
                <div className="install-actions">
                  {(!plugin || plugin.install_source === "market") &&
                    plugin?.status !== "update_pending" &&
                    plugin?.status !== "uninstall_pending" &&
                    compatibleReleases.length > 1 ? (
                    <label className="field">
                      <span>{t("market.installVersion")}</span>
                      <select
                        value={installRelease?.version ?? ""}
                        onChange={(event) => setSelectedVersions((current) => ({
                          ...current,
                          [item.name]: event.currentTarget.value,
                        }))}
                      >
                        {compatibleReleases.map((release) => (
                          <option key={release.version} value={release.version}>
                            {release.version}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : null}
                  {!plugin && !installedPackages.has(item.name) && installRelease ? (
                    <button
                      type="button"
                      disabled={installing !== null || installJob !== null}
                      onClick={() => {
                        if (
                          !window.confirm(
                            t("market.installConfirm", {
                              name: item.name,
                              version: installRelease.version,
                              publisher: item.author ?? t("market.unknownPublisher"),
                              source: item.repository ?? item.homepage ?? `https://www.npmjs.com/package/${item.name}`,
                            }),
                          )
                        ) {
                          return;
                        }
                        void (async () => {
                          setInstalling(item.name);
                          setInstallNotice((current) => ({
                            ...current,
                            [item.name]: { message: "" },
                          }));
                          try {
                            const job = await installConnectorFromMarket(
                              item.name,
                              installRelease.version,
                            );
                            setInstallJob(job);
                            localStorage.setItem("regenic.connector-market.install", JSON.stringify(job));
                          } catch (caught) {
                            setInstalling(null);
                            setInstallNotice((current) => ({
                              ...current,
                              [item.name]: {
                                message: caught instanceof Error && caught.message.endsWith("409")
                                  ? t("market.installAlreadyRunning")
                                  : t("market.installFailed"),
                                error: true,
                              },
                            }));
                          }
                        })();
                      }}
                    >
                      {installing === item.name
                        ? t("market.installing")
                        : t("market.installVersionButton", {
                            version: installRelease.version,
                          })}
                    </button>
                  ) : null}
                  {plugin?.install_source === "market" &&
                    plugin.status !== "update_pending" &&
                    plugin.status !== "uninstall_pending" &&
                    plugin.version !== installRelease?.version &&
                    installRelease ? (
                    <button
                      type="button"
                      disabled={installing !== null || installJob !== null || changingVersion !== null}
                      onClick={() => {
                        if (!window.confirm(t("market.updateConfirm", {
                          name: item.name,
                          from: plugin.version ?? "",
                          to: installRelease.version,
                          publisher: item.author ?? t("market.unknownPublisher"),
                          source: item.repository ?? item.homepage ?? `https://www.npmjs.com/package/${item.name}`,
                        }))) return;
                        void (async () => {
                          setChangingVersion(item.name);
                          try {
                            const job = await updateConnectorFromMarket(item.name, installRelease.version);
                            setInstallJob(job);
                            setInstalling(item.name);
                            localStorage.setItem("regenic.connector-market.install", JSON.stringify(job));
                          } catch {
                            setInstallNotice((current) => ({
                              ...current,
                              [item.name]: { message: t("market.updateFailed"), error: true },
                            }));
                          } finally {
                            setChangingVersion(null);
                          }
                        })();
                      }}
                    >
                      {changingVersion === item.name
                        ? t("market.updating")
                        : t("market.updateVersionButton", { version: installRelease.version })}
                    </button>
                  ) : null}
                  {plugin?.install_source === "market" &&
                    plugin.status !== "update_pending" &&
                    plugin.status !== "uninstall_pending" &&
                    plugin.previous_version ? (
                    <button
                      type="button"
                      className="ghost"
                      disabled={changingVersion !== null || installJob !== null}
                      onClick={() => {
                        if (!window.confirm(t("market.rollbackConfirm", {
                          name: item.name,
                          version: plugin.previous_version ?? "",
                        }))) return;
                        void (async () => {
                          setChangingVersion(item.name);
                          try {
                            const rollback = await rollbackConnectorFromMarket(item.name);
                            setInstallNotice((current) => ({
                              ...current,
                              [item.name]: {
                                message: t("market.rollbackStaged", { version: rollback.version }),
                              },
                            }));
                            try {
                              await onChanged();
                            } catch {
                              setInstallNotice((current) => ({
                                ...current,
                                [item.name]: {
                                  ...current[item.name],
                                  message: t("market.rollbackRefreshFailed"),
                                  refresh: true,
                                },
                              }));
                            }
                          } catch {
                            setInstallNotice((current) => ({
                              ...current,
                              [item.name]: { message: t("market.rollbackFailed"), error: true },
                            }));
                          } finally {
                            setChangingVersion(null);
                          }
                        })();
                      }}
                    >
                      {t("market.rollbackButton", { version: plugin.previous_version })}
                    </button>
                  ) : null}
                  {!plugin && !installedPackages.has(item.name) && compatibleReleases.length === 0 ? (
                    <span className="muted">{t("market.noCompatibleRelease")}</span>
                  ) : null}
                  {installedPackages.has(item.name) && !plugin ? (
                    <span className="chip stopped">{t("market.installedRefreshPending")}</span>
                  ) : null}
                  {plugin?.install_source === "market" &&
                    plugin.status !== "uninstall_pending" &&
                    plugin.status !== "update_pending" ? (
                    <button
                      type="button"
                      className="ghost"
                      disabled={uninstalling !== null || installedInstanceCount > 0 || installJob !== null}
                      onClick={() => {
                        if (!window.confirm(t("market.uninstallConfirm", { name: item.name }))) return;
                        void (async () => {
                          setUninstalling(item.name);
                          try {
                            await uninstallConnectorFromMarket(item.name);
                            setInstallNotice((current) => ({
                              ...current,
                              [item.name]: {
                                message: t("market.uninstallPendingNotice"),
                                error: false,
                              },
                            }));
                            try {
                              await onChanged();
                            } catch {
                              setInstallNotice((current) => ({
                                ...current,
                                [item.name]: {
                                  ...current[item.name],
                                  message: t("market.uninstallRefreshFailed"),
                                  refresh: true,
                                },
                              }));
                            }
                          } catch (caught) {
                            setInstallNotice((current) => ({
                              ...current,
                              [item.name]: {
                                message: caught instanceof Error && caught.message.endsWith("409")
                                  ? t("market.uninstallInstancesFirst", { count: installedInstanceCount })
                                  : t("market.uninstallFailed"),
                                error: true,
                              },
                            }));
                          } finally {
                            setUninstalling(null);
                          }
                        })();
                      }}
                    >
                      {uninstalling === item.name
                        ? t("market.uninstalling")
                        : t("market.uninstall")}
                    </button>
                  ) : null}
                  {plugin?.install_source === "market" && installedInstanceCount > 0 ? (
                    <div className="muted">
                      <p>{t("market.uninstallInstancesFirst", { count: installedInstanceCount })}</p>
                      <p>{t("market.uninstallBlockedInstances")}</p>
                      <ul>
                        {blockingInstallations.map((installation) => (
                          <li key={installation.id}>
                            <a href={`#connector-installation-${encodeURIComponent(installation.id)}`}>
                              {installation.label} ({installation.connector_type})
                            </a>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  {item.homepage ? (
                    <a href={item.homepage} target="_blank" rel="noreferrer">
                      {t("market.homepage")}
                    </a>
                  ) : null}
                  {item.repository ? (
                    <a href={item.repository} target="_blank" rel="noreferrer">
                      {t("market.repository")}
                    </a>
                  ) : null}
                  <a
                    href={`https://www.npmjs.com/package/${encodeURIComponent(item.name)}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {t("market.npm")}
                  </a>
                </div>
                {installNotice[item.name]?.message ? (
                  <p className={installNotice[item.name].error ? "action-error" : "action-hint"}>
                    {installNotice[item.name].message}
                    {installNotice[item.name].retryRegistration ? (
                      <>
                        {" "}
                        <button
                          type="button"
                          className="ghost"
                          disabled={retryingRegistration !== null}
                          onClick={() => {
                            void (async () => {
                              setRetryingRegistration(item.name);
                              try {
                                const result = await retryConnectorMarketRegistration(item.name);
                                let refreshed = true;
                                try {
                                  await onChanged();
                                } catch {
                                  refreshed = false;
                                }
                                const registeredTypes = result.registered_driver_types.join(", ");
                                setInstallNotice((current) => ({
                                  ...current,
                                  [item.name]: result.registered
                                    ? {
                                        message: `${t("market.registrationRetrySucceeded", {
                                          types: registeredTypes,
                                        })}${refreshed ? "" : ` ${t("market.refreshAfterInstallFailed")}`}`,
                                        driverType: result.driver_types[0],
                                        refresh: !refreshed,
                                      }
                                    : {
                                        message: t("market.registrationRetryFailed", {
                                          types: result.driver_types
                                            .filter((type) => !result.registered_driver_types.includes(type))
                                            .join(", ") || result.driver_types.join(", "),
                                        }),
                                        error: true,
                                        retryRegistration: true,
                                      },
                                }));
                              } catch {
                                setInstallNotice((current) => ({
                                  ...current,
                                  [item.name]: {
                                    ...current[item.name],
                                    message: t("market.registrationRetryFailed", {
                                      types: current[item.name]?.driverType ?? item.name,
                                    }),
                                    retryRegistration: true,
                                    error: true,
                                  },
                                }));
                              } finally {
                                setRetryingRegistration(null);
                              }
                            })();
                          }}
                        >
                          {retryingRegistration === item.name
                            ? t("market.registrationRetrying")
                            : t("market.retryRegistration")}
                        </button>
                      </>
                    ) : null}
                    {installNotice[item.name].driverType && !installNotice[item.name].error ? (
                      <> <a href={installNotice[item.name].driverType
                        ? `#connector-type-${encodeURIComponent(installNotice[item.name].driverType ?? "")}`
                        : "#engine-connector-config"}>{t("market.configureNext")}</a></>
                    ) : null}
                    {installNotice[item.name].refresh ? (
                      <>
                        {" "}
                        <button
                          type="button"
                          className="ghost"
                          onClick={() => {
                            void (async () => {
                              try {
                                await onChanged();
                                await loadMarket(true, true);
                              } catch {
                                setInstallNotice((current) => ({
                                  ...current,
                                  [item.name]: {
                                    ...current[item.name],
                                    message: t("market.refreshAfterInstallFailed"),
                                  },
                                }));
                              }
                            })();
                          }}
                        >
                          {t("market.refreshLocalStatus")}
                        </button>
                      </>
                    ) : null}
                  </p>
                ) : null}
                {item.versions.length > 1 ? (
                  <ConnectorReleaseDetails releases={item.versions} />
                ) : null}
              </article>
            );
          })}
          {visibleCount < connectors.length ? (
            <button
              type="button"
              className="ghost"
              onClick={() => setVisibleCount((count) => count + 30)}
            >
              {t("market.showMore", { count: connectors.length - visibleCount })}
            </button>
          ) : null}
          {installJob ? (
            <p className="action-hint" role="status" aria-live="polite">
              {t(`market.phase.${installJob.phase}`, {
                name: installJob.package_name,
                version: installJob.version,
              })}
            </p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

function ConnectorReleaseDetails({
  releases,
}: {
  releases: ConnectorMarketView["connectors"][number]["versions"];
}) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>{t("market.allReleases")}</summary>
      {open ? (
        <ul>
          {releases.map((release) => (
            <li key={release.version}>
              <code>{release.version}</code>
              {" · "}
              {release.published_at.slice(0, 10)}
              {" · "}
              {release.compatible
                ? t("market.supportedProtocol")
                : t("market.unsupportedProtocol", {
                    version: release.engines_regenic,
                  })}
            </li>
          ))}
        </ul>
      ) : null}
    </details>
  );
}

function EngineStat({
  label,
  value,
  tone,
  emphasis = false,
}: {
  label: string;
  value: string;
  tone?: "ok" | "warn" | "risk";
  emphasis?: boolean;
}) {
  return (
    <div
      className={`engine-stat${tone ? ` is-${tone}` : ""}${
        emphasis ? " is-emphasis" : ""
      }`}
    >
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

function syncModeKey(
  mode: SyncRunMode,
): "quick" | "continuous" | "archive" {
  if (mode === "continuous") {
    return "continuous";
  }
  if (mode === "archive") {
    return "archive";
  }
  return "quick";
}

function isDeletableRun(status: string): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}
