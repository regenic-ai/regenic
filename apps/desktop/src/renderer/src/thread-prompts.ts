import type { PromptAnswerItem, PromptQuestion } from "./types";

export function togglePromptOption(
  current: Record<string, PromptAnswerItem>,
  question: PromptQuestion,
  label: string,
): Record<string, PromptAnswerItem> {
  const existing = current[question.id] ?? { id: question.id, selected: [] };
  const selected = question.multi_select
    ? existing.selected.includes(label)
      ? existing.selected.filter((item) => item !== label)
      : [...existing.selected, label]
    : [label];
  return {
    ...current,
    [question.id]: {
      id: question.id,
      selected,
      ...(question.multi_select && existing.custom
        ? { custom: existing.custom }
        : {}),
    },
  };
}

export function typePromptCustom(
  current: Record<string, PromptAnswerItem>,
  question: PromptQuestion,
  custom: string,
): Record<string, PromptAnswerItem> {
  return {
    ...current,
    [question.id]: {
      id: question.id,
      selected: question.multi_select
        ? (current[question.id]?.selected ?? [])
        : [],
      custom,
    },
  };
}
