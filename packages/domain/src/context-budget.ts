export const CONTEXT_SECTION_KINDS = [
  "policy",
  "memory",
  "working",
  "facts",
  "summaries",
  "evidence",
] as const;

export type ContextSectionKind = (typeof CONTEXT_SECTION_KINDS)[number];

export interface ContextBudget {
  profile: string;
  max_tokens: number;
  max_items: number;
  max_raw_evidence: number;
  max_age_days?: number;
  section_tokens?: Partial<Record<ContextSectionKind, number>>;
}

export interface ContextBudgetSectionLedger {
  kind: ContextSectionKind;
  requested_tokens: number;
  selected_tokens: number;
  reserved_tokens: number;
  selected_items: number;
  truncated_items: number;
}

export interface ContextBudgetLedger {
  profile: string;
  max_tokens: number;
  max_items: number;
  max_raw_evidence: number;
  requested_tokens: number;
  selected_tokens: number;
  reserved_tokens: number;
  selected_items: number;
  truncated_items: number;
  sections: ContextBudgetSectionLedger[];
}