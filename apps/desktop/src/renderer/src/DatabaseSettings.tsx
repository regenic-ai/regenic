import { useEffect, useState } from "react";
import type { DatabaseDriver, DatabaseSettingsView } from "../../shared/database-settings";
import { isMessageKey } from "../../shared/messages";
import { useLocale } from "./LocaleContext";
import { InfoTip } from "./InfoTip";

export function DatabaseSettings({ engineMode, onChanged }: {
  engineMode: "local" | "custom";
  onChanged: () => Promise<void>;
}) {
  const { t } = useLocale();
  const [saved, setSaved] = useState<DatabaseSettingsView | null>(null);
  const [driver, setDriver] = useState<DatabaseDriver>("sqlite");
  const [connectionString, setConnectionString] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const dirty = saved && (driver !== saved.driver ||
    (driver === "postgres" && connectionString.trim() !== ""));
  const ready = saved?.canChange && (driver === "sqlite" ||
    connectionString.trim() !== "" || saved.hasSavedConnection);

  const showError = (caught: unknown) => {
    const key = caught instanceof Error ? caught.message : "";
    setError(isMessageKey(key) ? t(key) : t("database.operationFailed"));
  };

  useEffect(() => {
    let cancelled = false;
    if (!window.regenic?.getDatabaseSettings) {
      setError(t("database.desktopOnly"));
      return;
    }
    void window.regenic.getDatabaseSettings().then((view) => {
      if (!cancelled) {
        setSaved(view);
        setDriver(view.driver);
      }
    }).catch((caught: unknown) => {
      if (!cancelled) showError(caught);
    });
    return () => { cancelled = true; };
  }, [t, engineMode]);

  const testConnection = async () => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      if (!window.regenic?.testDatabaseSettings) throw new Error("database.desktopOnly");
      await window.regenic.testDatabaseSettings(connectionString.trim() || undefined);
      setMessage(t("database.testSucceeded"));
    } catch (caught) {
      showError(caught);
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      if (!window.regenic?.setDatabaseSettings) throw new Error("database.desktopOnly");
      const view = await window.regenic.setDatabaseSettings({
        driver,
        connectionString: driver === "postgres" ? connectionString.trim() || undefined : undefined,
        confirmed: true,
      });
      setSaved(view);
      setDriver(view.driver);
      setConnectionString("");
      setConfirming(false);
      try {
        await onChanged();
      } catch {
        throw new Error("database.refreshFailed");
      }
      setMessage(t("database.applied"));
    } catch (caught) {
      showError(caught);
    } finally {
      setBusy(false);
    }
  };

  const choose = (next: DatabaseDriver) => {
    setDriver(next);
    setConfirming(false);
    setMessage(null);
    setError(null);
  };

  return (
    <section className="card" id="settings-database">
      <div className="card-head">
        <h2 className="settings-heading">{t("database.title")}
          <InfoTip label={t("database.title")}>
            <p>{t("database.lead")}</p>
            <p>{t("database.applyHint")}</p>
          </InfoTip>
        </h2>
        {dirty ? <span className="chip syncing">{t("settings.unsaved")}</span> : null}
      </div>
      {saved ? (
        <div className="settings-current">
          <span className="muted">{t("settings.inUse")}</span>
          <strong>{saved.driver === "sqlite" ? "SQLite" : "PostgreSQL"}</strong>
          {saved.driver === "postgres" && saved.connectionLabel ? (
            <code>{saved.connectionLabel}</code>
          ) : null}
        </div>
      ) : null}
      <div className="choice-list" role="radiogroup" aria-label={t("database.title")}>
        <div className="choice-with-info">
          <button type="button" role="radio" aria-checked={driver === "sqlite"}
            aria-describedby="database-sqlite-hint"
            className={`choice${driver === "sqlite" ? " active" : ""}`}
            disabled={!saved?.canChange || busy} onClick={() => choose("sqlite")}>
            <span className="choice-mark" />
            <span><strong>{t("database.sqlite")}</strong></span>
          </button>
          <InfoTip label="SQLite" id="database-sqlite-hint">{t("database.sqliteHint")}</InfoTip>
        </div>
        <div className="choice-with-info">
          <button type="button" role="radio" aria-checked={driver === "postgres"}
            aria-describedby="database-postgres-hint"
            className={`choice${driver === "postgres" ? " active" : ""}`}
            disabled={!saved?.canChange || busy} onClick={() => choose("postgres")}>
            <span className="choice-mark" />
            <span><strong>PostgreSQL</strong></span>
          </button>
          <InfoTip label="PostgreSQL" id="database-postgres-hint">
            <p>{t("database.postgresHint")}</p>
            <p>{t("database.postgresLimit")}</p>
          </InfoTip>
        </div>
      </div>
      {driver === "postgres" ? (
        <div className="settings-fields">
          <div className="field">
            <span className="settings-label">
              <label htmlFor="database-connection">{t("database.connection")}</label>
              <InfoTip label={t("database.connection")} id="database-connection-hint">
                {t("database.connectionHint")}
              </InfoTip>
            </span>
            <input id="database-connection" type="password" value={connectionString} autoComplete="off"
              aria-describedby="database-connection-hint"
              spellCheck={false} disabled={!saved?.canChange || busy}
              placeholder={saved?.hasSavedConnection
                ? t("database.connectionSaved") : "postgresql://user:password@host:5432/database"}
              onChange={(event) => {
                setConnectionString(event.target.value);
                setConfirming(false);
                setMessage(null);
              }} />
          </div>
          <div className="install-actions">
            <button type="button" className="ghost" disabled={!ready || busy}
              onClick={() => void testConnection()}>
              {busy ? t("database.working") : t("database.test")}
            </button>
          </div>
        </div>
      ) : null}
      {saved && !saved.canChange ? (
        <p className="muted settings-note">{t("database.localOnly")}</p>
      ) : null}
      {confirming ? (
        <div role="alert" className="settings-fields">
          <strong>{t("database.confirmTitle")}</strong>
          <p>{t("database.confirmHint")}</p>
          <div className="install-actions">
            <button type="button" className="ghost" disabled={busy}
              onClick={() => setConfirming(false)}>{t("database.cancel")}</button>
            <button type="button" className="primary" disabled={!ready || busy}
              onClick={() => void apply()}>
              {busy ? t("database.working") : t("database.confirmApply")}
            </button>
          </div>
        </div>
      ) : null}
      <div className="settings-footer">
        {error ? <span className="action-error" role="alert">{error}</span> : (
          <span className="muted" role="status">{message}</span>
        )}
        <span className="install-actions">
          <button type="button" className="ghost" disabled={!dirty || busy} onClick={() => {
            if (saved) setDriver(saved.driver);
            setConnectionString("");
            setConfirming(false);
            setError(null);
            setMessage(null);
          }}>{t("settings.revert")}</button>
          <button type="button" className="primary" disabled={!dirty || !ready || busy || confirming}
            onClick={() => { setConfirming(true); setError(null); }}>
            {t("settings.apply")}
          </button>
        </span>
      </div>
    </section>
  );
}
