import { useEffect, useRef, useState } from "react";
import { fetchSearchSource } from "./api";
import { KernelRequestError } from "./kernel-request";
import { useLocale } from "./LocaleContext";
import type { InboxViewItem, PersonalSearchSource } from "./types";

export function SearchSourceDialog({ reference, onClose, onOpenConversation }: {
  reference: { event_id: string; content_hash: string };
  onClose: () => void;
  onOpenConversation: (item: InboxViewItem) => void;
}) {
  const { t } = useLocale();
  const dialog = useRef<HTMLDialogElement>(null);
  const [source, setSource] = useState<PersonalSearchSource | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setSource(null); setError(null);
    void fetchSearchSource(reference, controller.signal).then((next) => {
      if (!controller.signal.aborted) setSource(next);
    }).catch((caught: unknown) => {
      if (controller.signal.aborted) return;
      setError(caught instanceof KernelRequestError && caught.code === "not_found"
        ? t("search.sourceUnavailable")
        : caught instanceof Error ? caught.message : t("search.failed"));
    });
    return () => controller.abort();
  }, [reference.event_id, reference.content_hash, attempt, t]);

  return (
    <dialog ref={dialog} className="dialog search-source-dialog" aria-labelledby="search-source-title"
      onCancel={onClose} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <header className="semantic-actions">
        <h2 id="search-source-title">{t("search.sourceTitle")}</h2>
        <button type="button" className="ghost" onClick={onClose}>{t("search.close")}</button>
      </header>
      <p className="muted">{t("search.sourceHint")}</p>
      {!source && !error ? <p role="status">{t("search.sourceLoading")}</p> : null}
      {error ? <div role="alert"><p className="action-error">{error}</p>
        <button type="button" className="ghost" onClick={() => setAttempt((value) => value + 1)}>{t("search.retry")}</button>
      </div> : null}
      {source ? <>
        <p className="semantic-snippet search-source-text">{source.text}</p>
        <details><summary>{t("search.trace")}</summary><p><code>{source.snapshot_id}</code></p></details>
        {source.item ? <button type="button" className="primary" onClick={() => {
          if (source.item) onOpenConversation(source.item);
        }}>
          {t("search.openConversation")}
        </button> : <p className="muted">{t("search.noConversation")}</p>}
      </> : null}
    </dialog>
  );
}
