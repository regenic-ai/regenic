import { useEffect, useRef, useState } from "react";
import { fetchSemanticIndexStatus, indexSemanticOnce, retrySemanticJobs } from "./api";
import { useLocale } from "./LocaleContext";
import { isMessageKey } from "../../shared/messages";
import type { SemanticAction, SemanticRuntimeView, SemanticStage } from "../../shared/semantic-runtime";
import type { SemanticIndexStatus } from "./types";

type Generation = SemanticIndexStatus["generations"][number];

const transitional: SemanticStage[] = ["checking_python", "installing", "downloading", "starting", "stopping"];

function stageTone(runtime: SemanticRuntimeView | null, index: SemanticIndexStatus | null): string {
  if (runtime) {
    if (runtime.stage === "error") return "error";
    if (transitional.includes(runtime.stage)) return "syncing";
    if (runtime.stage === "running") return index && index.configured && !index.healthy ? "error" : "running";
    return "";
  }
  if (!index?.configured) return "";
  return index.healthy ? "running" : "error";
}

function GenerationProgress({ generation, disabled, canRetry, onRetry }: {
  generation: Generation;
  disabled: boolean;
  canRetry: boolean;
  onRetry: () => void;
}) {
  const { t } = useLocale();
  const { pending, running, succeeded, failed, quarantined, superseded } = generation.jobs;
  const skipped = generation.jobs.skipped ?? 0;
  const total = pending + running + succeeded + failed + quarantined;
  const percent = total === 0 ? 100 : Math.floor((succeeded / total) * 100);
  const needsAttention = failed + quarantined;
  const stats = [
    ["semantic.stat.succeeded", succeeded, ""],
    ["semantic.stat.pending", pending, ""],
    ["semantic.stat.running", running, running > 0 ? "is-live" : ""],
    ["semantic.stat.failed", failed, failed > 0 ? "is-risk" : ""],
    ["semantic.stat.quarantined", quarantined, quarantined > 0 ? "is-risk" : ""],
  ] as const;
  return (
    <div className={`semantic-generation${generation.active ? " is-active" : ""}`}>
      <div className="semantic-generation-head">
        <span className="semantic-coverage">
          {t("semantic.coverage", { succeeded, total, percent })}
        </span>
        <span className="semantic-generation-id">
          <code title={generation.id}>{generation.id.slice(0, 12)}</code>
          {generation.active ? <span className="chip running">{t("semantic.active")}</span> : null}
        </span>
      </div>
      <div className="semantic-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
        <span style={{ width: `${percent}%` }} />
      </div>
      <dl className="semantic-stats">
        {stats.map(([label, value, tone]) => (
          <div key={label} className={tone}>
            <dt>{t(label)}</dt>
            <dd>{value.toLocaleString()}</dd>
          </div>
        ))}
      </dl>
      {superseded > 0 ? <p className="muted semantic-note">{t("semantic.supersededNote", { superseded })}</p> : null}
      {skipped > 0 ? <p className="muted semantic-note">{t("semantic.skippedNote", { skipped })}</p> : null}
      {needsAttention > 0 ? (
        <div className="semantic-attention">
          <strong>{t("semantic.attentionTitle", { count: needsAttention })}</strong>
          {generation.failures?.length ? (
            <ul>
              {generation.failures.map((failure) => (
                <li key={failure.code}>
                  <IssueText code={failure.code} />
                  <span className="muted"> {t("semantic.failureCounts", failure)}</span>
                </li>
              ))}
            </ul>
          ) : null}
          <p className="muted semantic-note">{t("semantic.recoveryHint")}</p>
          <button type="button" className="ghost" disabled={disabled || !canRetry} onClick={onRetry}>
            {t("semantic.retryJobs")}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function IssueText({ code }: { code: string }) {
  const { t } = useLocale();
  const key = `semantic.issue.${code}`;
  return <>{t(isMessageKey(key) ? key : "semantic.issue.indexing_failed")}</>;
}

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
      if (!controller.signal.aborted) { setRuntime(nextRuntime); setConsent(false); }
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

  const disabled = busy || Boolean(runtime?.busy);
  const running = runtime?.stage === "running";
  const working = runtime ? transitional.includes(runtime.stage) : false;
  const tone = stageTone(runtime, index);
  const statusLabel = runtime
    ? t(`semantic.stage.${runtime.stage}`)
    : t(index?.configured ? index.healthy ? "semantic.provider.healthy" : "semantic.provider.unhealthy" : "semantic.provider.off");
  const providerHint = index?.configured
    ? index.healthy ? null : t("semantic.unhealthy")
    : runtime?.enabled ? null : t("semantic.lexical");
  const vectorsReady = index?.vector_status === "ready";
  const canRetry = Boolean(index?.healthy) && vectorsReady;

  const consentBox = (
    <label className="semantic-consent">
      <input type="checkbox" checked={consent} disabled={disabled || running}
        onChange={(event) => setConsent(event.target.checked)} />
      <span>{t("semantic.consent")}</span>
    </label>
  );
  const installButton = (primary: boolean) => (
    <button type="button" className={primary ? "primary" : "ghost"}
      disabled={disabled || !consent || running}
      onClick={() => void action("install")}>{t(runtime?.installed ? "semantic.reinstall" : "semantic.install")}</button>
  );

  return (
    <section className="card semantic-settings">
      <div className="card-head">
        <h2>{t("semantic.title")}</h2>
        <span className={`chip ${tone}`} role="status">
          <span className="dot" />{statusLabel}
        </span>
      </div>
      <p className="muted">{t("semantic.lead")}</p>

      {runtime?.error ? <p className="action-error" role="alert">{message(runtime.error)}</p> : null}
      {error ? <p className="action-error" role="alert">{message(error)}</p> : null}
      {pollError ? <p className="action-error" role="alert">{message(pollError)}</p> : null}
      {index?.provider_issue ? <p className="action-hint" role="status"><IssueText code={index.provider_issue} /></p> : null}
      {providerHint && !working ? <p className="muted semantic-note">{providerHint}</p> : null}

      {runtime?.canManage ? (
        runtime.installed ? (
          <>
            <div className="semantic-actions">
              {running ? null : (
                <button type="button" className="primary" disabled={disabled}
                  onClick={() => void action("start")}>{t(runtime.enabled ? "semantic.restart" : "semantic.start")}</button>
              )}
              {running || runtime.enabled ? (
                <button type="button" className="ghost" disabled={disabled}
                  onClick={() => void action("stop")}>{t("semantic.stop")}</button>
              ) : null}
              <span className="muted semantic-note">{t("semantic.restartNotice")}</span>
            </div>
            <details className="semantic-details">
              <summary>{t("semantic.maintenance")}</summary>
              <p className="muted semantic-note">{t(running ? "semantic.stopFirst" : "semantic.prerequisite")}</p>
              {consentBox}
              <div className="semantic-actions">{installButton(false)}</div>
            </details>
          </>
        ) : (
          <div className="semantic-setup">
            <p className="semantic-note">{t("semantic.prerequisite")}</p>
            {consentBox}
            <div className="semantic-actions">{installButton(true)}</div>
          </div>
        )
      ) : <p className="muted semantic-note">{t("semantic.localOnly")}</p>}

      {index?.configured ? (
        <div className="semantic-index">
          <div className="card-head">
            <h3>{t("semantic.index")}</h3>
            <button type="button" className="ghost" disabled={disabled || !vectorsReady}
              title={t("semantic.indexHint")}
              onClick={() => void indexAction()}>{t("semantic.indexNext")}</button>
          </div>
          <p className="muted semantic-note">{t("semantic.indexAuto")}</p>
          {indexResult ? <p className="action-ok" role="status">{indexResult}</p> : null}
          {index.generations.map((generation) => (
            <GenerationProgress key={generation.id} generation={generation}
              disabled={disabled} canRetry={canRetry}
              onRetry={() => void indexAction(generation.id)} />
          ))}
        </div>
      ) : null}
    </section>
  );
}
