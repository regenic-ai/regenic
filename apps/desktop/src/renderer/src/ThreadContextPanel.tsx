import { useEffect, useRef, useState } from "react";
import { assemblePersonalContext, replayPersonalContext } from "./api";
import { MessageBody } from "./MessageBody";
import { useLocale } from "./LocaleContext";
import type { PersonalContextBundle, PersonalContextSnapshot } from "./types";

type ContextState = {
  snapshot: PersonalContextSnapshot;
  bundle: PersonalContextBundle;
  mode: "fresh" | "replayed";
  loadedAt: string;
  sourceRevision: string;
};

export function ThreadContextPanel({
  threadId,
  sourceRevision,
  onLocateEvidence,
}: {
  threadId: string;
  sourceRevision: string;
  onLocateEvidence: (eventId: string) => boolean;
}) {
  const { t } = useLocale();
  const [context, setContext] = useState<ContextState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [evidenceNotice, setEvidenceNotice] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const historyRef = useRef(new Map<string, ContextState[]>());

  useEffect(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setContext(null);
    setBusy(false);
    setError(null);
    setEvidenceNotice(null);
    return () => abortRef.current?.abort();
  }, [threadId]);

  const remember = (next: ContextState) => {
    const history = historyRef.current.get(threadId) ?? [];
    historyRef.current.set(threadId, [next, ...history.filter((entry) => entry.snapshot.id !== next.snapshot.id)].slice(0, 8));
  };

  const start = async (mode: "fresh" | "replayed") => {
    const snapshotId = context?.snapshot.id;
    if (busy || (mode === "replayed" && !snapshotId)) {
      return;
    }
    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;
    setBusy(true);
    setError(null);
    try {
      if (mode === "fresh") {
        const result = await assemblePersonalContext(threadId, controller.signal);
        if (!controller.signal.aborted) {
          const next = { ...result, mode, loadedAt: new Date().toISOString(), sourceRevision };
          remember(next);
          setContext(next);
        }
      } else {
        const bundle = await replayPersonalContext(snapshotId!, controller.signal);
        if (!controller.signal.aborted) {
          setContext((current) => current && {
            ...current,
            bundle,
            mode,
            loadedAt: new Date().toISOString(),
          });
        }
      }
    } catch (caught) {
      if (!controller.signal.aborted) {
        setError(caught instanceof Error ? caught.message : t("thread.contextError"));
      }
    } finally {
      if (!controller.signal.aborted) {
        setBusy(false);
      }
    }
  };

  const history = historyRef.current.get(threadId) ?? [];
  const stale = Boolean(context && context.sourceRevision !== sourceRevision);
  const locateEvidence = (eventId: string) => {
    setEvidenceNotice(onLocateEvidence(eventId) ? null : t("thread.contextEvidenceUnavailable"));
  };

  return (
    <section className="thread-context" aria-label={t("thread.contextTitle")}>
      <div className="thread-context-head">
        <div>
          <h2>{t("thread.contextTitle")}</h2>
          <p>{context ? t(stale ? "thread.contextStale" : context.mode === "replayed" ? "thread.contextReplayed" : "thread.contextFresh") : t("thread.contextLead")}</p>
        </div>
        <button
          type="button"
          className="ghost"
          disabled={busy}
          onClick={() => void start("fresh")}
        >
          {busy ? t("thread.contextLoading") : t(context ? "thread.contextRefresh" : "thread.contextGenerate")}
        </button>
      </div>
      {error ? <p className="action-error" role="alert">{error}</p> : null}
      {evidenceNotice ? <p className="action-hint" role="status">{evidenceNotice}</p> : null}
      {!context ? null : (
        <div className="thread-context-result">
          <div className="thread-context-meta">
            <span>{t("thread.contextSnapshot", { id: context.snapshot.id.slice(0, 12) })}</span>
            <span>{t("thread.contextHash", { hash: context.bundle.content_hash.slice(0, 12) })}</span>
          </div>
          {history.length > 1 ? (
            <label className="thread-context-history">
              {t("thread.contextHistory")}
              <select
                value={context.snapshot.id}
                onChange={(event) => {
                  const selected = history.find((entry) => entry.snapshot.id === event.target.value);
                  if (selected) {
                    setContext(selected);
                  }
                }}
              >
                {history.map((entry) => (
                  <option key={entry.snapshot.id} value={entry.snapshot.id}>
                    {entry.snapshot.id.slice(0, 12)}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {context.bundle.sections.flatMap((section) => section.items).length === 0 ? (
            <p className="muted">{t("thread.contextEmpty")}</p>
          ) : context.bundle.sections.map((section) => (
            <div className="thread-context-section" key={section.kind}>
              <h3>{section.kind}</h3>
              {section.items.map((item) => (
                <article className="thread-context-item" key={item.candidate_id}>
                  {item.text ? <MessageBody text={item.text} /> : <p className="muted">{t("thread.contextNoText")}</p>}
                  <div className="thread-context-evidence">
                    {item.evidence.map((entry) => (
                      <button key={entry.event_id} type="button" onClick={() => locateEvidence(entry.event_id)}>
                        {t("thread.contextEvidence", { ids: entry.event_id.slice(0, 8) })}
                      </button>
                    ))}
                  </div>
                </article>
              ))}
            </div>
          ))}
          {context.bundle.degradation_flags.length > 0 ? (
            <p className="action-hint">{t("thread.contextDegraded", { flags: context.bundle.degradation_flags.join(", ") })}</p>
          ) : null}
          <button
            type="button"
            className="ghost"
            disabled={busy}
            onClick={() => void start("replayed")}
          >
            {t("thread.contextReplay")}
          </button>
        </div>
      )}
    </section>
  );
}