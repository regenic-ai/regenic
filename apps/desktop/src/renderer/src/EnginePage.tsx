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
  retryConnectorQuarantines,
  setConnectorStatus,
  setExecutorStatus,
  syncConnector,
  uninstallConnectorFromMarket,
  uninstallConnector,
  updateConnectorFromMarket,
  updateConnectorConfig,
} from "./api";
import { ConnectorKind } from "./ConnectorSettings";
import { AgentList } from "./ExecutorSettings";
import { connectorActionError, formatChatTime } from "./format";
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
  error,
  onChanged,
}: {
  engine: PersonalEngineView | null;
  error: string | null;
  onChanged: () => Promise<void>;
}) {
  const { t } = useLocale();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [syncingAll, setSyncingAll] = useState(false);
  const [installingType, setInstallingType] = useState<string | null>(null);
  const [pairingCodes, setPairingCodes] = useState<Record<string, string>>({});
  const [pendingUninstallIds, setPendingUninstallIds] = useState<string[]>([]);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [tab, setTab] = useState<"sources" | "handlers">("sources");
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
      <div className="page page-wide page-apps">
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
  const visibleRuns = (engine.sync_runs ?? []).filter((run) =>
    ["queued", "running", "paused", "failed"].includes(run.status),
  );

  return (
    <div className="page page-wide page-apps">
      <header className="page-hero">
        <p className="page-eyebrow">{t("engine.eyebrow")}</p>
        <h1>{t("engine.title")}</h1>
        <p className="page-lead">{t("engine.lead")}</p>
      </header>
      <div className="page-tabs" role="tablist" aria-label={t("engine.title")}>
        {([
          ["sources", t("engine.tabSources"), engine.installations.length],
          ["handlers", t("engine.tabHandlers"), (engine.executor_installations ?? []).length],
        ] as const).map(([id, label, count]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={tab === id ? "active" : ""}
            onClick={() => setTab(id)}
          >
            {label}
            <span className="page-tab-count">{count}</span>
          </button>
        ))}
      </div>
      {tab === "sources" ? (
        <>
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
                          <p className="action-error">
                            {run.last_error === "sync_work_pending"
                              ? t("sync.workPending")
                              : run.last_error}
                          </p>
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
                <h2 className="settings-heading">{t("engine.connectors")}</h2>
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
                onEnable={(installation) =>
                  void runAction(installation.id, async () => {
                    await setConnectorStatus(
                      installation.id,
                      "enabled",
                    );
                  })
                }
                onUpdate={(installation, config) =>
                  runAction(installation.id, async () => {
                    await updateConnectorConfig(installation.id, config);
                  })
                }
                error={actionError}
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
        </>
      ) : (
        <section className="card engine-connectors">
          <div className="card-head">
            <div className="card-title">
              <h2 className="settings-heading">{t("engine.executors")}</h2>
            </div>
          </div>
          <p className="muted">{t("engine.executorsLead")}</p>
          <AgentList
            agents={engine.executor_installations ?? []}
            apps={engine.installations}
            busyId={busyId}
            onToggle={(agent) =>
              void runAction(`ex:${agent.id}`, async () => {
                await setExecutorStatus(
                  agent.id,
                  agent.status === "disabled" ? "enabled" : "disabled",
                );
              })
            }
          />
          {actionError ? <p className="action-error">{actionError}</p> : null}
        </section>
      )}
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
  const [confirm, setConfirm] = useState<MarketConfirm | null>(null);

  const startInstall = (packageName: string, version: string) => {
    void (async () => {
      setInstalling(packageName);
      setInstallNotice((current) => ({
        ...current,
        [packageName]: { message: "" },
      }));
      try {
        const job = await installConnectorFromMarket(packageName, version);
        setInstallJob(job);
        localStorage.setItem("regenic.connector-market.install", JSON.stringify(job));
      } catch (caught) {
        setInstalling(null);
        setInstallNotice((current) => ({
          ...current,
          [packageName]: {
            message: caught instanceof Error && caught.message.endsWith("409")
              ? t("market.installAlreadyRunning")
              : t("market.installFailed"),
            error: true,
          },
        }));
      }
    })();
  };

  const startUpdate = (packageName: string, version: string) => {
    void (async () => {
      setChangingVersion(packageName);
      try {
        const job = await updateConnectorFromMarket(packageName, version);
        setInstallJob(job);
        setInstalling(packageName);
        localStorage.setItem("regenic.connector-market.install", JSON.stringify(job));
      } catch {
        setInstallNotice((current) => ({
          ...current,
          [packageName]: { message: t("market.updateFailed"), error: true },
        }));
      } finally {
        setChangingVersion(null);
      }
    })();
  };

  const startRollback = (packageName: string) => {
    void (async () => {
      setChangingVersion(packageName);
      try {
        const rollback = await rollbackConnectorFromMarket(packageName);
        setInstallNotice((current) => ({
          ...current,
          [packageName]: {
            message: t("market.rollbackStaged", { version: rollback.version }),
          },
        }));
        try {
          await onChanged();
        } catch {
          setInstallNotice((current) => ({
            ...current,
            [packageName]: {
              ...current[packageName],
              message: t("market.rollbackRefreshFailed"),
              refresh: true,
            },
          }));
        }
      } catch {
        setInstallNotice((current) => ({
          ...current,
          [packageName]: { message: t("market.rollbackFailed"), error: true },
        }));
      } finally {
        setChangingVersion(null);
      }
    })();
  };

  const startUninstall = (packageName: string, instanceCount: number) => {
    void (async () => {
      setUninstalling(packageName);
      try {
        await uninstallConnectorFromMarket(packageName);
        setInstallNotice((current) => ({
          ...current,
          [packageName]: {
            message: t("market.uninstallPendingNotice"),
            error: false,
          },
        }));
        try {
          await onChanged();
        } catch {
          setInstallNotice((current) => ({
            ...current,
            [packageName]: {
              ...current[packageName],
              message: t("market.uninstallRefreshFailed"),
              refresh: true,
            },
          }));
        }
      } catch (caught) {
        setInstallNotice((current) => ({
          ...current,
          [packageName]: {
            message: caught instanceof Error && caught.message.endsWith("409")
              ? t("market.uninstallInstancesFirst", { count: instanceCount })
              : t("market.uninstallFailed"),
            error: true,
          },
        }));
      } finally {
        setUninstalling(null);
      }
    })();
  };

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
          const registeredFeatures = [
            ...(job.result?.driver_types ?? []),
            ...(job.result?.executor_sources ?? []).map((source) => `executor:${source}`),
          ].join(", ");
          const notice = isUpdate
            ? t("market.updateStaged", { version: job.version })
            : registered
              ? t("market.installRegistered", {
                types: registeredFeatures,
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
        <h2>{t("market.title")}</h2>
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
      {loading && !market ? <p className="muted">{t("market.loading")}</p> : null}
      {error ? <p className="action-error">{error}</p> : null}
      {!loading && !error && !market?.configured ? (
        <>
          <p className="muted">{t("market.notConfigured")}</p>
          <p className="muted">{t("market.setupSteps")}</p>
        </>
      ) : null}
      {!error && market?.configured ? (
        <>
          {market.connectors.length > 3 ? (
            <label className="field market-search">
              <span className="sr-only">{t("market.search")}</span>
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
          ) : null}
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
            const installRelease = compatibleReleases[0];
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
            const job = installJob?.package_name === item.name ? installJob : null;
            const source = item.repository ?? item.homepage ?? `https://www.npmjs.com/package/${item.name}`;
            const publisher = item.author ?? t("market.unknownPublisher");
            const confirmHere = confirm?.packageName === item.name ? confirm : null;
            return (
              <article
                className={`connector-kind market-card${plugin?.status === "loaded" ? " is-installed" : ""}`}
                key={item.name}
              >
                <div className="app-row">
                  <div className="app-row-copy">
                    <strong>{item.title}</strong>
                    {item.description ? <p>{item.description}</p> : null}
                  </div>
                  <div className="app-row-actions">
                    {!plugin && !installedPackages.has(item.name) && installRelease ? (
                      <button
                        type="button"
                        className="primary"
                        disabled={installing !== null || installJob !== null || confirmHere !== null}
                        onClick={() => setConfirm({
                          packageName: item.name,
                          title: t("market.confirmInstallTitle", {
                            name: item.title,
                            version: installRelease.version,
                          }),
                          facts: [
                            [t("market.confirmPackage"), `${item.name}@${installRelease.version}`],
                            [t("market.confirmPublisher"), publisher],
                            [t("market.confirmSource"), source],
                          ],
                          body: t("market.confirmInstallRisk"),
                          confirmLabel: t("market.confirmInstall"),
                          run: () => startInstall(item.name, installRelease.version),
                        })}
                      >
                        {installing === item.name ? t("market.installing") : t("connector.install")}
                      </button>
                    ) : null}
                  </div>
                </div>
                {latest && !latest.compatible ? (
                  <p className="action-error">
                    {t("market.unsupportedProtocol", { version: latest.engines_regenic })}
                  </p>
                ) : null}
                {plugin?.error ? (
                  <p className="action-error">{plugin.error}</p>
                ) : null}
                {job ? (
                  <div className="market-progress" role="status" aria-live="polite">
                    <div className="market-progress-bar"><span /></div>
                    <p className="muted">
                      {t(`market.phase.${job.phase}`, {
                        name: job.package_name,
                        version: job.version,
                      })}
                    </p>
                  </div>
                ) : null}
                {confirmHere ? (
                  <div className={`market-confirm${confirmHere.danger ? " is-danger" : ""}`}>
                    <strong>{confirmHere.title}</strong>
                    {confirmHere.facts?.length ? (
                      <dl>
                        {confirmHere.facts.map(([label, value]) => (
                          <div key={label}>
                            <dt>{label}</dt>
                            <dd>
                              {value.startsWith("https://") ? (
                                <a href={value} target="_blank" rel="noreferrer">{value}</a>
                              ) : value}
                            </dd>
                          </div>
                        ))}
                      </dl>
                    ) : null}
                    <p>{confirmHere.body}</p>
                    <div className="market-confirm-actions">
                      <button
                        type="button"
                        className={`primary${confirmHere.danger ? " danger" : ""}`}
                        onClick={() => {
                          setConfirm(null);
                          confirmHere.run();
                        }}
                      >
                        {confirmHere.confirmLabel}
                      </button>
                      <button type="button" className="ghost" onClick={() => setConfirm(null)}>
                        {t("market.cancel")}
                      </button>
                    </div>
                  </div>
                ) : null}
                <div className="market-actions">
                  {plugin?.install_source === "market" &&
                    plugin.status !== "update_pending" &&
                    plugin.status !== "uninstall_pending" &&
                    plugin.version !== installRelease?.version &&
                    installRelease ? (
                    <button
                      type="button"
                      className="primary"
                      disabled={
                        installing !== null ||
                        installJob !== null ||
                        changingVersion !== null ||
                        confirmHere !== null
                      }
                      onClick={() => setConfirm({
                        packageName: item.name,
                        title: t("market.updateVersionButton", { version: installRelease.version }),
                        body: t("market.updateConfirm", {
                          name: item.name,
                          from: plugin.version ?? "",
                          to: installRelease.version,
                          publisher,
                          source,
                        }),
                        confirmLabel: t("market.updateVersionButton", { version: installRelease.version }),
                        run: () => startUpdate(item.name, installRelease.version),
                      })}
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
                      disabled={changingVersion !== null || installJob !== null || confirmHere !== null}
                      onClick={() => setConfirm({
                        packageName: item.name,
                        title: t("market.rollbackButton", { version: plugin.previous_version ?? "" }),
                        body: t("market.rollbackConfirm", {
                          name: item.name,
                          version: plugin.previous_version ?? "",
                        }),
                        confirmLabel: t("market.rollbackButton", { version: plugin.previous_version ?? "" }),
                        run: () => startRollback(item.name),
                      })}
                    >
                      {t("market.rollbackButton", { version: plugin.previous_version })}
                    </button>
                  ) : null}
                  {!plugin && !installedPackages.has(item.name) && compatibleReleases.length === 0 ? (
                    <span className="muted">{t("market.noCompatibleRelease")}</span>
                  ) : null}
                  {plugin?.install_source === "market" &&
                    plugin.status !== "uninstall_pending" &&
                    plugin.status !== "update_pending" ? (
                    <button
                      type="button"
                      className="ghost"
                      disabled={
                        uninstalling !== null ||
                        installedInstanceCount > 0 ||
                        installJob !== null ||
                        confirmHere !== null
                      }
                      onClick={() => setConfirm({
                        packageName: item.name,
                        title: t("market.uninstall"),
                        body: t("market.uninstallConfirm", { name: item.name }),
                        confirmLabel: t("market.uninstall"),
                        danger: true,
                        run: () => startUninstall(item.name, installedInstanceCount),
                      })}
                    >
                      {uninstalling === item.name
                        ? t("market.uninstalling")
                        : t("market.uninstall")}
                    </button>
                  ) : null}
                  {plugin?.install_source === "market" && installedInstanceCount > 0 ? (
                    <div className="muted market-blockers">
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
                                const registeredTypes = [
                                  ...result.registered_driver_types,
                                  ...result.registered_executor_sources.map(
                                    (source) => `executor:${source}`,
                                  ),
                                ].join(", ");
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
                                          types: [
                                            ...result.driver_types.filter(
                                              (type) => !result.registered_driver_types.includes(type),
                                            ),
                                            ...result.executor_sources
                                              .filter((source) =>
                                                !result.registered_executor_sources.includes(source))
                                              .map((source) => `executor:${source}`),
                                          ].join(", ") || item.name,
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
          {installJob &&
            !visibleConnectors.some((item) => item.name === installJob.package_name) ? (
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

type MarketConfirm = {
  packageName: string;
  title: string;
  body: string;
  facts?: Array<[string, string]>;
  confirmLabel: string;
  danger?: boolean;
  run: () => void;
};

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
