import { MessageBody } from "./MessageBody";
import { useLocale } from "./LocaleContext";
import { humanizePromptProse } from "./thread-prompts";

/** Collapsed work-face reason. Sibling to ThreadPromptPanel — not part of Prompt. */
export function WorkContextStrip({ text }: { text: string }) {
  const { t, locale } = useLocale();
  const body = humanizePromptProse(text.trim(), locale);
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
