import { useEffect, useState } from "react";
import {
  applyKernelSettings,
  currentApiOrigin,
  fetchKernelSettings,
} from "./api";
import { useLocale } from "./LocaleContext";
import type { KernelMode, Locale } from "./types";

export function SettingsPage({ onChanged }: { onChanged: () => Promise<void> }) {
  const { locale, setLocale, t } = useLocale();
  const [mode, setMode] = useState<KernelMode>("local");
  const [customOrigin, setCustomOrigin] = useState("http://127.0.0.1:4370");
  const [activeOrigin, setActiveOrigin] = useState(currentApiOrigin());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    </div>
  );
}
