import { useCallback, useEffect, useState } from "react";
import {
  fetchCancellationJobs,
  fetchWorkIdentityDiagnostics,
  retryCancellationJob,
} from "./api";
import { chipLabel } from "./format";
import { useLocale } from "./LocaleContext";
import { statusSummary, type ShellStatus, type ShellStatusRow } from "./shell-status";
import type { CancellationJobView, WorkIdentityDiagnosticView } from "./types";

function StatusGrid({ rows }: { rows: ShellStatusRow[] }) {
  return (
    <dl className="status-grid">
      {rows.map((row) => (
        <div key={row.label} className={row.tone ? `tone-${row.tone}` : undefined}>
          <dt>{row.label}</dt>
          <dd title={row.mono ? row.value : undefined}>
            {row.mono ? <code>{row.value}</code> : row.value || "—"}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function StatusPage({
  status,
  onOpenConnections,
}: {
  status: ShellStatus;
  onOpenConnections: () => void;
}) {
  const { t } = useLocale();
  const [jobs, setJobs] = useState<CancellationJobView[]>([]);
  const [jobsError, setJobsError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [identity, setIdentity] = useState<WorkIdentityDiagnosticView[]>([]);
  const [identityError, setIdentityError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const [nextJobs, nextIdentity] = await Promise.allSettled([
      fetchCancellationJobs(),
      fetchWorkIdentityDiagnostics(),
    ]);
    if (nextJobs.status === "fulfilled") {
      setJobs(nextJobs.value);
      setJobsError(null);
    } else {
      setJobsError(t("status.cancellationJobsError"));
    }
    if (nextIdentity.status === "fulfilled") {
      setIdentity(nextIdentity.value);
      setIdentityError(null);
    } else {
      setIdentityError(t("status.workIdentityError"));
    }
    setLoading(false);
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const retry = async (job: CancellationJobView) => {
    setRetrying(job.id);
    setJobsError(null);
    try {
      await retryCancellationJob(job);
      setJobs(await fetchCancellationJobs());
    } catch {
      setJobsError(t("status.cancellationRetryError"));
    } finally {
      setRetrying(null);
    }
  };

  const issues = jobs.length + identity.length;

  return (
    <div className="page page-wide status-page">
      <header className="page-hero">
        <h1>{t("nav.status")}</h1>
        <p className="page-lead">{t("status.lead")}</p>
      </header>

      <section className={`card status-summary tone-${status.tone}`}>
        <span className="status-dot" />
        <div className="status-summary-text">
          <strong>{statusSummary(status)}</strong>
          <span className="muted">{t("chrome.kernel", { state: chipLabel(status.chip) })}</span>
        </div>
        <button type="button" className="ghost" disabled={loading} onClick={() => void load()}>
          {loading ? t("status.refreshing") : t("status.refresh")}
        </button>
      </section>

      {status.errors.length > 0 || status.hints.length > 0 ? (
        <div className="status-notes">
          {status.errors.map((text) => (
            <p key={text} className="action-error">{text}</p>
          ))}
          {status.hints.map((text) => (
            <p key={text} className="action-hint">{text}</p>
          ))}
        </div>
      ) : null}

      {status.alerts.length > 0 ? (
        <section className="card">
          <div className="card-head">
            <h2>{t("status.alerts")}</h2>
            <button type="button" className="primary" onClick={onOpenConnections}>
              {t("shell.status.openConnections")}
            </button>
          </div>
          <ul className="status-alerts">
            {status.alerts.map((alert) => (
              <li key={`${alert.installationId ?? alert.name}:${alert.message}`}>
                <strong>{alert.name}</strong>
                <span>{alert.message}</span>
                {alert.hint ? <span className="muted">{alert.hint}</span> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="card">
        <h2>{t("status.runtime")}</h2>
        {status.rows.length > 0 ? (
          <StatusGrid rows={status.rows} />
        ) : (
          <p className="muted">{t("status.runtimeEmpty")}</p>
        )}
      </section>

      <section className="card">
        <div className="card-head">
          <h2>{t("status.diagnostics")}</h2>
          {issues === 0 && !jobsError && !identityError ? (
            <span className="chip">{t("status.diagnosticsClear")}</span>
          ) : null}
        </div>

        <div className="status-check">
          <div className="status-check-head">
            <strong>{t("status.cancellationJobs")}</strong>
            <span className="muted">{t("status.cancellationJobsLead")}</span>
          </div>
          {jobsError ? <p className="action-error">{jobsError}</p> : null}
          {jobs.length === 0 && !jobsError ? (
            <p className="muted">{t("status.cancellationJobsEmpty")}</p>
          ) : null}
          {jobs.map((job) => (
            <div className="settings-row" key={job.id}>
              <div>
                <strong>{job.status === "dead"
                  ? t("status.cancellationDead")
                  : t("status.cancellationFailed")}</strong>
                <p className="muted">
                  {t("status.cancellationJobDetails", {
                    run: job.run_id,
                    attempts: String(job.attempts),
                    code: job.last_error_code ?? t("status.cancellationUnknownError"),
                  })}
                </p>
                {job.last_error ? <p className="muted">{job.last_error}</p> : null}
              </div>
              {job.status === "dead" ? (
                <button
                  type="button"
                  className="ghost"
                  disabled={retrying !== null}
                  onClick={() => void retry(job)}
                >
                  {retrying === job.id ? t("status.cancellationRetrying") : t("status.cancellationRetry")}
                </button>
              ) : null}
            </div>
          ))}
        </div>

        <div className="status-check">
          <div className="status-check-head">
            <strong>{t("status.workIdentity")}</strong>
            <span className="muted">{t("status.workIdentityLead")}</span>
          </div>
          {identityError ? <p className="action-error">{identityError}</p> : null}
          {identity.length === 0 && !identityError ? (
            <p className="muted">{t("status.workIdentityEmpty")}</p>
          ) : null}
          {identity.map((item) => (
            <div className="settings-row" key={item.work_item_id}>
              <div>
                <strong>{t("status.workIdentityReason", {
                  reason: t(`status.workIdentityReason.${item.reason}`),
                })}</strong>
                <p className="muted">
                  {t("status.workIdentityDetails", {
                    item: item.work_item_id,
                    thread: item.thread_id,
                    unit: item.unit_key,
                    status: item.item_status,
                  })}
                </p>
                {item.current_run_id ? (
                  <p className="muted">{t("status.workIdentityCurrentRun", { run: item.current_run_id })}</p>
                ) : null}
                {item.candidate_run_ids.length > 0 ? (
                  <p className="muted">
                    {t("status.workIdentityCandidates", { runs: item.candidate_run_ids.join(", ") })}
                  </p>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      </section>

      {status.meta.length > 0 ? (
        <section className="card">
          <h2>{t("shell.status.details")}</h2>
          <StatusGrid rows={status.meta} />
        </section>
      ) : null}
    </div>
  );
}
