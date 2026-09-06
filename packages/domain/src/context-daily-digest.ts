import type { ContextArtifactProposal, ContextSourceRead } from "./context-port";

export const CONTEXT_DAILY_DIGEST_ALGORITHM_VERSION = "daily-digest-d0-v1";

export interface DailyDigestProjectionInput {
  org_id: string;
  utc_date: string;
  generation: string;
  source: ContextSourceRead;
}

export interface DailyDigestProjector {
  readonly id: string;
  readonly algorithm_version: string;
  project(input: DailyDigestProjectionInput): Promise<ContextArtifactProposal | null>;
}

export interface DailyDigestProjectionRunner {
  projectDailyDigest(input: {
    org_id: string;
    utc_date: string;
    generation?: string;
  }): Promise<{ artifact_id?: string; input_event_count: number }>;
}
