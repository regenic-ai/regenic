import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  fetchEngine,
  fetchInbox,
  fetchSearchQuestion,
  sendReply,
  startSearchQuestion,
  type SearchQuestion,
} from "./api";
import { askSpeech } from "./ask-speech";
import { AskTurns, askTurns } from "./AskTurns";
import { RunStatusIcon } from "./RunCard";
import { ArrowUpIcon, ChevronIcon, CloseIcon, PlusIcon, SparkleIcon } from "./Icons";
import { KernelRequestError } from "./kernel-request";
import { MessageBody } from "./MessageBody";
import { useLocale } from "./LocaleContext";
import type { InboxViewItem } from "./types";

const QUESTIONS_KEY = "regenic.search.questions";
const EXECUTOR_KEY = "regenic.search.executor";
const STOPPED_RUN = new Set(["failed", "cancelled", "canceled", "aborted"]);
const SETTLED_RUN = new Set(["completed", "done", ...STOPPED_RUN]);

interface StoredQuestion {
  id: string;
  query: string;
  scopeThreadId?: string;
  scopeTitle?: string;
  executorType?: string;
  askedAt?: string;
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

const QUESTIONS_CLEARED = "regenic-search-questions-cleared";

export function clearStoredQuestions(): void {
  try { localStorage.removeItem(QUESTIONS_KEY); } catch { /* storage unavailable */ }
  window.dispatchEvent(new Event(QUESTIONS_CLEARED));
}

function loadExecutor(): string {
  try { return localStorage.getItem(EXECUTOR_KEY) ?? ""; } catch { return ""; }
}

function saveExecutor(executorType: string) {
  try { localStorage.setItem(EXECUTOR_KEY, executorType); } catch { /* storage unavailable */ }
}

function AgentSwitch({ agents, value, onChange, lockedLabel }: {
  agents: Array<{ value: string; label: string }>;
  value: string;
  onChange?: (value: string) => void;
  lockedLabel?: string;
}) {
  const { t } = useLocale();
  const root = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const current = agents.find((item) => item.value === value);
  const label = lockedLabel || current?.label || "";
  const selectable = !lockedLabel && Boolean(onChange) && agents.length > 0;

  useEffect(() => {
    if (!open) return;
    const onDoc = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  if (!label) return null;
  if (!selectable) return <span className="ask-agent-current">{label}</span>;

  const choose = (executorType: string) => {
    onChange?.(executorType);
    setOpen(false);
  };

  return (
    <div className="ask-agent" ref={root}>
      <button
        type="button"
        className={`ask-agent-trigger${open ? " is-open" : ""}`}
        aria-label={t("search.ask.agent")}
        aria-haspopup="listbox"
        aria-expanded={open}
        onMouseDown={(event) => event.preventDefault()}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setActive(Math.max(0, agents.findIndex((item) => item.value === value)));
          setOpen((shown) => !shown);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            if (!open) {
              setOpen(true);
              return;
            }
            const delta = event.key === "ArrowDown" ? 1 : -1;
            setActive((index) => (index + delta + agents.length) % agents.length);
          } else if (event.key === "Enter" && open) {
            event.preventDefault();
            const next = agents[active];
            if (next) choose(next.value);
          } else if (event.key === "Escape" && open) {
            event.preventDefault();
            setOpen(false);
          }
        }}
      >
        <span>{label}</span>
        <ChevronIcon />
      </button>
      {open ? (
        <ul className="ask-agent-menu" role="listbox" aria-label={t("search.ask.agent")}>
          {agents.map((item, index) => (
            <li key={item.value}>
              <button
                type="button"
                role="option"
                aria-selected={item.value === value}
                className={`ask-agent-option${item.value === value ? " is-on" : ""}${index === active ? " is-active" : ""}`}
                onMouseEnter={() => setActive(index)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  choose(item.value);
                }}
              >
                <span>{item.label}</span>
                {item.value === value ? (
                  <svg className="ask-agent-check" viewBox="0 0 16 16" aria-hidden="true">
                    <path d="M3.5 8.2 6.4 11 12.5 4.8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                ) : <span className="ask-agent-check" aria-hidden="true" />}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function AskComposer({ value, onChange, onSubmit, placeholder, disabled, busy, scope, onClearScope, autoFocus, agents = [], agent = "", onAgent, agentLabel }: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  placeholder: string;
  disabled?: boolean;
  busy?: boolean;
  scope?: string | null;
  onClearScope?: () => void;
  autoFocus?: boolean;
  agents?: Array<{ value: string; label: string }>;
  agent?: string;
  onAgent?: (value: string) => void;
  agentLabel?: string;
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
        <div className="ask-composer-tools">
          <AgentSwitch agents={agents} value={agent} onChange={onAgent} lockedLabel={agentLabel} />
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
        </div>
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
  const { t, locale } = useLocale();
  const [questions, setQuestions] = useState<StoredQuestion[]>(loadQuestions);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState<SearchQuestion | null>(null);
  const [items, setItems] = useState<InboxViewItem[]>([]);
  const [agents, setAgents] = useState<Array<{ value: string; label: string }>>([]);
  const [agent, setAgent] = useState(loadExecutor);
  const [railStates, setRailStates] = useState<Record<string, "running" | "failed" | undefined>>({});
  const log = useRef<HTMLDivElement>(null);
  const loadedQuestion = useRef<string | null>(null);

  useEffect(() => {
    if (!scopeNonce) return;
    setSelectedId(null);
    setError(null);
  }, [scopeNonce]);

  useEffect(() => {
    const onCleared = () => {
      loadedQuestion.current = null;
      setQuestions([]);
      setSelectedId(null);
      setDraft("");
      setError(null);
      setLive(null);
      setItems([]);
      setRailStates({});
    };
    window.addEventListener(QUESTIONS_CLEARED, onCleared);
    return () => window.removeEventListener(QUESTIONS_CLEARED, onCleared);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const engine = await fetchEngine();
        if (controller.signal.aborted) return;
        const next = engine.executor_installations
          .filter((item) => item.status !== "disabled" && item.context_self_serve === true)
          .map((item) => ({ value: item.id, label: item.label || item.name }))
          .sort((left, right) => left.label.localeCompare(right.label, locale));
        setAgents(next);
        setAgent((current) => {
          const chosen = next.some((item) => item.value === current) ? current : (next[0]?.value ?? "");
          saveExecutor(chosen);
          return chosen;
        });
      } catch {
        if (!controller.signal.aborted) setAgents([]);
      }
    })();
    return () => controller.abort();
  }, [locale]);

  useEffect(() => {
    if (!selectedId) {
      loadedQuestion.current = null;
      setLive(null);
      setItems([]);
      return;
    }
    if (loadedQuestion.current !== selectedId) {
      setLive(null);
      setItems([]);
    }
    const controller = new AbortController();
    let timer = 0;
    const tick = async () => {
      try {
        const next = await fetchSearchQuestion(selectedId, controller.signal);
        if (controller.signal.aborted) return;
        setLive(next);
        const railState = next.run_status && STOPPED_RUN.has(next.run_status)
          ? "failed"
          : next.run_status && SETTLED_RUN.has(next.run_status) ? undefined : "running";
        setRailStates((current) => current[selectedId] === railState
          ? current
          : { ...current, [selectedId]: railState });
        if (next.agent_thread_id) {
          const page = await fetchInbox(
            { thread_id: next.agent_thread_id, limit: 200 },
            { signal: controller.signal },
          );
          if (controller.signal.aborted) return;
          setItems(page);
        }
        loadedQuestion.current = selectedId;
        setError(null);
      } catch {
        if (controller.signal.aborted) return;
        if (loadedQuestion.current !== selectedId) setError(t("search.ask.loadFailed"));
      }
      if (!controller.signal.aborted) timer = window.setTimeout(() => void tick(), 4000);
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
  const turns = askTurns(items, speech, selected?.askedAt);
  const lastTurn = turns[turns.length - 1];
  const lastAnswered = Boolean(lastTurn?.answers.length);
  const thinking = Boolean(selected) && !settled && !error && (!answered || !lastAnswered);
  const lastQuestionText = lastTurn?.question?.body_text?.trim() || selected?.query || "";

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
      const askedAt = new Date().toISOString();
      const created = await startSearchQuestion({
        query: text,
        ...(scope ? { thread_id: scope.threadId } : {}),
        ...(agent ? { executor_type: agent } : {}),
      });
      const stored: StoredQuestion = {
        id: created.id,
        query: created.query || text,
        ...(scope ? { scopeThreadId: scope.threadId, scopeTitle: scope.title } : {}),
        ...(created.executor_type || agent ? { executorType: created.executor_type || agent } : {}),
        askedAt: askedAt,
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

  function chooseAgent(executorType: string) {
    setAgent(executorType);
    saveExecutor(executorType);
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
                  <span>
                    {entry.query}
                    {railStates[entry.id] ? (
                      <span
                        className={`ask-rail-state is-${railStates[entry.id]}`}
                        title={railStates[entry.id] === "failed" ? t("run.ask.failedDot") : t("run.ask.live")}
                      >
                        {railStates[entry.id] === "failed"
                          ? <span className="ask-rail-dot" aria-hidden="true" />
                          : <RunStatusIcon status="running" />}
                        <span className="sr-only">
                          {railStates[entry.id] === "failed" ? t("run.ask.failedDot") : t("run.ask.live")}
                        </span>
                      </span>
                    ) : null}
                  </span>
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
              <AskTurns
                turns={turns}
                runId={live?.run_id}
                revision={`${live?.run_status ?? ""}:${speech.length}`}
                thinking={thinking}
                stopped={stopped}
                onRetry={() => void submit(lastQuestionText)}
              />
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
                agentLabel={agents.find((item) => item.value === (selected.executorType || live?.executor_type))?.label}
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
              agents={agents}
              agent={agent}
              onAgent={chooseAgent}
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
