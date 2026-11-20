import { useEffect, useRef, useState } from "react";
import { searchPersonalContext } from "./api";
import { contextSearchInput, orderedFindHits, type FindHit } from "./context-search";
import { ChevronDownIcon, ChevronUpIcon, CloseIcon, SearchIcon } from "./Icons";
import { useLocale } from "./LocaleContext";

/** In-conversation find: type to search, Enter and Shift+Enter step through hits, Esc closes. */
export function ThreadFindBar({ threadId, anchorAt, onLocate, onState, onClose }: {
  threadId: string;
  anchorAt: () => number | null;
  onLocate: (hit: FindHit) => void | Promise<void>;
  onState: (state: { query: string; eventId: string | null }) => void;
  onClose: () => void;
}) {
  const { t } = useLocale();
  const [query, setQuery] = useState("");
  const [searchedFor, setSearchedFor] = useState("");
  const [hits, setHits] = useState<FindHit[]>([]);
  const [index, setIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const request = useRef(0);
  const locate = useRef(onLocate);
  const report = useRef(onState);
  const anchor = useRef(anchorAt);
  locate.current = onLocate;
  report.current = onState;
  anchor.current = anchorAt;

  async function run(text: string) {
    const trimmed = text.trim();
    const ticket = ++request.current;
    if (!trimmed) {
      setHits([]);
      setSearchedFor("");
      setBusy(false);
      return;
    }
    setBusy(true);
    try {
      const result = await searchPersonalContext(
        contextSearchInput(trimmed, "", threadId, 20, "messages", new Date(), "all", true),
      );
      if (ticket !== request.current) return;
      const ordered = orderedFindHits(result.items, anchor.current());
      setHits(ordered.hits);
      setIndex(ordered.index);
      const current = ordered.hits[ordered.index];
      if (current) await locate.current(current);
    } catch {
      if (ticket === request.current) setHits([]);
    } finally {
      if (ticket === request.current) {
        setSearchedFor(trimmed);
        setBusy(false);
      }
    }
  }

  useEffect(() => {
    report.current({ query, eventId: hits[index]?.id ?? null });
  }, [query, hits, index]);

  useEffect(() => () => report.current({ query: "", eventId: null }), []);

  useEffect(() => {
    const timer = window.setTimeout(() => void run(query), 300);
    return () => window.clearTimeout(timer);
  }, [query, threadId]);

  function step(delta: number) {
    if (!hits.length) return;
    const next = (index + delta + hits.length) % hits.length;
    setIndex(next);
    void locate.current(hits[next]);
  }

  const settled = !busy && searchedFor === query.trim() && Boolean(searchedFor);
  return (
    <form
      className={`thread-find${settled && !hits.length ? " is-empty" : ""}`}
      role="search"
      onSubmit={(event) => { event.preventDefault(); }}
    >
      <SearchIcon />
      <input
        type="text"
        value={query}
        autoFocus
        spellCheck={false}
        placeholder={t("search.find.placeholder")}
        aria-label={t("search.find.placeholder")}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          } else if (event.key === "Enter" && !event.nativeEvent.isComposing) {
            event.preventDefault();
            if (searchedFor !== query.trim()) void run(query);
            else step(event.shiftKey ? -1 : 1);
          }
        }}
      />
      <span className="thread-find-count" aria-live="polite">
        {busy ? <span className="thread-find-spinner" aria-hidden="true" />
          : settled ? (hits.length ? t("search.find.count", { current: index + 1, total: hits.length }) : t("search.find.none")) : null}
      </span>
      <span className="thread-find-divider" aria-hidden="true" />
      <button type="button" className="item-tool" aria-label={t("search.find.prev")} title={`${t("search.find.prev")} (⇧↩)`}
        disabled={!hits.length} onClick={() => step(-1)}><ChevronUpIcon /></button>
      <button type="button" className="item-tool" aria-label={t("search.find.next")} title={`${t("search.find.next")} (↩)`}
        disabled={!hits.length} onClick={() => step(1)}><ChevronDownIcon /></button>
      <button type="button" className="item-tool" aria-label={t("search.find.close")} title={`${t("search.find.close")} (Esc)`}
        onClick={onClose}><CloseIcon /></button>
    </form>
  );
}
