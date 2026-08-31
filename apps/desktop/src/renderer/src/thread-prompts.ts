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

/** SCREAMING_SNAKE, lowercase_snake, or single decision tokens. */
export function looksLikeMachineKey(label: string): boolean {
  const trimmed = label.trim();
  return (
    /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(trimmed) ||
    /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(trimmed) ||
    /^(APPROVED|REJECTED|APPROVE|REJECT|ALLOW|REFUSE|DENY)$/i.test(trimmed)
  );
}

type DecisionCopy = (key: "prompt.approve" | "prompt.reject" | "prompt.confirmResult") => string;

/** Display-only. Answers still submit the raw option.label. */
export function decisionDisplayLabel(label: string, t: DecisionCopy): string {
  const trimmed = label.trim();
  if (/^(approved|approve|allow)$/i.test(trimmed)) {
    return t("prompt.approve");
  }
  if (/^(rejected|reject|refuse|deny)$/i.test(trimmed)) {
    return t("prompt.reject");
  }
  return label;
}

/** Soften jargon titles like 写回 / Write back without CRM-specific wording. */
export function promptTitleDisplay(title: string, t: DecisionCopy): string {
  const trimmed = title.replace(/\s+/g, " ").trim();
  if (/^(写回|回写|write\s*back)$/i.test(trimmed)) {
    return t("prompt.confirmResult");
  }
  return title;
}

/**
 * Soften English control words leaked into CJK prompt copy.
 * Only touches decision/control tokens — never domain nouns.
 * Prefer executor-authored human copy long-term.
 */
export function humanizePromptProse(text: string, locale: string): string {
  if (locale !== "zh" || !/[\u4e00-\u9fff]/.test(text)) {
    return text;
  }
  return text
    .replace(/\bAPPROVED\s*\/\s*REJECTED\b/g, "通过 / 驳回")
    .replace(/\bAPPROVED\b/g, "通过")
    .replace(/\bREJECTED\b/g, "驳回")
    .replace(/不得\s*complete\s*/gi, "不要结束");
}

/** Approval detail stays available but folded — not dropped. */
export function foldPromptDetail(presentation: ThreadPrompt["presentation"]): boolean {
  return presentation === "approval";
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
