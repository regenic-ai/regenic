import { useEffect, useId, useMemo, useState } from "react";
import { fetchWorkItemRuns } from "./api";
import { ChevronIcon } from "./Icons";
import { useLocale } from "./LocaleContext";
import { RunCard, RunStatusIcon, runReadLine, runTone, useRunClock, useRunReads } from "./RunCard";
import {
  formatRunWhen,
  formatRunWhenFull,
  isLiveRun,
  newerMessages,
  parseRunText,
  plainPreview,
  runAction,
  runDurationText,
  runStatusLabel,
  type RunAction,
} from "./run-observation";
import type { InboxViewItem, RecipeLastRun, WorkFace } from "./types";

function faceRunStatus(status: WorkFace["status"]): string | null {
  switch (status) {
    case "running": return "running";
    case "waiting_human": return "waiting_human";
    case "done": return "completed";
    case "failed": return "failed";
    case "skipped": return "cancelled";
    default: return null;
  }
}

/** The run the face points at, before the run list arrives or when it cannot load. */
function runFromFace(work: WorkFace): RecipeLastRun | null {
  const status = faceRunStatus(work.status);
  if (!work.run_id || !status) return null;
  return {
    run_id: work.run_id,
    status,
    at: work.updated_at ?? "",
    ...(work.result_summary ? { summary: work.result_summary } : {}),
    ...(work.executor_type ? { executor_type: work.executor_type } : {}),
    ...(work.delivery
      ? { delivery: { status: work.delivery.status, write_back: work.delivery.write_back, ...(work.delivery.last_error ? { last_error: work.delivery.last_error } : {}) } }
      : {}),
  };
}

export function useWorkRuns(work: WorkFace | undefined): {
  current: RecipeLastRun | null;
  earlier: RecipeLastRun[];
  all: RecipeLastRun[];
} {
  const [runs, setRuns] = useState<RecipeLastRun[]>([]);
  const key = work ? `${work.id}:${work.run_id ?? ""}:${work.status}:${work.updated_at ?? ""}:${work.delivery?.status ?? ""}` : "";
  useEffect(() => {
    if (!work?.id) {
      setRuns([]);
      return;
    }
    let live = true;
    fetchWorkItemRuns(work.id)
      .then((next) => {
        if (live) setRuns(next);
      })
      .catch(() => {
        if (live) setRuns([]);
      });
    return () => {
      live = false;
    };
  }, [key]);
  return useMemo(() => {
    if (!work) return { current: null, earlier: [], all: [] };
    const face = runFromFace(work);
    const fetched = work.run_id ? runs.find((run) => run.run_id === work.run_id) : undefined;
    const current = fetched
      ? {
          ...fetched,
          ...(face?.delivery
            ? {
                delivery: {
                  ...face.delivery,
                  ...(fetched.delivery?.accepted === true ? { accepted: true } : {}),
                },
              }
            : {}),
          ...(face && !fetched.summary && face.summary ? { summary: face.summary } : {}),
        }
      : face;
    return {
      current,
      earlier: runs.filter((run) => run.run_id !== current?.run_id),
      all: runs,
    };
  }, [work, runs]);
}

function EarlierRow({
  run,
  open,
  onToggle,
}: {
  run: RecipeLastRun;
  open: boolean;
  onToggle: () => void;
}) {
  const { t } = useLocale();
  const now = useRunClock(run);
  const text = parseRunText(run.summary);
  return (
    <button
      type="button"
      className={`run-row ${runTone(run.status)}${open ? " is-current" : ""}`}
      aria-expanded={open}
      onClick={onToggle}
    >
      <span className="run-status">
        <RunStatusIcon status={run.status} />
        {runStatusLabel(run.status, t)}
      </span>
      <time className="run-row-when" dateTime={run.at} title={formatRunWhenFull(run.at)}>
        {formatRunWhen(run.at, t)}
      </time>
      <span className="run-row-took">{runDurationText(run, t, now)}</span>
      <span className="run-row-summary">
        {plainPreview(text.conclusion, 160) || (isLiveRun(run.status) ? t("run.processingLine") : "")}
      </span>
    </button>
  );
}

function EarlierRuns({ runs, history }: { runs: RecipeLastRun[]; history: RecipeLastRun[] }) {
  const { t } = useLocale();
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  if (!runs.length) return null;
  return (
    <div className="run-earlier">
      <button
        type="button"
        className={`run-toggle${open ? " is-open" : ""}`}
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((value) => !value)}
      >
        {t("run.earlier", { count: runs.length })}
        <span className="run-caret"><ChevronIcon /></span>
      </button>
      {open ? (
        <ul id={listId} className="run-earlier-list">
          {runs.map((run, index) => {
            const id = run.run_id ?? `${run.at}:${index}`;
            const isOpen = expanded === id;
            return (
              <li key={id}>
                <EarlierRow run={run} open={isOpen} onToggle={() => setExpanded(isOpen ? null : id)} />
                {isOpen ? <RunCard run={run} history={history} /> : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

const CARD_OPEN_KEY = "regenic.threadRunCard.open";

function loadCardOpen(): boolean {
  try {
    return window.localStorage.getItem(CARD_OPEN_KEY) === "1";
  } catch {
    return false;
  }
}

function useCardOpen(): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(loadCardOpen);
  return [open, (next) => {
    setOpen(next);
    try {
      window.localStorage.setItem(CARD_OPEN_KEY, next ? "1" : "0");
    } catch {
      // Preference only.
    }
  }];
}

function RunBar({
  run,
  staleCount,
  onExpand,
  className,
}: {
  run: RecipeLastRun;
  staleCount: number;
  onExpand: () => void;
  className?: string;
}) {
  const { t } = useLocale();
  const now = useRunClock(run);
  const conclusion = parseRunText(run.summary).conclusion;
  const live = isLiveRun(run.status);
  const { reads } = useRunReads(live ? run.run_id : undefined, undefined, live);
  const latest = reads?.at(-1);
  const action = runAction(run);
  const preview = plainPreview(conclusion, 200)
    || (latest ? runReadLine(latest, t) : live ? t("run.processingLine") : action ? t(`run.short.${action}`) : "");
  const when = run.started_at && live ? run.started_at : run.at;
  const took = runDurationText(run, t, now);
  return (
    <button
      type="button"
      className={`run-bar ${runTone(run.status)}${className ? ` ${className}` : ""}`}
      aria-expanded={false}
      aria-label={t("run.expandCard")}
      onClick={onExpand}
    >
      <span className="run-status">
        <RunStatusIcon status={run.status} />
        {runStatusLabel(run.status, t)}
      </span>
      <span className="run-bar-meta">
        {when ? <time dateTime={when} title={formatRunWhenFull(when)}>{formatRunWhen(when, t)}</time> : null}
        {took ? <span>{took}</span> : null}
      </span>
      <span className="run-bar-preview">{preview}</span>
      {staleCount > 0 ? <span className="run-bar-stale">{t("run.staleShort", { count: staleCount })}</span> : null}
      <span className="run-caret" aria-hidden="true"><ChevronIcon /></span>
    </button>
  );
}

export function ThreadRunCard({
  work,
  heading,
  messages,
  compact = false,
  onRevealEvent,
  onAction,
  className,
}: {
  work: WorkFace;
  heading: string;
  messages: InboxViewItem[];
  compact?: boolean;
  onRevealEvent?: (eventId: string) => void;
  onAction?: (action: RunAction) => void;
  className?: string;
}) {
  const { current, earlier, all } = useWorkRuns(work);
  const newer = useMemo(() => {
    if (!current || isLiveRun(current.status) || !current.at) return [];
    const conclusion = parseRunText(current.summary).conclusion;
    return newerMessages(
      current.at,
      conclusion,
      messages.map((item) => ({
        id: item.event.id,
        occurred_at: item.event.occurred_at,
        kind: item.kind,
        body_text: item.body_text,
      })),
    );
  }, [current, messages]);
  const [open, setOpen] = useCardOpen();
  if (!current) return null;
  const first = newer[0];
  if (compact || !open) {
    return (
      <RunBar
        run={current}
        staleCount={compact ? 0 : newer.length}
        onExpand={() => setOpen(true)}
        className={className}
      />
    );
  }
  return (
    <RunCard
      run={current}
      history={all}
      replyTitle={heading}
      staleCount={newer.length}
      onRevealStale={first && onRevealEvent ? () => onRevealEvent(first.id) : undefined}
      onAction={onAction}
      onCollapse={() => setOpen(false)}
      revision={work.updated_at}
      className={`is-thread${className ? ` ${className}` : ""}`}
      footer={<EarlierRuns runs={earlier} history={all} />}
    />
  );
}
