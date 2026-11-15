import { useEffect, useState } from "react";
import { fetchFollowUpPolicy, saveFollowUpPolicy } from "./api";
import { useLocale } from "./LocaleContext";
import { InfoTip } from "./InfoTip";
import type { PersonalFollowUpPolicy } from "./types";

export function FollowUpPolicySettings() {
  const { t } = useLocale();
  const [policy, setPolicy] = useState<PersonalFollowUpPolicy | null>(null);
  const [saved, setSaved] = useState<PersonalFollowUpPolicy | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; failed: boolean } | null>(null);

  useEffect(() => {
    let current = true;
    void fetchFollowUpPolicy()
      .then((next) => {
        if (!current) return;
        setPolicy(next);
        setSaved(next);
      })
      .catch(() => {
        if (current) setMessage({ text: t("followUps.failed"), failed: true });
      });
    return () => {
      current = false;
    };
  }, [t]);

  const dirty = Boolean(
    policy &&
      saved &&
      (policy.wait_minutes !== saved.wait_minutes ||
        policy.include_initial_outbound !== saved.include_initial_outbound),
  );

  return (
    <section className="card" id="settings-follow-up">
      <div className="card-head">
        <h2 className="settings-heading">{t("followUps.policy")}
          <InfoTip label={t("followUps.policy")}>{t("followUps.policyLead")}</InfoTip>
        </h2>
        {dirty ? <span className="chip syncing">{t("settings.unsaved")}</span> : null}
      </div>
      {policy ? (
        <form
          className="follow-ups-policy"
          onSubmit={(event) => {
            event.preventDefault();
            setBusy(true);
            setMessage(null);
            void saveFollowUpPolicy(policy)
              .then((next) => {
                setPolicy(next);
                setSaved(next);
                setMessage({ text: t("settings.dispatchSaved"), failed: false });
              })
              .catch(() => setMessage({ text: t("followUps.failed"), failed: true }))
              .finally(() => setBusy(false));
          }}
        >
          <label className="field">
            {t("followUps.wait")}
            <input
              type="number"
              min={15}
              max={43200}
              step={1}
              required
              value={policy.wait_minutes}
              onChange={(event) =>
                setPolicy({ ...policy, wait_minutes: Number(event.target.value) })
              }
            />
          </label>
          <label className="follow-ups-check">
            <input
              type="checkbox"
              checked={policy.include_initial_outbound}
              onChange={(event) =>
                setPolicy({ ...policy, include_initial_outbound: event.target.checked })
              }
            />
            {t("followUps.initial")}
          </label>
          <button type="submit" className="primary" disabled={busy || !dirty}>
            {t("followUps.save")}
          </button>
        </form>
      ) : null}
      {message ? (
        <p className={message.failed ? "action-error" : "action-ok"} role="status">
          {message.text}
        </p>
      ) : null}
    </section>
  );
}
