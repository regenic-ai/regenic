import { useEffect, useState } from "react";
import { BrandLockup } from "./Brand";
import { fetchEngine, fetchInbox } from "./api";
import { chipLabel, engineChip, formatTime } from "./format";
import { groupInboxThreads, latestMessage } from "./inbox";
import { threadTitle } from "./message-view";
import type { InboxViewItem, PersonalEngineView } from "./types";

const POLL_MS = 5000;

export function TrayApp() {
  const [inbox, setInbox] = useState<InboxViewItem[]>([]);
  const [engine, setEngine] = useState<PersonalEngineView | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const nextEngine = await fetchEngine();
        if (cancelled) {
          return;
        }
        setEngine(nextEngine);
        if (nextEngine.kernel === "running") {
          setInbox(await fetchInbox());
        } else {
          setInbox([]);
        }
      } catch {
        if (!cancelled) {
          setEngine(null);
          setInbox([]);
        }
      }
    };
    void load();
    const timer = window.setInterval(() => {
      void load();
    }, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const chip = engineChip(engine);
  const threads = groupInboxThreads(inbox);
  const recent = threads.slice(0, 3);

  return (
    <div className="tray">
      <header className="tray-head">
        <div className="tray-brand">
          <BrandLockup />
        </div>
        <div className={`chip ${chip}`}>
          <span className="dot" />
          Kernel {chipLabel(chip)}
        </div>
        <p className="muted">
          {threads.length} current work
          {engine?.installations[0]?.last_attempt
            ? ` · last sync ${engine.installations[0].last_attempt.status}`
            : ""}
        </p>
      </header>
      <div className="tray-list">
        {recent.length === 0 ? (
          <div className="page-empty">No current work.</div>
        ) : (
          recent.map((thread) => {
            const latest = latestMessage(thread);
            return (
              <div className="item" key={thread.id}>
                <div className="item-meta">
                  <span>{thread.source}</span>
                  <span>{formatTime(latest.event.occurred_at)}</span>
                </div>
                <div className="item-title">{threadTitle(thread)}</div>
              </div>
            );
          })
        )}
      </div>
      <footer className="tray-foot">
        <button
          type="button"
          className="primary"
          onClick={() => void window.regenic.showConsole()}
        >
          Open console
        </button>
        <button
          type="button"
          className="ghost"
          onClick={() => void window.regenic.quitApp()}
        >
          Quit
        </button>
      </footer>
    </div>
  );
}
