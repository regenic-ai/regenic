import { canonicalContextJson } from "./context-canonical";
import type { ContextArtifact } from "./context-artifact";
import type {
  ContextArtifactDecision,
  ContextArtifactState,
  ContextArtifactSupersession,
} from "./context-artifact-lifecycle";
import type { ContextBundle } from "./context-bundle";
import type {
  ContextArtifactQuery,
  ContextArtifactStore,
  ContextBundleLookup,
  ContextProjectionCheckpoint,
} from "./context-port";
import type { ContextSnapshot } from "./context-snapshot";
import {
  validateContextArtifact,
  validateContextArtifactQuery,
  validateContextBundle,
  validateContextProjectionCheckpoint,
  validateContextSnapshot,
} from "./context-schema";

export class MemoryContextArtifactStore implements ContextArtifactStore {
  private readonly artifacts = new Map<string, ContextArtifact>();
  private readonly snapshots = new Map<string, ContextSnapshot>();
  private readonly bundles = new Map<string, ContextBundle>();
  private readonly checkpoints = new Map<string, ContextProjectionCheckpoint>();
  private readonly artifactStates = new Map<string, ContextArtifactState>();

  async putArtifact(artifact: ContextArtifact): Promise<ContextArtifact> {
    requireValid(validateContextArtifact(artifact), "artifact");
    this.putImmutable(this.artifacts, artifactKey(artifact.org_id, artifact.id), artifact, "artifact");
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
      .sort((left, right) => compare(`${left.recorded_at}\u0000${left.id}`, `${right.recorded_at}\u0000${right.id}`))
      .slice(0, stableQuery.limit ?? Number.POSITIVE_INFINITY)
      .map(clone);
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

function artifactKey(orgId: string, id: string): string {
  return keyOf(orgId, id);
}

function bundleKey(bundle: ContextBundle): string {
  return bundleLookupKey(bundle);
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
