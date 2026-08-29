import { useEffect, useMemo, useState } from "react";
import { MenuSelect } from "./MenuSelect";
import { useLocale } from "./LocaleContext";
import {
  forwardSelectLabel,
  type ForwardPickerTarget,
} from "./forward-preview";

export function ForwardSheet({
  mode,
  preview,
  files = [],
  targets,
  sending,
  error,
  onPreviewChange,
  onSend,
  onCancel,
}: {
  mode: "messages" | "transcript";
  preview: string;
  files?: string[];
  targets: ForwardPickerTarget[];
  sending: boolean;
  error: string | null;
  onPreviewChange: (text: string) => void;
  onSend: (target: ForwardPickerTarget, text: string) => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useLocale();
  const [targetKey, setTargetKey] = useState(targets[0]?.key ?? "");
  useEffect(() => {
    if (targets.some((item) => item.key === targetKey)) {
      return;
    }
    setTargetKey(targets[0]?.key ?? "");
  }, [targets, targetKey]);
  const options = useMemo(
    () =>
      targets.map((item) => ({
        value: item.key,
        label: forwardSelectLabel(item),
      })),
    [targets],
  );
  const selected = targets.find((item) => item.key === targetKey);
  const canSend = Boolean(selected) && preview.trim().length > 0 && !sending;

  return (
    <section className="forward-sheet" aria-label={t("thread.forward")}>
      <header className="forward-sheet-head">
        <strong>
          {mode === "transcript"
            ? t("thread.forwardConversation")
            : t("thread.forward")}
        </strong>
        <button type="button" className="ghost" onClick={onCancel} disabled={sending}>
          {t("thread.forwardCancel")}
        </button>
      </header>
      {targets.length === 0 ? (
        <p className="muted">{t("thread.forwardEmpty")}</p>
      ) : (
        <>
          <label className="forward-field">
            <span>{t("thread.forwardTo")}</span>
            <MenuSelect
              value={targetKey}
              options={options}
              searchable={options.length > 6}
              onChange={setTargetKey}
            />
          </label>
          {files.length > 0 ? (
            <div className="forward-files">
              <span>{t("thread.forwardFiles")}</span>
              <div className="msg-files">
                {files.map((name) => (
                  <span key={name} className="file-chip">
                    {name}
                  </span>
                ))}
              </div>
            </div>
          ) : null}
          <label className="forward-field">
            <span>{t("thread.forwardPreview")}</span>
            <textarea
              className="forward-preview"
              value={preview}
              rows={6}
              disabled={sending}
              onChange={(event) => onPreviewChange(event.target.value)}
            />
          </label>
          {error ? <p className="action-error">{error}</p> : null}
          <div className="forward-sheet-actions">
            <button
              type="button"
              className="primary"
              disabled={!canSend}
              onClick={() => {
                if (!selected) {
                  return;
                }
                void onSend(selected, preview);
              }}
            >
              {sending ? t("thread.forwarding") : t("thread.forwardSend")}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
