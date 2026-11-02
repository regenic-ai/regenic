import { useEffect, useState } from "react";
import {
  fetchFollowUpSnoozes,
  fetchFollowUps,
  snoozeFollowUp,
  unsnoozeFollowUp,
} from "./api";
import { useLocale } from "./LocaleContext";
import { PendingTriage } from "./PendingTriage";
import type { PersonalFollowUpView } from "./types";

export function FollowUpsPage({
  onChanged,
  threadLabel,
  onOpenThread,
}: {
  onChanged: () => Promise<void>;
  threadLabel: (threadId: string) => string | null;
  onOpenThread: (threadId: string) => void;
}) {
  const { t, locale } = useLocale();
  const [items, setItems] = useState<PersonalFollowUpView[]>([]);
  const [snoozes, setSnoozes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [triageKey, setTriageKey] = useState(0);

  const refresh = async () => {
    const [nextItems, nextSnoozes] = await Promise.all([
      fetchFollowUps(),
      fetchFollowUpSnoozes(),
    ]);
    setItems(nextItems);
    setSnoozes(nextSnoozes);
  };

  useEffect(() => {
    let current = true;
    void Promise.all([fetchFollowUps(), fetchFollowUpSnoozes()])
      .then(([nextItems, nextSnoozes]) => {
        if (!current) return;
        setItems(nextItems);
        setSnoozes(nextSnoozes);
      })
      .catch((caught: unknown) => {
        if (current) setError(caught instanceof Error ? caught.message : t("followUps.failed"));
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => { current = false; };
  }, []);

  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
      await refresh();
      await onChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("followUps.failed"));
    } finally {
      setBusy(false);
    }
  };

  const activeSnoozes = Object.entries(snoozes).filter(([, until]) => until > new Date().toISOString());

  return (
    <div className="page page-wide follow-ups-page">
      <header className="page-hero follow-ups-header">
        <div>
          <p className="page-eyebrow">{t("followUps.eyebrow")}</p>
          <h1>{t("followUps.title")}</h1>
          <p className="muted">{t("followUps.lead")}</p>
        </div>
        <button type="button" className="ghost" disabled={busy || loading} onClick={() => void run(async () => {
          setTriageKey((value) => value + 1);
        })}>
          {t("followUps.refresh")}
        </button>
      </header>
      {error ? <p className="action-error" role="alert">{error}</p> : null}
      <PendingTriage key={triageKey} onChanged={onChanged} />
      <section className="follow-ups-section" aria-label={t("followUps.due")}>
        <div className="follow-ups-section-head">
          <h2>{t("followUps.due")}</h2>
          <span className="chip">{items.length}</span>
        </div>
        {loading ? <p className="muted">{t("followUps.loading")}</p> : null}
        {!loading && !error && items.length === 0 ? <p className="muted">{t("followUps.empty")}</p> : null}
        <ul className="follow-ups-list">
          {items.map((item) => (
            <li className="follow-ups-row" key={item.event.id}>
              <button type="button" className="follow-ups-row-body follow-ups-open" onClick={() => onOpenThread(item.candidate.thread_id)}>
                <strong>{threadLabel(item.candidate.thread_id) ?? item.event.source}</strong>
                {item.body_text ? <span className="follow-ups-preview">{item.body_text}</span> : null}
                <span className="muted">{t("followUps.sentAt", { date: new Date(item.candidate.outbound_at).toLocaleString(locale) })}</span>
              </button>
              <button type="button" className="ghost" disabled={busy} onClick={() => void run(() => snoozeFollowUp(item.candidate.thread_id, new Date(Date.now() + 24 * 60 * 60_000).toISOString()))}>
                {t("followUps.snooze")}
              </button>
            </li>
          ))}
        </ul>
      </section>
      {activeSnoozes.length ? (
      <section className="follow-ups-section" aria-label={t("followUps.paused")}>
        <div className="follow-ups-section-head">
          <h2>{t("followUps.paused")}</h2>
          <span className="chip">{activeSnoozes.length}</span>
        </div>
        <ul className="follow-ups-list">
          {activeSnoozes.map(([threadId, until]) => (
            <li className="follow-ups-row" key={threadId}>
              <button type="button" className="follow-ups-row-body follow-ups-open" onClick={() => onOpenThread(threadId)}>
                <strong>{threadLabel(threadId) ?? t("followUps.unknownThread")}</strong>
                <span className="muted">{t("followUps.until", { date: new Date(until).toLocaleString(locale) })}</span>
              </button>
              <button type="button" className="ghost" disabled={busy} onClick={() => void run(() => unsnoozeFollowUp(threadId))}>
                {t("followUps.resume")}
              </button>
            </li>
          ))}
        </ul>
      </section>
      ) : null}
    </div>
  );
}