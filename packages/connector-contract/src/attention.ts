export type PromptPresentation = "choice" | "approval" | "plan_review";

export interface PromptOption {
  label: string;
  description?: string;
  /** Presentation-only. `plan_review` points at the affirmative option. */
  emphasized?: boolean;
}

export interface PromptQuestion {
  id: string;
  prompt: string;
  options?: PromptOption[];
  multi_select?: boolean;
  allow_custom?: boolean;
}

export interface ThreadPrompt {
  prompt_id: string;
  presentation: PromptPresentation;
  title?: string;
  detail?: string;
  questions: PromptQuestion[];
}

export interface PromptAnswerItem {
  id: string;
  selected: string[];
  custom?: string;
}

export interface PromptAnswer {
  prompt_id: string;
  answers: PromptAnswerItem[];
}

export interface ThreadAttention {
  unread: boolean;
  unread_count?: number;
  mentioned?: boolean;
}

/** Peer read of my outbound. Not the same as my unread of their inbound. */
export type ReceiptState = "sent" | "read";

export interface MessageReceipt {
  state: ReceiptState;
  read_at?: string;
  read_count?: number;
}

export interface AttentionAck {
  last_read_at?: string;
  last_read_external_id?: string;
}

export interface ThreadInboundCursor {
  external_id: string;
  occurred_at: string;
}
