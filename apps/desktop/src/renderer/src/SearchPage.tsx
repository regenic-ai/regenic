import { useEffect, useRef, useState } from "react";
import { searchPersonalContext } from "./api";
import { contextSearchInput } from "./context-search";
import { useLocale } from "./LocaleContext";
import type { PersonalContextSearchResult } from "./types";
import { isMessageKey } from "../../shared/messages";

export function SearchPage({ onSettings }: { onSettings: () => void }) {
  const { t, locale } = useLocale();
  const [query, setQuery] = useState("");
  const [source, setSource] = useState("");
  const [thread, setThread] = useState("");
  const [limit, setLimit] = useState(20);
  const [result, setResult] = useState<PersonalContextSearchResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<AbortController | null>(null);

  useEffect(() => {
    const reset = () => {
      pending.current?.abort();
      pending.current = null;
      setBusy(false); setResult(null); setError(null);
    };
    const unsubscribe = window.regenic?.onApiOriginChanged(reset);
    return () => { pending.current?.abort(); unsubscribe?.(); };
  }, []);

  async function search() {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setResult(null); setError(null); setBusy(true);
    try {
      const input = contextSearchInput(query, source, thread, limit);
      const next = await searchPersonalContext(input, AbortSignal.any([controller.signal, AbortSignal.timeout(90_000)]));
      if (!controller.signal.aborted && pending.current === controller) setResult(next);
    } catch (caught) {
      if (!controller.signal.aborted && pending.current === controller) {
        const message = caught instanceof Error ? caught.message : "";
        setError(isMessageKey(message) ? t(message) : message || t("search.failed"));
      }
    } finally {
      if (pending.current === controller) { pending.current = null; setBusy(false); }
    }
  }

  return (
    <div className="page page-wide semantic-search-page">
      <header className="page-hero">
        <h1>{t("search.title")}</h1>
        <p className="page-lead">{t("search.lead")}</p>
        <button type="button" className="ghost" onClick={onSettings}>{t("semantic.title")}</button>
      </header>
      <form className="card semantic-search-form" onSubmit={(event) => { event.preventDefault(); void search(); }}>
        <label htmlFor="context-query">{t("search.query")}</label>
        <textarea id="context-query" rows={3} value={query} maxLength={8000}
          onChange={(event) => setQuery(event.target.value)} placeholder={t("search.placeholder")} autoFocus />
        <div className="semantic-filters">
          <label>{t("search.source")}<input value={source} onChange={(event) => setSource(event.target.value)} /></label>
          <label>{t("search.thread")}<input value={thread} onChange={(event) => setThread(event.target.value)} /></label>
          <label>{t("search.limit")}<select value={limit} onChange={(event) => setLimit(Number(event.target.value))}>
            {[10, 20, 50, 100].map((value) => <option key={value} value={value}>{value}</option>)}
          </select></label>
        </div>
        <div className="semantic-actions">
          <button type="submit" className="primary" disabled={!query.trim()}>{busy ? t("search.searchAgain") : t("search.submit")}</button>
          {busy ? <button type="button" className="ghost" onClick={() => {
            pending.current?.abort(); pending.current = null; setBusy(false);
          }}>{t("search.cancel")}</button> : null}
        </div>
      </form>
      <div aria-live="polite" aria-busy={busy}>
        {busy ? <p className="muted">{t("search.loading")}</p> : null}
        {error ? <p role="alert" className="action-error">{error}</p> : null}
        {result ? (
          <>
            <section className="card semantic-search-meta">
              <strong>{t(result.generation ? "search.hybrid" : "search.lexical")}</strong>
              <p className="muted">{t("search.count", { count: result.items.length })}</p>
              {result.coverage ? <p>{t("search.coverage", {
                covered: result.coverage.covered_count, authorized: result.coverage.authorized_count,
              })}</p> : null}
              {result.degradation_flags.length ? <div role="status">
                <p>{t("search.degradation")}</p>
                <ul>{result.degradation_flags.map((flag) => {
                  const key = `search.flag.${flag}`;
                  return <li key={flag}>{isMessageKey(key) ? t(key) : flag} <code>({flag})</code></li>;
                })}</ul>
              </div> : null}
              {result.truncated ? <p>{t("search.truncated")}</p> : null}
              <details><summary>{t("search.trace")}</summary>
                <dl><dt>snapshot</dt><dd>{result.snapshot_id}</dd>
                  <dt>profile</dt><dd>{result.retrieval_profile}</dd>
                  <dt>generation</dt><dd>{result.generation ?? "—"}</dd>
                  <dt>read_epoch</dt><dd>{result.read_epoch}</dd></dl>
              </details>
            </section>
            {!result.items.length ? <p className="muted">{t("search.empty")}</p> : null}
            <ol className="semantic-results">
              {result.items.map((item) => (
                <li key={item.event_id} className="card">
                  <header><strong>#{item.rank} · {item.source}</strong>
                    <time dateTime={item.occurred_at}>{new Date(item.occurred_at).toLocaleString(locale)}</time></header>
                  <p className="semantic-snippet">{item.snippet}</p>
                  <details><summary>{t("search.evidence")}</summary>
                    <dl><dt>Event</dt><dd>{item.event_id}</dd>
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
    </div>
  );
}
