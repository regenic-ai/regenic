import {
  canonicalContextJson,
  hashContextArtifactInputs,
  type ContextArtifact,
  type ContextArtifactStore,
  type ContextAuthorityReader,
  type ContextProjector,
  type ContextProjectorRegistry,
  type ContextProjectionRunner,
  type EvidenceReference,
} from "@regenic/domain";

export interface ContextProjectionRun {
  projector_id: string;
  projected_events: number;
  stored_artifacts: number;
  checkpoint_sequence: number;
}

export class ContextProjectionCoordinator implements ContextProjectionRunner {
  constructor(
    private readonly authority: ContextAuthorityReader,
    private readonly artifacts: ContextArtifactStore,
    private readonly projectors: ContextProjectorRegistry,
  ) {}

  async project(orgId: string, generation: string): Promise<ContextProjectionRun[]> {
    const read = structuredClone(await this.authority.openContextRead(orgId));
    const evidence = read.events.map(toEvidence);
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
        evidence: structuredClone(evidence),
        ...(previous ? { previous_checkpoint: structuredClone(previous) } : {}),
      });
      let storedArtifacts = 0;
      for (const proposal of proposals) {
        const artifact = validateProposal(proposal, projector, orgId, generation, read.recorded_at, eventsByEvidence);
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

function toEvidence(event: Awaited<ReturnType<ContextAuthorityReader["openContextRead"]>>["events"][number]): EvidenceReference {
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
  eventsByEvidence: ReadonlyMap<string, Awaited<ReturnType<ContextAuthorityReader["openContextRead"]>>["events"][number]>,
): ContextArtifact {
  if (
    proposal.org_id !== orgId ||
    proposal.generation !== generation ||
    proposal.algorithm_version !== projector.algorithm_version ||
    proposal.status !== "proposed" && proposal.status !== "needs_clarify" ||
    proposal.recorded_at !== recordedAt ||
    proposal.input_hash !== hashContextArtifactInputs(proposal)
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