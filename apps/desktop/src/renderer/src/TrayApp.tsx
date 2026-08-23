import { useEffect, useRef, useState } from "react";
import { BrandLockup } from "./Brand";
import { fetchEngine, fetchInbox } from "./api";
import { chipLabel, engineChip, formatChatTime } from "./format";
import { groupInboxThreads, latestMessage, sortInboxThreads } from "./inbox";
import { threadActivityCopy, threadActivityOf, threadTitle } from "./message-view";
import type { InboxViewItem, PersonalEngineView } from "./types";

const POLL_MS = 2000;
const IDLE_POLL_MS = 8000;

export function TrayApp() {
  const [inbox, setInbox] = useState<InboxViewItem[]>([]);
  const [engine, setEngine] = useState<PersonalEngineView | null>(null);
  const digestRef = useRef<string | null>(null);
  const delayRef = useRef(POLL_MS);
  const inFlight = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let timer = 0;
    const load = async () => {
      if (inFlight.current) {
        return;
      }
      inFlight.current = true;
      try {
        const nextEngine = await fetchEngine({ detailed: false });
        if (cancelled) {
          return;
        }
        setEngine(nextEngine);
        const digest = nextEngine.inbox_digest ?? "";
        const skip =
          nextEngine.kernel === "running" &&
          digest.length > 0 &&
          digest === digestRef.current;
        if (nextEngine.kernel !== "running") {
          digestRef.current = digest || null;
          setInbox([]);
          delayRef.current = IDLE_POLL_MS;
          return;
        }
        if (!skip) {
          setInbox(await fetchInbox({ heads: true }));
          digestRef.current = digest || digestRef.current;
        }
        delayRef.current = skip ? IDLE_POLL_MS : POLL_MS;
      } catch {
        if (!cancelled) {
          setEngine(null);
          setInbox([]);
        }
      } finally {
        inFlight.current = false;
      }
    };
    const tick = async () => {
      await load();
      if (!cancelled) {
        timer = window.setTimeout(() => {
          void tick();
        }, delayRef.current);
      }
    };
    void tick();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, []);

  const chip = engineChip(engine);
  const threads = sortInboxThreads(groupInboxThreads(inbox));
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
              <div className={`item${thread.pinned ? " pinned" : ""}`} key={thread.id}>
                <div className="item-copy">
                  <div className="item-meta">
                    <span className={`channel-tag channel-${thread.channel}`}>
                      {thread.channel_label}
                    </span>
                    <span className="item-title">{threadTitle(thread)}</span>
                    <span>{latest ? formatChatTime(latest.event.occurred_at) : ""}</span>
                  </div>
                  <div className="item-reasons">
                    {threadActivityCopy(threadActivityOf(thread)) || thread.label}
                  </div>
                </div>
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
