import {
  canonicalContextJson,
  hashCanonicalContext,
  type BlobStore,
  type ContextArtifactStore,
  type ContextRetriever,
  type ContextRetrievalCapabilities,
  type AuthorizedContextRetrievalPlan,
  type RetrievedContextCandidate,
} from "@regenic/domain";

export const ACCEPTED_THREAD_SUMMARY_RETRIEVER_ID = "thread-summary-accepted";

export class AcceptedThreadSummaryRetriever implements ContextRetriever {
  readonly id = ACCEPTED_THREAD_SUMMARY_RETRIEVER_ID;

  constructor(
    private readonly artifacts: ContextArtifactStore,
    private readonly blobs: BlobStore,
  ) {}

  capabilities(): ContextRetrievalCapabilities {
    return {
      candidate_kinds: ["artifact"],
      lexical: true,
      vector: false,
      graph: false,
      rerank: false,
      multilingual: true,
    };
  }

  async retrieve(plan: AuthorizedContextRetrievalPlan): Promise<RetrievedContextCandidate[]> {
    if (plan.request.requested_kinds && !plan.request.requested_kinds.includes("artifact")) {
      return [];
    }
    const visible = new Set(plan.events.map((event) => event.event.event_id));
    const candidates: RetrievedContextCandidate[] = [];
    for (const artifact of await this.artifacts.listArtifacts({
      org_id: plan.request.org_id,
      kinds: ["thread_summary"],
      statuses: ["accepted"],
    })) {
      if (!artifact.body_hash || artifact.input_refs.some((reference) => !visible.has(reference.event_id))) {
        continue;
      }
      const bytes = await this.blobs.get(artifact.body_hash);
      const text = Buffer.from(bytes).toString("utf8");
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        throw new Error("Accepted Context artifact body is not JSON");
      }
      if (
        hashCanonicalContext(body) !== artifact.body_hash ||
        artifact.attrs === undefined ||
        canonicalContextJson(body) !== canonicalContextJson(artifact.attrs)
      ) {
        throw new Error("Accepted Context artifact body does not match its manifest");
      }
      const score = summaryScore(text, plan.request.query);
      if (plan.request.query && score.lexical === 0) continue;
      const estimatedTokens = Math.max(1, Math.ceil(text.length / 4));
      candidates.push({
        candidate: {
          candidate_id: `artifact:${artifact.id}`,
          kind: "artifact",
          resource_id: artifact.id,
          evidence: artifact.input_refs,
          required_scope_ids: [...artifact.required_scope_ids],
          recorded_at: artifact.recorded_at,
          status: "current",
          content_hash: artifact.body_hash,
          projection: {
            projector_id: artifact.kind,
            algorithm_version: artifact.algorithm_version,
            generation: artifact.generation,
          },
          scores: { lexical: score.lexical, exact_match: score.exact_match },
          estimated_tokens: estimatedTokens,
        },
        section: "summaries",
        item: {
          candidate_id: `artifact:${artifact.id}`,
          resource_id: artifact.id,
          kind: "artifact",
          status: "current",
          text,
          content_hash: artifact.body_hash,
          evidence: artifact.input_refs,
          estimated_tokens: estimatedTokens,
        },
      });
    }
    return candidates.sort((left, right) => left.candidate.candidate_id.localeCompare(right.candidate.candidate_id));
  }
}

function summaryScore(text: string, query: string | undefined): { lexical: number; exact_match: number } {
  if (!query) return { lexical: 0, exact_match: 0 };
  const normalizedText = normalize(text);
  const normalizedQuery = normalize(query);
  if (!normalizedText || !normalizedQuery) return { lexical: 0, exact_match: 0 };
  const terms = [...new Set(normalizedQuery.match(/[\p{L}\p{N}_-]+/gu) ?? [])];
  const textTerms = new Set(normalizedText.match(/[\p{L}\p{N}_-]+/gu) ?? []);
  const matched = terms.filter((term) => textTerms.has(term)).length;
  return {
    lexical: terms.length === 0 ? 0 : matched / terms.length,
    exact_match: normalizedText.includes(normalizedQuery) ? 1 : 0,
  };
}

function normalize(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}
