import { useEffect, useState } from "react";
import { SearchIcon, SettingsIcon, SparkleIcon } from "./Icons";
import { PreciseSearch } from "./PreciseSearch";
import { SearchAsk } from "./SearchAsk";
import { useLocale } from "./LocaleContext";
import type { InboxViewItem } from "./types";

const SEGMENT_KEY = "regenic.search.segment";

export interface SearchAskRequest {
  threadId: string;
  title: string;
  nonce: number;
}

export function SearchPage({ onSettings, onOpenConversation, ask, onAskConsumed }: {
  onSettings: () => void;
  onOpenConversation: (item: InboxViewItem) => void;
  ask?: SearchAskRequest | null;
  onAskConsumed?: () => void;
}) {
  const { t } = useLocale();
  const [segment, setSegment] = useState<"precise" | "ask">(() => {
    try {
      return localStorage.getItem(SEGMENT_KEY) === "ask" ? "ask" : "precise";
    } catch {
      return "precise";
    }
  });
  const [scope, setScope] = useState<{ threadId: string; title: string } | null>(null);
  const [scopeNonce, setScopeNonce] = useState(0);

  useEffect(() => {
    if (!ask) return;
    setSegment("ask");
    setScope({ threadId: ask.threadId, title: ask.title });
    setScopeNonce(ask.nonce);
    onAskConsumed?.();
  }, [ask?.nonce]);

  useEffect(() => {
    try { localStorage.setItem(SEGMENT_KEY, segment); } catch { /* storage unavailable */ }
  }, [segment]);

  return (
    <div className={`search-page is-${segment}`}>
      <header className="search-top">
        <h1 className="sr-only">{t("search.title")}</h1>
        <div className="search-segments" role="tablist" aria-label={t("search.title")}>
          <button
            type="button"
            role="tab"
            aria-selected={segment === "precise"}
            className={segment === "precise" ? "is-current" : ""}
            onClick={() => setSegment("precise")}
          >
            <SearchIcon />
            <span>{t("search.segment.precise")}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={segment === "ask"}
            className={segment === "ask" ? "is-current" : ""}
            onClick={() => setSegment("ask")}
          >
            <SparkleIcon />
            <span>{t("search.segment.ask")}</span>
          </button>
        </div>
        {segment === "precise" ? (
          <button type="button" className="search-top-link" onClick={onSettings}>
            <SettingsIcon />
            <span>{t("semantic.title")}</span>
          </button>
        ) : null}
      </header>
      <div className="search-pane search-pane-precise" hidden={segment !== "precise"}>
        <PreciseSearch heading={false} onOpenConversation={onOpenConversation} autoFocus={segment === "precise"} />
      </div>
      <div className="search-pane search-pane-ask" hidden={segment !== "ask"}>
        <SearchAsk scope={scope} scopeNonce={scopeNonce} onClearScope={() => setScope(null)} />
      </div>
    </div>
  );
}
