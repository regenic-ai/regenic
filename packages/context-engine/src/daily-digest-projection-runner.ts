import {
  canonicalContextJson,
  CONTEXT_DAILY_DIGEST_ALGORITHM_VERSION,
  hashCanonicalContext,
  hashContextArtifactInputs,
  type BlobStore,
  type ContextArtifactStore,
  type DailyDigestProjectionRunner,
  DEFAULT_DAILY_DIGEST_POLICY,
  type DailyDigestPolicyStore,
  type DailyDigestCoverageAlertStore,
} from "@regenic/domain";
import { AuthorityContextEvidenceSource } from "./authority-context-source";
import { DeterministicDailyDigestProjector } from "./deterministic-daily-digest-projector";

export class DailyDigestProjectionCoordinator implements DailyDigestProjectionRunner {
  constructor(
    private readonly source: AuthorityContextEvidenceSource,
    private readonly artifacts: ContextArtifactStore,
    private readonly blobs: BlobStore,
    private readonly projector = new DeterministicDailyDigestProjector(),
    private readonly policies?: DailyDigestPolicyStore,
    private readonly coverageAlerts?: DailyDigestCoverageAlertStore,
  ) {}

  async projectDailyDigest(input: {
    org_id: string;
    utc_date: string;
    generation?: string;
  }): Promise<{ artifact_id?: string; input_event_count: number }> {
    if (!input.org_id?.trim()) throw new Error("Daily digest organization is required");
    const generation = input.generation?.trim() || CONTEXT_DAILY_DIGEST_ALGORITHM_VERSION;
    const policy = await this.policies?.getDailyDigestPolicy(input.org_id)
      ?? DEFAULT_DAILY_DIGEST_POLICY;
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
    const projection = await this.projector.projectWithCoverage({
      org_id: input.org_id,
      utc_date: input.utc_date,
      generation,
      source: { ...source, events: materialized },
      policy,
    });
    for (const eventId of projection.omitted_event_ids) {
      await this.coverageAlerts?.putDailyDigestCoverageAlert({
        id: `daily-digest-coverage:${hashCanonicalContext([
          input.org_id, input.utc_date, generation, eventId, "omitted_high_signal",
        ])}`,
        org_id: input.org_id,
        local_date: input.utc_date,
        generation,
        event_id: eventId,
        reason_code: "omitted_high_signal",
        status: "open",
        created_at: source.recorded_at,
      });
    }
    const projected = projection.proposal;
    if (!projected) return { input_event_count: 0 };
    const previous = (await this.artifacts.listArtifacts({
      org_id: input.org_id,
      kinds: ["daily_digest"],
      statuses: ["proposed"],
      generation,
    })).find((artifact) => isDigestForUtcDate(artifact.attrs, input.utc_date));
    const proposal = previous && previous.id !== projected.id
      ? { ...projected, supersedes_id: previous.id }
      : projected;
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
    if (previous && previous.id !== proposal.id) {
      await this.artifacts.supersedeProposedArtifact({
        org_id: input.org_id,
        artifact_id: previous.id,
        replacement_id: proposal.id,
        decided_at: source.recorded_at,
      });
    }
    return { artifact_id: proposal.id, input_event_count: proposal.input_refs.length };
  }
}

function identity(source: string, externalId: string): string {
  return canonicalContextJson([source, externalId]);
}

function isDigestForUtcDate(attrs: unknown, utcDate: string): boolean {
  return Boolean(attrs && typeof attrs === "object" && !Array.isArray(attrs)
    && (attrs as { utc_date?: unknown }).utc_date === utcDate);
}
