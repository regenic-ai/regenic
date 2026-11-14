import type { MessageKey } from "../../shared/i18n.ts";
import type { PersonalSearchAnswerProgress } from "./types.ts";

export interface SearchAnswerProgressCopy {
  key: MessageKey;
  vars: Record<string, string | number>;
}

export function searchAnswerProgressCopy(
  progress: PersonalSearchAnswerProgress,
): SearchAnswerProgressCopy {
  const retrying = progress.current_attempt > 1;
  return {
    key: `search.answer.progress.${progress.phase}${
      retrying ? "Retry" : ""
    }` as MessageKey,
    vars: {
      completed: progress.completed_batches,
      batches: progress.total_batches,
      processed: progress.processed_messages,
      messages: progress.total_messages,
      attempt: progress.current_attempt,
      maxAttempts: progress.max_attempts,
    },
  };
}

export function searchAnswerConflictCopy(
  progress: PersonalSearchAnswerProgress,
): SearchAnswerProgressCopy | null {
  if (!progress.conflict_count) return null;
  return {
    key: "search.answer.progress.conflicts",
    vars: { conflicts: progress.conflict_count },
  };
}
