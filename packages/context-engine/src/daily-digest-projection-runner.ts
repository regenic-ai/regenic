import {
  canonicalContextJson,
  hashCanonicalContext,
  hashContextArtifactInputs,
  type BlobStore,
  type ContextArtifactStore,
  type DailyDigestProjectionRunner,
} from "@regenic/domain";
import { AuthorityContextEvidenceSource } from "./authority-context-source";
import { DeterministicDailyDigestProjector } from "./deterministic-daily-digest-projector";

export class DailyDigestProjectionCoordinator implements DailyDigestProjectionRunner {
  constructor(
    private readonly source: AuthorityContextEvidenceSource,
    private readonly artifacts: ContextArtifactStore,
    private readonly blobs: BlobStore,
    private readonly projector = new DeterministicDailyDigestProjector(),
  ) {}

  async projectDailyDigest(input: {
    org_id: string;
    utc_date: string;
    generation?: string;
  }): Promise<{ artifact_id?: string; input_event_count: number }> {
    if (!input.org_id?.trim()) throw new Error("Daily digest organization is required");
    const generation = input.generation?.trim() || "daily-digest-d0-v1";
    const source = await this.source.openRead({ org_id: input.org_id } as never);
    const heads = new Set(source.lifecycle_heads.map((head) => head.head_event_id));
    const selectedIds = new Set(source.events
      .filter((event) => heads.has(event.event.event_id))
      .filter((event) => event.event.operation !== "tombstone")
      .filter((event) => event.event.occurred_at.slice(0, 10) === input.utc_date)
      .map((event) => identity(event.event.source, event.event.external_id)));
    const materialized = await this.source.materialize(source.events
      .filter((event) => selectedIds.has(identity(event.event.source, event.event.external_id)))
      .map((event) => ({ ...event, status: "current" as const })));
    const proposal = await this.projector.project({
      org_id: input.org_id,
      utc_date: input.utc_date,
      generation,
      source: { ...source, events: materialized },
    });
    if (!proposal) return { input_event_count: 0 };
    if (
      proposal.input_hash !== hashContextArtifactInputs(proposal) ||
      proposal.body_hash !== hashCanonicalContext(proposal.attrs) ||
      !proposal.required_scope_ids.length
    ) {
      throw new Error("Daily digest projector returned an invalid artifact");
    }
    await this.blobs.put(
      proposal.body_hash,
      Buffer.from(canonicalContextJson(proposal.attrs), "utf8"),
      "application/vnd.regenic.context-artifact+json",
    );
    await this.artifacts.putArtifact(proposal);
    return { artifact_id: proposal.id, input_event_count: proposal.input_refs.length };
  }
}

function identity(source: string, externalId: string): string {
  return canonicalContextJson([source, externalId]);
}
