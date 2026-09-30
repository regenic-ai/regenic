import { useEffect, useState } from "react";
import {
  fetchFollowUpPolicy,
  fetchFollowUpSnoozes,
  fetchFollowUps,
  saveFollowUpPolicy,
  snoozeFollowUp,
  unsnoozeFollowUp,
} from "./api";
import { useLocale } from "./LocaleContext";
import type { PersonalFollowUpPolicy, PersonalFollowUpView } from "./types";

export function FollowUpsPage() {
  const { t, locale } = useLocale();
  const [items, setItems] = useState<PersonalFollowUpView[]>([]);
  const [snoozes, setSnoozes] = useState<Record<string, string>>({});
  const [policy, setPolicy] = useState<PersonalFollowUpPolicy | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
    void Promise.all([fetchFollowUpPolicy(), fetchFollowUps(), fetchFollowUpSnoozes()])
      .then(([nextPolicy, nextItems, nextSnoozes]) => {
        if (!current) return;
        setPolicy(nextPolicy);
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
        </div>
        <button type="button" className="ghost" disabled={busy || loading} onClick={() => void run(async () => {
          if (!policy) setPolicy(await fetchFollowUpPolicy());
        })}>
          {t("followUps.refresh")}
        </button>
      </header>
      {error ? <p className="action-error" role="alert">{error}</p> : null}
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
              <div className="follow-ups-row-body">
                <strong>{item.body_text || item.candidate.thread_id}</strong>
                <span className="muted">{item.event.source} · {t("followUps.sentAt", { date: new Date(item.candidate.outbound_at).toLocaleString(locale) })}</span>
                <span className="muted">{t("followUps.dueAt", { date: new Date(item.candidate.due_at).toLocaleString(locale) })}</span>
              </div>
              <button type="button" className="ghost" disabled={busy} onClick={() => void run(() => snoozeFollowUp(item.candidate.thread_id, new Date(Date.now() + 24 * 60 * 60_000).toISOString()))}>
                {t("followUps.snooze")}
              </button>
            </li>
          ))}
        </ul>
      </section>
      <section className="follow-ups-section" aria-label={t("followUps.paused")}>
        <div className="follow-ups-section-head">
          <h2>{t("followUps.paused")}</h2>
          <span className="chip">{activeSnoozes.length}</span>
        </div>
        {!loading && !error && activeSnoozes.length === 0 ? <p className="muted">{t("followUps.nonePaused")}</p> : null}
        <ul className="follow-ups-list">
          {activeSnoozes.map(([threadId, until]) => (
            <li className="follow-ups-row" key={threadId}>
              <div className="follow-ups-row-body">
                <strong>{threadId}</strong>
                <span className="muted">{t("followUps.until", { date: new Date(until).toLocaleString(locale) })}</span>
              </div>
              <button type="button" className="ghost" disabled={busy} onClick={() => void run(() => unsnoozeFollowUp(threadId))}>
                {t("followUps.resume")}
              </button>
            </li>
          ))}
        </ul>
      </section>
      <section className="follow-ups-section" aria-label={t("followUps.policy")}>
        <div className="follow-ups-section-head"><h2>{t("followUps.policy")}</h2></div>
        {policy ? (
          <form className="follow-ups-policy" onSubmit={(event) => {
            event.preventDefault();
            void run(async () => { setPolicy(await saveFollowUpPolicy(policy)); });
          }}>
            <label className="field">
              {t("followUps.wait")}
              <input type="number" min={15} max={43200} step={1} required value={policy.wait_minutes} onChange={(event) => setPolicy({ ...policy, wait_minutes: Number(event.target.value) })} />
            </label>
            <label className="follow-ups-check">
              <input type="checkbox" checked={policy.include_initial_outbound} onChange={(event) => setPolicy({ ...policy, include_initial_outbound: event.target.checked })} />
              {t("followUps.initial")}
            </label>
            <button type="submit" className="primary" disabled={busy}>{t("followUps.save")}</button>
          </form>
        ) : null}
      </section>
    </div>
  );
}