import { useEffect, useRef, useState } from "react";
import { isMessageKey, type MessageKey } from "../../shared/messages.ts";
import { fetchContextArtifactRecord, fetchContextArtifactSummaries } from "./api";
import {
  contextRecordPageFromResponse,
  contextSummariesFromResponse,
  type ContextMessageView,
  type ContextRecordSummary,
} from "./context-records";
import { formatTime } from "./format";
import { useLocale } from "./LocaleContext";

const RECORD_PAGE = 40;

export function ContextRecordsDialog({
  onClose,
}: {
  onClose: () => void;
}) {
  const { t } = useLocale();
  const [records, setRecords] = useState<ContextRecordSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

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
    void fetchContextArtifactSummaries()
      .then((body) => {
        if (!cancelled) {
          setRecords(contextSummariesFromResponse(body));
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
          {error ? <p className="action-error">{error}</p> : null}
          {records == null && !error ? (
            <p className="muted">{t("settings.contextLoading")}</p>
          ) : null}
          {records && records.length === 0 ? (
            <p className="muted">{t("settings.contextEmpty")}</p>
          ) : null}
          {records?.map((record) => {
            const open = openId === record.id;
            return (
              <article
                key={record.id}
                className={`context-record${record.status === "superseded" ? " is-superseded" : ""}`}
              >
                <button
                  type="button"
                  className="context-record-toggle"
                  aria-expanded={open}
                  onClick={() => setOpenId(open ? null : record.id)}
                >
                  <span className="context-record-title" title={record.title}>
                    {record.title}
                  </span>
                  <span className="context-record-meta">{recordMeta(record, t)}</span>
                </button>
                {open ? <ContextRecordBody id={record.id} /> : null}
              </article>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function ContextRecordBody({ id }: { id: string }) {
  const { t } = useLocale();
  const alive = useRef(true);
  const [messages, setMessages] = useState<ContextMessageView[] | null>(null);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);

  useEffect(() => {
    alive.current = true;
    let cancelled = false;
    void fetchContextArtifactRecord(id)
      .then((body) => {
        const page = contextRecordPageFromResponse(body);
        if (cancelled) {
          return;
        }
        if (!page) {
          setError(true);
          return;
        }
        setMessages(page.messages);
        setOffset(page.message_offset);
      })
      .catch(() => {
        if (!cancelled) {
          setError(true);
        }
      });
    return () => {
      cancelled = true;
      alive.current = false;
    };
  }, [id]);

  async function showEarlier() {
    if (offset <= 0 || loadingEarlier) {
      return;
    }
    const limit = Math.min(RECORD_PAGE, offset);
    const nextOffset = offset - limit;
    setLoadingEarlier(true);
    try {
      const body = await fetchContextArtifactRecord(id, { offset: nextOffset, limit });
      const page = contextRecordPageFromResponse(body);
      if (!alive.current) {
        return;
      }
      if (!page) {
        setError(true);
        return;
      }
      setMessages((current) => [...page.messages, ...(current ?? [])]);
      setOffset(page.message_offset);
    } catch {
      if (alive.current) {
        setError(true);
      }
    } finally {
      if (alive.current) {
        setLoadingEarlier(false);
      }
    }
  }

  const earlier = Math.min(RECORD_PAGE, offset);

  return (
    <div className="context-record-body">
      {earlier > 0 ? (
        <button
          type="button"
          className="ghost context-earlier"
          disabled={loadingEarlier}
          onClick={() => void showEarlier()}
        >
          {loadingEarlier
            ? t("settings.contextRecordLoading")
            : t("settings.contextEarlier", { count: earlier })}
        </button>
      ) : null}
      {error ? <p className="action-error">{t("settings.contextRecordError")}</p> : null}
      {messages == null && !error ? (
        <p className="muted">{t("settings.contextRecordLoading")}</p>
      ) : null}
      {messages && messages.length === 0 && !error ? (
        <p className="muted">{t("settings.contextNoBody")}</p>
      ) : null}
      {messages && messages.length > 0 ? (
        <div className="context-message-list">
          {messages.map((message, index) => (
            <p key={`${id}:${offset + index}`} className="context-message">
              {message.occurred_at ? (
                <time dateTime={message.occurred_at}>{formatTime(message.occurred_at)}</time>
              ) : null}
              {message.text}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function recordMeta(
  record: ContextRecordSummary,
  t: (key: MessageKey, vars?: Record<string, string | number>) => string,
): string {
  const parts = [contextKindLabel(record.kind, t)];
  if (record.status) {
    parts.push(contextStatusLabel(record.status, t));
  }
  if (record.message_count > 0) {
    parts.push(t("settings.contextMessages", { count: record.message_count }));
  }
  if (record.recorded_at) {
    parts.push(formatTime(record.recorded_at));
  }
  return parts.join(" · ");
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
