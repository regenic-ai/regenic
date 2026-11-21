import { useEffect, useId, useMemo, useState } from "react";
import { fetchWorkRunReads } from "./api";
import { ChevronIcon, SparkleIcon } from "./Icons";
import { useLocale } from "./LocaleContext";
import { MessageBody } from "./MessageBody";
import { RunReadList } from "./RunCard";
import { formatDuration, readTurns } from "./run-observation";
import type { AgentContextRead, InboxViewItem } from "./types";
import { clockInterval, useNow } from "./use-now";

export interface AskTurn {
  start: string;
  question?: InboxViewItem;
  answers: InboxViewItem[];
}

/**
 * Split the thread into turns. The first turn starts at the hidden task
 * prompt (or when the question was asked); each later person message starts
 * another.
 */
export function askTurns(
  items: InboxViewItem[],
  speech: InboxViewItem[],
  askedAt: string | undefined,
): AskTurn[] {
  const firstAt = items[0]?.event.occurred_at ?? askedAt ?? "";
  const turns: AskTurn[] = [{ start: firstAt, answers: [] }];
  for (const item of speech) {
    if (item.kind === "user") {
      turns.push({ start: item.event.occurred_at, question: item, answers: [] });
    } else {
      turns[turns.length - 1]!.answers.push(item);
    }
  }
  return turns;
}

function turnTook(turn: AskTurn): number | null {
  const last = turn.answers[turn.answers.length - 1];
  const start = Date.parse(turn.start);
  const end = last ? Date.parse(last.event.occurred_at) : Number.NaN;
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : null;
}

function ReadsToggle({ reads }: { reads: AgentContextRead[] }) {
  const { t } = useLocale();
  const id = useId();
  const [open, setOpen] = useState(false);
  if (!reads.length) return null;
  return (
    <>
      <button
        type="button"
        className={`run-toggle${open ? " is-open" : ""}`}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((value) => !value)}
      >
        {t("run.processReads", { count: reads.length })}
        <span className="run-caret"><ChevronIcon /></span>
      </button>
      {open ? <div id={id} className="ask-turn-reads"><RunReadList reads={reads} failed={false} onRetry={() => undefined} /></div> : null}
    </>
  );
}

function ThinkingRow({ start, reads }: { start: string; reads: AgentContextRead[] }) {
  const { t } = useLocale();
  const startMs = Date.parse(start);
  const now = useNow(true, clockInterval(Number.isFinite(startMs) ? Date.now() - startMs : null));
  const elapsed = Number.isFinite(startMs) ? Math.max(0, now - startMs) : null;
  return (
    <>
      <div className="ask-message is-assistant is-thinking">
        <span className="ask-avatar" aria-hidden="true"><SparkleIcon /></span>
        <span className="ask-thinking" role="status">
          {elapsed === null ? t("search.ask.thinking") : t("run.ask.thinking", { duration: formatDuration(elapsed, t, false) })}
        </span>
      </div>
      {reads.length ? <div className="ask-turn-meta"><ReadsToggle reads={reads} /></div> : null}
    </>
  );
}

export function AskTurns({
  turns,
  runId,
  revision,
  thinking,
  stopped,
  onRetry,
}: {
  turns: AskTurn[];
  runId?: string;
  revision: string;
  thinking: boolean;
  stopped: boolean;
  onRetry?: () => void;
}) {
  const { t } = useLocale();
  const [reads, setReads] = useState<AgentContextRead[]>([]);

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
          if (active) setReads(next);
        })
        .catch(() => undefined)
        .finally(() => {
          if (active && thinking) timer = window.setTimeout(load, 4000);
        });
    };
    load();
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [runId, revision, thinking]);

  const readsByTurn = useMemo(() => {
    const owners = readTurns(reads, turns.map((turn) => turn.start));
    return turns.map((_, index) => reads.filter((_, readIndex) => owners[readIndex] === index));
  }, [reads, turns]);

  const lastIndex = turns.length - 1;
  return (
    <>
      {turns.map((turn, index) => {
        const took = turnTook(turn);
        const isLast = index === lastIndex;
        return (
          <div key={turn.question?.event.id ?? `turn-${index}`} className="ask-turn">
            {turn.question ? (
              <article className="ask-message is-user">
                <MessageBody text={turn.question.body_text ?? ""} attachments={turn.question.attachments} />
              </article>
            ) : null}
            {turn.answers.map((item) => (
              <article key={item.event.id} className="ask-message is-assistant">
                <span className="ask-avatar" aria-hidden="true"><SparkleIcon /></span>
                <div className="ask-message-body">
                  <MessageBody text={item.body_text ?? ""} attachments={item.attachments} />
                </div>
              </article>
            ))}
            {turn.answers.length && took !== null ? (
              <div className="ask-turn-meta">
                <span>{t("run.ask.took", { duration: formatDuration(took, t) })}</span>
                {readsByTurn[index]?.length ? <span aria-hidden="true">·</span> : null}
                <ReadsToggle reads={readsByTurn[index] ?? []} />
              </div>
            ) : null}
            {isLast && thinking && !turn.answers.length ? (
              <ThinkingRow start={turn.start} reads={readsByTurn[index] ?? []} />
            ) : null}
            {isLast && stopped && !turn.answers.length ? (
              <p className="ask-error" role="alert">
                {t("search.ask.runFailed")}
                {onRetry ? (
                  <>
                    {" "}
                    <button type="button" className="run-link" onClick={onRetry}>{t("run.ask.retry")}</button>
                  </>
                ) : null}
              </p>
            ) : null}
          </div>
        );
      })}
    </>
  );
}
