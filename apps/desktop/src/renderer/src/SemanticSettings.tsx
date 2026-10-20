import { useEffect, useRef, useState } from "react";
import { fetchSemanticIndexStatus, indexSemanticOnce, retrySemanticJobs } from "./api";
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
  const operation = useRef<AbortController | null>(null);

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
      operation.current?.abort(); operation.current = null; setBusy(false);
      setRuntime(null); setIndex(null); setPollError(null); setError(null); setIndexResult(null);
      void refresh();
    });
    void refresh();
    return () => { cancelled = true; controller.abort(); operation.current?.abort(); clearTimeout(timer); unsubscribe?.(); };
  }, [t]);

  function message(value: string): string { return isMessageKey(value) ? t(value) : value; }

  async function action(next: SemanticAction) {
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true); setError(null);
    try {
      if (!window.regenic?.semanticAction) throw new Error(t("semantic.localOnly"));
      const nextRuntime = await window.regenic.semanticAction(next);
      if (!controller.signal.aborted) setRuntime(nextRuntime);
    } catch (caught) {
      if (!controller.signal.aborted) setError(caught instanceof Error ? message(caught.message) : t("semantic.failed"));
    }
    finally { if (!controller.signal.aborted) setBusy(false); }
  }

  async function indexAction(generation?: string) {
    if (generation && !window.confirm(t("semantic.retryConfirm"))) return;
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true); setError(null); setIndexResult(null);
    const started = performance.now();
    try {
      const result = generation
        ? t("semantic.retryResult", await retrySemanticJobs(generation, controller.signal))
        : t("semantic.indexResult", await indexSemanticOnce(controller.signal));
      if (controller.signal.aborted) return;
      setIndexResult(`${result} ${t("semantic.actionElapsed", { ms: Math.round(performance.now() - started) })}`);
      const next = await fetchSemanticIndexStatus(AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]));
      if (!controller.signal.aborted) setIndex(next);
    } catch (caught) {
      if (!controller.signal.aborted) setError(caught instanceof Error ? message(caught.message) : t("semantic.failed"));
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  function issue(code: string): string {
    const key = `semantic.issue.${code}`;
    return t(isMessageKey(key) ? key : "semantic.issue.indexing_failed");
  }

  const disabled = busy || runtime?.busy;
  return (
    <section className="card semantic-settings">
      <h2>{t("semantic.title")}</h2>
      <p className="muted">{t("semantic.lead")}</p>
      <p>{t("semantic.prerequisite")}</p>
      {runtime ? <p role="status">{t(`semantic.stage.${runtime.stage}`)}</p> : <p>{t("semantic.localOnly")}</p>}
      <p>{t(index?.configured ? index.healthy ? "semantic.healthy" : "semantic.unhealthy" : "semantic.lexical")}</p>
      {index?.provider_issue ? <p role="status">{issue(index.provider_issue)}</p> : null}
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
          <p className="muted">{t("semantic.recoveryHint")}</p>
          {index.generations.map((generation) => (
            <div key={generation.id} className="semantic-generation">
              <code>{generation.id}</code>{generation.active ? <strong> · {t("semantic.active")}</strong> : null}
              <p>{t("semantic.progress", generation.jobs)}</p>
              {generation.failures?.length ? <ul>{generation.failures.map((failure) => (
                <li key={failure.code}>{issue(failure.code)} {t("semantic.failureCounts", failure)}</li>
              ))}</ul> : null}
              <button type="button" className="ghost"
                disabled={disabled || !index.healthy || index.vector_status !== "ready" ||
                  generation.jobs.failed + generation.jobs.quarantined === 0}
                onClick={() => void indexAction(generation.id)}>{t("semantic.retryJobs")}</button>
            </div>
          ))}
          <button type="button" className="ghost" disabled={disabled || index.vector_status !== "ready"}
            onClick={() => void indexAction()}>{t("semantic.indexNext")}</button>
          {indexResult ? <p role="status">{indexResult}</p> : null}
        </div>
      ) : null}
    </section>
  );
}
