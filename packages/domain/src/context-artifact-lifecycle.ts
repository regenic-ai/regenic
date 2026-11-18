import type { ContextArtifactStatus } from "./context-artifact";

export interface ContextArtifactState {
  org_id: string;
  artifact_id: string;
  status: ContextArtifactStatus;
  decided_at: string;
  superseded_by?: string;
}

export interface ContextArtifactDecision {
  org_id: string;
  artifact_id: string;
  status: Extract<ContextArtifactStatus, "accepted" | "rejected" | "needs_clarify">;
  decided_at: string;
}

export interface ContextArtifactSupersession {
  org_id: string;
  artifact_id: string;
  replacement_id: string;
  decided_at: string;
}

export interface ContextArtifactLifecycleStore {
  getArtifactState(orgId: string, artifactId: string): Promise<ContextArtifactState | null>;
  decideArtifact(input: ContextArtifactDecision): Promise<ContextArtifactState>;
  supersedeArtifact(input: ContextArtifactSupersession): Promise<{
    superseded: ContextArtifactState;
    accepted: ContextArtifactState;
  }>;
}
