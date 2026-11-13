import { useEffect, useState } from "react";
import { fetchSyncSettings, saveSyncSettings } from "./api";
import { useLocale } from "./LocaleContext";
import {
  fasterSyncSettings,
  sameSyncSettings,
  syncDisplayValue,
  syncModeFor,
  syncSettingsDraft,
  syncSettingsFromDraft,
  type SyncMode,
  type SyncSettingsDraft,
} from "./sync-settings";
import type { PersonalSyncSettings, PersonalSyncSettingsView } from "./types";

const fields = [
  ["quota_tokens", "syncSettings.quotaTokens", "syncSettings.requests", "syncSettings.quotaTokensHelp"],
  ["quota_window_ms", "syncSettings.quotaWindow", "syncSettings.seconds", "syncSettings.quotaWindowHelp"],
  ["installation_concurrency", "syncSettings.installations", "syncSettings.connections", "syncSettings.installationsHelp"],
  ["live_concurrency", "syncSettings.live", "syncSettings.conversations", "syncSettings.liveHelp"],
  ["history_concurrency", "syncSettings.history", "syncSettings.conversations", "syncSettings.historyHelp"],
  ["media_concurrency", "syncSettings.media", "syncSettings.conversations", "syncSettings.mediaHelp"],
  ["first_seed_limit", "syncSettings.firstSeed", "syncSettings.conversations", "syncSettings.firstSeedHelp"],
  ["steady_claim_limit", "syncSettings.steady", "syncSettings.tasks", "syncSettings.steadyHelp"],
  ["bootstrap_claim_limit", "syncSettings.bootstrap", "syncSettings.tasks", "syncSettings.bootstrapHelp"],
] as const;

type Field = (typeof fields)[number];
type Feedback = "saved" | "loadFailed" | "saveFailed";

export function SyncSettings() {
  const { t } = useLocale();
  const [view, setView] = useState<PersonalSyncSettingsView | null>(null);
  const [draft, setDraft] = useState<SyncSettingsDraft | null>(null);
  const [mode, setMode] = useState<SyncMode>("balanced");
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    setFeedback(null);
    void fetchSyncSettings().then((next) => {
      if (!current) return;
      setView(next);
      setDraft(syncSettingsDraft(next.settings));
      setMode(syncModeFor(next));
    }).catch(() => {
      if (current) setFeedback("loadFailed");
    });
    return () => { current = false; };
  }, [loadAttempt]);

  const dirty = Boolean(view && draft &&
    ((mode === "balanced" && view.customized) ||
      fields.some(([key]) => draft[key] !== String(syncDisplayValue(key, view.settings[key])))));
  const busy = saving;
  const savedMode = view ? syncModeFor(view) : "balanced";
  const canSpeedUp = Boolean(view && !sameSyncSettings(fasterSyncSettings(view), view.defaults));

  const chooseMode = (next: "balanced" | "faster") => {
    if (!view) return;
    setMode(next);
    setDraft(syncSettingsDraft(next === "balanced" ? view.defaults : fasterSyncSettings(view)));
    setFeedback(null);
  };

  const discard = () => {
    if (!view) return;
    setDraft(syncSettingsDraft(view.settings));
    setMode(savedMode);
    setFeedback(null);
  };

  const save = async (settings: PersonalSyncSettings | null) => {
    setSaving(true);
    setFeedback(null);
    try {
      const next = await saveSyncSettings(settings);
      setView(next);
      setDraft(syncSettingsDraft(next.settings));
      setMode(syncModeFor(next));
      setFeedback("saved");
    } catch {
      setFeedback("saveFailed");
    } finally {
      setSaving(false);
    }
  };

  const renderField = ([key, label, unit, help]: Field) => {
    if (!view || !draft) return null;
    const id = `sync-${key}`;
    const min = syncDisplayValue(key, view.ranges[key][0]);
    const max = syncDisplayValue(key, view.ranges[key][1]);
    return (
      <div className="sync-setting-field" key={key}>
        <label htmlFor={id}>{t(label)}</label>
        <div className="sync-setting-control">
          <input id={id} type="number" required
            step={key === "quota_window_ms" ? 0.001 : 1}
            min={min} max={max} value={draft[key]}
            aria-describedby={`${id}-hint ${id}-range`}
            onChange={(event) => {
              setDraft({ ...draft, [key]: event.target.value });
              setMode("custom");
              setFeedback(null);
            }} />
          <span aria-hidden="true">{t(unit)}</span>
        </div>
        <p className="sync-setting-help" id={`${id}-hint`}>{t(help)}</p>
        <span className="sync-setting-hint" id={`${id}-range`}>
          {t("syncSettings.default", { value: syncDisplayValue(key, view.defaults[key]) })}
          <span className="sync-setting-range">{min}–{max} {t(unit)}</span>
        </span>
      </div>
    );
  };

  return (
    <section className="card sync-settings" id="settings-sync">
      <div className="card-head">
        <h2>{t("syncSettings.title")}</h2>
        {dirty ? <span className="chip syncing">{t("settings.unsaved")}</span> : null}
      </div>
      <p className="muted sync-settings-lead">{t("syncSettings.lead")}</p>
      {view && draft ? (
        <form onSubmit={(event) => {
          event.preventDefault();
          void save(mode === "balanced" ? null : syncSettingsFromDraft(draft));
        }} aria-busy={busy}>
          <p className="sync-settings-current">
            {t("syncSettings.currentMode", {
              mode: t(savedMode === "balanced" ? "syncSettings.balanced" : savedMode === "faster" ? "syncSettings.faster" : "syncSettings.customized"),
            })}
          </p>
          <fieldset className="sync-settings-group sync-settings-modes" disabled={busy}>
            <legend>{t("syncSettings.speed")}</legend>
            <div className="sync-mode-options">
              {(["balanced", "faster"] as const).map((value) => (
                <label key={value} className={`sync-mode-option${mode === value ? " selected" : ""}${value === "faster" && !canSpeedUp ? " unavailable" : ""}`}>
                  <input type="radio" name="sync-speed" value={value}
                    checked={mode === value} disabled={value === "faster" && !canSpeedUp}
                    aria-describedby={`sync-mode-${value}-description`}
                    onChange={() => chooseMode(value)} />
                  <span className="sync-mode-content">
                    <span className="sync-mode-title">
                      {t(value === "balanced" ? "syncSettings.balanced" : "syncSettings.faster")}
                      {value === "balanced" ? <span className="sync-mode-recommended">{t("syncSettings.recommended")}</span> : null}
                    </span>
                    <span className="sync-mode-description" id={`sync-mode-${value}-description`}>
                      {t(value === "balanced" ? "syncSettings.balancedDescription" : canSpeedUp ? "syncSettings.fasterDescription" : "syncSettings.fasterUnavailable")}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          {mode === "custom" ? (
            <p className="sync-settings-custom" role="status">
              <strong>{t("syncSettings.customized")}</strong>
              <span>{t("syncSettings.customHint")}</span>
            </p>
          ) : null}
          <p className="sync-settings-expectation">
            {t(mode === "faster" ? "syncSettings.fasterHint" : mode === "custom" ? "syncSettings.customExpectation" : "syncSettings.balancedHint")}
          </p>
          <details className="sync-settings-advanced"
            onInvalidCapture={(event) => { event.currentTarget.open = true; }}>
            <summary>
              <span>{t("syncSettings.advanced")}</span>
              <span className="muted">{t("syncSettings.advancedSummary")}</span>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="m6 4 4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </summary>
            <div className="sync-settings-advanced-body">
              <p className="sync-settings-description">{t("syncSettings.advancedHint")}</p>
              <fieldset className="sync-settings-group" disabled={busy}>
                <legend>{t("syncSettings.quotaGroup")}</legend>
                <p className="sync-settings-description">{t("syncSettings.quotaHint")}</p>
                <div className="sync-settings-fields">{fields.slice(0, 2).map(renderField)}</div>
              </fieldset>
              <fieldset className="sync-settings-group" disabled={busy}>
                <legend>{t("syncSettings.concurrencyGroup")}</legend>
                <p className="sync-settings-description">{t("syncSettings.concurrencyHint")}</p>
                <div className="sync-settings-fields">{fields.slice(2, 6).map(renderField)}</div>
              </fieldset>
              <fieldset className="sync-settings-group" disabled={busy}>
                <legend>{t("syncSettings.batchGroup")}</legend>
                <p className="sync-settings-description">{t("syncSettings.batchHint")}</p>
                <div className="sync-settings-fields">{fields.slice(6).map(renderField)}</div>
              </fieldset>
              <p className="sync-settings-notice">{t("syncSettings.warning")}</p>
            </div>
          </details>
          {feedback === "saveFailed" ? <p className="action-error" role="alert">{t("syncSettings.saveFailed")}</p> : null}
          <div className="sync-settings-footer">
            <button type="button" className="sync-settings-reset" disabled={busy || mode === "balanced"}
              onClick={() => chooseMode("balanced")}>
              {t("syncSettings.reset")}
            </button>
            <div className="sync-settings-save">
              <span className={feedback === "saved" ? "action-ok" : "muted"} role="status">
                {t(feedback === "saved" ? "syncSettings.saved" : dirty ? "syncSettings.pendingHint" : "syncSettings.effectiveHint")}
              </span>
              {dirty ? <button type="button" disabled={busy} onClick={discard}>
                {t("syncSettings.discard")}
              </button> : null}
              <button type="submit" className="primary" disabled={busy || !dirty}>
                {t(busy ? "syncSettings.saving" : "syncSettings.save")}
              </button>
            </div>
          </div>
        </form>
      ) : feedback === "loadFailed" ? (
        <div className="sync-settings-load">
          <p className="action-error" role="alert">{t("syncSettings.loadFailed")}</p>
          <button type="button" className="secondary" onClick={() => setLoadAttempt((attempt) => attempt + 1)}>
            {t("syncSettings.retry")}
          </button>
        </div>
      ) : <p className="muted sync-settings-loading" role="status">{t("syncSettings.loading")}</p>}
    </section>
  );
}
