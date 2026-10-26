import { Fragment, useEffect, useState } from "react";
import { cancelSearchAnswer, fetchExecutors, fetchSearchAnswer, startSearchAnswer } from "./api";
import { searchAnswerConversations, searchAnswerSegments } from "./context-search";
import { KernelRequestError } from "./kernel-request";
import { useLocale } from "./LocaleContext";
import type { ExecutorCatalogEntry, PersonalSearchAnswer, PersonalSearchConversation } from "./types";
import { subscribeWorkUpdates } from "./personal-events";

/** Reconnect/lost-event fallback; normal updates arrive over the shared SSE connection. */
const POLL_FALLBACK_MS = 15_000;

function isActive(answer: PersonalSearchAnswer | null): boolean {
  return answer?.status === "running" || answer?.status === "waiting_human";
}

/** Asks an installed executor to answer from the visible cards; the kernel never calls a model for this. */
export function SearchAnswerCard({ query, conversations, onCite }: {
  query: string;
  conversations: PersonalSearchConversation[];
  onCite: (eventId: string) => void;
}) {
  const { t } = useLocale();
  const [executors, setExecutors] = useState<ExecutorCatalogEntry[] | null>(null);
  const [executor, setExecutor] = useState("");
  const [answer, setAnswer] = useState<PersonalSearchAnswer | null>(null);
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetchExecutors()
      .then((list) => {
        if (!live) return;
        setExecutors(list);
        setExecutor(list.find((entry) => entry.executor_type === "dsh")?.executor_type ?? list[0]?.executor_type ?? "");
      })
      .catch(() => { if (live) setExecutors([]); });
    return () => { live = false; };
  }, []);

  useEffect(() => {
    if (!answer || !isActive(answer)) {
      return;
    }
    const controller = new AbortController();
    let refreshing = false;
    const refresh = async () => {
      if (refreshing) return;
      refreshing = true;
      try {
        setAnswer(await fetchSearchAnswer(answer.answer_id, controller.signal));
        setError(null);
      } catch (caught) {
        if (!controller.signal.aborted) {
          setError(caught instanceof Error ? caught.message : t("search.answer.failed"));
        }
      } finally {
        refreshing = false;
      }
    };
    const unsubscribe = subscribeWorkUpdates((workItemId) => {
      if (workItemId === answer.work_item_id) void refresh();
    });
    const timer = window.setInterval(() => void refresh(), POLL_FALLBACK_MS);
    return () => {
      unsubscribe();
      window.clearInterval(timer);
      controller.abort();
    };
  }, [answer, t]);

  const label = (type: string) => executors?.find((entry) => entry.executor_type === type)?.label ?? type;

  async function ask() {
    setError(null);
    setStarting(true);
    setAnswer(null);
    try {
      setAnswer(await startSearchAnswer({
        query,
        conversations: searchAnswerConversations(conversations),
        ...(executor ? { executor_type: executor } : {}),
      }));
    } catch (caught) {
      setError(caught instanceof KernelRequestError && caught.code === "executor_unavailable"
        ? t("search.answer.noExecutor")
        : caught instanceof KernelRequestError && caught.code === "executor_session_unavailable"
          ? t("search.answer.noSession")
          : caught instanceof KernelRequestError && caught.code === "busy"
            ? t("search.answer.busy")
            : caught instanceof Error ? caught.message : t("search.answer.failed"));
    } finally {
      setStarting(false);
    }
  }

  async function stop() {
    if (!answer) return;
    setError(null);
    setStopping(true);
    try {
      setAnswer(await cancelSearchAnswer(answer.answer_id));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("search.answer.failed"));
    } finally {
      setStopping(false);
    }
  }

  const choose = executors && executors.length > 1 && !isActive(answer) ? (
    <select aria-label={t("search.answer.executor")} value={executor} disabled={starting}
      onChange={(event) => setExecutor(event.target.value)}>
      {executors.map((entry) => <option key={entry.executor_type} value={entry.executor_type}>{entry.label}</option>)}
    </select>
  ) : null;

  let body;
  if (executors && executors.length === 0) {
    body = <p className="muted">{t("search.answer.noExecutor")}</p>;
  } else if (!answer && starting) {
    body = <p className="muted" role="status">{t("search.answer.running", { executor: label(executor) })}</p>;
  } else if (!answer) {
    body = (
      <div className="search-answer-row">
        <p className="muted">{t("search.answer.hint")}</p>
        <button type="button" className="ghost" disabled={starting || !executors} onClick={() => void ask()}>
          {t("search.answer.ask")}
        </button>
      </div>
    );
  } else if (isActive(answer)) {
    body = (
      <div className="search-answer-row">
        <p className="muted" role="status">
          {t(answer.status === "waiting_human" ? "search.answer.waiting" : "search.answer.running",
            { executor: label(answer.executor_type) })}
        </p>
        <button type="button" className="link muted-link" disabled={stopping}
          onClick={() => void stop()}>{t("search.answer.cancel")}</button>
      </div>
    );
  } else if (answer.status === "completed" && answer.answer) {
    body = (
      <>
        <p className="search-answer-text">
          {searchAnswerSegments(answer.answer, answer.citations ?? []).map((segment, index) => "text" in segment
            ? <Fragment key={index}>{segment.text}</Fragment>
            : (
              <button key={index} type="button" className="search-answer-cite"
                title={t("search.answer.cite", { ref: segment.ref })} onClick={() => onCite(segment.event_id)}>
                {segment.ref}
              </button>
            ))}
        </p>
        <div className="search-answer-row muted">
          <span>{t("search.answer.by", { executor: label(answer.executor_type) })}</span>
          <button type="button" className="link muted-link" disabled={starting} onClick={() => void ask()}>
            {t("search.answer.again")}
          </button>
        </div>
      </>
    );
  } else {
    body = (
      <div className="search-answer-row">
        <p className="muted">{t(`search.answer.${answer.status === "timed_out" ? "timedOut" : answer.status === "cancelled" ? "cancelled" : "failed"}`)}</p>
        <button type="button" className="link" disabled={starting} onClick={() => void ask()}>{t("search.answer.again")}</button>
      </div>
    );
  }

  return (
    <section className="search-answer" aria-live="polite">
      <header className="search-answer-head">
        <span className="search-answer-title">{t("search.answer.title")}</span>
        {choose}
      </header>
      {body}
      {error ? <p role="alert" className="action-error">{error}</p> : null}
    </section>
  );
}
