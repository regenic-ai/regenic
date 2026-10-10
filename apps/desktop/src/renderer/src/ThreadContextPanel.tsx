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

const HISTORY_PAGE_SIZE = 20;

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
  const [historyBusy, setHistoryBusy] = useState(false);
  const [historyCanLoadMore, setHistoryCanLoadMore] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const historyAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    historyAbortRef.current?.abort();
    historyAbortRef.current = null;
    setContext(null);
    setBusy(false);
    setError(null);
    setEvidenceNotice(null);
    return () => {
      abortRef.current?.abort();
      historyAbortRef.current?.abort();
    };
  }, [threadId]);

  useEffect(() => {
    const controller = new AbortController();
    historyAbortRef.current?.abort();
    historyAbortRef.current = controller;
    setHistory([]);
    setHistoryCanLoadMore(false);
    setHistoryBusy(true);
    void fetchPersonalContextHistory(threadId, { signal: controller.signal })
      .then((entries) => {
        if (!controller.signal.aborted) {
          setHistory(entries);
          setHistoryCanLoadMore(entries.length === HISTORY_PAGE_SIZE);
        }
      })
      .catch((caught) => {
        if (!controller.signal.aborted) {
          setError(caught instanceof Error ? caught.message : t("thread.contextHistoryError"));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setHistoryBusy(false);
      });
    return () => {
      controller.abort();
      if (historyAbortRef.current === controller) historyAbortRef.current = null;
    };
  }, [threadId, t]);

  const loadOlderHistory = async () => {
    const before = history.at(-1);
    if (!before || historyBusy || !historyCanLoadMore) return;
    const controller = new AbortController();
    historyAbortRef.current?.abort();
    historyAbortRef.current = controller;
    setHistoryBusy(true);
    setError(null);
    try {
      const entries = await fetchPersonalContextHistory(threadId, {
        before,
        signal: controller.signal,
      });
      if (!controller.signal.aborted) {
        setHistory((current) => [
          ...current,
          ...entries.filter((entry) =>
            !current.some((existing) => existing.snapshot_id === entry.snapshot_id),
          ),
        ]);
        setHistoryCanLoadMore(entries.length === HISTORY_PAGE_SIZE);
      }
    } catch (caught) {
      if (!controller.signal.aborted) {
        setError(caught instanceof Error ? caught.message : t("thread.contextHistoryError"));
      }
    } finally {
      if (!controller.signal.aborted) setHistoryBusy(false);
    }
  };

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
          const entries = await fetchPersonalContextHistory(threadId, { signal: controller.signal });
          if (!controller.signal.aborted) {
            setHistory(entries);
            setHistoryCanLoadMore(entries.length === HISTORY_PAGE_SIZE);
          }
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
        <div className="thread-context-history">
          <label>
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
          {historyCanLoadMore ? (
            <button
              type="button"
              className="ghost"
              disabled={busy || historyBusy}
              onClick={() => void loadOlderHistory()}
            >
              {historyBusy ? t("thread.contextHistoryLoading") : t("thread.contextHistoryLoadMore")}
            </button>
          ) : null}
        </div>
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