import type { ActorRef } from "./actor";
import type { ContextArtifact, ContextArtifactKind, ContextArtifactStatus } from "./context-artifact";
import type { ContextArtifactIndex } from "./context-artifact-summary";
import type {
  ContextArtifactDecision,
  ContextArtifactLifecycleStore,
  ContextArtifactState,
  ContextArtifactSupersession,
} from "./context-artifact-lifecycle";
import type { ContextBundle, ContextBundleItem } from "./context-bundle";
import type { ContextSectionKind } from "./context-budget";
import type { ContextCandidate, ContextCandidateKind } from "./context-candidate";
import type { EvidenceReference } from "./context-consumer";
import type { ContextRequest } from "./context-request";
import type {
  ContextSnapshot,
  ContextSnapshotIndexEntry,
  ContextSnapshotIndexQuery,
  ContextRetrievalTrace,
} from "./context-snapshot";
import type {
  BlobReservation,
  EventRecord,
  JsonValue,
  ReserveBlobWritesInput,
  WeightHints,
} from "./ingestion";
import type { ContextEmbeddingMaterial, EmbeddingGeneration } from "./embedding-provider";

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
  /** Accepts metadata-only plans and loads Event text through the supplied materializer. */
  lazy_materialization?: boolean;
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
  after_recorded_at?: string;
  after_id?: string;
}

export interface ContextArtifactEvidenceReferenceBackfill {
  org_id: string;
  artifact_id: string;
  expected_input_hash: string;
}

export interface ContextBundleLookup {
  org_id: string;
  snapshot_id: string;
  principal: ActorRef;
  consumer_id: string;
}

export interface ContextArtifactStore extends ContextArtifactLifecycleStore {
  reserveBlobWrites(input: ReserveBlobWritesInput): Promise<BlobReservation[]>;
  releaseBlobReservations(reservations: readonly BlobReservation[]): Promise<void>;
  putArtifact(
    artifact: ContextArtifact,
    blobReservations?: readonly BlobReservation[],
  ): Promise<ContextArtifact>;
  getArtifact(orgId: string, id: string): Promise<ContextArtifact | null>;
  listArtifacts(query: ContextArtifactQuery): Promise<ContextArtifact[]>;
  backfillArtifactEvidenceReferences(
    input: ContextArtifactEvidenceReferenceBackfill,
  ): Promise<void>;
  listArtifactIndexes(query: ContextArtifactQuery): Promise<ContextArtifactIndex[]>;
  getArtifactState(orgId: string, artifactId: string): Promise<ContextArtifactState | null>;
  decideArtifact(input: ContextArtifactDecision): Promise<ContextArtifactState>;
  supersedeArtifact(input: ContextArtifactSupersession): Promise<{
    superseded: ContextArtifactState;
    accepted: ContextArtifactState;
  }>;
  putSnapshot(snapshot: ContextSnapshot): Promise<void>;
  getSnapshot(orgId: string, id: string): Promise<ContextSnapshot | null>;
  putSnapshotIndex(entry: ContextSnapshotIndexEntry): Promise<void>;
  listSnapshotIndex(query: ContextSnapshotIndexQuery): Promise<ContextSnapshotIndexEntry[]>;
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
  content_media_type?: string;
  text?: string;
  search_parts?: import("./context-search").ContextSearchPart[];
  search_body?: string;
  estimated_tokens?: number;
  direction_tags?: string[];
  weight_hints?: WeightHints;
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
  /**
   * Epoch of openRead for the same request, without the event bodies.
   * Absent means the caller reads the epoch from openRead.
   */
  openReadEpoch?(request: ContextRequest): Promise<string>;
  /**
   * Changes when any authority commit lands, including same-connection writes.
   * Equal stamps mean the last openRead is still the current lifecycle.
   */
  openReadStamp?(): Promise<string>;
  /**
   * File path of the authority database. Personal search uses it to filter
   * current heads inside the index instead of copying them into the process.
   */
  databasePath?(): string | undefined;
  /**
   * Current-head metadata for the ids a ranked index query already returned.
   * Missing ids are not current heads and must not be displayed.
   */
  loadCurrentEvents?(orgId: string, eventIds: string[]): Promise<ContextSourceEvent[]>;
  materialize?(
    events: AuthorizedContextSourceEvent[],
  ): Promise<AuthorizedContextSourceEvent[]>;
  materializeForEmbedding?(
    events: AuthorizedContextSourceEvent[],
    extractorVersion?: EmbeddingGeneration["extractor_version"],
  ): Promise<ContextEmbeddingMaterial[]>;
}

export interface ContextAuthorityRead {
  read_epoch: string;
  recorded_at: string;
  events: Array<EventRecord & { content_media_type?: string }>;
  lifecycle_heads: ContextLifecycleHead[];
}

export interface ContextEventPageQuery {
  after_event_id?: string;
  limit: number;
}

export interface ContextEventPage {
  events: ContextAuthorityRead["events"];
  /** True when this page reached the end of the authority sequence. */
  done: boolean;
}

export interface ContextAuthorityReader {
  openContextRead(orgId: string, query?: ContextAuthorityReadQuery): Promise<ContextAuthorityRead>;
  /**
   * Same epoch string as openContextRead, without transferring the events.
   * Absent means the caller takes the epoch from a full read.
   */
  openContextReadEpoch?(orgId: string, query?: ContextAuthorityReadQuery): Promise<string>;
  /**
   * Database-level commit stamp. It is not scoped to one organization:
   * a matching stamp means no authority commit happened, so every org is unchanged.
   */
  openContextMutationStamp?(): Promise<string>;
  /** Thread-scoped read for incremental projection without scanning the org. */
  openContextReadForThread(
    orgId: string,
    threadId: string,
  ): Promise<ContextAuthorityRead>;
  /**
   * One sequence-ordered page of authority events, without blob bytes.
   * Absent means lexical rebuild falls back to a full authority read.
   */
  openContextEventPage?(
    orgId: string,
    query: ContextEventPageQuery,
  ): Promise<ContextEventPage>;
  /** On-disk authority file. Absent for hosted databases and in-memory stores. */
  databasePath?(): string;
  /** Current heads for these ids only. Ids that are not current heads are omitted. */
  readCurrentHeadsByIds?(
    orgId: string,
    eventIds: string[],
  ): Promise<ContextAuthorityRead["events"]>;
}

export interface ContextAuthorityReadQuery {
  filters?: ContextRequest["filters"];
  anchors?: ContextRequest["anchors"];
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
  /** Protected Event selection does not require text; absent means eager compatibility. */
  metadata_only?: boolean;
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
  /**
   * Present only for personal search against a local authority file.
   * Retrievers then rank inside the index and materialize this shortlist,
   * instead of receiving every visible event.
   */
  index_scope?: {
    authority_path: string;
    /** Lexical shortlist size. Vector search uses its own candidate limit. */
    limit: number;
    stamp: string;
  };
}

export interface RetrievedContextCandidate {
  candidate: ContextCandidate;
  section: ContextSectionKind;
  item: ContextBundleItem;
}

export interface ContextRetrievalResult {
  candidates: RetrievedContextCandidate[];
  degradation_flags?: string[];
  trace?: ContextRetrievalTrace;
}

export interface ContextRetriever {
  readonly id: string;
  capabilities(): ContextRetrievalCapabilities;
  retrieve(
    plan: AuthorizedContextRetrievalPlan,
    materialize?: ContextEventMaterializer,
  ): Promise<RetrievedContextCandidate[] | ContextRetrievalResult>;
}

export type ContextEventMaterializer = (
  eventIds: readonly string[],
) => Promise<AuthorizedContextSourceEvent[]>;

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
  projectThread(
    orgId: string,
    generation: string,
    threadId: string,
  ): Promise<Array<{
    projector_id: string;
    projected_events: number;
    stored_artifacts: number;
    checkpoint_sequence: number;
  }>>;
  syncLexicalIndex(
    orgId: string,
    generation: string,
    eventIds?: string[],
    threadId?: string,
  ): Promise<void>;
  /**
   * False while a generation or text-version walk still has pages left.
   * Absent means one syncLexicalIndex call already finished the walk.
   */
  lexicalMaintenanceIdle?(orgId: string, generation: string): Promise<boolean>;
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