import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { fetchWorkRunReads } from "./api";
import { writeClipboard } from "./copy-message";
import { ChevronIcon } from "./Icons";
import { useLocale } from "./LocaleContext";
import { MessageBody } from "./MessageBody";
import {
  formatRunWhen,
  formatRunWhenFull,
  isLiveRun,
  parseRunText,
  runAction,
  runClockCopy,
  runElapsedMs,
  runStatusLabel,
  sameTaskText,
  slowerThanUsual,
  triggerLabel,
  type RunAction,
} from "./run-observation";
import type { AgentContextRead, RecipeLastRun } from "./types";
import { clockInterval, useNow } from "./use-now";

type Translate = ReturnType<typeof useLocale>["t"];

export function RunStatusIcon({ status }: { status: string }) {
  if (status === "running") {
    return (
      <svg className="run-icon is-spin" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
        <circle cx="6" cy="6" r="4.4" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="1.6" />
        <path d="M6 1.6a4.4 4.4 0 0 1 4.4 4.4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    );
  }
  if (status === "waiting_human") {
    return (
      <svg className="run-icon" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
        <path d="M4.3 3.2v5.6M7.7 3.2v5.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    );
  }
  if (status === "completed") {
    return (
      <svg className="run-icon" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
        <path d="M2.6 6.3 5 8.6l4.4-5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (status === "failed") {
    return (
      <svg className="run-icon" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
        <path d="M3.4 3.4l5.2 5.2M8.6 3.4l-5.2 5.2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg className="run-icon" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <path d="M3.2 6h5.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export function runTone(status: string): string {
  switch (status) {
    case "running": return "is-running";
    case "waiting_human": return "is-waiting";
    case "completed": return "is-done";
    case "failed": return "is-failed";
    default: return "is-muted";
  }
}

const ACTION_ICON: Record<RunAction, string> = {
  replied: "↩",
  replying: "↩",
  send_failed: "⚠",
  uncertain: "⚠",
  quiet: "",
  record_only: "",
  partial: "",
  suggested: "",
  decide: "→",
};

function actionCopy(action: RunAction, title: string | undefined, t: Translate): string {
  switch (action) {
    case "replied": return title ? t("run.action.replied", { title }) : t("run.action.repliedUntitled");
    case "replying": return title ? t("run.action.replying", { title }) : t("run.action.replyingUntitled");
    case "send_failed": return t("run.action.sendFailed");
    case "uncertain": return t("run.action.uncertain");
    case "quiet": return t("run.action.quiet");
    case "record_only": return t("run.action.recordOnly");
    case "partial": return t("run.action.partial");
    case "suggested": return t("run.action.suggested");
    case "decide": return t("run.action.decide");
  }
}

function actionLinkCopy(action: RunAction, t: Translate): string | null {
  if (action === "send_failed") return t("run.action.sendFailedLink");
  if (action === "uncertain") return t("run.action.uncertainLink");
  if (action === "decide") return t("run.action.decideLink");
  return null;
}

/** Live clock for one run, ticking only while it is live. */
export function useRunClock(run: Pick<RecipeLastRun, "status" | "started_at" | "at">): number {
  const live = isLiveRun(run.status);
  const elapsed = runElapsedMs(run, Date.now());
  return useNow(live, clockInterval(elapsed));
}

export function RunStatusLine({
  run,
  history,
  trailing,
}: {
  run: RecipeLastRun;
  history?: RecipeLastRun[];
  trailing?: ReactNode;
}) {
  const { t } = useLocale();
  const now = useRunClock(run);
  const clock = runClockCopy(run, t, now);
  const slow = history ? slowerThanUsual(run, history, now) : false;
  const when = run.started_at && isLiveRun(run.status) ? run.started_at : run.at;
  return (
    <div className={`run-status-line ${runTone(run.status)}${slow ? " is-slow" : ""}`}>
      <span className="run-status">
        <RunStatusIcon status={run.status} />
        <span aria-hidden="true">{runStatusLabel(run.status, t)}</span>
        <span className="sr-only" role="status" aria-live="polite">{runStatusLabel(run.status, t)}</span>
      </span>
      {clock ? <span className="run-clock">{clock}</span> : null}
      {slow ? <span className="run-slow">{t("run.slow")}</span> : null}
      <time className="run-when" dateTime={when} title={formatRunWhenFull(when)}>
        {formatRunWhen(when, t)}
      </time>
      {trailing ? <span className="run-status-trailing">{trailing}</span> : null}
    </div>
  );
}

function RunConclusion({ text }: { text: string }) {
  const { t } = useLocale();
  const clipId = useId();
  const clipRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);

  useLayoutEffect(() => {
    const node = clipRef.current;
    if (!node || expanded) return;
    const measure = () => setOverflows(node.scrollHeight > node.clientHeight + 2);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [expanded, text]);

  return (
    <div className="run-conclusion">
      <div
        id={clipId}
        ref={clipRef}
        className={`run-conclusion-clip${expanded ? " is-expanded" : " is-collapsed"}`}
      >
        <MessageBody text={text} />
      </div>
      {overflows && !expanded ? <span className="run-conclusion-fade" aria-hidden="true" /> : null}
      {overflows || expanded ? (
        <button
          type="button"
          className={`run-toggle${expanded ? " is-open" : ""}`}
          aria-expanded={expanded}
          aria-controls={clipId}
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? t("work.resultCollapse") : t("run.showAll")}
          <span className="run-caret"><ChevronIcon /></span>
        </button>
      ) : null}
    </div>
  );
}

const READS_POLL_MS = 4000;
const LIVE_PROGRESS_LIMIT = 4;

/** Lookups for one run. While `polling` is set, refreshes until the run settles. */
export function useRunReads(runId: string | undefined, revision?: string, polling = false) {
  const [reads, setReads] = useState<AgentContextRead[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!runId) {
      setReads([]);
      return;
    }
    let active = true;
    let timer = 0;
    const load = () => {
      fetchWorkRunReads(runId)
        .then((next) => {
          if (!active) return;
          setReads(next);
          setFailed(false);
        })
        .catch(() => {
          if (active) setFailed(true);
        })
        .finally(() => {
          if (active && polling) timer = window.setTimeout(load, READS_POLL_MS);
        });
    };
    load();
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [runId, revision, attempt, polling]);
  return { reads, failed, retry: () => setAttempt((value) => value + 1) };
}

export function runReadLine(read: AgentContextRead, t: Translate): string {
  const count = read.messages;
  if (read.tool === "search_conversations") {
    return t("work.readSearch", { query: read.query ?? "", count });
  }
  if (read.tool === "read_task_conversation") {
    return t("work.readTask", { count });
  }
  return read.title
    ? t("work.readWindow", { title: read.title, count })
    : t("work.readWindowUntitled", { count });
}

export function RunReadList({
  reads,
  failed,
  onRetry,
}: {
  reads: AgentContextRead[] | null;
  failed: boolean;
  onRetry: () => void;
}) {
  const { t } = useLocale();
  if (failed) {
    return (
      <p className="run-process-muted">
        {t("run.readsUnavailable")} ·{" "}
        <button type="button" className="run-link" onClick={onRetry}>{t("run.retry")}</button>
      </p>
    );
  }
  if (!reads) return null;
  if (!reads.length) return <p className="run-process-muted">{t("run.noReads")}</p>;
  return (
    <ol className="run-reads">
      {reads.map((read, index) => (
        <li key={`${read.at}:${index}`}>
          <time className="run-process-muted" dateTime={read.at}>{formatRunWhen(read.at, t)}</time>
          <span>{runReadLine(read, t)}</span>
        </li>
      ))}
    </ol>
  );
}

function TaskText({ text, edited }: { text: string; edited: boolean }) {
  const { t } = useLocale();
  const textRef = useRef<HTMLParagraphElement>(null);
  const [open, setOpen] = useState(false);
  const [overflows, setOverflows] = useState(false);

  useLayoutEffect(() => {
    const node = textRef.current;
    if (!node || open) return;
    const measure = () => setOverflows(node.scrollHeight > node.clientHeight + 2);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [open, text]);

  return (
    <div className="run-task">
      <p ref={textRef} className={`run-task-text${open ? " is-open" : ""}`}>{text}</p>
      {edited || overflows || open ? (
        <div className="run-task-foot">
          {edited ? <span className="run-badge">{t("run.taskEdited")}</span> : null}
          {overflows || open ? (
            <button type="button" className="run-link" onClick={() => setOpen((value) => !value)}>
              {open ? t("work.resultCollapse") : t("work.resultExpand")}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export interface RunCardProps {
  run: RecipeLastRun;
  /** Same-rule runs, for "slower than usual". */
  history?: RecipeLastRun[];
  /** Conversation the reply went to. */
  replyTitle?: string;
  executorLabel?: string;
  task?: string;
  currentTask?: string;
  triggerText?: string;
  /** Messages after the conclusion; zero hides the line. */
  staleCount?: number;
  onRevealStale?: () => void;
  /** Where "retry", "confirm", and "reply" lead. Omit to show the action without a link. */
  onAction?: (action: RunAction) => void;
  processOpen?: boolean;
  /** Status line and process only, for a run waiting on a prompt. */
  compact?: boolean;
  /** Changes when the run may have new reads. */
  revision?: string;
  footer?: ReactNode;
  className?: string;
  onCollapse?: () => void;
}

export function RunCard({
  run,
  history,
  replyTitle,
  executorLabel,
  task,
  currentTask,
  triggerText,
  staleCount = 0,
  onRevealStale,
  onAction,
  processOpen = false,
  compact = false,
  revision,
  footer,
  className,
  onCollapse,
}: RunCardProps) {
  const { t } = useLocale();
  const processId = useId();
  const [open, setOpen] = useState(processOpen);
  const [copied, setCopied] = useState(false);
  const live = isLiveRun(run.status);
  const { reads, failed, retry } = useRunReads(run.run_id, revision ?? `${run.status}:${run.at}`, live);
  const text = parseRunText(run.summary);
  const action = runAction(run);
  const actionLink = action ? actionLinkCopy(action, t) : null;

  useEffect(() => setOpen(processOpen), [processOpen, run.run_id]);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copyButton = text.conclusion && !compact ? (
    <button
      type="button"
      className="run-copy"
      onClick={() => {
        void writeClipboard(text.conclusion).then((ok) => {
          if (ok) setCopied(true);
        });
      }}
    >
      {copied ? t("thread.copied") : t("thread.copy")}
    </button>
  ) : null;
  const trailing = copyButton || onCollapse ? (
    <>
      {copyButton}
      {onCollapse ? (
        <button
          type="button"
          className="run-collapse"
          aria-expanded={true}
          aria-label={t("work.resultCollapse")}
          title={t("work.resultCollapse")}
          onClick={onCollapse}
        >
          <ChevronIcon />
        </button>
      ) : null}
    </>
  ) : null;

  const showTrigger = Boolean(run.trigger_kind || triggerText);
  const showReads = Boolean(reads?.length) || (failed && !reads?.length);
  const showAgent = Boolean(executorLabel || run.executor_type);
  const showProcess = showTrigger || showReads || showAgent || Boolean(task) || Boolean(text.note);
  const processSummary = [
    t("run.process"),
    run.trigger_kind ? triggerLabel(run.trigger_kind, t) : "",
    reads?.length ? t("run.processReads", { count: reads.length }) : "",
  ].filter(Boolean).join(" · ");

  let body: ReactNode = null;
  if (!compact) {
    if (text.conclusion) {
      body = (
        <>
          {run.status === "failed" ? <p className="run-label">{t("run.failureReason")}</p> : null}
          <RunConclusion text={text.conclusion} />
        </>
      );
    } else if (live) {
      const recent = reads?.slice(-LIVE_PROGRESS_LIMIT) ?? [];
      body = (
        <div className="run-progress">
          <p className="run-thinking"><span className="run-thinking-dot" aria-hidden="true" />{t("run.thinking")}</p>
          {recent.length ? (
            <>
              {reads && reads.length > recent.length ? (
                <p className="run-process-muted">{t("run.processReads", { count: reads.length })}</p>
              ) : null}
              <RunReadList reads={recent} failed={false} onRetry={() => undefined} />
            </>
          ) : null}
        </div>
      );
    } else if (run.status !== "cancelled") {
      body = <p className="run-empty">{t("run.noConclusion")}</p>;
    }
  }

  return (
    <section className={`run-card${compact ? " is-compact" : ""}${className ? ` ${className}` : ""}`}>
      <RunStatusLine run={run} history={history} trailing={trailing} />
      {body}
      {!compact && action ? (
        <p className={`run-action is-${action}`}>
          {ACTION_ICON[action] ? <span aria-hidden="true">{ACTION_ICON[action]}</span> : null}
          <span>{actionCopy(action, replyTitle, t)}</span>
          {actionLink && onAction ? (
            <>
              <span aria-hidden="true">·</span>
              <button type="button" className="run-link" onClick={() => onAction(action)}>{actionLink}</button>
            </>
          ) : null}
        </p>
      ) : null}
      {!compact && staleCount > 0 ? (
        <button type="button" className="run-stale" onClick={onRevealStale} disabled={!onRevealStale}>
          <span aria-hidden="true">⚠</span>
          {t("run.stale", { count: staleCount })}
        </button>
      ) : null}
      {showProcess ? <div className="run-process">
        <button
          type="button"
          className={`run-toggle run-process-toggle${open ? " is-open" : ""}`}
          aria-expanded={open}
          aria-controls={processId}
          onClick={() => setOpen((value) => !value)}
        >
          <span className="run-caret is-side"><ChevronIcon /></span>
          {processSummary}
        </button>
        {open ? (
          <dl id={processId} className="run-process-body">
            {showTrigger ? (
              <>
                <dt>{t("run.field.trigger")}</dt>
                <dd>
                  {run.trigger_kind ? triggerLabel(run.trigger_kind, t) : null}
                  {triggerText ? <span className="run-process-muted">「{triggerText}」</span> : null}
                </dd>
              </>
            ) : null}
            {showAgent ? (
              <>
                <dt>{t("run.field.agent")}</dt>
                <dd>{executorLabel ?? run.executor_type}</dd>
              </>
            ) : null}
            {task ? (
              <>
                <dt>{t("run.field.task")}</dt>
                <dd>
                  <TaskText
                    text={task}
                    edited={currentTask !== undefined && !sameTaskText(task, currentTask)}
                  />
                </dd>
              </>
            ) : null}
            {showReads ? (
              <>
                <dt>{t("run.field.reads")}</dt>
                <dd><RunReadList reads={reads} failed={failed && !reads?.length} onRetry={retry} /></dd>
              </>
            ) : null}
            {text.note ? (
              <>
                <dt>{t("run.field.note")}</dt>
                <dd><MessageBody text={text.note} /></dd>
              </>
            ) : null}
          </dl>
        ) : null}
      </div> : null}
      {footer}
    </section>
  );
}
