import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { fetchSearchSource, fetchSearchWindow, searchPersonalContext } from "./api";
import {
  applySearchWindow,
  contextSearchInput,
  SEARCH_CARD_MAX_MESSAGES,
  searchElapsedSeconds,
  searchFileType,
  searchHighlightRanges,
  searchMentionsFiles,
  searchMessageText,
  searchSnippetPreview,
  searchWindowRequest,
  type SearchWindowTarget,
} from "./context-search";
import { KernelRequestError } from "./kernel-request";
import { useLocale } from "./LocaleContext";
import { SearchAnswerCard } from "./SearchAnswerCard";
import type {
  InboxViewItem,
  PersonalExpandedSearchResult,
  PersonalSearchConversation,
  PersonalSearchMatch,
  PersonalSearchMessage,
} from "./types";
import { isMessageKey } from "../../shared/messages";

const RECENT_KEY = "regenic.search.recent";
const RECENT_LIMIT = 8;
const DEFAULT_LIMIT = 10;
const INFORMATIONAL_FLAGS = new Set(["model_absent", "graph_absent", "rerank_absent"]);

function loadRecent(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string").slice(0, RECENT_LIMIT) : [];
  } catch {
    return [];
  }
}

function saveRecent(entries: string[]) {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(entries)); } catch { /* storage unavailable */ }
}

function highlight(text: string, query: string): ReactNode {
  const ranges = searchHighlightRanges(text, query);
  if (!ranges.length) return text;
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (start > cursor) parts.push(text.slice(cursor, start));
    parts.push(<mark key={start}>{text.slice(start, end)}</mark>);
    cursor = end;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}

export function SearchPage({ onSettings, onOpenConversation }: {
  onSettings: () => void;
  onOpenConversation: (item: InboxViewItem) => void;
}) {
  const { t, locale } = useLocale();
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<"all" | "messages" | "files">("all");
  const [source, setSource] = useState("");
  const [thread, setThread] = useState("");
  const [limit, setLimit] = useState(DEFAULT_LIMIT);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [recent, setRecent] = useState<string[]>(loadRecent);
  const [result, setResult] = useState<PersonalExpandedSearchResult | null>(null);
  const [submitted, setSubmitted] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [cards, setCards] = useState<PersonalSearchConversation[]>([]);
  const [loadingMore, setLoadingMore] = useState<string | null>(null);
  const [cited, setCited] = useState<string | null>(null);
  const pending = useRef<AbortController | null>(null);
  const openPending = useRef<AbortController | null>(null);
  const morePending = useRef<AbortController | null>(null);
  const input = useRef<HTMLInputElement | null>(null);
  const [elapsed, setElapsed] = useState<number | null>(null);

  useEffect(() => {
    const reset = () => {
      pending.current?.abort(); pending.current = null;
      openPending.current?.abort(); openPending.current = null;
      morePending.current?.abort(); morePending.current = null;
      setBusy(false); setResult(null); setCards([]); setError(null);
      setOpening(null); setLoadingMore(null); setElapsed(null);
    };
    const unsubscribe = window.regenic?.onApiOriginChanged(reset);
    return () => {
      pending.current?.abort(); openPending.current?.abort(); morePending.current?.abort(); unsubscribe?.();
    };
  }, []);

  const activeFilters = (source.trim() ? 1 : 0) + (thread.trim() ? 1 : 0) + (limit !== DEFAULT_LIMIT ? 1 : 0);

  function cancel() {
    pending.current?.abort(); pending.current = null; setBusy(false);
  }

  async function search(text = query, filters = { source, thread, limit }, searchKind = kind) {
    pending.current?.abort();
    openPending.current?.abort();
    morePending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setResult(null); setCards([]); setError(null); setBusy(true);
    setOpening(null); setLoadingMore(null); setElapsed(null);
    const started = performance.now();
    try {
      const searchInput = contextSearchInput(text, filters.source, filters.thread, filters.limit, searchKind);
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(90_000)]);
      const next = await searchPersonalContext(searchInput, signal).catch((caught: unknown) => {
        if (caught instanceof KernelRequestError && caught.code === "context_changed" && !signal.aborted) {
          return searchPersonalContext(searchInput, signal);
        }
        throw caught;
      });
      if (!controller.signal.aborted && pending.current === controller) {
        setResult(next); setCards(next.conversations);
        setSubmitted(searchInput.query); setElapsed(Math.round(performance.now() - started));
        const nextRecent = [searchInput.query, ...recent.filter((entry) => entry !== searchInput.query)].slice(0, RECENT_LIMIT);
        setRecent(nextRecent); saveRecent(nextRecent);
      }
    } catch (caught) {
      if (!controller.signal.aborted && pending.current === controller) {
        const message = caught instanceof Error ? caught.message : "";
        setError(isMessageKey(message) ? t(message) : message || t("search.failed"));
      }
    } finally {
      if (pending.current === controller) { pending.current = null; setBusy(false); }
    }
  }

  async function open(
    message: { event_id: string; content_hash: string },
    partIndex?: number,
  ) {
    openPending.current?.abort();
    const controller = new AbortController();
    openPending.current = controller;
    setOpening(message.event_id); setError(null);
    try {
      const opened = await fetchSearchSource({
        event_id: message.event_id, content_hash: message.content_hash,
        ...(partIndex === undefined ? {} : { part_index: partIndex }),
      }, controller.signal);
      if (controller.signal.aborted) return;
      if (opened.item) onOpenConversation(opened.item);
      else setError(t("search.noConversation"));
    } catch (caught) {
      if (controller.signal.aborted) return;
      setError(caught instanceof KernelRequestError && caught.code === "not_found"
        ? t("search.sourceUnavailable")
        : caught instanceof Error ? caught.message : t("search.failed"));
    } finally {
      if (openPending.current === controller) { openPending.current = null; setOpening(null); }
    }
  }

  async function loadMore(card: PersonalSearchConversation, target: SearchWindowTarget, key: string) {
    const request = searchWindowRequest(card, target);
    if (!request) return;
    morePending.current?.abort();
    const controller = new AbortController();
    morePending.current = controller;
    setLoadingMore(key); setError(null);
    try {
      const page = await fetchSearchWindow(request, controller.signal);
      if (controller.signal.aborted) return;
      setCards((current) => current.map((entry) =>
        entry.thread_id === card.thread_id ? applySearchWindow(entry, target, page) : entry));
    } catch (caught) {
      if (
        caught instanceof KernelRequestError &&
        caught.code === "context_changed"
      ) {
        await search(submitted, { source, thread, limit });
      } else if (!controller.signal.aborted) {
        setError(caught instanceof Error ? caught.message : t("search.failed"));
      }
    } finally {
      if (morePending.current === controller) { morePending.current = null; setLoadingMore(null); }
    }
  }

  function cite(eventId: string) {
    document.getElementById(searchMessageElementId(eventId))?.scrollIntoView({ block: "center", behavior: "smooth" });
    setCited(eventId);
    window.setTimeout(() => setCited((current) => current === eventId ? null : current), 1_600);
  }

  function runRecent(entry: string) {
    setQuery(entry);
    void search(entry);
  }

  function clearFilters() {
    setSource(""); setThread(""); setLimit(DEFAULT_LIMIT);
  }

  const notices = useMemo(() => {
    const flags = result?.degradation_flags ?? [];
    return {
      warnings: flags.filter((flag) => !INFORMATIONAL_FLAGS.has(flag)),
      info: flags.filter((flag) => INFORMATIONAL_FLAGS.has(flag)),
    };
  }, [result]);

  const flagText = (flag: string) => {
    const key = `search.flag.${flag}`;
    return isMessageKey(key) ? t(key) : t("search.flag.unknown");
  };
  const warningTexts = [...new Set(notices.warnings.map(flagText))];
  const fileCount = result?.items.reduce((sum, hit) =>
    sum + (hit.matches ?? []).filter((match) => match.kind === "file").length, 0) ?? 0;
  const summary = !result ? "" : result.items.length && kind === "files"
    ? t("search.summary.files", { files: fileCount })
    : kind === "messages" ? t("search.summary.messages", { count: result.items.length })
      : fileCount ? t("search.summary.allFiles", { count: result.items.length, files: fileCount })
        : t("search.summary.all", { count: result.items.length });
  const suggestFiles = result !== null && kind !== "files" && searchMentionsFiles(submitted);

  return (
    <div className="page page-wide semantic-search-page">
      <header className="page-hero search-hero">
        <div>
          <h1>{t("search.title")}</h1>
          <p className="page-lead">{t("search.lead")}</p>
        </div>
        <button type="button" className="ghost" onClick={onSettings}>{t("semantic.title")}</button>
      </header>

      <form className="semantic-search-form" onSubmit={(event) => { event.preventDefault(); void search(); }}>
        <div className="search-box">
          <svg className="search-box-icon" viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <input id="context-query" ref={input} type="search" value={query} maxLength={8000}
            aria-label={t("search.query")} placeholder={t("search.placeholder")} autoFocus
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Escape" && busy) { event.preventDefault(); cancel(); } }} />
          {busy ? (
            <button type="button" className="ghost" onClick={cancel}>{t("search.cancel")}</button>
          ) : null}
          <button type="submit" className="primary" disabled={!query.trim()}>
            {busy ? t("search.searchAgain") : t("search.submit")}
          </button>
        </div>
        <div className="search-toolbar">
          <div className="search-recent" role="group" aria-label={t("search.kind")}>
            {(["all", "messages", "files"] as const).map((value) => (
              <button type="button" className="search-recent-chip" key={value}
                aria-pressed={kind === value} onClick={() => {
                  setKind(value);
                  if (query.trim()) void search(query, { source, thread, limit }, value);
                }}>{t(`search.kind.${value}`)}</button>
            ))}
          </div>
          <button type="button" className={`link search-filter-toggle${filtersOpen ? " is-open" : ""}`}
            aria-expanded={filtersOpen} onClick={() => setFiltersOpen((value) => !value)}>
            {activeFilters ? t("search.filtersActive", { count: activeFilters }) : t("search.filters")}
          </button>
          {activeFilters ? <button type="button" className="link muted-link" onClick={clearFilters}>{t("search.clearFilters")}</button> : null}
          <span className="muted search-shortcut">{t("search.shortcut")}</span>
        </div>
        {filtersOpen ? (
          <div className="semantic-filters">
            <label className="field">{t("search.source")}<input value={source} onChange={(event) => setSource(event.target.value)} /></label>
            <label className="field">{t("search.thread")}<input value={thread} onChange={(event) => setThread(event.target.value)} /></label>
            <label className="field">{t("search.limit")}<select value={limit} onChange={(event) => setLimit(Number(event.target.value))}>
              {[10, 20].map((value) => <option key={value} value={value}>{value}</option>)}
            </select></label>
          </div>
        ) : null}
      </form>

      <div className="search-body" aria-live="polite" aria-busy={busy}>
        {busy ? (
          <ol className="semantic-results is-loading" aria-label={t("search.loading")}>
            {[0, 1, 2].map((index) => <li key={index} className="search-skeleton"><span /><span /><span /></li>)}
          </ol>
        ) : null}
        {error ? <p role="alert" className="action-error">{error}</p> : null}

        {!busy && !result && !error ? (
          <div className="search-empty-state">
            {recent.length ? (
              <>
                <div className="search-recent-head">
                  <span className="muted">{t("search.recent")}</span>
                  <button type="button" className="link muted-link" onClick={() => { setRecent([]); saveRecent([]); }}>
                    {t("search.clearRecent")}
                  </button>
                </div>
                <div className="search-recent">
                  {recent.map((entry) => (
                    <button type="button" key={entry} className="search-recent-chip" onClick={() => runRecent(entry)}>{entry}</button>
                  ))}
                </div>
              </>
            ) : <p className="muted">{t("search.idle")}</p>}
          </div>
        ) : null}

        {result ? (
          <>
            <div className="semantic-search-meta">
              <span className="search-summary">{summary}</span>
              <span className={`search-mode${result.generation ? " is-hybrid" : ""}`}
                title={t(result.generation ? "search.hybridHint" : "search.lexicalHint")}>
                {t(result.generation ? "search.hybrid" : "search.lexical")}
              </span>
              {result.coverage ? (
                <span className="muted">{t("search.coverage", {
                  covered: result.coverage.covered_count, authorized: result.coverage.authorized_count,
                })}</span>
              ) : null}
              {elapsed !== null ? <span className="muted">{t("search.elapsed", { seconds: searchElapsedSeconds(elapsed) })}</span> : null}
              <details className="search-trace">
                <summary>{t("search.trace")}</summary>
                <dl><dt>snapshot</dt><dd>{result.snapshot_id}</dd>
                  <dt>profile</dt><dd>{result.retrieval_profile}</dd>
                  <dt>generation</dt><dd>{result.generation ?? "—"}</dd>
                  <dt>read_epoch</dt><dd>{result.read_epoch}</dd>
                  {result.degradation_flags.length ? <><dt>flags</dt><dd>{result.degradation_flags.join(", ")}</dd></> : null}</dl>
                {notices.info.length ? <ul>{notices.info.map((flag) => <li key={flag}>{flagText(flag)}</li>)}</ul> : null}
              </details>
            </div>
            {warningTexts.length ? (
              <div className="search-warning" role="status">
                <svg className="search-notice-icon" viewBox="0 0 16 16" aria-hidden="true">
                  <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
                  <path d="M8 7.25v4M8 4.75v.01" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
                {warningTexts.length === 1 ? <p>{warningTexts[0]}</p>
                  : <ul>{warningTexts.map((text) => <li key={text}>{text}</li>)}</ul>}
                {!result.generation ? (
                  <button type="button" className="ghost search-notice-action" onClick={onSettings}>{t("search.enableSemantic")}</button>
                ) : null}
              </div>
            ) : null}
            {suggestFiles ? (
              <div className="search-suggestion" role="note">
                <p>{t("search.fileIntent")}</p>
                <button type="button" className="ghost search-notice-action" onClick={() => {
                  setKind("files");
                  void search(submitted, { source, thread, limit }, "files");
                }}>{t("search.fileIntentApply")}</button>
              </div>
            ) : null}
            {result.items.some((hit) => hit.matches?.some((match) => match.kind === "event"))
              ? <p className="muted">{t("search.eventOnly")}</p> : null}
            {!result.items.length ? (
              <div className="search-empty-state">
                <p>{t("search.empty")}</p>
                {activeFilters ? <button type="button" className="ghost" onClick={() => {
                  clearFilters(); void search(submitted, { source: "", thread: "", limit: DEFAULT_LIMIT });
                }}>{t("search.clearFiltersAndRetry")}</button> : null}
              </div>
            ) : null}
            {cards.length ? (
              <SearchAnswerCard key={`${result.snapshot_id}:${submitted}`} query={submitted}
                conversations={cards} onCite={cite} />
            ) : null}
            <ol className="semantic-results">
              {result.items.map((hit) => <Fragment key={hit.event_id}>
                {(hit.matches ?? []).filter((match) => match.kind === "file")
                .map((file) => (
                  <FileResult key={`${hit.event_id}:${file.part_index}`} hit={hit} file={file} query={submitted}
                    locale={locale} opening={opening === hit.event_id} disabled={opening !== null}
                    onOpen={() => void open(hit, file.part_index)} />
                ))}
              {cards.filter((conversation) => conversation.anchor_event_ids[0] === hit.event_id).map((conversation) => (
                <ConversationCard key={conversation.thread_id} conversation={conversation} query={submitted}
                  locale={locale} opening={opening} loading={loadingMore} cited={cited}
                  onOpen={(message) => void open(message)}
                  onLoad={(target, key) => void loadMore(conversation, target, key)} />
              ))}
              </Fragment>)}
            </ol>
            {result.truncated ? <p className="search-footnote">{t("search.truncated")}</p> : null}
          </>
        ) : null}
      </div>
    </div>
  );
}

function FileResult({ hit, file, query, locale, opening, disabled, onOpen }: {
  hit: PersonalExpandedSearchResult["items"][number];
  file: PersonalSearchMatch;
  query: string;
  locale: string;
  opening: boolean;
  disabled: boolean;
  onOpen: () => void;
}) {
  const { t } = useLocale();
  const [expanded, setExpanded] = useState(false);
  const type = searchFileType(file.filename, file.media_type);
  const preview = file.snippet === undefined ? null : searchSnippetPreview(file.snippet);
  const snippetId = `search-file-snippet-${hit.event_id}-${file.part_index}`;
  const occurred = new Date(hit.occurred_at);
  return (
    <li className="semantic-result search-file">
      <div className="search-file-head">
        <span className={`search-file-icon is-${type.category}`} aria-hidden="true">
          {type.badge || <svg viewBox="0 0 16 16"><path d="M4 1.75h5L12.25 5v9.25H4z M9 1.75V5h3.25"
            fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /></svg>}
        </span>
        <div className="search-file-title">
          <h3 title={file.filename}>{highlight(file.filename ?? t("search.unnamedFile"), query)}</h3>
          <p className="search-file-meta">
            <span>{type.format ?? t("search.fileType.generic")}</span>
            <span>{hit.source}</span>
            <time dateTime={hit.occurred_at}>{occurred.toLocaleString(locale, {
              year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit",
            })}</time>
          </p>
        </div>
        <button type="button" className="ghost search-file-open" disabled={disabled} onClick={onOpen}>
          {opening ? t("search.opening") : t("search.openSource")}
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.5h6.5V10M12.25 3.75 4 12"
            fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
      </div>
      <ul className="search-file-via" aria-label={t("search.matchVia")}>
        {file.via.map((via) => <li key={via} className={`is-${via}`}>{t(`search.via.${via}`)}</li>)}
      </ul>
      {preview ? (
        <div className="search-file-excerpt">
          <p id={snippetId} className={`search-file-snippet${type.code ? " is-code" : ""}${expanded ? " is-expanded" : ""}`}>
            {highlight(preview.text, query)}
          </p>
          {preview.long ? (
            <button type="button" className="link search-file-more" aria-expanded={expanded} aria-controls={snippetId}
              onClick={() => setExpanded((value) => !value)}>
              {expanded ? t("search.showLess") : t("search.showMore")}
            </button>
          ) : null}
        </div>
      ) : <p className="search-file-whole">{t("search.wholeFile")}</p>}
      <details className="search-file-details">
        <summary>{t("search.details")}</summary>
        <p>{file.start !== undefined && file.end !== undefined
          ? t("search.textRange", { start: file.start, end: file.end })
          : t("search.noRegion")}</p>
        <p className="search-file-details-title">{t("search.fileIdentity")}</p>
        <dl>
          <dt>media type</dt><dd>{file.media_type ?? "—"}</dd>
          <dt>event</dt><dd>{hit.event_id}</dd><dt>part</dt><dd>{file.part_index}</dd>
          <dt>event hash</dt><dd>{hit.content_hash}</dd>
          {file.content_hash ? <><dt>file hash</dt><dd>{file.content_hash}</dd></> : null}
        </dl>
      </details>
    </li>
  );
}

function searchMessageElementId(eventId: string): string {
  return `search-message-${eventId}`;
}

function ConversationCard({ conversation, query, locale, opening, loading, cited, onOpen, onLoad }: {
  conversation: PersonalSearchConversation;
  query: string;
  locale: string;
  opening: string | null;
  loading: string | null;
  cited: string | null;
  onOpen: (message: PersonalSearchMessage) => void;
  onLoad: (target: SearchWindowTarget, key: string) => void;
}) {
  const { t } = useLocale();
  const { messages, continuation } = conversation;
  const byId = new Map(messages.map((message) => [message.event_id, message]));
  const gapBefore = new Map(continuation.gaps.map((gap, index) => [gap.before.event_id, index]));
  const full = messages.length >= SEARCH_CARD_MAX_MESSAGES;
  const sender = (message: PersonalSearchMessage) => message.actor_label ?? message.actor_id ?? t("search.unknownSender");
  const text = (message: PersonalSearchMessage) => searchMessageText(message, {
    image: t("search.attachmentImage"),
    file: (name) => t("search.attachmentFile", { name }),
  });
  const time = (value: string) => new Date(value).toLocaleString(locale, {
    month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
  const first = messages[0];
  const last = messages.at(-1);
  const marker = (label: string, target: SearchWindowTarget, anchor: PersonalSearchMessage | undefined) => {
    if (!anchor) return null;
    const key = `${conversation.thread_id}:${target.kind}:${"index" in target ? target.index : ""}`;
    return (
      <li className="search-thread-gap">
        {full ? (
          <button type="button" className="link muted-link" disabled={opening !== null} onClick={() => onOpen(anchor)}>
            {t("search.openForMore")}
          </button>
        ) : (
          <button type="button" className="link muted-link" disabled={loading !== null} onClick={() => onLoad(target, key)}>
            {loading === key ? t("search.loadingMore") : label}
          </button>
        )}
      </li>
    );
  };

  return (
    <li className="semantic-result search-thread">
      <header className="semantic-result-head search-thread-head">
        <span className="semantic-result-source">{conversation.title ?? t("search.untitled")}</span>
        <span className="muted">
          {conversation.channel_label ?? first?.source}
          {first && last ? <> · <time dateTime={first.occurred_at}>{time(first.occurred_at)}</time>
            {last !== first ? <>–<time dateTime={last.occurred_at}>{time(last.occurred_at)}</time></> : null}</> : null}
        </span>
      </header>
      <ol className="search-thread-messages">
        {continuation.before ? marker(t("search.loadEarlier"), { kind: "before" }, first) : null}
        {messages.map((message) => {
          const parent = message.reply_to_event_id ? byId.get(message.reply_to_event_id) : undefined;
          const gap = gapBefore.get(message.event_id);
          return (
            <Fragment key={message.event_id}>
              {gap !== undefined ? marker(t("search.loadGap"), { kind: "gap", index: gap }, message) : null}
              <li id={searchMessageElementId(message.event_id)}
                className={`search-message is-${message.selection_reason}${cited === message.event_id ? " is-cited" : ""}`}>
                <button type="button" className="search-message-main" disabled={opening !== null}
                  title={t("search.openConversation")} onClick={() => onOpen(message)}>
                  <span className="search-message-head">
                    <span className="search-message-sender">{sender(message)}</span>
                    <time dateTime={message.occurred_at}>{time(message.occurred_at)}</time>
                    {opening === message.event_id ? <span className="muted">{t("search.opening")}</span> : null}
                  </span>
                  {parent ? (
                    <span className="search-message-quote">
                      {t("search.replyTo", { name: sender(parent) })}: {text(parent)}
                    </span>
                  ) : null}
                  <span className="semantic-snippet">
                    {message.selection_reason === "hit" ? highlight(text(message), query) : text(message)}
                  </span>
                </button>
              </li>
            </Fragment>
          );
        })}
        {continuation.after ? marker(t("search.loadLater"), { kind: "after" }, last) : null}
      </ol>
    </li>
  );
}
