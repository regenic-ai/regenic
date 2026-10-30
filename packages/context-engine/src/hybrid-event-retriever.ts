import { createHash } from "node:crypto";
import {
  ContextVectorUnavailableError,
  EmbeddingError,
  assertEmbeddingDescriptor,
  validateEmbeddingVector,
  contextLexicalQueryTerms,
  contextLexicalTerms,
  type AuthorizedContextRetrievalPlan,
  type ContextRetriever,
  type ContextEventMaterializer,
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
  version: "personal-hybrid-rrf-v3",
  score_weights: { anchor: 4, exact_match: 3, lexical: 2, recency: 1, hybrid: 8 },
  vector_min_score: 0.7,
};
const MIN_VECTOR_CANDIDATES = 50;
const MAX_VECTOR_CANDIDATES = 1000;
const VECTOR_CANDIDATE_MULTIPLIER = 5;
const QUERY_VECTOR_CACHE_SIZE = 128;
const RRF_K = 60;

export class HybridEventRetriever implements ContextRetriever {
  readonly id = HYBRID_EVENT_RETRIEVER_ID;
  private readonly queryVectors = new Map<string, Promise<number[]>>();

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
    return { ...this.lexical.capabilities(), vector: true, lazy_materialization: true };
  }

  async retrieve(
    plan: AuthorizedContextRetrievalPlan,
    materialize?: ContextEventMaterializer,
  ): Promise<ContextRetrievalResult> {
    const lexicalPlan = materialize && !this.lexical.capabilities().lazy_materialization
      ? { ...plan, events: await materialize(plan.events.map((source) => source.event.event_id)) }
      : plan;
    const lexicalResult = await this.lexical.retrieve(lexicalPlan, materialize);
    const lexical = Array.isArray(lexicalResult) ? { candidates: lexicalResult } : lexicalResult;
    if (!plan.request.query || (plan.request.requested_kinds && !plan.request.requested_kinds.includes("event"))) return lexical;
    const eligible = eligibleEventSources(plan).filter((source) => source.event.content_hash);
    const allowed = new Map(eligible.map((source) => [source.event.event_id, source]));
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
    const vectorLimit = vectorCandidateLimit(plan);
    try {
      generation = await this.generations?.activeGeneration(plan.request.org_id) ?? this.generation;
      assertEmbeddingDescriptor(this.provider.descriptor, generation.model);
      const queryVector = await this.queryVector(
        plan.request.org_id,
        generation,
        plan.request.query,
      );
      result = await this.index.matchAuthorized({
        org_id: plan.request.org_id, generation: generation.id, query_vector: [...queryVector],
        authorized: eligible.map((source) => ({
          event_id: source.event.event_id, content_hash: source.event.content_hash!,
        })), limit: vectorLimit,
      });
    } catch (error) {
      if (error instanceof ContextVectorUnavailableError) return fallback(`vector_index_${error.reason}`);
      if (!(error instanceof EmbeddingError) || error.code === "input_too_large" || error.code === "invalid_input") throw error;
      return fallback(error.code === "timeout" ? "embedding_timeout" : "embedding_unavailable");
    }
    // Invalid keys or chunk bindings are a boundary failure, never a lexical fallback.
    if (!result || result.generation !== generation.id || !Array.isArray(result.covered) ||
      !Array.isArray(result.matched) || result.matched.length > vectorLimit) throw new ContextEngineError("invalid_candidate", "Invalid vector result");
    const covered = new Set<string>();
    for (const key of result.covered) {
      const source = allowed.get(key?.event_id);
      if (!source || key.content_hash !== source.event.content_hash || covered.has(key.event_id)) {
        throw new ContextEngineError("invalid_candidate", "Unauthorized or duplicate vector coverage");
      }
      covered.add(key.event_id);
    }
    if (result.skipped !== undefined && !Array.isArray(result.skipped)) {
      throw new ContextEngineError("invalid_candidate", "Invalid vector skip result");
    }
    const skipped = new Set<string>();
    for (const key of result.skipped ?? []) {
      const source = allowed.get(key?.event_id);
      if (!source || key.content_hash !== source.event.content_hash ||
        skipped.has(key.event_id) || covered.has(key.event_id)) {
        throw new ContextEngineError("invalid_candidate", "Unauthorized or duplicate vector skip");
      }
      skipped.add(key.event_id);
    }
    const seen = new Set<string>();
    for (const hit of result.matched) {
      const source = allowed.get(hit?.event_id);
      if (!source || !covered.has(hit.event_id) || seen.has(hit.event_id) ||
        hit.content_hash !== source.event.content_hash || !Number.isFinite(hit.score) ||
        hit.score < -1 || hit.score > 1 || !Number.isSafeInteger(hit.chunk_ordinal) || hit.chunk_ordinal < 0 ||
        !Number.isSafeInteger(hit.start) || !Number.isSafeInteger(hit.end) || hit.start < 0 ||
        hit.end <= hit.start) {
        throw new ContextEngineError("invalid_candidate", "Invalid authorized vector chunk binding");
      }
      seen.add(hit.event_id);
    }
    if (materialize) {
      for (const source of await materialize([...seen])) {
        allowed.set(source.event.event_id, source);
      }
    }
    for (const hit of result.matched) {
      const text = allowed.get(hit.event_id)!.text;
      // V2 spans include extracted text and visual units, bound by the stored projection.
      const length = generation.extractor_version === "stored-body-and-attachments-v2" &&
        hit.material_length !== undefined ? hit.material_length : text?.length;
      if (!Number.isSafeInteger(length) || hit.end > length!) {
        throw new ContextEngineError("invalid_candidate", "Invalid authorized vector chunk binding");
      }
    }
    if (materialize) {
      for (const source of await materialize(rankedLexical.map((value) => value.candidate.resource_id))) {
        allowed.set(source.event.event_id, source);
      }
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
        ...(covered.size + skipped.size < allowed.size ? ["vector_index_partial"] : [])],
      trace,
    };
  }

  private async queryVector(
    orgId: string,
    generation: EmbeddingGeneration,
    query: string,
  ): Promise<number[]> {
    const key = createHash("sha256")
      .update(orgId)
      .update("\0")
      .update(generation.id)
      .update("\0")
      .update(query)
      .digest("hex");
    const cached = this.queryVectors.get(key);
    if (cached) {
      this.queryVectors.delete(key);
      this.queryVectors.set(key, cached);
      return cached;
    }
    const pending = (async () => {
      const [tokens] = await this.provider.countTokens([query], "query");
      if (!Number.isSafeInteger(tokens) || tokens < 1) {
        throw new EmbeddingError("invalid_response", true);
      }
      if (tokens > generation.model.max_input_tokens) {
        throw new EmbeddingError("input_too_large", false);
      }
      const vectors = await this.provider.embed([query], "query");
      if (vectors.length !== 1) {
        throw new EmbeddingError("invalid_response", true);
      }
      validateEmbeddingVector(vectors[0], generation.model.dimensions);
      return vectors[0];
    })();
    this.queryVectors.set(key, pending);
    if (this.queryVectors.size > QUERY_VECTOR_CACHE_SIZE) {
      this.queryVectors.delete(this.queryVectors.keys().next().value!);
    }
    try {
      return await pending;
    } catch (error) {
      if (this.queryVectors.get(key) === pending) {
        this.queryVectors.delete(key);
      }
      throw error;
    }
  }
}

function vectorCandidateLimit(plan: AuthorizedContextRetrievalPlan): number {
  const requested = Math.max(
    plan.request.budget.max_items,
    plan.request.budget.max_raw_evidence,
  );
  return Math.min(
    MAX_VECTOR_CANDIDATES,
    Math.max(MIN_VECTOR_CANDIDATES, requested * VECTOR_CANDIDATE_MULTIPLIER),
  );
}

function lexicalScore(value: RetrievedContextCandidate): number {
  const scores = value.candidate.scores;
  return 3 * (scores.exact_match ?? 0) + 2 * (scores.lexical ?? 0) + (scores.recency ?? 0);
}
function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
