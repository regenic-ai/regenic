import { randomUUID } from "node:crypto";
import { canonicalContextJson } from "./context-canonical";
import type { ContextArtifact } from "./context-artifact";
import type {
  BlobMetaInput,
  BlobReservation,
  ReserveBlobWritesInput,
} from "./ingestion";
import {
  contextArtifactPreview,
  type ContextArtifactIndex,
} from "./context-artifact-summary";
import type {
  ContextArtifactDecision,
  ContextArtifactState,
  ContextArtifactSupersession,
} from "./context-artifact-lifecycle";
import type { ContextBundle } from "./context-bundle";
import type {
  ContextArtifactEvidenceReferenceBackfill,
  ContextArtifactQuery,
  ContextArtifactStore,
  ContextBundleLookup,
  ContextProjectionCheckpoint,
} from "./context-port";
import type {
  ContextSnapshot,
  ContextSnapshotIndexEntry,
  ContextSnapshotIndexQuery,
} from "./context-snapshot";
import {
  validateContextArtifact,
  validateContextArtifactQuery,
  validateContextBundle,
  validateContextProjectionCheckpoint,
  validateContextSnapshot,
  validateContextSnapshotIndexEntry,
  validateContextSnapshotIndexQuery,
} from "./context-schema";

export class MemoryContextArtifactStore implements ContextArtifactStore {
  private readonly artifacts = new Map<string, ContextArtifact>();
  private readonly snapshots = new Map<string, ContextSnapshot>();
  private readonly snapshotIndex = new Map<string, ContextSnapshotIndexEntry>();
  private readonly bundles = new Map<string, ContextBundle>();
  private readonly checkpoints = new Map<string, ContextProjectionCheckpoint>();
  private readonly artifactStates = new Map<string, ContextArtifactState>();
  private readonly blobStates = new Map<string, {
    state: "reserved" | "available" | "deleting" | "protected";
    generation: number;
    claimToken?: string;
    leaseExpiresAt?: number;
  }>();

  seedProtectedBlob(contentHash: string): void {
    if (!/^[a-f0-9]{64}$/.test(contentHash)) {
      throw new Error("Invalid Blob hash");
    }
    if (!this.blobStates.has(contentHash)) {
      this.blobStates.set(contentHash, { state: "protected", generation: 0 });
    }
  }

  async reserveBlobWrites(input: ReserveBlobWritesInput): Promise<BlobReservation[]> {
    const blobs = [...new Map(input.blobs.map((blob) => [blob.content_hash, blob])).values()]
      .sort((left, right) => left.content_hash.localeCompare(right.content_hash));
    const forceWrite = new Set(input.force_write_hashes ?? []);
    if (!input.owner_id.trim() || !Number.isSafeInteger(input.lease_duration_ms)
      || input.lease_duration_ms < 1
      || blobs.some((blob) => !isValidBlobMeta(blob))
      || [...forceWrite].some((hash) => !blobs.some((blob) => blob.content_hash === hash))) {
      throw new Error("Invalid Blob reservation request");
    }

    const now = Date.now();
    const nextStates = new Map(this.blobStates);
    const reservations: BlobReservation[] = [];
    for (const blob of blobs) {
      const current = nextStates.get(blob.content_hash);
      if (!current) {
        const token = randomUUID();
        nextStates.set(blob.content_hash, {
          state: "reserved",
          generation: 1,
          claimToken: token,
          leaseExpiresAt: now + input.lease_duration_ms,
        });
        reservations.push({ content_hash: blob.content_hash, generation: 1, mode: "write", claim_token: token });
        continue;
      }
      if (current.state === "deleting"
        || current.claimToken && (current.leaseExpiresAt ?? 0) > now) {
        throw new Error(`Blob reservation is busy or unavailable: ${blob.content_hash}`);
      }
      if (current.state === "reserved" || forceWrite.has(blob.content_hash)) {
        const token = randomUUID();
        const generation = current.generation + 1;
        nextStates.set(blob.content_hash, {
          ...current,
          generation,
          claimToken: token,
          leaseExpiresAt: now + input.lease_duration_ms,
        });
        reservations.push({ content_hash: blob.content_hash, generation, mode: "write", claim_token: token });
      } else {
        nextStates.set(blob.content_hash, { ...current, claimToken: undefined, leaseExpiresAt: undefined });
        reservations.push({ content_hash: blob.content_hash, generation: current.generation, mode: "reuse" });
      }
    }
    this.blobStates.clear();
    for (const [hash, state] of nextStates) this.blobStates.set(hash, state);
    return reservations;
  }

  async releaseBlobReservations(reservations: readonly BlobReservation[]): Promise<void> {
    for (const reservation of reservations) {
      if (reservation.mode !== "write") continue;
      const current = this.blobStates.get(reservation.content_hash);
      if (current?.generation === reservation.generation
        && current.claimToken === reservation.claim_token) {
        this.blobStates.set(reservation.content_hash, {
          ...current,
          claimToken: undefined,
          leaseExpiresAt: undefined,
        });
      }
    }
  }

  async putArtifact(
    artifact: ContextArtifact,
    blobReservations?: readonly BlobReservation[],
  ): Promise<ContextArtifact> {
    requireValid(validateContextArtifact(artifact), "artifact");
    const referencedHashes = artifactBlobHashes(artifact);
    if (blobReservations) {
      const reservationHashes = new Set(blobReservations.map((reservation) => reservation.content_hash));
      if (reservationHashes.size !== blobReservations.length
        || reservationHashes.size !== referencedHashes.size
        || [...referencedHashes].some((hash) => !reservationHashes.has(hash))) {
        throw new Error("Context artifact reservations must exactly match its Blob references");
      }
      for (const reservation of blobReservations) {
        const current = this.blobStates.get(reservation.content_hash);
        const valid = current?.generation === reservation.generation
          && (reservation.mode === "write"
            ? current.claimToken === reservation.claim_token
              && (current.leaseExpiresAt ?? 0) > Date.now()
              && (current.state === "reserved" || current.state === "protected")
            : current.claimToken === undefined
              && (current.state === "available" || current.state === "protected"));
        if (!valid) throw new Error(`Blob reservation is busy or unavailable: ${reservation.content_hash}`);
      }
    } else {
      for (const hash of referencedHashes) {
        const current = this.blobStates.get(hash);
        if (current?.state === "reserved" || current?.state === "deleting"
          || current?.claimToken && (current.leaseExpiresAt ?? 0) > Date.now()) {
          throw new Error(`Cannot protect context artifact Blob reference: ${hash}`);
        }
      }
    }
    this.putImmutable(this.artifacts, artifactKey(artifact.org_id, artifact.id), artifact, "artifact");
    for (const hash of referencedHashes) {
      const current = this.blobStates.get(hash);
      if (!blobReservations) {
        this.blobStates.set(hash, {
          state: "protected",
          generation: current?.generation ?? 0,
        });
        continue;
      }
      const reservation = blobReservations.find((item) => item.content_hash === hash);
      if (!reservation) throw new Error("Context artifact Blob reservation disappeared");
      this.blobStates.set(hash, {
        state: current?.state === "protected" ? "protected" : "available",
        generation: current?.generation ?? reservation.generation,
      });
    }
    const key = artifactKey(artifact.org_id, artifact.id);
    if (!this.artifactStates.has(key)) {
      this.artifactStates.set(key, {
        org_id: artifact.org_id,
        artifact_id: artifact.id,
        status: artifact.status,
        decided_at: artifact.recorded_at,
      });
    }
    return clone(artifact);
  }

  async getArtifact(orgId: string, id: string): Promise<ContextArtifact | null> {
    return cloneOrNull(this.artifacts.get(artifactKey(orgId, id)));
  }

  async listArtifacts(query: ContextArtifactQuery): Promise<ContextArtifact[]> {
    const validation = validateContextArtifactQuery(query);
    requireValid(validation, "artifact query");
    const stableQuery = validation.success ? validation.data : query;
    const kinds = stableQuery.kinds ? new Set(stableQuery.kinds) : undefined;
    const statuses = stableQuery.statuses ? new Set(stableQuery.statuses) : undefined;
    return [...this.artifacts.values()]
      .filter((artifact) => artifact.org_id === stableQuery.org_id)
      .map((artifact) => this.withState(artifact))
      .filter((artifact) => !kinds || kinds.has(artifact.kind))
      .filter((artifact) => !statuses || statuses.has(artifact.status))
      .filter((artifact) => !stableQuery.generation || artifact.generation === stableQuery.generation)
      .filter((artifact) => stableQuery.after_recorded_at === undefined ||
        artifact.recorded_at > stableQuery.after_recorded_at ||
        artifact.recorded_at === stableQuery.after_recorded_at &&
          compareUnicodeScalars(artifact.id, stableQuery.after_id ?? "") > 0)
      .sort((left, right) =>
        compare(left.recorded_at, right.recorded_at) || compareUnicodeScalars(left.id, right.id))
      .slice(0, stableQuery.limit ?? Number.POSITIVE_INFINITY)
      .map(clone);
  }

  async backfillArtifactEvidenceReferences(
    input: ContextArtifactEvidenceReferenceBackfill,
  ): Promise<void> {
    const artifact = this.artifacts.get(artifactKey(input.org_id, input.artifact_id));
    if (!artifact || artifact.input_hash !== input.expected_input_hash) {
      throw new Error("Context artifact changed during evidence reference backfill");
    }
    const hashes = [...new Set(artifact.input_refs.flatMap((reference) =>
      reference.content_hash ? [reference.content_hash] : []))].sort();
    for (const hash of hashes) {
      const current = this.blobStates.get(hash);
      if (current?.state === "deleting" || current?.state === "reserved" ||
        current?.claimToken && (current.leaseExpiresAt ?? 0) > Date.now()) {
        throw new Error(`Blob reservation is busy or unavailable: ${hash}`);
      }
    }
    for (const hash of hashes) {
      this.blobStates.set(hash, { state: "protected", generation: this.blobStates.get(hash)?.generation ?? 0 });
    }
  }

  async listArtifactIndexes(query: ContextArtifactQuery): Promise<ContextArtifactIndex[]> {
    return (await this.listArtifacts(query)).map((artifact) => ({
      id: artifact.id,
      kind: artifact.kind,
      status: artifact.status,
      recorded_at: artifact.recorded_at,
      preview: contextArtifactPreview(artifact),
    }));
  }

  async getArtifactState(orgId: string, artifactId: string): Promise<ContextArtifactState | null> {
    return cloneOrNull(this.artifactStates.get(artifactKey(orgId, artifactId)));
  }

  async decideArtifact(input: ContextArtifactDecision): Promise<ContextArtifactState> {
    const state = this.requireTransitionable(input.org_id, input.artifact_id);
    if (input.status === "needs_clarify" || input.status === "accepted" || input.status === "rejected") {
      const next = { ...state, status: input.status, decided_at: input.decided_at } as ContextArtifactState;
      this.artifactStates.set(artifactKey(input.org_id, input.artifact_id), next);
      return clone(next);
    }
    throw new Error("Invalid Context artifact decision");
  }

  async supersedeArtifact(input: ContextArtifactSupersession): Promise<{
    superseded: ContextArtifactState;
    accepted: ContextArtifactState;
  }> {
    const current = this.artifactStates.get(artifactKey(input.org_id, input.artifact_id));
    const replacement = this.requireTransitionable(input.org_id, input.replacement_id);
    const artifact = this.artifacts.get(artifactKey(input.org_id, input.replacement_id));
    if (
      !current || current.status !== "accepted" ||
      !artifact || artifact.supersedes_id !== input.artifact_id
    ) {
      throw new Error("Invalid Context artifact supersession");
    }
    const superseded = {
      ...current,
      status: "superseded" as const,
      decided_at: input.decided_at,
      superseded_by: input.replacement_id,
    };
    const accepted = {
      ...replacement,
      status: "accepted" as const,
      decided_at: input.decided_at,
    };
    this.artifactStates.set(artifactKey(input.org_id, input.artifact_id), superseded);
    this.artifactStates.set(artifactKey(input.org_id, input.replacement_id), accepted);
    return { superseded: clone(superseded), accepted: clone(accepted) };
  }

  async putSnapshot(snapshot: ContextSnapshot): Promise<void> {
    requireValid(validateContextSnapshot(snapshot), "snapshot");
    this.putImmutable(this.snapshots, artifactKey(snapshot.org_id, snapshot.id), snapshot, "snapshot");
  }

  async getSnapshot(orgId: string, id: string): Promise<ContextSnapshot | null> {
    return cloneOrNull(this.snapshots.get(artifactKey(orgId, id)));
  }

  async putSnapshotIndex(entry: ContextSnapshotIndexEntry): Promise<void> {
    requireValid(validateContextSnapshotIndexEntry(entry), "snapshot index entry");
    this.putImmutable(
      this.snapshotIndex,
      snapshotIndexKey(entry),
      entry,
      "snapshot index entry",
    );
  }

  async listSnapshotIndex(query: ContextSnapshotIndexQuery): Promise<ContextSnapshotIndexEntry[]> {
    const validation = validateContextSnapshotIndexQuery(query);
    requireValid(validation, "snapshot index query");
    const stableQuery = validation.success ? validation.data : query;
    return [...this.snapshotIndex.values()]
      .filter((entry) =>
        entry.org_id === stableQuery.org_id
        && entry.thread_id === stableQuery.thread_id
        && entry.principal.actor_type === stableQuery.principal.actor_type
        && entry.principal.actor_id === stableQuery.principal.actor_id
        && entry.consumer_id === stableQuery.consumer_id
        && (!stableQuery.purpose || entry.purpose === stableQuery.purpose)
      )
      .filter((entry) => !stableQuery.before_created_at
        || entry.created_at < stableQuery.before_created_at
        || (
          entry.created_at === stableQuery.before_created_at
          && entry.snapshot_id < stableQuery.before_snapshot_id!
        ))
      .sort((left, right) =>
        compare(
          `${right.created_at}\u0000${right.snapshot_id}`,
          `${left.created_at}\u0000${left.snapshot_id}`,
        )
      )
      .slice(0, stableQuery.limit ?? Number.POSITIVE_INFINITY)
      .map(clone);
  }

  async putBundle(bundle: ContextBundle): Promise<void> {
    requireValid(validateContextBundle(bundle), "bundle");
    this.putImmutable(this.bundles, bundleKey(bundle), bundle, "bundle");
  }

  async getBundle(query: ContextBundleLookup): Promise<ContextBundle | null> {
    return cloneOrNull(this.bundles.get(bundleLookupKey(query)));
  }

  async putCheckpoint(checkpoint: ContextProjectionCheckpoint): Promise<void> {
    const stableCheckpoint = validatedCheckpoint(checkpoint);
    const key = checkpointKey(
      stableCheckpoint.org_id,
      stableCheckpoint.projector_id,
      stableCheckpoint.generation,
    );
    const current = this.checkpoints.get(key);
    if (current) {
      if (current.algorithm_version !== stableCheckpoint.algorithm_version) {
        throw new Error("Projection checkpoint algorithm cannot change within a generation");
      }
      if (current.sequence > stableCheckpoint.sequence) {
        throw new Error("Projection checkpoint cannot move backwards");
      }
      if (current.sequence === stableCheckpoint.sequence) {
        if (canonicalContextJson(current) === canonicalContextJson(stableCheckpoint)) {
          return;
        }
        if (
          current.watermark === stableCheckpoint.watermark ||
          Date.parse(stableCheckpoint.updated_at) <= Date.parse(current.updated_at)
        ) {
          throw new Error("Projection checkpoint cannot regress at the same sequence");
        }
      }
    }
    this.checkpoints.set(key, clone(stableCheckpoint));
  }

  async getCheckpoint(
    orgId: string,
    projectorId: string,
    generation: string,
  ): Promise<ContextProjectionCheckpoint | null> {
    return cloneOrNull(this.checkpoints.get(checkpointKey(orgId, projectorId, generation)));
  }

  private putImmutable<T>(store: Map<string, T>, key: string, value: T, label: string): void {
    const current = store.get(key);
    if (current && canonicalContextJson(current) !== canonicalContextJson(value)) {
      throw new Error(`Cannot replace immutable context ${label}: ${key}`);
    }
    if (!current) {
      store.set(key, clone(value));
    }
  }

  private withState(artifact: ContextArtifact): ContextArtifact {
    const state = this.artifactStates.get(artifactKey(artifact.org_id, artifact.id));
    return state ? { ...artifact, status: state.status } : artifact;
  }

  private requireTransitionable(orgId: string, artifactId: string): ContextArtifactState {
    const state = this.artifactStates.get(artifactKey(orgId, artifactId));
    if (!state || !["proposed", "needs_clarify"].includes(state.status)) {
      throw new Error("Context artifact is not transitionable");
    }
    return state;
  }
}

function artifactBlobHashes(artifact: ContextArtifact): Set<string> {
  return new Set([
    ...(artifact.body_hash && artifact.body_storage !== "artifact" ? [artifact.body_hash] : []),
    ...artifact.input_refs.flatMap((reference) => reference.content_hash ? [reference.content_hash] : []),
  ]);
}

function isValidBlobMeta(blob: BlobMetaInput): boolean {
  return /^[a-f0-9]{64}$/.test(blob.content_hash)
    && Boolean(blob.media_type.trim())
    && Number.isSafeInteger(blob.byte_size)
    && blob.byte_size >= 0;
}

function artifactKey(orgId: string, id: string): string {
  return keyOf(orgId, id);
}

function bundleKey(bundle: ContextBundle): string {
  return bundleLookupKey(bundle);
}

function snapshotIndexKey(entry: ContextSnapshotIndexEntry): string {
  return JSON.stringify([
    entry.org_id,
    entry.thread_id,
    entry.snapshot_id,
    entry.principal.actor_type,
    entry.principal.actor_id,
    entry.consumer_id,
  ]);
}

function bundleLookupKey(bundle: ContextBundleLookup): string {
  return keyOf(
    bundle.org_id,
    bundle.snapshot_id,
    bundle.principal.actor_type,
    bundle.principal.actor_id,
    bundle.consumer_id,
  );
}

function checkpointKey(orgId: string, projectorId: string, generation: string): string {
  return keyOf(orgId, projectorId, generation);
}

function keyOf(...parts: string[]): string {
  return canonicalContextJson(parts);
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareUnicodeScalars(left: string, right: string): number {
  const leftScalars = Array.from(left, (value) => value.codePointAt(0)!);
  const rightScalars = Array.from(right, (value) => value.codePointAt(0)!);
  const length = Math.min(leftScalars.length, rightScalars.length);
  for (let index = 0; index < length; index += 1) {
    if (leftScalars[index] !== rightScalars[index]) {
      return leftScalars[index] - rightScalars[index];
    }
  }
  return leftScalars.length - rightScalars.length;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function cloneOrNull<T>(value: T | undefined): T | null {
  return value === undefined ? null : clone(value);
}

function requireValid(
  result: { success: true } | { success: false; issues: Array<{ message: string }> },
  label: string,
): void {
  if (!result.success) {
    throw new Error(`Invalid context ${label}: ${result.issues.map((issue) => issue.message).join("; ")}`);
  }
}

function validatedCheckpoint(checkpoint: unknown): ContextProjectionCheckpoint {
  const validation = validateContextProjectionCheckpoint(checkpoint);
  requireValid(validation, "projection checkpoint");
  if (!validation.success) {
    throw new Error("Invalid context projection checkpoint");
  }
  return validation.data;
}
