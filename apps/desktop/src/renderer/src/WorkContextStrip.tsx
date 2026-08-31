import { MessageBody } from "./MessageBody";
import { useLocale } from "./LocaleContext";

/** Collapsed work-face reason. Sibling to ThreadPromptPanel — not part of Prompt. */
export function WorkContextStrip({ text }: { text: string }) {
  const { t } = useLocale();
  const body = text.trim();
  if (!body) {
    return null;
  }
  return (
    <details className="work-context">
      <summary>{t("work.context")}</summary>
      <div className="work-context-body">
        <MessageBody text={body} />
      </div>
    </details>
  );
}
