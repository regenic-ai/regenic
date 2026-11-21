import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { fetchWorkRunDetail } from "./api";
import { ChevronDownIcon, ChevronUpIcon, CloseIcon } from "./Icons";
import { useLocale } from "./LocaleContext";
import { RunCard } from "./RunCard";
import type { RecipeLastRun, WorkRunDetail } from "./types";

export function RunDetailPanel({
  runs,
  index,
  currentTask,
  executorLabel,
  onIndex,
  onClose,
  onOpenThread,
}: {
  runs: RecipeLastRun[];
  index: number;
  currentTask?: string;
  executorLabel?: (executorType: string) => string | undefined;
  onIndex: (index: number) => void;
  onClose: () => void;
  onOpenThread?: (threadId: string) => void;
}) {
  const { t } = useLocale();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const returnFocus = useRef<Element | null>(null);
  const [detail, setDetail] = useState<WorkRunDetail | null>(null);
  const listed = runs[index]!;
  const runId = listed.run_id;

  useEffect(() => {
    returnFocus.current = document.activeElement;
    headingRef.current?.focus();
    return () => {
      if (returnFocus.current instanceof HTMLElement) returnFocus.current.focus();
    };
  }, []);

  useEffect(() => {
    setDetail(null);
    if (!runId) return;
    let live = true;
    fetchWorkRunDetail(runId)
      .then((next) => {
        if (live) setDetail(next);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [runId, listed.status, listed.at]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      } else if (event.key === "ArrowUp" && index > 0) {
        event.preventDefault();
        onIndex(index - 1);
      } else if (event.key === "ArrowDown" && index < runs.length - 1) {
        event.preventDefault();
        onIndex(index + 1);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [index, runs.length, onClose, onIndex]);

  const run = detail && detail.run.run_id === runId ? { ...listed, ...detail.run } : listed;
  const threadId = run.thread_id?.trim();
  const openThread = threadId && onOpenThread ? () => onOpenThread(threadId) : undefined;

  return createPortal(
    <>
      <div className="run-panel-scrim" onClick={onClose} aria-hidden="true" />
      <aside className="run-panel" role="dialog" aria-modal="true" aria-labelledby="run-panel-title">
        <header className="run-panel-head">
          <h2 id="run-panel-title" ref={headingRef} tabIndex={-1}>{t("run.panelTitle")}</h2>
          <span className="run-panel-nav">
            <button
              type="button"
              className="item-tool"
              aria-label={t("run.previous")}
              disabled={index === 0}
              onClick={() => onIndex(index - 1)}
            >
              <ChevronUpIcon />
            </button>
            <button
              type="button"
              className="item-tool"
              aria-label={t("run.next")}
              disabled={index >= runs.length - 1}
              onClick={() => onIndex(index + 1)}
            >
              <ChevronDownIcon />
            </button>
          </span>
          <button type="button" className="item-tool" aria-label={t("run.close")} onClick={onClose}>
            <CloseIcon />
          </button>
        </header>
        <div className="run-panel-body">
          <RunCard
            key={runId ?? index}
            run={run}
            history={runs}
            executorLabel={run.executor_type ? executorLabel?.(run.executor_type) : undefined}
            task={detail?.task}
            currentTask={currentTask}
            triggerText={detail?.trigger_text}
            onAction={openThread ? () => openThread() : undefined}
            processOpen
          />
        </div>
        {openThread ? (
          <footer className="run-panel-foot">
            <button type="button" className="primary" onClick={openThread}>
              {t("run.openConversation")}
            </button>
          </footer>
        ) : null}
      </aside>
    </>,
    document.body,
  );
}
