import type { ActorRef } from "./actor";
import type { ContextArtifact, ContextArtifactKind, ContextArtifactStatus } from "./context-artifact";
import type { ContextBundle, ContextBundleItem } from "./context-bundle";
import type { ContextSectionKind } from "./context-budget";
import type { ContextCandidate, ContextCandidateKind } from "./context-candidate";
import type { EvidenceReference } from "./context-consumer";
import type { ContextRequest } from "./context-request";
import type { ContextSnapshot } from "./context-snapshot";
import type { EventRecord, JsonValue } from "./ingestion";

export interface ContextProjectionCapabilities {
  artifact_kinds: ContextArtifactKind[];
  incremental: boolean;
  rebuild: boolean;
  requires_model: boolean;
}

export interface ContextRetrievalCapabilities {
  candidate_kinds: ContextCandidateKind[];
  lexical: boolean;
  vector: boolean;
  graph: boolean;
  rerank: boolean;
  multilingual: boolean;
}

export interface ContextProjectionCheckpoint {
  org_id: string;
  projector_id: string;
  algorithm_version: string;
  generation: string;
  sequence: number;
  watermark: string;
  updated_at: string;
}

export interface ContextArtifactQuery {
  org_id: string;
  kinds?: ContextArtifactKind[];
  statuses?: ContextArtifactStatus[];
  generation?: string;
  limit?: number;
}

export interface ContextBundleLookup {
  org_id: string;
  snapshot_id: string;
  principal: ActorRef;
  consumer_id: string;
}

export interface ContextArtifactStore {
  putArtifact(artifact: ContextArtifact): Promise<ContextArtifact>;
  getArtifact(orgId: string, id: string): Promise<ContextArtifact | null>;
  listArtifacts(query: ContextArtifactQuery): Promise<ContextArtifact[]>;
  putSnapshot(snapshot: ContextSnapshot): Promise<void>;
  getSnapshot(orgId: string, id: string): Promise<ContextSnapshot | null>;
  putBundle(bundle: ContextBundle): Promise<void>;
  getBundle(query: ContextBundleLookup): Promise<ContextBundle | null>;
  putCheckpoint(checkpoint: ContextProjectionCheckpoint): Promise<void>;
  getCheckpoint(
    orgId: string,
    projectorId: string,
    generation: string,
  ): Promise<ContextProjectionCheckpoint | null>;
}

export interface ContextArtifactProposal
  extends Omit<ContextArtifact, "status"> {
  status: Extract<ContextArtifactStatus, "proposed" | "needs_clarify">;
}

export interface ContextProjectionInput {
  org_id: string;
  generation: string;
  read_epoch: string;
  recorded_at: string;
  evidence: EvidenceReference[];
  source_events: ContextSourceEvent[];
  lifecycle_heads: ContextLifecycleHead[];
  previous_checkpoint?: ContextProjectionCheckpoint;
}

export interface ContextProjector {
  readonly id: string;
  readonly algorithm_version: string;
  capabilities(): ContextProjectionCapabilities;
  project(input: ContextProjectionInput): Promise<ContextArtifactProposal[]>;
}

export interface ContextSourceEvent {
  event: EvidenceReference & {
    org_id: string;
    ingested_at: string;
    parent_event_id?: string;
  };
  thread_id?: string;
  actor_id?: string;
  required_scope_ids: string[];
  text?: string;
  estimated_tokens?: number;
  attrs?: Record<string, JsonValue>;
}

export interface ContextSourceRead {
  read_epoch: string;
  recorded_at: string;
  lifecycle_complete: true;
  lifecycle_heads: ContextLifecycleHead[];
  events: ContextSourceEvent[];
}

export interface ContextLifecycleHead {
  source: string;
  external_id: string;
  head_event_id: string;
}

export interface AuthorizedContextSourceEvent extends ContextSourceEvent {
  status: "current" | "superseded" | "retracted";
}

export interface ContextEvidenceSource {
  openRead(request: ContextRequest): Promise<ContextSourceRead>;
}

export interface ContextAuthorityRead {
  read_epoch: string;
  recorded_at: string;
  events: Array<EventRecord & { content_media_type?: string }>;
  lifecycle_heads: ContextLifecycleHead[];
}

export interface ContextAuthorityReader {
  openContextRead(orgId: string): Promise<ContextAuthorityRead>;
}

export interface ContextVisibilityInput {
  request: ContextRequest;
  resource: {
    kind: ContextCandidateKind;
    resource_id: string;
    required_scope_ids: string[];
  };
}

export interface ContextPolicyEvaluator {
  policyHash(request: ContextRequest): Promise<string>;
  visible(input: ContextVisibilityInput): Promise<boolean>;
  protectedEventIds(input: {
    request: ContextRequest;
    read_epoch: string;
    recorded_at: string;
    events: AuthorizedContextSourceEvent[];
  }): Promise<string[]>;
  canReplay(input: {
    request: ContextReplayRequest;
    snapshot: ContextSnapshot;
    bundle: ContextBundle;
  }): Promise<boolean>;
}

export interface AuthorizedContextRetrievalPlan {
  request: ContextRequest;
  read_epoch: string;
  recorded_at: string;
  principal_policy_hash: string;
  events: AuthorizedContextSourceEvent[];
}

export interface RetrievedContextCandidate {
  candidate: ContextCandidate;
  section: ContextSectionKind;
  item: ContextBundleItem;
}

export interface ContextRetriever {
  readonly id: string;
  capabilities(): ContextRetrievalCapabilities;
  retrieve(plan: AuthorizedContextRetrievalPlan): Promise<RetrievedContextCandidate[]>;
}

export interface ContextProjectorRegistry {
  register(projector: ContextProjector): () => void;
  get(id: string): ContextProjector | undefined;
  list(): ContextProjector[];
}

export interface ContextProjectionRunner {
  project(orgId: string, generation: string): Promise<Array<{
    projector_id: string;
    projected_events: number;
    stored_artifacts: number;
    checkpoint_sequence: number;
  }>>;
}

export interface ContextRetrieverRegistry {
  register(retriever: ContextRetriever): () => void;
  get(id: string): ContextRetriever | undefined;
  list(): ContextRetriever[];
}

export interface ContextAssemblyResult {
  snapshot: ContextSnapshot;
  bundle: ContextBundle;
}

export interface ContextReplayRequest {
  org_id: string;
  snapshot_id: string;
  principal: ActorRef;
  consumer_id: string;
  purpose: string;
  allowed_uses: ContextRequest["allowed_uses"];
}

export interface ContextEngine {
  assemble(request: ContextRequest): Promise<ContextAssemblyResult>;
  replay(request: ContextReplayRequest): Promise<ContextBundle>;
}