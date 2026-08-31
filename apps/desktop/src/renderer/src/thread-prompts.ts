import type { PromptAnswerItem, PromptQuestion, ThreadPrompt } from "./types";

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

/** Skip visible legend only when it restates the panel title/detail. */
export function shouldShowQuestionLegend(
  prompt: ThreadPrompt,
  question: PromptQuestion,
): boolean {
  const legend = question.prompt.replace(/\s+/g, " ").trim();
  if (!legend) {
    return false;
  }
  const title = prompt.title?.replace(/\s+/g, " ").trim() ?? "";
  const detail = prompt.detail?.replace(/\s+/g, " ").trim() ?? "";
  if (title && legend === title) {
    return false;
  }
  if (detail && legend === detail) {
    return false;
  }
  return true;
}

/** SCREAMING_SNAKE or lowercase_snake — not a human sentence. */
export function looksLikeMachineKey(label: string): boolean {
  const trimmed = label.trim();
  return (
    /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(trimmed) ||
    /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(trimmed)
  );
}

export function optionPrimaryLabel(option: {
  label: string;
  description?: string;
}): string {
  const description = option.description?.replace(/\s+/g, " ").trim() ?? "";
  if (description && looksLikeMachineKey(option.label)) {
    return description;
  }
  return option.label;
}

export function optionSecondaryLabel(option: {
  label: string;
  description?: string;
}): string | null {
  const description = option.description?.replace(/\s+/g, " ").trim() ?? "";
  if (description && looksLikeMachineKey(option.label)) {
    return option.label.trim();
  }
  return description || null;
}
