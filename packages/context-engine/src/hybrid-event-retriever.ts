import {
  ContextVectorUnavailableError,
  EmbeddingError,
  assertEmbeddingDescriptor,
  validateEmbeddingVector,
  contextLexicalQueryTerms,
  contextLexicalTerms,
  type AuthorizedContextRetrievalPlan,
  type ContextRetriever,
  type ContextRetrievalResult,
  type ContextRetrievalTrace,
  type ContextVectorIndex,
  type ContextVectorGenerationStore,
  type EmbeddingGeneration,
  type EmbeddingProvider,
  type RetrievedContextCandidate,
} from "@regenic/domain";
import { eligibleEventSources, eventCandidateMaterialFor, retrievalTimeFor } from "./deterministic-event-retriever";
import { ContextEngineError } from "./deterministic-context-engine";

export const HYBRID_EVENT_RETRIEVER_ID = "event-hybrid";
export const HYBRID_RETRIEVAL_PROFILE = {
  version: "personal-hybrid-rrf-v2",
  score_weights: { anchor: 4, exact_match: 3, lexical: 2, recency: 1, hybrid: 8 },
  vector_min_score: 0.7,
};
const ROUTE_LIMIT = 1000;
const RRF_K = 60;

export class HybridEventRetriever implements ContextRetriever {
  readonly id = HYBRID_EVENT_RETRIEVER_ID;

  constructor(
    private readonly lexical: ContextRetriever,
    private readonly provider: EmbeddingProvider,
    private readonly index: ContextVectorIndex | undefined,
    private readonly generation: EmbeddingGeneration,
    private readonly generations?: ContextVectorGenerationStore,
    private readonly profile = HYBRID_RETRIEVAL_PROFILE,
  ) {
    assertEmbeddingDescriptor(provider.descriptor, generation.model);
    if (!Number.isFinite(profile.vector_min_score) || profile.vector_min_score < -1 || profile.vector_min_score > 1) {
      throw new Error("Invalid hybrid similarity threshold");
    }
  }

  capabilities() {
    return { ...this.lexical.capabilities(), vector: true };
  }

  async retrieve(plan: AuthorizedContextRetrievalPlan): Promise<ContextRetrievalResult> {
    const lexicalResult = await this.lexical.retrieve(plan);
    const lexical = Array.isArray(lexicalResult) ? { candidates: lexicalResult } : lexicalResult;
    if (!plan.request.query || (plan.request.requested_kinds && !plan.request.requested_kinds.includes("event"))) return lexical;
    const eligible = eligibleEventSources(plan).filter((source) => source.event.content_hash);
    const allowed = new Map(eligible.map((source) => [source.event.event_id, source]));
    if (allowed.size > 10000) return {
      ...lexical, degradation_flags: [...(lexical.degradation_flags ?? []), "vector_index_capacity",
        ...(plan.request.temporal.mode !== "current" ? ["vector_temporal_unsupported"] : []),
        ...(!this.index ? ["vector_index_absent"] : [])],
    };
    const rankedLexical = [...lexical.candidates].sort((a, b) =>
      lexicalScore(b) - lexicalScore(a) || compare(a.candidate.resource_id, b.candidate.resource_id));
    const trace: ContextRetrievalTrace = {
      retriever_id: this.id, profile: this.profile.version, mode: "lexical",
      authorized_count: allowed.size, covered_count: 0,
      routes: rankedLexical.map((candidate, rank) => ({
        event_id: candidate.candidate.resource_id, lexical_rank: rank + 1,
      })),
    };
    const fallback = (flag: string): ContextRetrievalResult => ({
      ...lexical, trace, degradation_flags: [...(lexical.degradation_flags ?? []), flag],
    });
    if (plan.request.temporal.mode !== "current") return fallback("vector_temporal_unsupported");
    if (!this.index) return fallback("vector_index_absent");
    if (!allowed.size) return { ...lexical, trace };
    let result: Awaited<ReturnType<ContextVectorIndex["matchAuthorized"]>>;
    let generation = this.generation;
    try {
      generation = await this.generations?.activeGeneration(plan.request.org_id) ?? this.generation;
      assertEmbeddingDescriptor(this.provider.descriptor, generation.model);
      const [tokens] = await this.provider.countTokens([plan.request.query], "query");
      if (!Number.isSafeInteger(tokens) || tokens < 1) throw new EmbeddingError("invalid_response", true);
      if (tokens > generation.model.max_input_tokens) throw new EmbeddingError("input_too_large", false);
      const vectors = await this.provider.embed([plan.request.query], "query");
      if (vectors.length !== 1) throw new EmbeddingError("invalid_response", true);
      validateEmbeddingVector(vectors[0], generation.model.dimensions);
      result = await this.index.matchAuthorized({
        org_id: plan.request.org_id, generation: generation.id, query_vector: vectors[0],
        authorized: eligible.map((source) => ({
          event_id: source.event.event_id, content_hash: source.event.content_hash!,
        })), limit: ROUTE_LIMIT,
      });
    } catch (error) {
      if (error instanceof ContextVectorUnavailableError) return fallback(`vector_index_${error.reason}`);
      if (!(error instanceof EmbeddingError) || error.code === "input_too_large" || error.code === "invalid_input") throw error;
      return fallback(error.code === "timeout" ? "embedding_timeout" : "embedding_unavailable");
    }
    // Invalid keys or chunk bindings are a boundary failure, never a lexical fallback.
    if (!result || result.generation !== generation.id || !Array.isArray(result.covered) ||
      !Array.isArray(result.matched) || result.matched.length > ROUTE_LIMIT) throw new ContextEngineError("invalid_candidate", "Invalid vector result");
    const covered = new Set<string>();
    for (const key of result.covered) {
      const source = allowed.get(key?.event_id);
      if (!source || key.content_hash !== source.event.content_hash || covered.has(key.event_id)) {
        throw new ContextEngineError("invalid_candidate", "Unauthorized or duplicate vector coverage");
      }
      covered.add(key.event_id);
    }
    const seen = new Set<string>();
    for (const hit of result.matched) {
      const source = allowed.get(hit?.event_id);
      if (!source || !covered.has(hit.event_id) || seen.has(hit.event_id) ||
        hit.content_hash !== source.event.content_hash || !Number.isFinite(hit.score) ||
        hit.score < -1 || hit.score > 1 || !Number.isSafeInteger(hit.chunk_ordinal) || hit.chunk_ordinal < 0 ||
        !Number.isSafeInteger(hit.start) || !Number.isSafeInteger(hit.end) || hit.start < 0 ||
        hit.end <= hit.start || typeof source.text !== "string" || hit.end > source.text.length) {
        throw new ContextEngineError("invalid_candidate", "Invalid authorized vector chunk binding");
      }
      seen.add(hit.event_id);
    }
    const vector = result.matched.filter((hit) => hit.score >= this.profile.vector_min_score)
      .sort((a, b) => b.score - a.score || compare(a.event_id, b.event_id));
    const significantTerms = contextLexicalQueryTerms(plan.request.query).filter((term) =>
      !/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]$/u.test(term));
    const admittedLexical = rankedLexical.filter((value) => {
      if (!covered.has(value.candidate.resource_id) || significantTerms.length === 0) return true;
      const terms = new Set(contextLexicalTerms(allowed.get(value.candidate.resource_id)?.text));
      return significantTerms.some((term) => terms.has(term));
    });
    const ranks = new Map<string, ContextRetrievalTrace["routes"][number]>(admittedLexical.map((value, rank) => [value.candidate.resource_id, {
      event_id: value.candidate.resource_id, lexical_rank: rank + 1,
    }]));
    vector.forEach((hit, rank) => {
      ranks.set(hit.event_id, { ...ranks.get(hit.event_id), event_id: hit.event_id,
        vector_rank: rank + 1, vector_score: hit.score, chunk_ordinal: hit.chunk_ordinal,
        start: hit.start, end: hit.end });
    });
    trace.mode = "hybrid";
    trace.generation = generation.id;
    trace.model_revision = generation.model.model_revision;
    trace.covered_count = covered.size;
    trace.routes = [...ranks.values()].sort((a, b) => compare(a.event_id, b.event_id));
    const candidates = new Map(admittedLexical.map((candidate) => [candidate.candidate.resource_id, candidate]));
    for (const hit of vector) {
      const material = eventCandidateMaterialFor(allowed.get(hit.event_id)!, plan.request, retrievalTimeFor(plan));
      if (material) candidates.set(hit.event_id, material);
    }
    for (const [id, value] of candidates) {
      const route = ranks.get(id);
      if (!route) continue;
      const score = (route.lexical_rank ? 1 / (RRF_K + route.lexical_rank) : 0) +
        (route.vector_rank ? 1 / (RRF_K + route.vector_rank) : 0);
      value.candidate.scores = { anchor: value.candidate.scores.anchor ?? 0, hybrid: Number((score * (RRF_K + 1) / 2).toFixed(9)) };
    }
    return {
      candidates: [...candidates.values()].sort((a, b) => compare(a.candidate.candidate_id, b.candidate.candidate_id)),
      degradation_flags: [...(lexical.degradation_flags ?? []),
        ...(covered.size < allowed.size ? ["vector_index_partial"] : [])],
      trace,
    };
  }
}

function lexicalScore(value: RetrievedContextCandidate): number {
  const scores = value.candidate.scores;
  return 3 * (scores.exact_match ?? 0) + 2 * (scores.lexical ?? 0) + (scores.recency ?? 0);
}
function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
