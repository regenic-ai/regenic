import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useLocale } from "./LocaleContext";
import {
  decisionDisplayLabel,
  foldPromptDetail,
  humanizePromptProse,
  optionPrimaryLabel,
  optionSecondaryLabel,
  promptStartsCollapsed,
  promptTitleDisplay,
  selectedOptionSummary,
  shouldShowQuestionLegend,
  togglePromptOption,
  typePromptCustom,
} from "./thread-prompts";
import type { PromptAnswerItem, PromptQuestion, ThreadPrompt } from "./types";

export function ThreadPromptPanel({
  prompts,
  submitting,
  error,
  onAnswer,
}: {
  prompts: ThreadPrompt[];
  submitting: boolean;
  error: string | null;
  onAnswer: (prompt: ThreadPrompt, answers: PromptAnswerItem[]) => Promise<void>;
}) {
  const { t, locale } = useLocale();
  const prompt = prompts[0];
  if (!prompt) {
    return null;
  }
  const heading =
    prompt.presentation === "approval"
      ? t("prompt.approval")
      : prompt.presentation === "plan_review"
        ? t("prompt.plan")
        : t("prompt.answer");
  const title = prompt.title ? promptTitleDisplay(prompt.title, t) : null;
  const detail = prompt.detail?.trim()
    ? humanizePromptProse(prompt.detail, locale)
    : null;
  const collapsible = promptStartsCollapsed(prompt.presentation);
  const [expanded, setExpanded] = useState(!collapsible);

  if (prompt.presentation === "approval") {
    return (
      <form
        className={`prompt-panel presentation-${prompt.presentation}`}
        onSubmit={(event) => {
          event.preventDefault();
        }}
      >
        <div className="prompt-head">
          <p className="prompt-kicker">{heading}</p>
          {title ? <h2>{title}</h2> : null}
          {detail ? (
            foldPromptDetail(prompt.presentation) ? (
              <details className="prompt-detail-fold">
                <summary>{t("prompt.moreDetail")}</summary>
                <p className="prompt-detail-fold-body">{detail}</p>
              </details>
            ) : (
              <PromptDetail text={detail} />
            )
          ) : null}
          {prompts.length > 1 ? (
            <p className="prompt-count">{t("prompt.of", { count: prompts.length })}</p>
          ) : null}
        </div>
        <ApprovalPrompt
          prompt={prompt}
          submitting={submitting}
          onAnswer={onAnswer}
        />
        {error ? <p className="action-error">{error}</p> : null}
      </form>
    );
  }

  return (
    <ChoicePrompt
      prompt={prompt}
      promptCount={prompts.length}
      heading={heading}
      title={title}
      detail={detail}
      expanded={expanded}
      onExpand={() => setExpanded(true)}
      onCollapse={() => setExpanded(false)}
      submitting={submitting}
      error={error}
      onAnswer={onAnswer}
    />
  );
}

function PromptDetail({ text }: { text: string }) {
  const { t } = useLocale();
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const clipRef = useRef<HTMLParagraphElement>(null);

  useLayoutEffect(() => {
    const node = clipRef.current;
    if (!node) {
      setOverflows(false);
      return;
    }
    if (expanded) {
      return;
    }
    const measure = () => {
      setOverflows(node.scrollHeight > node.clientHeight + 2);
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [expanded, text]);

  return (
    <div className="prompt-detail-wrap">
      <p
        ref={clipRef}
        className={`prompt-detail${expanded ? " is-expanded" : ""}`}
      >
        {text}
      </p>
      {overflows || expanded ? (
        <button
          type="button"
          className="prompt-detail-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? t("work.resultCollapse") : t("work.resultExpand")}
        </button>
      ) : null}
    </div>
  );
}

function ApprovalPrompt({
  prompt,
  submitting,
  onAnswer,
}: {
  prompt: ThreadPrompt;
  submitting: boolean;
  onAnswer: (prompt: ThreadPrompt, answers: PromptAnswerItem[]) => Promise<void>;
}) {
  const { t } = useLocale();
  const question = prompt.questions[0];
  const options = question?.options ?? [
    { label: "Allow" },
    { label: "Refuse" },
  ];
  return (
    <div className="prompt-actions">
      {options.map((option) => (
        <button
          key={option.label}
          type="button"
          className={/refuse|reject|deny/i.test(option.label) ? "ghost" : "primary"}
          disabled={submitting}
          onClick={() => {
            void onAnswer(prompt, [
              { id: question?.id ?? "decision", selected: [option.label] },
            ]);
          }}
        >
          {decisionDisplayLabel(option.label, t)}
        </button>
      ))}
    </div>
  );
}

function ChoicePrompt({
  prompt,
  promptCount,
  heading,
  title,
  detail,
  expanded,
  onExpand,
  onCollapse,
  submitting,
  error,
  onAnswer,
}: {
  prompt: ThreadPrompt;
  promptCount: number;
  heading: string;
  title: string | null;
  detail: string | null;
  expanded: boolean;
  onExpand: () => void;
  onCollapse: () => void;
  submitting: boolean;
  error: string | null;
  onAnswer: (prompt: ThreadPrompt, answers: PromptAnswerItem[]) => Promise<void>;
}) {
  const { t } = useLocale();
  const initial = useMemo(() => emptyAnswers(prompt.questions), [prompt]);
  const [answers, setAnswers] = useState(initial);
  const ready = prompt.questions.every((question) => {
    const current = answers[question.id];
    return Boolean(current?.selected.length || current?.custom?.trim());
  });
  const summary = selectedOptionSummary(prompt, answers, t);
  const submit = () => {
    void onAnswer(
      prompt,
      prompt.questions.map((question) => ({
        id: question.id,
        selected: answers[question.id]?.selected ?? [],
        ...(answers[question.id]?.custom?.trim()
          ? { custom: answers[question.id]?.custom?.trim() }
          : {}),
      })),
    );
  };

  if (!expanded) {
    return (
      <form
        className={`prompt-panel presentation-${prompt.presentation} is-compact`}
        onSubmit={(event) => {
          event.preventDefault();
        }}
      >
        <div className="prompt-compact-bar">
          <button
            type="button"
            className="prompt-compact-open"
            onClick={onExpand}
            aria-expanded={false}
          >
            <span className="prompt-compact-meta">
              <span className="prompt-kicker">{heading}</span>
              {title ? <span className="prompt-compact-title">{title}</span> : null}
            </span>
            <span className="prompt-compact-cta">
              {summary ?? t("prompt.pickToContinue")}
            </span>
          </button>
          {ready ? (
            <button
              type="button"
              className="primary prompt-compact-continue"
              disabled={submitting}
              onClick={submit}
            >
              {submitting ? t("prompt.sending") : t("prompt.continue")}
            </button>
          ) : (
            <button
              type="button"
              className="ghost prompt-compact-choose"
              onClick={onExpand}
            >
              {t("prompt.showChoices")}
            </button>
          )}
        </div>
        {error ? <p className="action-error">{error}</p> : null}
      </form>
    );
  }

  return (
    <form
      className={`prompt-panel presentation-${prompt.presentation}`}
      onSubmit={(event) => {
        event.preventDefault();
      }}
    >
      <div className="prompt-head">
        <div className="prompt-head-row">
          <p className="prompt-kicker">{heading}</p>
          <button
            type="button"
            className="prompt-fold-toggle"
            aria-expanded={true}
            onClick={onCollapse}
          >
            {t("prompt.hideChoices")}
          </button>
        </div>
        {title ? <h2>{title}</h2> : null}
        {detail ? (
          foldPromptDetail(prompt.presentation) ? (
            <details className="prompt-detail-fold">
              <summary>{t("prompt.moreDetail")}</summary>
              <p className="prompt-detail-fold-body">{detail}</p>
            </details>
          ) : (
            <PromptDetail text={detail} />
          )
        ) : null}
        {promptCount > 1 ? (
          <p className="prompt-count">{t("prompt.of", { count: promptCount })}</p>
        ) : null}
      </div>
      {prompt.questions.map((question) => {
        const showLegend = shouldShowQuestionLegend(prompt, question);
        const legendText =
          question.prompt.replace(/\s+/g, " ").trim() ||
          prompt.title?.replace(/\s+/g, " ").trim() ||
          t("prompt.answer");
        return (
          <fieldset key={question.id} className="prompt-question">
            <legend className={showLegend ? undefined : "sr-only"}>{legendText}</legend>
            {question.options?.length ? (
              <div className="prompt-options">
                {question.options.map((option) => {
                  const selected = answers[question.id]?.selected.includes(option.label);
                  const emphasized =
                    prompt.presentation === "plan_review" && option.emphasized === true;
                  const primary = decisionDisplayLabel(
                    optionPrimaryLabel(option),
                    t,
                  );
                  const secondary = optionSecondaryLabel(option);
                  return (
                    <button
                      key={option.label}
                      type="button"
                      className={`prompt-option${selected ? " is-on" : ""}${
                        emphasized ? " is-emphasized" : ""
                      }`}
                      aria-pressed={selected}
                      disabled={submitting}
                      onClick={() =>
                        setAnswers((current) =>
                          togglePromptOption(current, question, option.label),
                        )
                      }
                    >
                      <span>{primary}</span>
                      {emphasized ? <small>{t("prompt.suggested")}</small> : null}
                      {secondary ? <small>{secondary}</small> : null}
                    </button>
                  );
                })}
              </div>
            ) : null}
            {question.allow_custom || !question.options?.length ? (
              <input
                className="prompt-custom"
                value={answers[question.id]?.custom ?? ""}
                placeholder={t("prompt.yourAnswer")}
                disabled={submitting}
                onChange={(event) =>
                  setAnswers((current) =>
                    typePromptCustom(current, question, event.target.value),
                  )
                }
              />
            ) : null}
          </fieldset>
        );
      })}
      <div className="prompt-actions">
        <button
          type="button"
          className="primary"
          disabled={submitting || !ready}
          onClick={submit}
        >
          {submitting ? t("prompt.sending") : t("prompt.continue")}
        </button>
      </div>
      {error ? <p className="action-error">{error}</p> : null}
    </form>
  );
}

function emptyAnswers(
  questions: PromptQuestion[],
): Record<string, PromptAnswerItem> {
  return Object.fromEntries(
    questions.map((question) => [question.id, { id: question.id, selected: [] }]),
  );
}
