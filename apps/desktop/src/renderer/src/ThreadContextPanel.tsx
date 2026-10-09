import { useEffect, useRef, useState } from "react";
import {
  assemblePersonalContext,
  fetchPersonalContextHistory,
  replayPersonalContext,
} from "./api";
import { MessageBody } from "./MessageBody";
import { useLocale } from "./LocaleContext";
import type {
  PersonalContextBundle,
  PersonalContextSnapshot,
  PersonalContextSnapshotIndexEntry,
} from "./types";

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
  const [history, setHistory] = useState<PersonalContextSnapshotIndexEntry[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setContext(null);
    setBusy(false);
    setError(null);
    setEvidenceNotice(null);
    return () => abortRef.current?.abort();
  }, [threadId]);

  useEffect(() => {
    const controller = new AbortController();
    setHistory([]);
    void fetchPersonalContextHistory(threadId, controller.signal)
      .then((entries) => {
        if (!controller.signal.aborted) setHistory(entries);
      })
      .catch((caught) => {
        if (!controller.signal.aborted) {
          setError(caught instanceof Error ? caught.message : t("thread.contextHistoryError"));
        }
      });
    return () => controller.abort();
  }, [threadId, t]);

  const start = async (
    mode: "fresh" | "replayed",
    replay?: PersonalContextSnapshotIndexEntry,
  ) => {
    const snapshotId = replay?.snapshot_id ?? context?.snapshot.id;
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
          setContext(next);
          const entries = await fetchPersonalContextHistory(threadId, controller.signal);
          if (!controller.signal.aborted) setHistory(entries);
        }
      } else {
        const bundle = await replayPersonalContext(snapshotId!, controller.signal);
        if (!controller.signal.aborted) {
          const entry = replay ?? history.find((item) => item.snapshot_id === snapshotId);
          setContext((current) => ({
            snapshot: {
              id: snapshotId!,
              created_at: entry?.created_at ?? current?.snapshot.created_at ?? new Date().toISOString(),
            },
            bundle,
            mode,
            loadedAt: new Date().toISOString(),
            sourceRevision: current?.sourceRevision ?? sourceRevision,
          }));
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
      {history.length > 0 ? (
        <label className="thread-context-history">
          {t("thread.contextHistory")}
          <select
            value={context?.snapshot.id ?? ""}
            disabled={busy}
            onChange={(event) => {
              const selected = history.find((entry) => entry.snapshot_id === event.target.value);
              if (selected) void start("replayed", selected);
            }}
          >
            <option value="" disabled>{t("thread.contextHistorySelect")}</option>
            {history.map((entry) => (
              <option key={entry.snapshot_id} value={entry.snapshot_id}>
                {t("thread.contextHistoryEntry", {
                  id: entry.snapshot_id.slice(0, 12),
                  date: new Date(entry.created_at).toLocaleString(),
                })}
              </option>
            ))}
          </select>
        </label>
      ) : null}
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