import { useEffect, useState } from "react";
import { fetchSemanticIndexStatus, indexSemanticOnce } from "./api";
import { useLocale } from "./LocaleContext";
import { isMessageKey } from "../../shared/messages";
import type { SemanticAction, SemanticRuntimeView } from "../../shared/semantic-runtime";
import type { SemanticIndexStatus } from "./types";

export function SemanticSettings() {
  const { t } = useLocale();
  const [runtime, setRuntime] = useState<SemanticRuntimeView | null>(null);
  const [index, setIndex] = useState<SemanticIndexStatus | null>(null);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [indexResult, setIndexResult] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    let controller = new AbortController();
    const refresh = async () => {
      clearTimeout(timer);
      controller.abort();
      controller = new AbortController();
      const current = controller;
      try {
        const [local, next] = await Promise.all([
          window.regenic?.getSemanticRuntime?.() ?? Promise.resolve(null),
          fetchSemanticIndexStatus(AbortSignal.any([current.signal, AbortSignal.timeout(10_000)])),
        ]);
        if (!cancelled && !current.signal.aborted) { setRuntime(local); setIndex(next); setPollError(null); }
      } catch (caught) {
        if (!cancelled && !current.signal.aborted) setPollError(caught instanceof Error ? caught.message : t("semantic.failed"));
      } finally {
        if (!cancelled && !current.signal.aborted) timer = setTimeout(() => void refresh(), 2000);
      }
    };
    const unsubscribe = window.regenic?.onApiOriginChanged(() => {
      setRuntime(null); setIndex(null); setPollError(null); setError(null); setIndexResult(null);
      void refresh();
    });
    void refresh();
    return () => { cancelled = true; controller.abort(); clearTimeout(timer); unsubscribe?.(); };
  }, [t]);

  function message(value: string): string { return isMessageKey(value) ? t(value) : value; }

  async function action(next: SemanticAction) {
    setBusy(true); setError(null);
    try {
      if (!window.regenic?.semanticAction) throw new Error(t("semantic.localOnly"));
      setRuntime(await window.regenic.semanticAction(next));
    } catch (caught) { setError(caught instanceof Error ? message(caught.message) : t("semantic.failed")); }
    finally { setBusy(false); }
  }

  const disabled = busy || runtime?.busy;
  return (
    <section className="card semantic-settings">
      <h2>{t("semantic.title")}</h2>
      <p className="muted">{t("semantic.lead")}</p>
      <p>{t("semantic.prerequisite")}</p>
      {runtime ? <p role="status">{t(`semantic.stage.${runtime.stage}`)}</p> : <p>{t("semantic.localOnly")}</p>}
      <p>{t(index?.configured ? index.healthy ? "semantic.healthy" : "semantic.unhealthy" : "semantic.lexical")}</p>
      {runtime?.error ? <p className="action-error" role="alert">{message(runtime.error)}</p> : null}
      {error ? <p className="action-error" role="alert">{message(error)}</p> : null}
      {pollError ? <p className="action-error" role="alert">{message(pollError)}</p> : null}
      {runtime?.canManage ? (
        <>
          <label className="semantic-consent"><input type="checkbox" checked={consent}
            disabled={disabled || runtime.stage === "running"}
            onChange={(event) => setConsent(event.target.checked)} />{t("semantic.consent")}</label>
          <div className="semantic-actions">
            <button type="button" className="ghost" disabled={disabled || !consent || runtime.stage === "running"}
              onClick={() => void action("install")}>{t(runtime.installed ? "semantic.reinstall" : "semantic.install")}</button>
            <button type="button" className="primary" disabled={disabled || !runtime.installed || runtime.stage === "running"}
              onClick={() => void action("start")}>{t("semantic.start")}</button>
            <button type="button" className="ghost" disabled={disabled || (!runtime.enabled && runtime.stage !== "running")}
              onClick={() => void action("stop")}>{t("semantic.stop")}</button>
          </div>
        </>
      ) : <p className="muted">{t("semantic.localOnly")}</p>}
      <p className="muted">{t("semantic.restartNotice")}</p>
      {index?.configured ? (
        <div>
          <h3>{t("semantic.index")}</h3>
          <p className="muted">{t("semantic.indexHint")}</p>
          {index.generations.map((generation) => (
            <div key={generation.id} className="semantic-generation">
              <code>{generation.id}</code>{generation.active ? <strong> · {t("semantic.active")}</strong> : null}
              <p>{t("semantic.progress", generation.jobs)}</p>
            </div>
          ))}
          <button type="button" className="ghost" disabled={disabled || index.vector_status !== "ready"}
            onClick={() => {
              setBusy(true); setError(null);
              void indexSemanticOnce().then((result) => setIndexResult(t("semantic.indexResult", result)))
                .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : t("semantic.failed")))
                .finally(() => setBusy(false));
            }}>{t("semantic.indexNext")}</button>
          {indexResult ? <p role="status">{indexResult}</p> : null}
        </div>
      ) : null}
    </section>
  );
}
