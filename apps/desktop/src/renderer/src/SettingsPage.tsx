import { useEffect, useRef, useState, type UIEvent } from "react";
import {
  applyDataDirectory,
  applyKernelSettings,
  clearStore,
  currentApiOrigin,
  fetchKernelSettings,
  fetchStore,
  fetchDispatchPolicy,
  saveDispatchPolicy,
  pickDataDirectory,
  resolveSourceRetention,
} from "./api";
import { isMessageKey, type MessageKey } from "../../shared/messages.ts";
import { ContextRecordsDialog } from "./ContextRecordsDialog";
import { SemanticSettings } from "./SemanticSettings";
import { useLocale } from "./LocaleContext";
import type {
  DataDirectoryAction,
  DataDirectoryPlan,
  DataDirectoryView,
  KernelMode,
  Locale,
  MessageDisposition,
  PersonalDispatchPolicy,
  SourceRetentionView,
  StoreView,
} from "./types";

const emptyStore: StoreView = {
  events: 0,
  conversations: 0,
  work_items: 0,
  blobs: 0,
  context_artifacts: 0,
  context_snapshots: 0,
  context_snapshot_index: 0,
  context_bundles: 0,
  context_checkpoints: 0,
  recipes: 0,
  connectors: 0,
  executors: 0,
};

function localizeThrown(
  t: (key: MessageKey) => string,
  message: string,
  fallback: MessageKey,
): string {
  return isMessageKey(message) ? t(message) : message || t(fallback);
}

function storeHasData(store: StoreView): boolean {
  return (
    store.events > 0 ||
    store.conversations > 0 ||
    store.work_items > 0 ||
    store.blobs > 0 ||
    store.context_artifacts > 0 ||
    store.context_snapshots > 0 ||
    store.context_snapshot_index > 0 ||
    store.context_bundles > 0 ||
    store.context_checkpoints > 0
  );
}

function contextRecordCount(store: Pick<StoreView, "context_artifacts">): number {
  return store.context_artifacts;
}

export function SettingsPage({
  onChanged,
  onStoreCleared,
}: {
  onChanged: () => Promise<void>;
  onStoreCleared: () => Promise<void>;
}) {
  const { locale, setLocale, t } = useLocale();
  const [mode, setMode] = useState<KernelMode>("local");
  const [customOrigin, setCustomOrigin] = useState("http://127.0.0.1:4370");
  const [customApiKey, setCustomApiKey] = useState("");
  const [hasSavedPersonalApiKey, setHasSavedPersonalApiKey] = useState(false);
  const [activeOrigin, setActiveOrigin] = useState(currentApiOrigin());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [store, setStore] = useState<StoreView | null>(null);
  const [storeBusy, setStoreBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [storeError, setStoreError] = useState<string | null>(null);
  const [storeDone, setStoreDone] = useState<string | null>(null);
  const [dataDir, setDataDir] = useState<DataDirectoryView | null>(null);
  const [dataPlan, setDataPlan] = useState<DataDirectoryPlan | null>(null);
  const [sourceRetention, setSourceRetention] =
    useState<SourceRetentionView | null>(null);
  const [dataBusy, setDataBusy] = useState(false);
  const [dataError, setDataError] = useState<string | null>(null);
  const [dataDone, setDataDone] = useState<string | null>(null);
  const [reclaimConfirming, setReclaimConfirming] = useState(false);
  const [reclaimBusy, setReclaimBusy] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [dispatchPolicy, setDispatchPolicy] = useState<PersonalDispatchPolicy | null>(null);
  const [dispatchBusy, setDispatchBusy] = useState(false);
  const [dispatchMessage, setDispatchMessage] = useState<string | null>(null);
  const [dispatchFailed, setDispatchFailed] = useState(false);
  const [savedDispatch, setSavedDispatch] = useState<PersonalDispatchPolicy | null>(null);
  const [savedKernel, setSavedKernel] = useState<{ mode: KernelMode; customOrigin: string }>({
    mode: "local", customOrigin: "http://127.0.0.1:4370",
  });
  const [activeSection, setActiveSection] = useState("settings-general");
  const [pathCopied, setPathCopied] = useState(false);
  const pageRef = useRef<HTMLDivElement | null>(null);

  const dispatchDirty = Boolean(dispatchPolicy && savedDispatch &&
    JSON.stringify(dispatchPolicy) !== JSON.stringify(savedDispatch));
  const kernelDirty = mode !== savedKernel.mode ||
    (mode === "custom" && (customOrigin !== savedKernel.customOrigin || customApiKey.trim() !== ""));

  const trackSection = (event: UIEvent<HTMLDivElement>) => {
    const page = event.currentTarget;
    const top = page.getBoundingClientRect().top + 96;
    let current = "settings-general";
    for (const node of page.querySelectorAll<HTMLElement>(".settings-sections > [id]")) {
      if (node.getBoundingClientRect().top <= top) current = node.id;
    }
    if (page.scrollTop + page.clientHeight >= page.scrollHeight - 4) {
      current = "settings-danger";
    }
    setActiveSection(current);
  };

  const jumpTo = (id: string) => {
    setActiveSection(id);
    pageRef.current?.querySelector(`#${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const copyPath = async (path: string) => {
    try {
      await navigator.clipboard.writeText(path);
      setPathCopied(true);
      window.setTimeout(() => setPathCopied(false), 1500);
    } catch { /* clipboard unavailable */ }
  };

  useEffect(() => {
    let cancelled = false;
    void fetchDispatchPolicy()
      .then((policy) => {
        if (!cancelled) { setDispatchPolicy(policy); setSavedDispatch(policy); }
      })
      .catch(() => {
        if (!cancelled) { setDispatchMessage(t("settings.dispatchError")); setDispatchFailed(true); }
      });
    return () => { cancelled = true; };
  }, [activeOrigin, t]);

  const savePersonalDispatch = async () => {
    if (!dispatchPolicy) return;
    setDispatchBusy(true);
    setDispatchMessage(null);
    try {
      const saved = await saveDispatchPolicy(dispatchPolicy);
      setDispatchPolicy(saved);
      setSavedDispatch(saved);
      setDispatchFailed(false);
      setDispatchMessage(t("settings.dispatchSaved"));
    } catch {
      setDispatchFailed(true);
      setDispatchMessage(t("settings.dispatchError"));
    } finally {
      setDispatchBusy(false);
    }
  };

  useEffect(() => {
    void fetchKernelSettings()
      .then((settings) => {
        setMode(settings.mode);
        setCustomOrigin(settings.customOrigin);
        setSavedKernel({ mode: settings.mode, customOrigin: settings.customOrigin });
        setHasSavedPersonalApiKey(settings.hasSavedPersonalApiKey === true);
        setActiveOrigin(settings.activeOrigin);
        setDataDir(settings.dataDirectory);
        setSourceRetention(settings.sourceRetention ?? null);
      })
      .catch(() => {
        setError(t("settings.readError"));
      });
  }, [t]);

  useEffect(() => {
    let cancelled = false;
    let timer = 0;
    let attempt = 0;
    const load = async () => {
      try {
        const next = await fetchStore();
        if (!cancelled) {
          setStore(next);
          setStoreError(null);
        }
      } catch {
        if (cancelled) {
          return;
        }
        if (attempt < 8) {
          attempt += 1;
          timer = window.setTimeout(() => {
            void load();
          }, 1000);
          return;
        }
        setStore((current) => current ?? emptyStore);
        setStoreError(t("settings.storeReadError"));
      }
    };
    void load();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [t, activeOrigin]);

  const apply = async () => {
    setBusy(true);
    setError(null);
    try {
      const settings = await applyKernelSettings({
        mode,
        origin: mode === "custom" ? customOrigin : undefined,
        personalApiKey:
          mode === "custom" && customApiKey.trim() ? customApiKey.trim() : undefined,
      });
      setMode(settings.mode);
      setCustomOrigin(settings.customOrigin);
      setSavedKernel({ mode: settings.mode, customOrigin: settings.customOrigin });
      setHasSavedPersonalApiKey(settings.hasSavedPersonalApiKey === true);
      setCustomApiKey("");
      setActiveOrigin(settings.activeOrigin);
      setDataDir(settings.dataDirectory);
      setSourceRetention(settings.sourceRetention ?? null);
      await onChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("settings.applyError"));
    } finally {
      setBusy(false);
    }
  };

  const chooseFolder = async () => {
    setDataBusy(true);
    setDataError(null);
    setDataDone(null);
    try {
      const plan = await pickDataDirectory();
      if (!plan) {
        return;
      }
      if (plan.sameAsCurrent) {
        setDataPlan(null);
        setDataDone(t("settings.dataDirSame"));
        return;
      }
      if (!plan.canChange) {
        setDataPlan(null);
        setDataError(
          localizeThrown(t, plan.reason ?? "", "settings.dataDirError"),
        );
        return;
      }
      setDataPlan(plan);
    } catch (caught) {
      setDataError(
        localizeThrown(
          t,
          caught instanceof Error ? caught.message : "",
          "settings.dataDirPickError",
        ),
      );
    } finally {
      setDataBusy(false);
    }
  };

  const commitDataDirectory = async (path: string, action: DataDirectoryAction) => {
    setDataBusy(true);
    setDataError(null);
    setDataDone(null);
    try {
      const settings = await applyDataDirectory({ path, action });
      setMode(settings.mode);
      setCustomOrigin(settings.customOrigin);
      setSavedKernel({ mode: settings.mode, customOrigin: settings.customOrigin });
      setActiveOrigin(settings.activeOrigin);
      setDataDir(settings.dataDirectory);
      setSourceRetention(settings.sourceRetention ?? null);
      setReclaimConfirming(false);
      setDataPlan(null);
      setDataDone(
        action === "migrate" || action === "replace"
          ? t("settings.dataDirDoneMigrated", { path: settings.dataDirectory.path })
          : t("settings.dataDirDone", { path: settings.dataDirectory.path }),
      );
      try {
        setStore(await fetchStore());
      } catch {
        setStore(emptyStore);
      }
      await onChanged();
    } catch (caught) {
      setDataError(
        localizeThrown(
          t,
          caught instanceof Error ? caught.message : "",
          "settings.dataDirError",
        ),
      );
    } finally {
      setDataBusy(false);
    }
  };

  const resolveRetention = async (action: "keep" | "discard") => {
    const freed = sourceRetention?.size ?? "";
    setReclaimBusy(true);
    setDataError(null);
    if (action === "keep") {
      setDataDone(null);
    }
    try {
      const settings = await resolveSourceRetention({ action });
      setDataDir(settings.dataDirectory);
      setSourceRetention(settings.sourceRetention ?? null);
      setReclaimConfirming(false);
      if (action === "discard") {
        setDataDone(t("settings.dataDirReclaimDone", { size: freed }));
      }
    } catch (caught) {
      setDataError(
        localizeThrown(
          t,
          caught instanceof Error ? caught.message : "",
          "settings.dataDirReclaimError",
        ),
      );
    } finally {
      setReclaimBusy(false);
    }
  };

  const chooseLocale = (next: Locale) => {
    if (next === locale) {
      return;
    }
    void setLocale(next);
  };

  const clearLocalData = async () => {
    setStoreBusy(true);
    setStoreError(null);
    setStoreDone(null);
    try {
      const result = await clearStore();
      setStore({
        events: 0,
        conversations: 0,
        work_items: 0,
        blobs: 0,
        context_artifacts: 0,
        context_snapshots: 0,
        context_snapshot_index: 0,
        context_bundles: 0,
        context_checkpoints: 0,
        recipes: result.kept.recipes,
        connectors: result.kept.connectors,
        executors: result.kept.executors ?? 0,
      });
      setConfirming(false);
      setStoreDone(
        t("settings.storeDone", {
          conversations: result.cleared.conversations,
          events: result.cleared.events,
          work: result.cleared.work_items,
        }),
      );
      await onStoreCleared();
    } catch (caught) {
      setStoreError(
        caught instanceof Error ? caught.message : t("settings.storeError"),
      );
    } finally {
      setStoreBusy(false);
    }
  };

  const currentStore = store ?? emptyStore;
  const canClear = storeHasData(currentStore);

  const sections = [
    ["settings-general", t("settings.language")],
    ["settings-dispatch", t("settings.dispatch")],
    ["settings-semantic", t("semantic.title")],
    ["settings-kernel", t("settings.kernel")],
    ["settings-data", t("settings.store")],
    ["settings-danger", t("settings.danger")],
  ] as const;

  return (
    <div className="page page-wide settings-page" ref={pageRef} onScroll={trackSection}>
      <header className="page-hero">
        <h1>{t("settings.title")}</h1>
        <p className="page-lead">{t("settings.lead")}</p>
      </header>

      <div className="settings-layout">
        <nav className="settings-nav" aria-label={t("settings.title")}>
          {sections.map(([id, label]) => (
            <button key={id} type="button" className={activeSection === id ? "active" : ""}
              onClick={() => jumpTo(id)}>{label}</button>
          ))}
        </nav>

        <div className="settings-sections">
          <section className="card" id="settings-general">
            <div className="settings-row">
              <div>
                <h2>{t("settings.language")}</h2>
                <p className="muted">{t("settings.languageLead")}</p>
              </div>
              <div className="segmented" role="radiogroup" aria-label={t("settings.language")}>
                {(["zh", "en"] as const).map((value) => (
                  <button key={value} type="button" role="radio" aria-checked={locale === value}
                    className={locale === value ? "active" : ""} onClick={() => chooseLocale(value)}>
                    {t(value === "zh" ? "settings.chinese" : "settings.english")}
                  </button>
                ))}
              </div>
            </div>
          </section>

          <section className="card" id="settings-dispatch">
            <div className="card-head">
              <h2>{t("settings.dispatch")}</h2>
              {dispatchDirty ? <span className="chip syncing">{t("settings.unsaved")}</span> : null}
            </div>
            <p className="muted">{t("settings.dispatchLead")}</p>
            {dispatchPolicy ? (
              <div className="dispatch-rules">
                {([
                  ["high_hint_disposition", "settings.dispatchHigh", "settings.dispatchHighHint"],
                  ["actionable_disposition", "settings.dispatchActionable", "settings.dispatchActionableHint"],
                  ["short_text_disposition", "settings.dispatchShort", "settings.dispatchShortHint"],
                  ["default_disposition", "settings.dispatchDefault", "settings.dispatchDefaultHint"],
                ] as const).map(([field, label, hint]) => (
                  <div className="dispatch-rule" key={field}>
                    <div className="dispatch-rule-text">
                      <strong>{t(label)}</strong>
                      <span className="muted">{t(hint)}</span>
                    </div>
                    <div className="segmented" role="radiogroup" aria-label={t(label)}>
                      {([
                        ["current_work", "settings.dispatchCurrent"],
                        ["pending", "settings.dispatchPending"],
                        ["outside_current_work", "settings.dispatchOutside"],
                      ] as const).map(([value, optionLabel]) => (
                        <button key={value} type="button" role="radio"
                          aria-checked={dispatchPolicy[field] === value}
                          className={dispatchPolicy[field] === value ? "active" : ""}
                          onClick={() => setDispatchPolicy({ ...dispatchPolicy, [field]: value as MessageDisposition })}>
                          {t(optionLabel)}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
            <div className="settings-footer">
              {dispatchMessage ? <span className={dispatchFailed ? "action-error" : "action-ok"} role="status">{dispatchMessage}</span> : <span />}
              <span className="install-actions">
                <button type="button" className="ghost" disabled={!dispatchDirty || dispatchBusy}
                  onClick={() => setDispatchPolicy(savedDispatch)}>{t("settings.revert")}</button>
                <button type="button" className="primary" onClick={() => void savePersonalDispatch()}
                  disabled={!dispatchDirty || dispatchBusy}>
                  {dispatchBusy ? t("settings.dispatchSaving") : t("settings.dispatchSave")}
                </button>
              </span>
            </div>
          </section>

          <div id="settings-semantic">
            <SemanticSettings />
          </div>

          <section className="card" id="settings-kernel">
            <div className="card-head">
              <h2>{t("settings.kernel")}</h2>
              {kernelDirty ? <span className="chip syncing">{t("settings.unsaved")}</span> : null}
            </div>
            <div className="settings-current">
              <span className="muted">{t("settings.inUse")}</span>
              <code>{activeOrigin}</code>
            </div>
            <div className="choice-list">
              <button
                type="button"
                className={`choice${mode === "local" ? " active" : ""}`}
                onClick={() => setMode("local")}
              >
                <span className="choice-mark" />
                <span>
                  <strong>{t("settings.local")}</strong>
                  <span className="muted">{t("settings.localHint")}</span>
                </span>
              </button>
              <button
                type="button"
                className={`choice${mode === "custom" ? " active" : ""}`}
                onClick={() => setMode("custom")}
              >
                <span className="choice-mark" />
                <span>
                  <strong>{t("settings.custom")}</strong>
                  <span className="muted">{t("settings.customHint")}</span>
                </span>
              </button>
            </div>
            {mode === "custom" ? (
              <div className="settings-fields">
                <label className="field">
                  <span>{t("settings.url")}</span>
                  <input
                    value={customOrigin}
                    placeholder="https://your-kernel.example"
                    onChange={(event) => setCustomOrigin(event.target.value)}
                  />
                </label>
                <label className="field">
                  <span>{t("settings.personalApiKey")}</span>
                  <input
                    type="password"
                    value={customApiKey}
                    placeholder={
                      hasSavedPersonalApiKey
                        ? t("settings.personalApiKeySaved")
                        : t("settings.personalApiKeyPlaceholder")
                    }
                    autoComplete="off"
                    onChange={(event) => setCustomApiKey(event.target.value)}
                  />
                </label>
              </div>
            ) : null}
            {mode === "custom" && activeOrigin !== customOrigin ? (
              <p className="muted">
                {t("settings.customUnused", { origin: activeOrigin })}
              </p>
            ) : null}
            <div className="settings-footer">
              {error ? <span className="action-error">{error}</span> : <span className="muted">{t("settings.kernelApplyHint")}</span>}
              <span className="install-actions">
                <button type="button" className="ghost" disabled={!kernelDirty || busy} onClick={() => {
                  setMode(savedKernel.mode); setCustomOrigin(savedKernel.customOrigin); setCustomApiKey("");
                }}>{t("settings.revert")}</button>
                <button type="button" className="primary" disabled={!kernelDirty || busy} onClick={() => void apply()}>
                  {busy ? t("settings.applying") : t("settings.apply")}
                </button>
              </span>
            </div>
          </section>

          <section className="card" id="settings-data">
            <h2>{t("settings.store")}</h2>
            <p className="muted">{t("settings.storeLead")}</p>
            <div className="store-footprint">
              <StoreStat
                label={t("settings.storeConversations")}
                value={currentStore.conversations}
              />
              <StoreStat label={t("settings.storeMessages")} value={currentStore.events} />
              <StoreStat label={t("settings.storeWork")} value={currentStore.work_items} />
              <StoreStat label={t("settings.storeBlobs")} value={currentStore.blobs} />
              <StoreStat
                label={t("settings.storeContext")}
                value={contextRecordCount(currentStore)}
                ariaLabel={t("settings.contextOpen")}
                onClick={() => setContextOpen(true)}
              />
            </div>
            {contextOpen ? (
              <ContextRecordsDialog onClose={() => setContextOpen(false)} />
            ) : null}

            <div className="settings-path">
              <div className="settings-path-text">
                <span className="muted">{t("settings.dataDir")}</span>
                <code title={dataDir?.path}>{dataDir?.path || "—"}</code>
              </div>
              {dataPlan ? null : (
                <span className="install-actions">
                  {dataDir?.path ? (
                    <button type="button" className="ghost" onClick={() => void copyPath(dataDir.path)}>
                      {pathCopied ? t("settings.copied") : t("settings.copyPath")}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="ghost"
                    disabled={!dataDir?.canChange || dataBusy}
                    onClick={() => void chooseFolder()}
                  >
                    {dataBusy ? t("settings.dataDirApplying") : t("settings.dataDirBrowse")}
                  </button>
                </span>
              )}
            </div>
            <p className="muted settings-note">{t("settings.dataDirLead")}</p>
            {dataDir?.splitLayout ? (
              <details className="settings-details">
                <summary>{t("settings.dataDirSplitTitle")}</summary>
                <div className="kv">
                  <span>{t("settings.dataDirDatabase")}</span>
                  <strong><code>{dataDir.database}</code></strong>
                </div>
                <div className="kv">
                  <span>{t("settings.dataDirBlobs")}</span>
                  <strong><code>{dataDir.blobRoot}</code></strong>
                </div>
                <p className="muted">{t("settings.dataDirSplit")}</p>
              </details>
            ) : null}
            {dataDir?.source === "relocated" && dataDir.relocatedFrom ? (
              <p className="muted settings-note">
                {t("settings.dataDirFollowed", {
                  path: dataDir.path,
                  from: dataDir.relocatedFrom,
                })}
              </p>
            ) : null}
            {dataDir?.source === "repo" && dataDir.checkoutRoot ? (
              <p className="muted settings-note">
                {t("settings.dataDirCheckout", {
                  checkout: dataDir.checkoutRoot,
                  product: dataDir.productRoot,
                })}
              </p>
            ) : null}
            {dataDir?.envOverride ? (
              <p className="muted settings-note">{t("settings.dataDirEnv")}</p>
            ) : null}
            {dataDir && !dataDir.canChange && !dataDir.envOverride ? (
              <p className="muted settings-note">{t("settings.dataDirCustom")}</p>
            ) : null}
            {dataDir?.remoteWarning || dataPlan?.remoteWarning ? (
              <p className="action-hint">{t("settings.dataDirRemote")}</p>
            ) : null}
            {dataPlan ? (
              <div className="data-dir-confirm">
                <p>
                  {dataPlan.destHasData
                    ? dataPlan.destLooksLikeStore === false
                      ? t("settings.dataDirReasonNotStore")
                      : t("settings.dataDirDestExists")
                    : dataPlan.sourceHasData
                      ? t("settings.dataDirMigrateLead", { path: dataPlan.path })
                      : t("settings.dataDirEmptyLead")}
                </p>
                {dataPlan.destHasData ? (
                  <p className="muted">{t("settings.dataDirReplaceLead")}</p>
                ) : null}
                {dataPlan.relocatedTo ? (
                  <p className="muted">
                    {t("settings.dataDirDestRelocated", { path: dataPlan.relocatedTo })}
                  </p>
                ) : null}
                {dataPlan.pickedPath ? (
                  <p className="muted">
                    {t("settings.dataDirNested", { path: dataPlan.path })}
                  </p>
                ) : null}
                <p className="muted">
                  <code>{dataPlan.path}</code>
                </p>
                <div className="install-actions">
                  <button
                    type="button"
                    className="ghost"
                    disabled={dataBusy}
                    onClick={() => setDataPlan(null)}
                  >
                    {t("settings.storeCancel")}
                  </button>
                  {dataPlan.destHasData ? (
                    <>
                      <button
                        type="button"
                        className="ghost danger"
                        disabled={dataBusy}
                        onClick={() => void commitDataDirectory(dataPlan.path, "replace")}
                      >
                        {t("settings.dataDirReplace")}
                      </button>
                      {dataPlan.destLooksLikeStore !== false ? (
                        <button
                          type="button"
                          className="primary"
                          disabled={dataBusy}
                          onClick={() => void commitDataDirectory(dataPlan.path, "adopt")}
                        >
                          {dataBusy ? t("settings.dataDirApplying") : t("settings.dataDirAdopt")}
                        </button>
                      ) : null}
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="ghost"
                        disabled={dataBusy}
                        onClick={() => void commitDataDirectory(dataPlan.path, "empty")}
                      >
                        {t("settings.dataDirEmpty")}
                      </button>
                      {dataPlan.sourceHasData ? (
                        <button
                          type="button"
                          className="primary"
                          disabled={dataBusy}
                          onClick={() => void commitDataDirectory(dataPlan.path, "migrate")}
                        >
                          {dataBusy
                            ? t("settings.dataDirApplying")
                            : t("settings.dataDirMigrate")}
                        </button>
                      ) : null}
                    </>
                  )}
                </div>
              </div>
            ) : null}
            {dataDone ? <p className="action-ok">{dataDone}</p> : null}
            {dataError ? <p className="action-error">{dataError}</p> : null}
            {sourceRetention?.canDelete ? (
              <div className="data-dir-reclaim">
                <p className="data-dir-reclaim-size">{sourceRetention.size}</p>
                <p>
                  {t("settings.dataDirReclaimLead", { path: sourceRetention.path })}
                </p>
                {reclaimConfirming ? (
                  <>
                    <p className="muted">
                      {t("settings.dataDirReclaimConfirmLead", {
                        size: sourceRetention.size,
                      })}
                    </p>
                    <div className="install-actions">
                      <button
                        type="button"
                        className="ghost"
                        disabled={reclaimBusy}
                        onClick={() => setReclaimConfirming(false)}
                      >
                        {t("settings.storeCancel")}
                      </button>
                      <button
                        type="button"
                        className="primary danger"
                        disabled={reclaimBusy}
                        onClick={() => void resolveRetention("discard")}
                      >
                        {reclaimBusy
                          ? t("settings.dataDirReclaimRemoving")
                          : t("settings.dataDirReclaimConfirm")}
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <p className="muted">{t("settings.dataDirReclaimHint")}</p>
                    <div className="install-actions">
                      <button
                        type="button"
                        className="ghost"
                        disabled={reclaimBusy || dataBusy}
                        onClick={() => void resolveRetention("keep")}
                      >
                        {t("settings.dataDirReclaimKeep")}
                      </button>
                      <button
                        type="button"
                        className="primary"
                        disabled={reclaimBusy || dataBusy}
                        onClick={() => {
                          setDataDone(null);
                          setReclaimConfirming(true);
                        }}
                      >
                        {t("settings.dataDirReclaimRemove", {
                          size: sourceRetention.size,
                        })}
                      </button>
                    </div>
                  </>
                )}
              </div>
            ) : null}
          </section>

          <section className="card danger-zone" id="settings-danger">
            <h2>{t("settings.danger")}</h2>
            <div className="settings-row">
              <div>
                <strong>{t("settings.storeClear")}</strong>
                <p className="muted">{canClear ? t("settings.storeClearHint") : t("settings.storeEmpty")}</p>
              </div>
              {confirming ? null : (
                <button
                  type="button"
                  className="ghost danger"
                  disabled={!canClear || storeBusy}
                  onClick={() => {
                    setStoreDone(null);
                    setConfirming(true);
                  }}
                >
                  {t("settings.storeClear")}
                </button>
              )}
            </div>
            {confirming ? (
              <div className="store-confirm">
                <p>{t("settings.storeConfirmLead")}</p>
                <div className="install-actions">
                  <button
                    type="button"
                    className="ghost"
                    disabled={storeBusy}
                    onClick={() => setConfirming(false)}
                  >
                    {t("settings.storeCancel")}
                  </button>
                  <button
                    type="button"
                    className="primary danger"
                    disabled={storeBusy}
                    onClick={() => void clearLocalData()}
                  >
                    {storeBusy ? t("settings.storeClearing") : t("settings.storeConfirm")}
                  </button>
                </div>
              </div>
            ) : null}
            {storeDone ? <p className="action-ok">{storeDone}</p> : null}
            {storeError ? <p className="action-error">{storeError}</p> : null}
          </section>
        </div>
      </div>
    </div>
  );
}

function StoreStat({
  label,
  value,
  onClick,
  ariaLabel,
}: {
  label: string;
  value: number;
  onClick?: () => void;
  ariaLabel?: string;
}) {
  if (!onClick) {
    return (
      <div className="store-stat">
        <span className="store-stat-value">{value}</span>
        <span className="store-stat-label">{label}</span>
      </div>
    );
  }
  return (
    <button
      type="button"
      className="store-stat"
      aria-label={ariaLabel ?? label}
      onClick={onClick}
    >
      <span className="store-stat-value">{value}</span>
      <span className="store-stat-label">{label}</span>
    </button>
  );
}
