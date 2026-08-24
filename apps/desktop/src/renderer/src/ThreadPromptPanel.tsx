import { useMemo, useState } from "react";
import { togglePromptOption, typePromptCustom } from "./thread-prompts";
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
  const prompt = prompts[0];
  if (!prompt) {
    return null;
  }
  const heading =
    prompt.presentation === "approval"
      ? "Needs your approval"
      : prompt.presentation === "plan_review"
        ? "Review the plan"
        : "Waiting for your answer";
  return (
    <form
      className={`prompt-panel presentation-${prompt.presentation}`}
      onSubmit={(event) => {
        event.preventDefault();
      }}
    >
      <div className="prompt-head">
        <p className="prompt-kicker">{heading}</p>
        {prompt.title ? <h2>{prompt.title}</h2> : null}
        {prompt.detail ? <p className="prompt-detail">{prompt.detail}</p> : null}
        {prompts.length > 1 ? (
          <p className="prompt-count">1 of {prompts.length}</p>
        ) : null}
      </div>
      {prompt.presentation === "approval" ? (
        <ApprovalPrompt
          prompt={prompt}
          submitting={submitting}
          onAnswer={onAnswer}
        />
      ) : (
        <ChoicePrompt
          prompt={prompt}
          submitting={submitting}
          onAnswer={onAnswer}
        />
      )}
      {error ? <p className="action-error">{error}</p> : null}
    </form>
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
          {option.label}
        </button>
      ))}
    </div>
  );
}

function ChoicePrompt({
  prompt,
  submitting,
  onAnswer,
}: {
  prompt: ThreadPrompt;
  submitting: boolean;
  onAnswer: (prompt: ThreadPrompt, answers: PromptAnswerItem[]) => Promise<void>;
}) {
  const initial = useMemo(() => emptyAnswers(prompt.questions), [prompt]);
  const [answers, setAnswers] = useState(initial);
  const ready = prompt.questions.every((question) => {
    const current = answers[question.id];
    return Boolean(current?.selected.length || current?.custom?.trim());
  });
  return (
    <>
      {prompt.questions.map((question) => (
        <fieldset key={question.id} className="prompt-question">
          <legend>{question.prompt}</legend>
          {question.options?.length ? (
            <div className="prompt-options">
              {question.options.map((option) => {
                const selected = answers[question.id]?.selected.includes(option.label);
                const emphasized =
                  prompt.presentation === "plan_review" && option.emphasized === true;
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
                    <span>{option.label}</span>
                    {emphasized ? <small>Suggested</small> : null}
                    {option.description ? <small>{option.description}</small> : null}
                  </button>
                );
              })}
            </div>
          ) : null}
          {question.allow_custom || !question.options?.length ? (
            <input
              className="prompt-custom"
              value={answers[question.id]?.custom ?? ""}
              placeholder="Your answer"
              disabled={submitting}
              onChange={(event) =>
                setAnswers((current) =>
                  typePromptCustom(current, question, event.target.value),
                )
              }
            />
          ) : null}
        </fieldset>
      ))}
      <div className="prompt-actions">
        <button
          type="button"
          className="primary"
          disabled={submitting || !ready}
          onClick={() => {
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
          }}
        >
          {submitting ? "Sending…" : "Continue"}
        </button>
      </div>
    </>
  );
}

function emptyAnswers(
  questions: PromptQuestion[],
): Record<string, PromptAnswerItem> {
  return Object.fromEntries(
    questions.map((question) => [question.id, { id: question.id, selected: [] }]),
  );
}

