import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  fetchInbox,
  fetchSearchQuestion,
  sendReply,
  startSearchQuestion,
  type SearchQuestion,
} from "./api";
import { AgentReadsCard } from "./AgentReadsCard";
import { ArrowUpIcon, CloseIcon, PlusIcon, SparkleIcon } from "./Icons";
import { KernelRequestError } from "./kernel-request";
import { MessageBody } from "./MessageBody";
import { useLocale } from "./LocaleContext";
import type { InboxViewItem } from "./types";

const QUESTIONS_KEY = "regenic.search.questions";
const STOPPED_RUN = new Set(["failed", "cancelled", "canceled", "aborted"]);
const SETTLED_RUN = new Set(["completed", "done", ...STOPPED_RUN]);
const PROMPT_PREAMBLE = "Answer QUESTION using only";

/** Working heartbeats and channel reminders are not part of the question. */
function askSpeech(item: InboxViewItem): boolean {
  if (item.activity === "working" || item.kind === "system") return false;
  const text = item.body_text?.trim() ?? "";
  if (!text && !(item.attachments?.length)) return false;
  if (item.kind === "user" && text.startsWith(PROMPT_PREAMBLE)) return false;
  return true;
}

interface StoredQuestion {
  id: string;
  query: string;
  scopeThreadId?: string;
  scopeTitle?: string;
}

function loadQuestions(): StoredQuestion[] {
  try {
    const value = JSON.parse(localStorage.getItem(QUESTIONS_KEY) ?? "[]");
    if (!Array.isArray(value)) return [];
    return value.filter((entry): entry is StoredQuestion =>
      Boolean(entry) && typeof entry.id === "string" && typeof entry.query === "string");
  } catch {
    return [];
  }
}

function saveQuestions(entries: StoredQuestion[]) {
  try { localStorage.setItem(QUESTIONS_KEY, JSON.stringify(entries)); } catch { /* storage unavailable */ }
}

function AskComposer({ value, onChange, onSubmit, placeholder, disabled, busy, scope, onClearScope, autoFocus }: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  placeholder: string;
  disabled?: boolean;
  busy?: boolean;
  scope?: string | null;
  onClearScope?: () => void;
  autoFocus?: boolean;
}) {
  const { t } = useLocale();
  const field = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const node = field.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, 200)}px`;
    node.style.overflowY = node.scrollHeight > 200 ? "auto" : "hidden";
  }, [value]);

  useEffect(() => {
    if (autoFocus) field.current?.focus();
  }, [autoFocus]);

  const canSend = Boolean(value.trim()) && !disabled && !busy;
  return (
    <form className="ask-composer" onSubmit={(event) => { event.preventDefault(); if (canSend) onSubmit(); }}
      onClick={(event) => { if (event.target === event.currentTarget) field.current?.focus(); }}>
      <textarea
        ref={field}
        rows={1}
        value={value}
        maxLength={8000}
        placeholder={placeholder}
        aria-label={placeholder}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            if (canSend) onSubmit();
          }
        }}
      />
      <div className="ask-composer-bar">
        {scope ? (
          <span className="ask-scope-chip">
            <span>{t("search.ask.scope", { title: scope })}</span>
            {onClearScope ? (
              <button type="button" aria-label={t("search.ask.clearScope")} title={t("search.ask.clearScope")} onClick={onClearScope}>
                <CloseIcon />
              </button>
            ) : null}
          </span>
        ) : <span className="ask-composer-hint">{t("search.ask.hint")}</span>}
        <button type="submit" className="ask-send" disabled={!canSend} aria-label={t("search.ask.submit")} title={t("search.ask.submit")}>
          {busy ? <span className="ask-send-spinner" aria-hidden="true" /> : <ArrowUpIcon />}
        </button>
      </div>
    </form>
  );
}

export function SearchAsk({ scope, scopeNonce = 0, onClearScope }: {
  scope: { threadId: string; title: string } | null;
  scopeNonce?: number;
  onClearScope: () => void;
}) {
  const { t } = useLocale();
  const [questions, setQuestions] = useState<StoredQuestion[]>(loadQuestions);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState<SearchQuestion | null>(null);
  const [items, setItems] = useState<InboxViewItem[]>([]);
  const log = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!scopeNonce) return;
    setSelectedId(null);
    setError(null);
  }, [scopeNonce]);

  useEffect(() => {
    if (!selectedId) {
      setLive(null);
      setItems([]);
      return;
    }
    const controller = new AbortController();
    let timer = 0;
    const tick = async () => {
      try {
        const next = await fetchSearchQuestion(selectedId, controller.signal);
        if (controller.signal.aborted) return;
        setLive(next);
        setError(null);
        if (next.agent_thread_id) {
          const page = await fetchInbox(
            { thread_id: next.agent_thread_id, limit: 200 },
            { signal: controller.signal },
          );
          if (!controller.signal.aborted) setItems(page);
        }
        if (!controller.signal.aborted) timer = window.setTimeout(() => void tick(), 4000);
      } catch (caught) {
        if (controller.signal.aborted) return;
        setError(t("search.ask.loadFailed"));
      }
    };
    void tick();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [selectedId, t]);

  useEffect(() => {
    const node = log.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [items.length, selectedId]);

  const selected = questions.find((entry) => entry.id === selectedId) ?? null;
  const canFollow = Boolean(selected && live?.agent_thread_id);
  const stopped = Boolean(live?.run_status && STOPPED_RUN.has(live.run_status));
  const speech = items.filter(askSpeech);
  const answered = speech.some((item) => item.kind === "assistant");
  const settled = Boolean(live?.run_status && SETTLED_RUN.has(live.run_status));
  const thinking = Boolean(selected) && !settled && !error && !answered;

  function startNew() {
    setSelectedId(null);
    setError(null);
    setDraft("");
  }

  async function submit(text = draft.trim()) {
    if (!text || starting) return;
    setStarting(true);
    setError(null);
    try {
      if (canFollow && live?.agent_thread_id) {
        await sendReply({ thread_id: live.agent_thread_id, text });
        setDraft("");
        const page = await fetchInbox({ thread_id: live.agent_thread_id, limit: 200 });
        setItems(page);
        return;
      }
      const created = await startSearchQuestion({
        query: text,
        ...(scope ? { thread_id: scope.threadId } : {}),
      });
      const stored: StoredQuestion = {
        id: created.id,
        query: created.query || text,
        ...(scope ? { scopeThreadId: scope.threadId, scopeTitle: scope.title } : {}),
      };
      const next = [stored, ...questions.filter((entry) => entry.id !== stored.id)];
      setQuestions(next);
      saveQuestions(next);
      setDraft("");
      setSelectedId(stored.id);
      setLive(created);
    } catch (caught) {
      setError(caught instanceof KernelRequestError && (caught.code === "executor_unavailable" || caught.code === "executor_session_unavailable")
        ? t("search.ask.noExecutor")
        : caught instanceof Error ? caught.message : t("search.ask.failed"));
    } finally {
      setStarting(false);
    }
  }

  const suggestions = scope
    ? [t("search.ask.suggestScoped.1"), t("search.ask.suggestScoped.2"), t("search.ask.suggestScoped.3")]
    : [t("search.ask.suggest.1"), t("search.ask.suggest.2"), t("search.ask.suggest.3")];

  return (
    <div className={`search-ask${questions.length ? " has-rail" : ""}`}>
      {questions.length ? (
        <aside className="ask-rail" aria-label={t("search.ask.list")}>
          <button type="button" className={`ask-rail-new${selected ? "" : " is-current"}`} onClick={startNew}>
            <PlusIcon />
            <span>{t("search.ask.new")}</span>
          </button>
          <p className="ask-rail-label">{t("search.ask.recent")}</p>
          <ul>
            {questions.map((entry) => (
              <li key={entry.id}>
                <button
                  type="button"
                  className={entry.id === selectedId ? "is-current" : ""}
                  title={entry.query}
                  onClick={() => { setSelectedId(entry.id); setError(null); setDraft(""); }}
                >
                  <span>{entry.query}</span>
                  {entry.scopeTitle ? <small>{entry.scopeTitle}</small> : null}
                </button>
              </li>
            ))}
          </ul>
        </aside>
      ) : null}

      {selected ? (
        <section className="ask-thread">
          <div className="ask-log" ref={log} aria-live="polite">
            <div className="ask-column">
              {selected.scopeTitle ? (
                <p className="ask-thread-scope">{t("search.ask.scope", { title: selected.scopeTitle })}</p>
              ) : null}
              <article className="ask-message is-user"><MessageBody text={selected.query} /></article>
              {live?.run_id ? (
                <div className="ask-reads">
                  <AgentReadsCard runId={live.run_id} revision={`${live.run_status ?? ""}:${speech.length}`} />
                </div>
              ) : null}
              {speech.map((item) => item.kind === "user" ? (
                <article key={item.event.id} className="ask-message is-user">
                  <MessageBody text={item.body_text ?? ""} attachments={item.attachments} />
                </article>
              ) : (
                <article key={item.event.id} className="ask-message is-assistant">
                  <span className="ask-avatar" aria-hidden="true"><SparkleIcon /></span>
                  <div className="ask-message-body">
                    <MessageBody text={item.body_text ?? ""} attachments={item.attachments} />
                  </div>
                </article>
              ))}
              {thinking ? (
                <div className="ask-message is-assistant is-thinking">
                  <span className="ask-avatar" aria-hidden="true"><SparkleIcon /></span>
                  <span className="ask-thinking">{t("search.ask.thinking")}</span>
                </div>
              ) : null}
              {stopped ? <p className="ask-error" role="alert">{t("search.ask.runFailed")}</p> : null}
              {error ? <p className="ask-error" role="alert">{error}</p> : null}
            </div>
          </div>
          <div className="ask-dock">
            <div className="ask-column">
              <AskComposer
                value={draft}
                onChange={setDraft}
                onSubmit={() => void submit()}
                placeholder={t("search.ask.follow")}
                disabled={!canFollow}
                busy={starting}
                scope={selected.scopeTitle ?? null}
                autoFocus
              />
            </div>
          </div>
        </section>
      ) : (
        <section className="ask-hero">
          <div className="ask-column">
            <span className="ask-hero-mark" aria-hidden="true"><SparkleIcon /></span>
            <h2>{t("search.ask.heroTitle")}</h2>
            <p className="ask-hero-lead">{t("search.ask.lead")}</p>
            <AskComposer
              value={draft}
              onChange={setDraft}
              onSubmit={() => void submit()}
              placeholder={t("search.ask.placeholder")}
              busy={starting}
              scope={scope?.title ?? null}
              onClearScope={onClearScope}
              autoFocus
            />
            {error ? <p className="ask-error" role="alert">{error}</p> : null}
            <ul className="ask-suggestions" aria-label={t("search.ask.suggestLabel")}>
              {suggestions.map((text) => (
                <li key={text}>
                  <button type="button" disabled={starting} onClick={() => void submit(text)}>
                    <span>{text}</span>
                    <ArrowUpIcon />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}
    </div>
  );
}
