import { useEffect, useState } from "react";
import {
  applyKernelSettings,
  clearStore,
  currentApiOrigin,
  fetchKernelSettings,
  fetchStore,
} from "./api";
import { useLocale } from "./LocaleContext";
import type { KernelMode, Locale, StoreView } from "./types";

const emptyStore: StoreView = {
  events: 0,
  conversations: 0,
  work_items: 0,
  blobs: 0,
  recipes: 0,
  connectors: 0,
  executors: 0,
};

function storeHasData(store: StoreView): boolean {
  return (
    store.events > 0 ||
    store.conversations > 0 ||
    store.work_items > 0 ||
    store.blobs > 0
  );
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
  const [activeOrigin, setActiveOrigin] = useState(currentApiOrigin());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [store, setStore] = useState<StoreView | null>(null);
  const [storeBusy, setStoreBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [storeError, setStoreError] = useState<string | null>(null);
  const [storeDone, setStoreDone] = useState<string | null>(null);

  useEffect(() => {
    void fetchKernelSettings()
      .then((settings) => {
        setMode(settings.mode);
        setCustomOrigin(settings.customOrigin);
        setActiveOrigin(settings.activeOrigin);
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
      });
      setMode(settings.mode);
      setCustomOrigin(settings.customOrigin);
      setActiveOrigin(settings.activeOrigin);
      await onChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("settings.applyError"));
    } finally {
      setBusy(false);
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

  return (
    <div className="page page-wide">
      <header className="page-hero">
        <h1>{t("settings.title")}</h1>
        <p className="page-lead">{t("settings.lead")}</p>
      </header>

      <section className="card">
        <h2>{t("settings.language")}</h2>
        <p className="muted">{t("settings.languageLead")}</p>
        <div className="choice-list language-choices">
          <button
            type="button"
            className={`choice${locale === "en" ? " active" : ""}`}
            onClick={() => chooseLocale("en")}
          >
            <span className="choice-mark" />
            <span>
              <strong>{t("settings.english")}</strong>
              <span className="muted">{t("settings.englishHint")}</span>
            </span>
          </button>
          <button
            type="button"
            className={`choice${locale === "zh" ? " active" : ""}`}
            onClick={() => chooseLocale("zh")}
          >
            <span className="choice-mark" />
            <span>
              <strong>{t("settings.chinese")}</strong>
              <span className="muted">{t("settings.chineseHint")}</span>
            </span>
          </button>
        </div>
      </section>

      <section className="card">
        <h2>{t("settings.kernel")}</h2>
        <div className="kv">
          <span>{t("settings.inUse")}</span>
          <strong>
            <code>{activeOrigin}</code>
          </strong>
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
          <label className="field">
            <span>{t("settings.url")}</span>
            <input
              value={customOrigin}
              placeholder="http://127.0.0.1:4370"
              onChange={(event) => setCustomOrigin(event.target.value)}
            />
          </label>
        ) : null}
        {mode === "custom" && activeOrigin !== customOrigin ? (
          <p className="muted">
            {t("settings.customUnused", { origin: activeOrigin })}
          </p>
        ) : null}
        <div className="install-actions">
          <button type="button" className="primary" disabled={busy} onClick={() => void apply()}>
            {busy ? t("settings.applying") : t("settings.apply")}
          </button>
        </div>
        {error ? <p className="action-error">{error}</p> : null}
      </section>

      <section className="card">
        <h2>{t("settings.store")}</h2>
        <p className="muted">{t("settings.storeLead")}</p>
        <div className="kv">
          <span>{t("settings.storeKernel")}</span>
          <strong>
            <code>{activeOrigin}</code>
          </strong>
        </div>
        <div className="store-footprint">
          <StoreStat
            label={t("settings.storeConversations")}
            value={currentStore.conversations}
          />
          <StoreStat label={t("settings.storeMessages")} value={currentStore.events} />
          <StoreStat label={t("settings.storeWork")} value={currentStore.work_items} />
          <StoreStat label={t("settings.storeBlobs")} value={currentStore.blobs} />
        </div>
        {!canClear ? <p className="muted">{t("settings.storeEmpty")}</p> : null}
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
        ) : (
          <div className="install-actions">
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
          </div>
        )}
        {storeDone ? <p className="action-ok">{storeDone}</p> : null}
        {storeError ? <p className="action-error">{storeError}</p> : null}
      </section>
    </div>
  );
}

function StoreStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="store-stat">
      <span className="store-stat-value">{value}</span>
      <span className="store-stat-label">{label}</span>
    </div>
  );
}
