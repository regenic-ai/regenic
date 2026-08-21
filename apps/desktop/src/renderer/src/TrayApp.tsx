import { useEffect, useState } from "react";
import { BrandLockup } from "./Brand";
import { fetchEngine, fetchInbox } from "./api";
import { chipLabel, engineChip, formatTime, previewText } from "./format";
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
  const recent = inbox.slice(0, 3);

  return (
    <div className="tray">
      <header className="tray-head">
        <div className="tray-brand">
          <BrandLockup />
        </div>
        <div className={`chip ${chip}`}>
          <span className="dot" />
          内核{chipLabel(chip)}
        </div>
        <p className="muted">
          {engine?.inbox_count ?? 0} 条当前工作
          {engine?.installations[0]?.last_attempt
            ? ` · 最近同步 ${engine.installations[0].last_attempt.status}`
            : ""}
        </p>
      </header>
      <div className="tray-list">
        {recent.length === 0 ? (
          <div className="page-empty">没有待处理消息。</div>
        ) : (
          recent.map((item) => (
            <div className="item" key={item.event.id}>
              <div className="item-meta">
                <span>{item.event.source}</span>
                <span>{formatTime(item.event.occurred_at)}</span>
              </div>
              <div className="item-title">
                {previewText(item.body_text, item.event.external_id)}
              </div>
            </div>
          ))
        )}
      </div>
      <footer className="tray-foot">
        <button
          type="button"
          className="primary"
          onClick={() => void window.regenic.showConsole()}
        >
          打开控制台
        </button>
        <button
          type="button"
          className="ghost"
          onClick={() => void window.regenic.quitApp()}
        >
          退出
        </button>
      </footer>
    </div>
  );
}
