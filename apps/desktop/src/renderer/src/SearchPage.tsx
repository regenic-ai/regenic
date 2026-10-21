import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { searchPersonalContext } from "./api";
import { contextSearchInput } from "./context-search";
import { useLocale } from "./LocaleContext";
import type { InboxViewItem, PersonalContextSearchResult } from "./types";
import { isMessageKey } from "../../shared/messages";
import { SearchSourceDialog } from "./SearchSourceDialog";

const RECENT_KEY = "regenic.search.recent";
const RECENT_LIMIT = 8;
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function highlight(text: string, query: string): ReactNode {
  const terms = [...new Set(query.split(/\s+/).map((term) => term.trim()).filter((term) => term.length >= 2))];
  if (!terms.length) return text;
  const pattern = new RegExp(`(${terms.map(escapeRegExp).join("|")})`, "gi");
  const lower = new Set(terms.map((term) => term.toLowerCase()));
  return text.split(pattern).map((part, index) =>
    lower.has(part.toLowerCase()) ? <mark key={index}>{part}</mark> : part);
}

export function SearchPage({ onSettings, onOpenConversation }: {
  onSettings: () => void;
  onOpenConversation: (item: InboxViewItem) => void;
}) {
  const { t, locale } = useLocale();
  const [query, setQuery] = useState("");
  const [source, setSource] = useState("");
  const [thread, setThread] = useState("");
  const [limit, setLimit] = useState(20);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [recent, setRecent] = useState<string[]>(loadRecent);
  const [result, setResult] = useState<PersonalContextSearchResult | null>(null);
  const [submitted, setSubmitted] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<AbortController | null>(null);
  const input = useRef<HTMLInputElement | null>(null);
  const [sourceReference, setSourceReference] = useState<{ event_id: string; content_hash: string } | null>(null);
  const [elapsed, setElapsed] = useState<number | null>(null);

  useEffect(() => {
    const reset = () => {
      pending.current?.abort();
      pending.current = null;
      setBusy(false); setResult(null); setError(null);
      setSourceReference(null); setElapsed(null);
    };
    const unsubscribe = window.regenic?.onApiOriginChanged(reset);
    return () => { pending.current?.abort(); unsubscribe?.(); };
  }, []);

  const activeFilters = (source.trim() ? 1 : 0) + (thread.trim() ? 1 : 0) + (limit !== 20 ? 1 : 0);

  function cancel() {
    pending.current?.abort(); pending.current = null; setBusy(false);
  }

  async function search(text = query, filters = { source, thread, limit }) {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setResult(null); setError(null); setBusy(true);
    setSourceReference(null); setElapsed(null);
    const started = performance.now();
    try {
      const searchInput = contextSearchInput(text, filters.source, filters.thread, filters.limit);
      const next = await searchPersonalContext(searchInput, AbortSignal.any([controller.signal, AbortSignal.timeout(90_000)]));
      if (!controller.signal.aborted && pending.current === controller) {
        setResult(next); setSubmitted(searchInput.query); setElapsed(Math.round(performance.now() - started));
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

  function runRecent(entry: string) {
    setQuery(entry);
    void search(entry);
  }

  function clearFilters() {
    setSource(""); setThread(""); setLimit(20);
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
    return isMessageKey(key) ? t(key) : flag;
  };

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
              {[10, 20, 50, 100].map((value) => <option key={value} value={value}>{value}</option>)}
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
              <span className={`chip ${result.generation ? "running" : ""}`}>
                {t(result.generation ? "search.hybrid" : "search.lexical")}
              </span>
              <span>{t("search.count", { count: result.items.length })}</span>
              {result.coverage ? (
                <span className="muted">{t("search.coverage", {
                  covered: result.coverage.covered_count, authorized: result.coverage.authorized_count,
                })}</span>
              ) : null}
              {elapsed !== null ? <span className="muted">{t("search.elapsed", { ms: elapsed })}</span> : null}
              <details className="search-trace">
                <summary>{t("search.trace")}</summary>
                <dl><dt>snapshot</dt><dd>{result.snapshot_id}</dd>
                  <dt>profile</dt><dd>{result.retrieval_profile}</dd>
                  <dt>generation</dt><dd>{result.generation ?? "—"}</dd>
                  <dt>read_epoch</dt><dd>{result.read_epoch}</dd></dl>
                {notices.info.length ? <ul>{notices.info.map((flag) => <li key={flag}>{flagText(flag)}</li>)}</ul> : null}
              </details>
            </div>
            {notices.warnings.length ? (
              <div className="search-warning" role="status">
                <ul>{notices.warnings.map((flag) => <li key={flag}>{flagText(flag)}</li>)}</ul>
                {!result.generation ? (
                  <button type="button" className="link" onClick={onSettings}>{t("search.enableSemantic")}</button>
                ) : null}
              </div>
            ) : null}
            {result.truncated ? <p className="muted">{t("search.truncated")}</p> : null}
            {!result.items.length ? (
              <div className="search-empty-state">
                <p>{t("search.empty")}</p>
                {activeFilters ? <button type="button" className="ghost" onClick={() => {
                  clearFilters(); void search(submitted, { source: "", thread: "", limit: 20 });
                }}>{t("search.clearFiltersAndRetry")}</button> : null}
              </div>
            ) : null}
            <ol className="semantic-results">
              {result.items.map((item) => (
                <li key={item.event_id} className="semantic-result">
                  <button type="button" className="semantic-result-main" onClick={() => setSourceReference({
                    event_id: item.event_id, content_hash: item.content_hash,
                  })}>
                    <span className="semantic-result-head">
                      <span className="semantic-result-source">{item.source}</span>
                      <time dateTime={item.occurred_at}>{new Date(item.occurred_at).toLocaleString(locale)}</time>
                    </span>
                    <span className="semantic-snippet">{highlight(item.snippet, submitted)}</span>
                    <span className="semantic-result-open">{t("search.viewSource")} →</span>
                  </button>
                  <details className="semantic-result-evidence"><summary>{t("search.evidence")}</summary>
                    <dl><dt>{t("search.rank")}</dt><dd>#{item.rank}</dd>
                      <dt>Event</dt><dd>{item.event_id}</dd>
                      <dt>SHA-256</dt><dd>{item.content_hash}</dd>
                      <dt>{t("search.interval")}</dt><dd>{item.snippet_start}–{item.snippet_end}</dd></dl>
                    <ul>{item.evidence.map((entry) => <li key={entry.event_id}>
                      <code>{entry.event_id}</code>
                    </li>)}</ul>
                  </details>
                </li>
              ))}
            </ol>
          </>
        ) : null}
      </div>
      {sourceReference ? <SearchSourceDialog reference={sourceReference}
        onClose={() => { setSourceReference(null); input.current?.focus(); }} onOpenConversation={onOpenConversation} /> : null}
    </div>
  );
}
