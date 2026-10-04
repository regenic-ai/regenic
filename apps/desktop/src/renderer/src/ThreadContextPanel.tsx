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
};

export function ThreadContextPanel({ threadId }: { threadId: string }) {
  const { t } = useLocale();
  const [context, setContext] = useState<ContextState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setContext(null);
    setBusy(false);
    setError(null);
    return () => abortRef.current?.abort();
  }, [threadId]);

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
          setContext({ ...result, mode, loadedAt: new Date().toISOString() });
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

  return (
    <section className="thread-context" aria-label={t("thread.contextTitle")}>
      <div className="thread-context-head">
        <div>
          <h2>{t("thread.contextTitle")}</h2>
          <p>{context ? t(context.mode === "replayed" ? "thread.contextReplayed" : "thread.contextFresh") : t("thread.contextLead")}</p>
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
      {!context ? null : (
        <div className="thread-context-result">
          <div className="thread-context-meta">
            <span>{t("thread.contextSnapshot", { id: context.snapshot.id.slice(0, 12) })}</span>
            <span>{t("thread.contextHash", { hash: context.bundle.content_hash.slice(0, 12) })}</span>
          </div>
          {context.bundle.sections.flatMap((section) => section.items).length === 0 ? (
            <p className="muted">{t("thread.contextEmpty")}</p>
          ) : context.bundle.sections.map((section) => (
            <div className="thread-context-section" key={section.kind}>
              <h3>{section.kind}</h3>
              {section.items.map((item) => (
                <article className="thread-context-item" key={item.candidate_id}>
                  {item.text ? <MessageBody text={item.text} /> : <p className="muted">{t("thread.contextNoText")}</p>}
                  <p className="thread-context-evidence">
                    {t("thread.contextEvidence", { ids: item.evidence.map((entry) => entry.event_id.slice(0, 8)).join(", ") || "-" })}
                  </p>
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