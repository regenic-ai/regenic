import {
  canonicalContextJson,
  bodyTextFromStored,
  hashCanonicalContext,
  hashContextArtifactInputs,
  threadProjectionGeneration,
  type BlobStore,
  type ContextArtifact,
  type ContextArtifactStore,
  type ContextAuthorityReader,
  type ContextAuthorityRead,
  type ContextProjector,
  type ContextProjectorRegistry,
  type ContextProjectionRunner,
  type EvidenceReference,
  type ContextSourceEvent,
} from "@regenic/domain";

export interface ContextProjectionRun {
  projector_id: string;
  projected_events: number;
  stored_artifacts: number;
  checkpoint_sequence: number;
}

type AuthorityEvent = ContextAuthorityRead["events"][number];

export class ContextProjectionCoordinator implements ContextProjectionRunner {
  constructor(
    private readonly authority: ContextAuthorityReader,
    private readonly artifacts: ContextArtifactStore,
    private readonly projectors: ContextProjectorRegistry,
    private readonly blobs?: BlobStore,
  ) {}

  async project(orgId: string, generation: string): Promise<ContextProjectionRun[]> {
    requireProjectionNamespace(orgId, generation);
    const read = structuredClone(await this.authority.openContextRead(orgId));
    return this.projectRead(orgId, generation, read);
  }

  async projectThread(
    orgId: string,
    generation: string,
    threadId: string,
  ): Promise<ContextProjectionRun[]> {
    requireProjectionNamespace(orgId, generation);
    const scopedGeneration = threadProjectionGeneration(generation, threadId);
    const read = structuredClone(
      await this.authority.openContextReadForThread(orgId, threadId),
    );
    return this.projectRead(orgId, scopedGeneration, read, orgId);
  }

  private async projectRead(
    orgId: string,
    generation: string,
    read: ContextAuthorityRead,
    validateOrgId = orgId,
  ): Promise<ContextProjectionRun[]> {
    if (
      typeof read.read_epoch !== "string" ||
      !read.read_epoch.trim() ||
      typeof read.recorded_at !== "string" ||
      Number.isNaN(Date.parse(read.recorded_at))
    ) {
      throw new Error("Context projection authority returned an invalid read boundary");
    }
    if (read.events.some((event) => event.org_id !== validateOrgId)) {
      throw new Error("Context projection authority read contains an Event from another organization");
    }
    const evidence = read.events.map(toEvidence);
    const sourceEvents = await toSourceEvents(read.events, this.blobs);
    const eventsByEvidence = new Map(
      read.events.map((event) => [canonicalContextJson(toEvidence(event)), event]),
    );
    const sequence = read.events.length;
    const runs: ContextProjectionRun[] = [];

    for (const projector of this.projectors.list()) {
      const previous = await this.artifacts.getCheckpoint(orgId, projector.id, generation);
      if (previous && previous.sequence > sequence) {
        throw new Error("Projection checkpoint exceeds the authority read");
      }
      if (previous?.sequence === sequence) {
        runs.push({
          projector_id: projector.id,
          projected_events: 0,
          stored_artifacts: 0,
          checkpoint_sequence: sequence,
        });
        continue;
      }
      const proposals = await projector.project({
        org_id: orgId,
        generation,
        read_epoch: read.read_epoch,
        recorded_at: read.recorded_at,
        evidence: structuredClone(evidence),
        source_events: structuredClone(sourceEvents),
        lifecycle_heads: structuredClone(read.lifecycle_heads),
        ...(previous ? { previous_checkpoint: structuredClone(previous) } : {}),
      });
      let storedArtifacts = 0;
      for (const proposal of proposals) {
        const artifact = validateProposal(
          proposal,
          projector,
          orgId,
          generation,
          read.recorded_at,
          eventsByEvidence,
        );
        if (artifact.attrs !== undefined && artifact.body_hash) {
          await this.blobs?.put(
            artifact.body_hash,
            Buffer.from(canonicalContextJson(artifact.attrs), "utf8"),
            "application/vnd.regenic.context-artifact+json",
          );
        }
        await this.artifacts.putArtifact(artifact);
        storedArtifacts += 1;
      }
      await this.artifacts.putCheckpoint({
        org_id: orgId,
        projector_id: projector.id,
        algorithm_version: projector.algorithm_version,
        generation,
        sequence,
        watermark: read.read_epoch,
        updated_at: read.recorded_at,
      });
      runs.push({
        projector_id: projector.id,
        projected_events: evidence.length,
        stored_artifacts: storedArtifacts,
        checkpoint_sequence: sequence,
      });
    }
    return runs;
  }
}

function toEvidence(event: AuthorityEvent): EvidenceReference {
  return {
    event_id: event.id,
    source: event.source,
    external_id: event.external_id,
    operation: event.operation,
    occurred_at: event.occurred_at,
    ...(event.content_hash ? { content_hash: event.content_hash } : {}),
  };
}

function validateProposal(
  proposal: ContextArtifact,
  projector: ContextProjector,
  orgId: string,
  generation: string,
  recordedAt: string,
  eventsByEvidence: ReadonlyMap<string, AuthorityEvent>,
): ContextArtifact {
  if (
    proposal.org_id !== orgId ||
    proposal.generation !== generation ||
    proposal.algorithm_version !== projector.algorithm_version ||
    !projector.capabilities().artifact_kinds.includes(proposal.kind) ||
    proposal.status !== "proposed" && proposal.status !== "needs_clarify" ||
    proposal.input_refs.length === 0 ||
    proposal.recorded_at !== recordedAt ||
    proposal.input_hash !== hashContextArtifactInputs(proposal) ||
    proposal.attrs !== undefined && proposal.body_hash !== hashCanonicalContext(proposal.attrs)
  ) {
    throw new Error("Projector returned an invalid context artifact proposal");
  }
  const requiredScopes = new Set<string>();
  for (const reference of proposal.input_refs) {
    const event = eventsByEvidence.get(canonicalContextJson(reference));
    if (!event?.required_scope_ids?.length) {
      throw new Error("Projector proposal references evidence outside the authority read");
    }
    for (const scope of event.required_scope_ids) {
      requiredScopes.add(scope);
    }
  }
  const expectedScopes = [...requiredScopes].sort();
  if (canonicalContextJson([...proposal.required_scope_ids].sort()) !== canonicalContextJson(expectedScopes)) {
    throw new Error("Projector proposal cannot widen or narrow evidence scopes");
  }
  return structuredClone(proposal);
}

async function toSourceEvents(
  events: AuthorityEvent[],
  blobs?: BlobStore,
): Promise<ContextSourceEvent[]> {
  const hashes = [...new Set(events.flatMap((event) =>
    event.operation !== "tombstone" && event.content_hash ? [event.content_hash] : [],
  ))];
  const bodies = blobs ? await blobs.getMany(hashes) : new Map<string, Uint8Array>();
  if (blobs && hashes.some((hash) => !bodies.has(hash))) {
    throw new Error("Context projection authority Event references a missing Blob");
  }
  return events.map((event) => {
    const bytes = event.content_hash ? bodies.get(event.content_hash) : undefined;
    const text = bytes && event.content_media_type
      ? bodyTextFromStored(bytes, event.content_media_type)
      : undefined;
    return {
      event: {
        ...toEvidence(event),
        org_id: event.org_id,
        ingested_at: event.ingested_at,
        ...(event.parent_event_id ? { parent_event_id: event.parent_event_id } : {}),
      },
      ...(event.thread_id ? { thread_id: event.thread_id } : {}),
      ...(event.actor_id ? { actor_id: event.actor_id } : {}),
      required_scope_ids: [...(event.required_scope_ids ?? [])],
      ...(text === undefined ? {} : { text }),
    };
  });
}

function requireProjectionNamespace(orgId: string, generation: string): void {
  if (!orgId.trim() || !generation.trim()) {
    throw new Error("Context projection organization and generation are required");
  }
}
