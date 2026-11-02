import { useState } from "react";
import {
  reviewCustomerServiceTask,
  sendCustomerServiceTask,
  snoozeFollowUp,
} from "./api";
import { formatChatTime } from "./format";
import { KernelRequestError } from "./kernel-request";
import { useLocale } from "./LocaleContext";
import {
  PROPOSAL_REJECT_REASONS,
  PROPOSAL_REPLY_MYSELF_NOTE,
  proposalErrorKind,
  proposalEvidence,
  proposalFacts,
  proposalMemberRows,
  proposalRisks,
  type ProposalRejectReason,
} from "./reply-proposals";
import type { CustomerServiceTaskView, PersonalFollowUpView } from "./types";

/**
 * Agent-drafted reply shown in the source conversation, docked where the
 * Composer sits — same slot as executor prompts. Sending still runs the
 * coordinator's review → re-verify → send steps.
 */
export function ReplyProposalPanel({
  task,
  onChanged,
  onRewrite,
}: {
  task: CustomerServiceTaskView;
  onChanged: () => Promise<void>;
  onRewrite: (text: string) => void;
}) {
  const { t, locale } = useLocale();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState<ProposalRejectReason | null>(null);
  const [note, setNote] = useState("");
  const draft = task.draft;
  if (!draft) {
    return null;
  }
  const risks = proposalRisks(task);
  const evidence = proposalEvidence(task);
  const facts = proposalFacts(task);
  const members = proposalMemberRows(task);

  const act = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (caught) {
      const kind = proposalErrorKind(
        caught instanceof KernelRequestError ? caught.code : undefined,
      );
      if (kind === "changed") {
        setError(t("proposal.errorChanged"));
        await onChanged().catch(() => undefined);
      } else if (kind === "unavailable") {
        setError(t("proposal.errorUnavailable"));
      } else if (kind === "stale") {
        setError(t("proposal.errorStale"));
        await onChanged().catch(() => undefined);
      } else {
        setError(caught instanceof Error ? caught.message : t("proposal.errorOther"));
      }
    } finally {
      setBusy(false);
    }
  };

  const send = () =>
    act(async () => {
      if (task.status === "awaiting_review") {
        await reviewCustomerServiceTask(task.id, "approved");
      }
      await sendCustomerServiceTask(task.id);
      await onChanged();
    });

  const rewrite = () =>
    act(async () => {
      if (task.status === "awaiting_review") {
        await reviewCustomerServiceTask(task.id, "rejected", PROPOSAL_REPLY_MYSELF_NOTE);
      }
      onRewrite(draft.text);
      await onChanged();
    });

  const decline = () =>
    act(async () => {
      if (!reason) return;
      const detail = note.trim();
      await reviewCustomerServiceTask(
        task.id,
        "rejected",
        detail ? `${reason}: ${detail}` : reason,
      );
      await onChanged();
    });

  const evidenceLine = [
    evidence.members > 0
      ? t("proposal.evidenceMembers", { found: evidence.found, total: evidence.members })
      : null,
    evidence.queriedAt
      ? t("proposal.evidenceAt", { time: formatChatTime(evidence.queriedAt) })
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
  // Approved drafts can only be sent; rewriting would need a fresh review cycle.
  const canRewrite = task.status === "awaiting_review";

  return (
    <form
      className="prompt-panel presentation-approval proposal-panel"
      onSubmit={(event) => event.preventDefault()}
    >
      <div className="prompt-head">
        <p className="prompt-kicker">{t("proposal.kicker")}</p>
        {task.brief.question.trim() ? (
          <p className="proposal-question">
            {t("proposal.answering", { question: task.brief.question.trim() })}
          </p>
        ) : null}
      </div>
      <p className="proposal-draft">{draft.text}</p>
      {risks.length ? (
        <div className="proposal-risks" role="note">
          <strong>{t("proposal.risks")}</strong>
          <ul>
            {risks.map((risk) => (
              <li key={risk}>{risk}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <details className="prompt-detail-fold proposal-evidence">
        <summary>{evidenceLine || t("proposal.evidence")}</summary>
        <div className="prompt-detail-fold-body">
          {facts.length ? (
            <dl className="proposal-facts">
              {facts.map((fact) => (
                <div key={fact.key}>
                  <dt>{t(`proposal.fact.${fact.key}`)}</dt>
                  <dd>
                    {fact.value}
                    {fact.verified ? null : (
                      <span className="muted"> · {t("proposal.unverified")}</span>
                    )}
                  </dd>
                </div>
              ))}
            </dl>
          ) : null}
          {members.length ? (
            <ul className="proposal-members">
              {members.map((member) => (
                <li key={member.key}>
                  <strong>{member.name}</strong>
                  <span className={member.status === "found" ? "muted" : "proposal-miss"}>
                    {member.fields ||
                      (member.status === "found"
                        ? t("proposal.memberFound")
                        : member.status === "not_queried"
                          ? t("proposal.memberNotQueried")
                          : t("proposal.memberMissing"))}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          <p className="muted">
            {t("proposal.updatedAt", {
              date: new Date(task.updated_at).toLocaleString(locale),
            })}
          </p>
        </div>
      </details>
      {declining ? (
        <fieldset className="prompt-question proposal-decline">
          <legend>{t("proposal.declineWhy")}</legend>
          <div className="prompt-options">
            {PROPOSAL_REJECT_REASONS.map((value) => (
              <button
                key={value}
                type="button"
                className={`prompt-option${reason === value ? " is-on" : ""}`}
                aria-pressed={reason === value}
                disabled={busy}
                onClick={() => setReason(value)}
              >
                <span>{t(`proposal.reason.${value}`)}</span>
              </button>
            ))}
          </div>
          <input
            className="prompt-custom"
            value={note}
            placeholder={t("proposal.declineNote")}
            disabled={busy}
            onChange={(event) => setNote(event.target.value)}
          />
          <div className="prompt-actions">
            <button type="button" className="primary" disabled={busy || !reason} onClick={() => void decline()}>
              {t("proposal.declineConfirm")}
            </button>
            <button
              type="button"
              className="ghost"
              disabled={busy}
              onClick={() => {
                setDeclining(false);
                setReason(null);
                setNote("");
              }}
            >
              {t("proposal.back")}
            </button>
          </div>
        </fieldset>
      ) : (
        <div className="prompt-actions">
          <button type="button" className="primary" disabled={busy} onClick={() => void send()}>
            {busy ? t("proposal.sending") : t("proposal.send")}
          </button>
          {canRewrite ? (
            <button type="button" className="ghost" disabled={busy} onClick={() => void rewrite()}>
              {t("proposal.rewrite")}
            </button>
          ) : null}
          {canRewrite ? (
            <button type="button" className="ghost" disabled={busy} onClick={() => setDeclining(true)}>
              {t("proposal.decline")}
            </button>
          ) : null}
        </div>
      )}
      <p className="muted proposal-footnote">{t("proposal.footnote")}</p>
      {error ? <p className="action-error" role="alert">{error}</p> : null}
    </form>
  );
}

/** Thin strip above the Composer — the reply itself is the follow-up. */
export function FollowUpNudge({
  item,
  onChanged,
}: {
  item: PersonalFollowUpView;
  onChanged: () => Promise<void>;
}) {
  const { t } = useLocale();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="follow-up-nudge" role="status">
      <span>
        {t("followUp.nudge", { time: formatChatTime(item.candidate.outbound_at) })}
      </span>
      <button
        type="button"
        className="ghost"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setError(null);
          void snoozeFollowUp(
            item.candidate.thread_id,
            new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
          )
            .then(onChanged)
            .catch((caught: unknown) =>
              setError(caught instanceof Error ? caught.message : t("followUps.failed")))
            .finally(() => setBusy(false));
        }}
      >
        {t("followUp.later")}
      </button>
      {error ? <span className="action-error">{error}</span> : null}
    </div>
  );
}
