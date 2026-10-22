import { useEffect, useMemo, useState } from "react";
import {
  fetchCustomerServiceTasks,
  reviewCustomerServiceTask,
  sendCustomerServiceTask,
} from "./api";
import { useLocale } from "./LocaleContext";
import type { CustomerServiceTaskView } from "./types";

export function CustomerTasksPage() {
  const { t, locale } = useLocale();
  const [items, setItems] = useState<CustomerServiceTaskView[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selected = useMemo(
    () => items.find((item) => item.id === selectedId) ?? items[0] ?? null,
    [items, selectedId],
  );

  const refresh = async (signal?: AbortSignal) => {
    const next = await fetchCustomerServiceTasks(signal);
    setItems(next);
    setSelectedId((current) =>
      current && next.some((item) => item.id === current)
        ? current
        : next[0]?.id ?? null);
  };

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal)
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) {
          setError(caught instanceof Error ? caught.message : t("customerTasks.failed"));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, []);

  const run = async (action: () => Promise<CustomerServiceTaskView>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const changed = await action();
      setItems((current) => current.map((item) => item.id === changed.id ? changed : item));
      setSelectedId(changed.id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("customerTasks.failed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page page-wide customer-tasks-page">
      <header className="page-hero customer-tasks-header">
        <div>
          <p className="page-eyebrow">{t("customerTasks.eyebrow")}</p>
          <h1>{t("customerTasks.title")}</h1>
          <p className="muted">{t("customerTasks.lead")}</p>
        </div>
        <button type="button" className="ghost" disabled={busy || loading} onClick={() => {
          setLoading(true);
          setError(null);
          void refresh().catch((caught: unknown) => {
            setError(caught instanceof Error ? caught.message : t("customerTasks.failed"));
          }).finally(() => setLoading(false));
        }}>
          {t("customerTasks.refresh")}
        </button>
      </header>
      {error ? <p className="action-error" role="alert">{error}</p> : null}
      {loading ? <p className="muted">{t("customerTasks.loading")}</p> : null}
      {!loading && items.length === 0 ? (
        <section className="card">
          <h2>{t("customerTasks.empty")}</h2>
          <p className="muted">{t("customerTasks.emptyHint")}</p>
        </section>
      ) : null}
      {selected ? (
        <div className="customer-tasks-grid">
          <aside className="card customer-task-list">
            <h2>{t("customerTasks.queue")}</h2>
            {items.map((item) => (
              <button
                type="button"
                className={`customer-task-list-item${item.id === selected.id ? " is-active" : ""}`}
                key={item.id}
                onClick={() => setSelectedId(item.id)}
              >
                <strong>{item.brief.question}</strong>
                <span>{item.status}</span>
                <small>{new Date(item.updated_at).toLocaleString(locale)}</small>
              </button>
            ))}
          </aside>
          <main className="customer-task-detail">
            <section className="card">
              <div className="card-head">
                <h2>{selected.brief.question}</h2>
                <span className="chip">{selected.status}</span>
              </div>
              <dl className="customer-task-facts">
                <div><dt>{t("customerTasks.customer")}</dt><dd>{resolved(selected.brief.customer)}</dd></div>
                <div><dt>{t("customerTasks.project")}</dt><dd>{resolved(selected.brief.project)}</dd></div>
                <div><dt>{t("customerTasks.batch")}</dt><dd>{resolved(selected.brief.batch)}</dd></div>
                <div><dt>{t("customerTasks.intent")}</dt><dd>{resolved(selected.brief.intent)}</dd></div>
              </dl>
              {selected.brief.unresolved.length ? (
                <p className="action-error">
                  {t("customerTasks.unresolved")}: {selected.brief.unresolved.join(", ")}
                </p>
              ) : null}
            </section>
            <section className="card">
              <div className="card-head">
                <h2>{t("customerTasks.coverage")}</h2>
                <span className="chip">
                  {selected.brief.members.length}
                  {selected.brief.expected_member_count === undefined
                    ? ""
                    : ` / ${selected.brief.expected_member_count}`}
                </span>
              </div>
              <ul className="customer-task-members">
                {selected.brief.members.map((member) => {
                  const result = selected.business_evidence
                    .flatMap((evidence) => evidence.results)
                    .find((entry) => entry.member_key === member.member_key);
                  return (
                    <li key={member.member_key}>
                      <strong>{member.display_name}</strong>
                      <span>{member.business_id ?? member.status}</span>
                      <span>{result?.status ?? t("customerTasks.notQueried")}</span>
                      <span>{result?.fields
                        .filter((field) => field.visibility === "customer")
                        .map((field) => `${field.field}: ${String(field.value)}`)
                        .join(" · ") || "—"}</span>
                    </li>
                  );
                })}
              </ul>
            </section>
            {selected.draft ? (
              <section className="card customer-task-draft">
                <div className="card-head">
                  <h2>{t("customerTasks.draft")}</h2>
                  <span className="chip">{selected.draft.review?.result ?? t("customerTasks.pendingReview")}</span>
                </div>
                <p>{selected.draft.text}</p>
                {selected.draft.unresolved.length ? (
                  <p className="muted">{t("customerTasks.unresolved")}: {selected.draft.unresolved.join(", ")}</p>
                ) : null}
                <div className="customer-task-actions">
                  {selected.status === "awaiting_review" ? (
                    <>
                      <button type="button" className="primary" disabled={busy} onClick={() =>
                        void run(() => reviewCustomerServiceTask(selected.id, "approved"))}>
                        {t("customerTasks.approve")}
                      </button>
                      <button type="button" className="ghost" disabled={busy} onClick={() =>
                        void run(() => reviewCustomerServiceTask(selected.id, "rejected"))}>
                        {t("customerTasks.reject")}
                      </button>
                    </>
                  ) : null}
                  {selected.status === "approved" ? (
                    <button type="button" className="primary" disabled={busy} onClick={() => {
                      if (window.confirm(t("customerTasks.sendConfirm"))) {
                        void run(() => sendCustomerServiceTask(selected.id));
                      }
                    }}>
                      {t("customerTasks.send")}
                    </button>
                  ) : null}
                  {selected.status === "sent" && selected.draft.sent ? (
                    <span className="muted">
                      {t("customerTasks.sentAt", {
                        date: new Date(selected.draft.sent.sent_at).toLocaleString(locale),
                      })}
                    </span>
                  ) : null}
                </div>
              </section>
            ) : null}
          </main>
        </div>
      ) : null}
    </div>
  );
}

function resolved(value: { status: string; value?: string }): string {
  return value.value ? `${value.value} (${value.status})` : value.status;
}
