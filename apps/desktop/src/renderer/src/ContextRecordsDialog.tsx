import { useEffect, useState } from "react";
import { isMessageKey, type MessageKey } from "../../shared/messages.ts";
import { fetchContextArtifacts } from "./api";
import {
  contextRecordsFromArtifacts,
  type ContextRecordView,
} from "./context-records";
import { formatTime } from "./format";
import { useLocale } from "./LocaleContext";

export function ContextRecordsDialog({
  otherCount,
  onClose,
}: {
  otherCount: number;
  onClose: () => void;
}) {
  const { t } = useLocale();
  const [records, setRecords] = useState<ContextRecordView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    void fetchContextArtifacts()
      .then((body) => {
        if (!cancelled) {
          setRecords(contextRecordsFromArtifacts(body));
        }
      })
      .catch(() => {
        if (!cancelled) {
          setError(t("settings.contextError"));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [t]);

  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        className="dialog context-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t("settings.storeContext")}
      >
        <div className="dialog-head">
          <h2>{t("settings.storeContext")}</h2>
          <button type="button" className="ghost" onClick={onClose}>
            {t("connector.close")}
          </button>
        </div>
        <div className="context-records">
          {otherCount > 0 ? (
            <p className="muted">{t("settings.contextOther", { count: otherCount })}</p>
          ) : null}
          {error ? <p className="action-error">{error}</p> : null}
          {records == null && !error ? (
            <p className="muted">{t("settings.contextLoading")}</p>
          ) : null}
          {records && records.length === 0 ? (
            <p className="muted">{t("settings.contextEmpty")}</p>
          ) : null}
          {records?.map((record) => (
            <details key={record.id} className="context-record">
              <summary>
                <span className="context-record-title">{record.title}</span>
                <span className="context-record-meta">
                  {contextKindLabel(record.kind, t)}
                  {record.status ? ` · ${contextStatusLabel(record.status, t)}` : ""}
                  {" · "}
                  {t("settings.contextMessages", { count: record.message_count })}
                  {record.recorded_at ? ` · ${formatTime(record.recorded_at)}` : ""}
                </span>
              </summary>
              <div className="context-record-body">
                {record.messages.map((message, index) => (
                  <p key={`${record.id}:${index}`} className="context-message">
                    {message.occurred_at ? (
                      <time dateTime={message.occurred_at}>
                        {formatTime(message.occurred_at)}
                      </time>
                    ) : null}
                    {message.text}
                  </p>
                ))}
              </div>
            </details>
          ))}
        </div>
      </div>
    </div>
  );
}

function contextKindLabel(
  kind: string,
  t: (key: MessageKey) => string,
): string {
  const key = `settings.contextKind.${kind}`;
  return isMessageKey(key) ? t(key) : kind;
}

function contextStatusLabel(
  status: string,
  t: (key: MessageKey) => string,
): string {
  const key = `settings.contextStatus.${status}`;
  return isMessageKey(key) ? t(key) : status;
}
