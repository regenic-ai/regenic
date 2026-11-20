import { useEffect, useRef, useState } from "react";
import { searchPersonalContext } from "./api";
import { contextSearchInput } from "./context-search";
import { ChevronDownIcon, ChevronUpIcon, CloseIcon, SearchIcon } from "./Icons";
import { useLocale } from "./LocaleContext";

/** In-conversation find: type to search, Enter and Shift+Enter step through hits, Esc closes. */
export function ThreadFindBar({ threadId, onLocate, onClose }: {
  threadId: string;
  onLocate: (eventId: string) => void;
  onClose: () => void;
}) {
  const { t } = useLocale();
  const [query, setQuery] = useState("");
  const [searchedFor, setSearchedFor] = useState("");
  const [hits, setHits] = useState<string[]>([]);
  const [index, setIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const request = useRef(0);
  const locate = useRef(onLocate);
  locate.current = onLocate;

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
        contextSearchInput(trimmed, "", threadId, 20, "messages"),
      );
      if (ticket !== request.current) return;
      const ids = result.items.map((hit) => hit.event_id);
      setHits(ids);
      setIndex(0);
      if (ids[0]) locate.current(ids[0]);
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
    const timer = window.setTimeout(() => void run(query), 300);
    return () => window.clearTimeout(timer);
  }, [query, threadId]);

  function step(delta: number) {
    if (!hits.length) return;
    const next = (index + delta + hits.length) % hits.length;
    setIndex(next);
    locate.current(hits[next]);
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
