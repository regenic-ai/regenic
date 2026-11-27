import { createHash } from "node:crypto";
import {
  ContextVectorUnavailableError,
  EmbeddingError,
  assertEmbeddingDescriptor,
  contextVectorAuthorizationAccumulator,
  contextVectorAuthorizationHash,
  contextVectorAuthorizationHashFromAccumulator,
  updateContextVectorAuthorizationAccumulator,
  validateEmbeddingVector,
  contextLexicalQueryTerms,
  contextLexicalTerms,
  noteSearchStageCache,
  timeSearchStage,
  timeSearchStageSync,
  type AuthorizedContextRetrievalPlan,
  type AuthorizedContextSourceEvent,
  type ContextRetriever,
  type ContextEventMaterializer,
  type ContextRetrievalResult,
  type ContextRetrievalTrace,
  type ContextVectorIndex,
  type ContextVectorAuthorizationKey,
  type ContextVectorAuthorizationDelta,
  type ContextVectorCoverageProof,
  type ContextVectorGenerationStore,
  type EmbeddingGeneration,
  type EmbeddingProvider,
  type RetrievedContextCandidate,
} from "@regenic/domain";
import { eligibleEventSources, eventCandidateMaterialFor, retrievalTimeFor } from "./deterministic-event-retriever";
import { ContextEngineError } from "./deterministic-context-engine";
import { searchMatchesFor, searchSnippet } from "./search-matches";

export const HYBRID_EVENT_RETRIEVER_ID = "event-hybrid";
const HYBRID_SCORE_WEIGHTS = {
  anchor: 4, exact_match: 3, lexical: 2, recency: 1,
  hybrid: 8, thread: 3, evidence_diversity: 1,
};
export const HYBRID_RRF_PROFILE = {
  version: "personal-hybrid-thread-rrf-v4",
  fusion: "rrf" as const,
  score_weights: HYBRID_SCORE_WEIGHTS,
  vector_min_score: 0.7,
  semantic_evidence_score: 0.7,
  vector_weight: 0.5,
  lexical_weight: 0.5,
};
export const HYBRID_RETRIEVAL_PROFILE = {
  version: "personal-hybrid-thread-minmax-v5",
  fusion: "minmax" as const,
  score_weights: HYBRID_SCORE_WEIGHTS,
  vector_min_score: -1,
  semantic_evidence_score: 0.7,
  vector_weight: 0.6,
  lexical_weight: 0.4,
};
export interface HybridRetrievalProfile {
  version: string;
  fusion: "rrf" | "minmax";
  score_weights: typeof HYBRID_SCORE_WEIGHTS;
  vector_min_score: number;
  semantic_evidence_score: number;
  vector_weight: number;
  lexical_weight: number;
}
const MIN_VECTOR_CANDIDATES = 50;
const MAX_VECTOR_CANDIDATES = 1000;
const VECTOR_CANDIDATE_MULTIPLIER = 5;
const QUERY_VECTOR_CACHE_SIZE = 128;
const RRF_K = 60;

export class HybridEventRetriever implements ContextRetriever {
  readonly id = HYBRID_EVENT_RETRIEVER_ID;
  private readonly queryVectors = new Map<string, Promise<number[]>>();
  private authorizationSnapshot?: VectorAuthorizationSnapshot;

  constructor(
    private readonly lexical: ContextRetriever,
    private readonly provider: EmbeddingProvider,
    private readonly index: ContextVectorIndex | undefined,
    private readonly generation: EmbeddingGeneration,
    private readonly generations?: ContextVectorGenerationStore,
    private readonly profile: HybridRetrievalProfile = HYBRID_RETRIEVAL_PROFILE,
  ) {
    assertEmbeddingDescriptor(provider.descriptor, generation.model);
    assertHybridProfile(profile);
  }

  capabilities() {
    return { ...this.lexical.capabilities(), vector: true, rerank: true, lazy_materialization: true };
  }

  async retrieve(
    plan: AuthorizedContextRetrievalPlan,
    materialize?: ContextEventMaterializer,
  ): Promise<ContextRetrievalResult> {
    if (plan.index_scope) return this.retrieveScoped(plan, materialize);
    const lexicalPlan = materialize && !this.lexical.capabilities().lazy_materialization
      ? { ...plan, events: await materialize(plan.events.map((source) => source.event.event_id)) }
      : plan;
    const lexicalResult = await this.lexical.retrieve(lexicalPlan, materialize);
    const lexical = Array.isArray(lexicalResult) ? { candidates: lexicalResult } : lexicalResult;
    if (!plan.request.query || (plan.request.requested_kinds && !plan.request.requested_kinds.includes("event"))) return lexical;
    const query = plan.request.query;
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
    const index = this.index;
    if (!allowed.size) return { ...lexical, trace };
    const authorized: ContextVectorAuthorizationKey[] = eligible.map((source) => ({
      event_id: source.event.event_id,
      content_hash: source.event.content_hash!,
    }));
    let result: Awaited<ReturnType<ContextVectorIndex["matchAuthorized"]>>;
    let generation = this.generation;
    let embeddingDegradation: string | undefined;
    const vectorLimit = vectorCandidateLimit(plan);
    let authorization: PreparedVectorAuthorization | undefined;
    try {
      generation = await this.generations?.activeGeneration(plan.request.org_id) ?? this.generation;
      const prepared = timeSearchStageSync("authorize", () => this.prepareAuthorization(
        plan.request.org_id,
        generation.id,
        authorized,
      ));
      authorization = prepared;
      assertEmbeddingDescriptor(this.provider.descriptor, generation.model);
      const queryVector = await timeSearchStage("embed", () => this.queryVector(
        plan.request.org_id,
        generation,
        query,
      ));
      result = await timeSearchStage("vector", () => index.matchAuthorized({
        org_id: plan.request.org_id, generation: generation.id, query_vector: [...queryVector],
        authorized,
        authorization_hash: prepared.hash,
        authorization_accumulator: prepared.accumulator,
        ...(prepared.delta ? { authorization_delta: prepared.delta } : {}),
        limit: vectorLimit,
        ...(plan.request.search_kind ? { query, search_kind: plan.request.search_kind } : {}),
      }));
    } catch (error) {
      if (error instanceof ContextVectorUnavailableError) return fallback(`vector_index_${error.reason}`);
      if (!(error instanceof EmbeddingError) || error.code === "input_too_large" || error.code === "invalid_input") throw error;
      embeddingDegradation = error.code === "timeout" ? "embedding_timeout" : "embedding_unavailable";
      if (!plan.request.search_kind || plan.request.search_kind === "messages" ||
        !index.matchAuthorizedText) return fallback(embeddingDegradation);
      const searchKind = plan.request.search_kind;
      try {
        const prepared = authorization ?? timeSearchStageSync("authorize", () => this.prepareAuthorization(
          plan.request.org_id,
          generation.id,
          authorized,
        ));
        authorization = prepared;
        result = await timeSearchStage("vector", () => index.matchAuthorizedText!({
          org_id: plan.request.org_id, generation: generation.id, query,
          authorized,
          authorization_hash: prepared.hash,
          authorization_accumulator: prepared.accumulator,
          ...(prepared.delta ? { authorization_delta: prepared.delta } : {}),
          limit: vectorLimit,
          search_kind: searchKind,
        }));
      } catch (indexError) {
        if (indexError instanceof ContextVectorUnavailableError) return {
          ...fallback(embeddingDegradation),
          degradation_flags: [...(lexical.degradation_flags ?? []), embeddingDegradation, `vector_index_${indexError.reason}`],
        };
        throw indexError;
      }
    }
    this.authorizationSnapshot = authorization?.snapshot;
    const authorizationHash = authorization?.hash
      ?? contextVectorAuthorizationHash(authorized);
    // Invalid keys or chunk bindings are a boundary failure, never a lexical fallback.
    if (!result || result.generation !== generation.id || !Array.isArray(result.covered) ||
      !Array.isArray(result.matched) || result.matched.length > vectorLimit) throw new ContextEngineError("invalid_candidate", "Invalid vector result");
    if (
      result.acceleration !== undefined
      && (
        result.acceleration.algorithm_version !== "sqlite-vec-authorized-exact-v1"
        || !Number.isSafeInteger(result.acceleration.authorized_chunks)
        || result.acceleration.authorized_chunks < 1
        || !Number.isSafeInteger(result.acceleration.candidate_chunks)
        || result.acceleration.candidate_chunks < 1
        || result.acceleration.candidate_chunks > result.acceleration.authorized_chunks
        || (
          result.acceleration.authorization_update !== undefined
          && !["rebuilt", "reused", "delta"].includes(
            result.acceleration.authorization_update,
          )
        )
        || (
          result.acceleration.authorization_update === "delta"
          && (
            !Number.isSafeInteger(result.acceleration.added_events)
            || result.acceleration.added_events! < 0
            || !Number.isSafeInteger(result.acceleration.removed_events)
            || result.acceleration.removed_events! < 0
          )
        )
        || (
          result.acceleration.authorization_update !== "delta"
          && (
            result.acceleration.added_events !== undefined
            || result.acceleration.removed_events !== undefined
          )
        )
      )
    ) {
      throw new ContextEngineError("invalid_candidate", "Invalid vector acceleration proof");
    }
    const covered = new Set<string>();
    const uncovered = new Set<string>();
    let coveredCount: number;
    if (result.coverage !== undefined) {
      validateVectorCoverageProof(
        result.coverage,
        authorizationHash,
        authorized.length,
        allowed,
        uncovered,
      );
      if (result.covered.length !== 0) {
        throw new ContextEngineError("invalid_candidate", "Ambiguous vector coverage");
      }
      coveredCount = result.coverage.covered_count;
    } else {
      for (const key of result.covered) {
        const source = allowed.get(key?.event_id);
        if (!source || key.content_hash !== source.event.content_hash || covered.has(key.event_id)) {
          throw new ContextEngineError("invalid_candidate", "Unauthorized or duplicate vector coverage");
        }
        covered.add(key.event_id);
      }
      coveredCount = covered.size;
    }
    const isCovered = (eventId: string) => result.coverage !== undefined
      ? allowed.has(eventId) && !uncovered.has(eventId)
      : covered.has(eventId);
    if (result.skipped !== undefined && !Array.isArray(result.skipped)) {
      throw new ContextEngineError("invalid_candidate", "Invalid vector skip result");
    }
    const skipped = new Set<string>();
    for (const key of result.skipped ?? []) {
      const source = allowed.get(key?.event_id);
      if (!source || key.content_hash !== source.event.content_hash ||
        skipped.has(key.event_id) || isCovered(key.event_id) ||
        (result.coverage !== undefined && !uncovered.has(key.event_id))) {
        throw new ContextEngineError("invalid_candidate", "Unauthorized or duplicate vector skip");
      }
      skipped.add(key.event_id);
    }
    const seen = new Set<string>();
    for (const hit of result.matched) {
      const source = allowed.get(hit?.event_id);
      if (!source || !isCovered(hit.event_id) || seen.has(hit.event_id) ||
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
    const searchMatches = new Map<string, ReturnType<typeof searchMatchesFor>>();
    if (plan.request.search_kind) {
      for (const hit of result.matched) {
        const source = allowed.get(hit.event_id)!;
        const matches = searchMatchesFor(source, plan.request, hit.search_matches, this.profile.semantic_evidence_score);
        if (hit.score >= this.profile.semantic_evidence_score && plan.request.search_kind !== "files") {
          const body = source.search_body ?? source.text ?? "";
          if (hit.end <= body.length && !matches.some((match) => match.kind === "message")) {
            matches.push({ kind: "message", via: ["semantic"],
              ...searchSnippet(body.slice(hit.start, hit.end), undefined, hit.start) });
          } else if (plan.request.search_kind === "all" && !matches.length) {
            // Legacy and cross-part chunks are Event evidence, not an attachment identity.
            matches.push({ kind: "event", via: ["semantic"] });
          }
        }
        searchMatches.set(hit.event_id, matches);
      }
    }
    const vector = result.matched.filter((hit) => plan.request.search_kind
      ? searchMatches.get(hit.event_id)!.length > 0
      : hit.score >= this.profile.vector_min_score)
      .sort((a, b) => b.score - a.score || compare(a.event_id, b.event_id));
    const significantTerms = contextLexicalQueryTerms(plan.request.query).filter((term) =>
      !/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]$/u.test(term));
    const admittedLexical = rankedLexical.filter((value) => {
      if (plan.request.search_kind) return true;
      if (!isCovered(value.candidate.resource_id) || significantTerms.length === 0) return true;
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
    trace.covered_count = coveredCount;
    if (result.acceleration) trace.vector_acceleration = result.acceleration;
    trace.routes = [...ranks.values()].sort((a, b) => compare(a.event_id, b.event_id));
    const candidates = new Map(admittedLexical.map((candidate) => [candidate.candidate.resource_id, candidate]));
    for (const hit of vector) {
      const material = eventCandidateMaterialFor(allowed.get(hit.event_id)!, plan.request, retrievalTimeFor(plan));
      if (material) {
        const matches = searchMatches.get(hit.event_id);
        if (matches) {
          material.item.search_matches = matches;
          material.item.estimated_tokens = material.candidate.estimated_tokens =
            Math.ceil(((material.item.text?.length ?? 0) +
              matches.reduce((sum, match) => sum + (match.snippet?.length ?? match.filename?.length ?? 0), 0)) / 4);
        }
        candidates.set(hit.event_id, material);
      }
    }
    const lexicalRaw = new Map(admittedLexical.map((value) => [value.candidate.resource_id, lexicalScore(value)]));
    const vectorRaw = new Map(vector.map((hit) => [hit.event_id, hit.score]));
    const lexicalRange = scoreRange([...lexicalRaw.values()]);
    const vectorRange = scoreRange([...vectorRaw.values()]);
    for (const [id, value] of candidates) {
      const route = ranks.get(id);
      if (!route) continue;
      const recency = value.candidate.scores.recency;
      value.candidate.scores = {
        anchor: value.candidate.scores.anchor ?? 0,
        hybrid: fuseHybridRoute(this.profile, {
          lexicalRank: route.lexical_rank,
          lexicalScore: lexicalRaw.get(id),
          vectorRank: route.vector_rank,
          vectorScore: vectorRaw.get(id),
        }, lexicalRange, vectorRange),
        ...(recency === undefined ? {} : { recency }),
      };
    }
    timeSearchStageSync("rerank", () => {
      rerankThreads(candidates, allowed, ranks, query);
    });
    trace.routes = [...ranks.values()].sort((a, b) => compare(a.event_id, b.event_id));
    return {
      candidates: [...candidates.values()].sort((a, b) => compare(a.candidate.candidate_id, b.candidate.candidate_id)),
      degradation_flags: [...(lexical.degradation_flags ?? []),
        ...(embeddingDegradation ? [embeddingDegradation] : []),
        ...(coveredCount + skipped.size < allowed.size ? ["vector_index_partial"] : [])],
      trace,
    };
  }

  private async retrieveScoped(
    plan: AuthorizedContextRetrievalPlan,
    materialize?: ContextEventMaterializer,
  ): Promise<ContextRetrievalResult> {
    const scope = plan.index_scope!;
    const lexicalResult = await this.lexical.retrieve(plan, materialize);
    const lexical = Array.isArray(lexicalResult) ? { candidates: lexicalResult } : lexicalResult;
    if (!plan.request.query || (plan.request.requested_kinds && !plan.request.requested_kinds.includes("event"))) {
      return lexical;
    }
    const query = plan.request.query;
    const rankedLexical = [...lexical.candidates].sort((left, right) =>
      lexicalScore(right) - lexicalScore(left) || compare(left.candidate.resource_id, right.candidate.resource_id));
    const authorizedCount = lexical.trace?.authorized_count ?? rankedLexical.length;
    const lexicalCovered = lexical.trace?.covered_count ?? 0;
    const trace: ContextRetrievalTrace = {
      retriever_id: this.id,
      profile: this.profile.version,
      mode: "lexical",
      authorized_count: authorizedCount,
      covered_count: lexicalCovered,
      routes: rankedLexical.map((candidate, rank) => ({
        event_id: candidate.candidate.resource_id,
        lexical_rank: rank + 1,
      })),
    };
    const fallback = (flag: string): ContextRetrievalResult => ({
      ...lexical,
      trace,
      degradation_flags: [...(lexical.degradation_flags ?? []), flag],
    });
    if (!materialize || !this.index?.matchRanked) return fallback(this.index ? "vector_index_absent" : "vector_index_absent");
    const index = this.index;
    let generation = await this.generations?.activeGeneration(plan.request.org_id) ?? this.generation;
    if (!generation) return fallback("vector_index_unbuilt");
    let ranked: Awaited<ReturnType<NonNullable<ContextVectorIndex["matchRanked"]>>>;
    try {
      assertEmbeddingDescriptor(this.provider.descriptor, generation.model);
      const queryVector = await timeSearchStage("embed", () => this.queryVector(
        plan.request.org_id,
        generation,
        query,
      ));
      ranked = await timeSearchStage("vector", () => index.matchRanked!({
        org_id: plan.request.org_id,
        generation: generation.id,
        query_vector: [...queryVector],
        limit: vectorCandidateLimit(plan),
        authority_path: scope.authority_path,
        ...(plan.request.filters ? { filters: plan.request.filters } : {}),
        stamp: scope.stamp,
      }));
    } catch (error) {
      if (error instanceof ContextVectorUnavailableError) return fallback(`vector_index_${error.reason}`);
      if (!(error instanceof EmbeddingError) || error.code === "input_too_large" || error.code === "invalid_input") throw error;
      return fallback(error.code === "timeout" ? "embedding_timeout" : "embedding_unavailable");
    }
    const loaded = await materialize([
      ...rankedLexical.map((candidate) => candidate.candidate.resource_id),
      ...ranked.matched.map((hit) => hit.event_id),
    ]);
    const allowed = new Map(loaded.map((source) => [source.event.event_id, source]));
    for (const hit of ranked.matched) {
      const source = allowed.get(hit.event_id);
      if (!source || source.event.content_hash !== hit.content_hash ||
        !Number.isFinite(hit.score) || hit.score < -1 || hit.score > 1 ||
        !Number.isSafeInteger(hit.chunk_ordinal) || hit.chunk_ordinal < 0 ||
        !Number.isSafeInteger(hit.start) || !Number.isSafeInteger(hit.end) || hit.start < 0 || hit.end <= hit.start) {
        throw new ContextEngineError("invalid_candidate", "Invalid ranked vector hit");
      }
    }
    const searchMatches = new Map<string, ReturnType<typeof searchMatchesFor>>();
    if (plan.request.search_kind) {
      for (const hit of ranked.matched) {
        const source = allowed.get(hit.event_id)!;
        const matches = searchMatchesFor(source, plan.request, [], this.profile.semantic_evidence_score);
        if (hit.score >= this.profile.semantic_evidence_score && plan.request.search_kind !== "files") {
          const body = source.search_body ?? source.text ?? "";
          if (hit.end <= body.length && !matches.some((match) => match.kind === "message")) {
            matches.push({
              kind: "message",
              via: ["semantic"],
              ...searchSnippet(body.slice(hit.start, hit.end), undefined, hit.start),
            });
          } else if (plan.request.search_kind === "all" && !matches.length) {
            matches.push({ kind: "event", via: ["semantic"] });
          }
        }
        searchMatches.set(hit.event_id, matches);
      }
    }
    const vector = ranked.matched.filter((hit) => plan.request.search_kind
      ? searchMatches.get(hit.event_id)!.length > 0
      : hit.score >= this.profile.vector_min_score)
      .sort((left, right) => right.score - left.score || compare(left.event_id, right.event_id));
    const significantTerms = contextLexicalQueryTerms(query).filter((term) =>
      !/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]$/u.test(term));
    const admittedLexical = rankedLexical.filter((value) => {
      if (plan.request.search_kind || significantTerms.length === 0) return true;
      const terms = new Set(contextLexicalTerms(allowed.get(value.candidate.resource_id)?.text));
      return significantTerms.some((term) => terms.has(term));
    });
    const ranks = new Map<string, ContextRetrievalTrace["routes"][number]>(admittedLexical.map((value, rank) => [
      value.candidate.resource_id,
      { event_id: value.candidate.resource_id, lexical_rank: rank + 1 },
    ]));
    vector.forEach((hit, rank) => {
      ranks.set(hit.event_id, {
        ...ranks.get(hit.event_id),
        event_id: hit.event_id,
        vector_rank: rank + 1,
        vector_score: hit.score,
        chunk_ordinal: hit.chunk_ordinal,
        start: hit.start,
        end: hit.end,
      });
    });
    trace.mode = "hybrid";
    trace.generation = generation.id;
    trace.model_revision = generation.model.model_revision;
    trace.authorized_count = ranked.authorized_count;
    trace.covered_count = ranked.covered_count;
    trace.routes = [...ranks.values()].sort((left, right) => compare(left.event_id, right.event_id));
    const candidates = new Map(admittedLexical.map((candidate) => [candidate.candidate.resource_id, candidate]));
    for (const hit of vector) {
      const material = eventCandidateMaterialFor(allowed.get(hit.event_id)!, plan.request, retrievalTimeFor(plan));
      if (!material) continue;
      const matches = searchMatches.get(hit.event_id);
      if (matches) {
        material.item.search_matches = matches;
        material.item.estimated_tokens = material.candidate.estimated_tokens =
          Math.ceil(((material.item.text?.length ?? 0) +
            matches.reduce((sum, match) => sum + (match.snippet?.length ?? match.filename?.length ?? 0), 0)) / 4);
      }
      candidates.set(hit.event_id, material);
    }
    const lexicalRaw = new Map(admittedLexical.map((value) => [value.candidate.resource_id, lexicalScore(value)]));
    const vectorRaw = new Map(vector.map((hit) => [hit.event_id, hit.score]));
    const lexicalRange = scoreRange([...lexicalRaw.values()]);
    const vectorRange = scoreRange([...vectorRaw.values()]);
    for (const [id, value] of candidates) {
      const route = ranks.get(id);
      if (!route) continue;
      const recency = value.candidate.scores.recency;
      value.candidate.scores = {
        anchor: value.candidate.scores.anchor ?? 0,
        hybrid: fuseHybridRoute(this.profile, {
          lexicalRank: route.lexical_rank,
          lexicalScore: lexicalRaw.get(id),
          vectorRank: route.vector_rank,
          vectorScore: vectorRaw.get(id),
        }, lexicalRange, vectorRange),
        ...(recency === undefined ? {} : { recency }),
      };
    }
    timeSearchStageSync("rerank", () => {
      rerankThreads(candidates, allowed, ranks, query);
    });
    trace.routes = [...ranks.values()].sort((left, right) => compare(left.event_id, right.event_id));
    return {
      candidates: [...candidates.values()].sort((left, right) => compare(left.candidate.candidate_id, right.candidate.candidate_id)),
      degradation_flags: [
        ...(lexical.degradation_flags ?? []),
        ...(ranked.covered_count < ranked.authorized_count ? ["vector_index_partial"] : []),
      ],
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
    noteSearchStageCache("embed", cached ? "hit" : "miss");
    if (cached) {
      this.queryVectors.delete(key);
      this.queryVectors.set(key, cached);
      return cached;
    }
    const pending = (async () => {
      let batch;
      if (this.provider.embedWithTokenCounts) {
        batch = await this.provider.embedWithTokenCounts([query], "query");
      } else {
        const counts = await this.provider.countTokens([query], "query");
        const [count] = counts;
        if (!Number.isSafeInteger(count) || count < 1) {
          throw new EmbeddingError("invalid_response", true);
        }
        if (count > generation.model.max_input_tokens) {
          throw new EmbeddingError("input_too_large", false);
        }
        batch = { counts, vectors: await this.provider.embed([query], "query") };
      }
      const [tokens] = batch.counts;
      if (!Number.isSafeInteger(tokens) || tokens < 1) {
        throw new EmbeddingError("invalid_response", true);
      }
      if (tokens > generation.model.max_input_tokens) {
        throw new EmbeddingError("input_too_large", false);
      }
      if (batch.counts.length !== 1 || batch.vectors.length !== 1) {
        throw new EmbeddingError("invalid_response", true);
      }
      validateEmbeddingVector(batch.vectors[0], generation.model.dimensions);
      return batch.vectors[0];
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

  private prepareAuthorization(
    orgId: string,
    generation: string,
    keys: ContextVectorAuthorizationKey[],
  ): PreparedVectorAuthorization {
      const previous = this.authorizationSnapshot;
      const listHash = vectorAuthorizationListHash(keys);
      if (
        previous
        && previous.org_id === orgId
        && previous.generation === generation
        && previous.keys.size === keys.length
        && previous.list_hash === listHash
      ) {
        return {
          hash: previous.hash,
          accumulator: previous.accumulator,
          snapshot: previous,
        };
      }
      if (!previous || previous.org_id !== orgId || previous.generation !== generation) {
        const accumulator = contextVectorAuthorizationAccumulator(keys);
        const hash = contextVectorAuthorizationHashFromAccumulator(keys.length, accumulator);
        return {
          hash,
          accumulator,
          snapshot: {
            org_id: orgId,
            generation,
            hash,
            accumulator,
            list_hash: listHash,
            keys: new Map(keys.map((key) => [key.event_id, structuredClone(key)])),
          },
        };
      }
      const current = new Map<string, ContextVectorAuthorizationKey>();
      const added: ContextVectorAuthorizationKey[] = [];
      for (const key of keys) {
        const copy = structuredClone(key);
        current.set(key.event_id, copy);
        const old = previous.keys.get(key.event_id);
        if (!old || !sameAuthorizationKey(old, key)) added.push(copy);
      }
      const removed: ContextVectorAuthorizationKey[] = [];
      for (const [eventId, key] of previous.keys) {
        const next = current.get(eventId);
        if (!next || !sameAuthorizationKey(key, next)) removed.push(structuredClone(key));
      }
      const accumulator = updateContextVectorAuthorizationAccumulator(
        previous.accumulator,
        added,
        removed,
      );
      const hash = contextVectorAuthorizationHashFromAccumulator(keys.length, accumulator);
      const delta: ContextVectorAuthorizationDelta | undefined =
        hash === previous.hash && added.length === 0 && removed.length === 0
          ? undefined
          : {
              previous_authorization_hash: previous.hash,
              previous_accumulator: previous.accumulator,
              accumulator,
              added,
              removed,
            };
      return {
        hash,
        accumulator,
        ...(delta ? { delta } : {}),
        snapshot: {
          org_id: orgId,
          generation,
          hash,
          accumulator,
          list_hash: listHash,
          keys: current,
        },
      };
  }
}

interface VectorAuthorizationSnapshot {
  org_id: string;
  generation: string;
  hash: string;
  accumulator: string;
  list_hash: string;
  keys: Map<string, ContextVectorAuthorizationKey>;
}

interface PreparedVectorAuthorization {
  hash: string;
  accumulator: string;
  delta?: ContextVectorAuthorizationDelta;
  snapshot: VectorAuthorizationSnapshot;
}

function sameAuthorizationKey(
  left: ContextVectorAuthorizationKey,
  right: ContextVectorAuthorizationKey,
): boolean {
  return left.content_hash === right.content_hash
    && left.body_length === right.body_length;
}

function vectorAuthorizationListHash(
  keys: readonly ContextVectorAuthorizationKey[],
): string {
  const hash = createHash("sha256");
  hash.update(`${keys.length}\0`);
  let chunk = "";
  for (const key of keys) {
    const bodyLength = key.body_length === undefined ? "-" : String(key.body_length);
    chunk += `${key.event_id.length}:${key.event_id}${key.content_hash}${bodyLength.length}:${bodyLength}`;
    if (chunk.length >= 64 * 1024) {
      hash.update(chunk);
      chunk = "";
    }
  }
  if (chunk) hash.update(chunk);
  return hash.digest("hex");
}

function validateVectorCoverageProof(
  proof: ContextVectorCoverageProof,
  authorizationHash: string,
  authorizedCount: number,
  allowed: Map<string, AuthorizedContextSourceEvent>,
  uncovered: Set<string>,
): void {
  if (
    !proof
    || proof.authorization_hash !== authorizationHash
    || proof.authorized_count !== authorizedCount
    || !Number.isSafeInteger(proof.covered_count)
    || proof.covered_count < 0
    || proof.covered_count > authorizedCount
    || typeof proof.complete !== "boolean"
    || !Array.isArray(proof.uncovered)
  ) {
    throw new ContextEngineError("invalid_candidate", "Invalid vector coverage proof");
  }
  for (const key of proof.uncovered) {
    const source = allowed.get(key?.event_id);
    if (!source || key.content_hash !== source.event.content_hash || uncovered.has(key.event_id)) {
      throw new ContextEngineError("invalid_candidate", "Unauthorized or duplicate vector coverage");
    }
    uncovered.add(key.event_id);
  }
  if (
    proof.covered_count !== authorizedCount - uncovered.size
    || proof.complete !== (uncovered.size === 0)
  ) {
    throw new ContextEngineError("invalid_candidate", "Inconsistent vector coverage proof");
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

function assertHybridProfile(profile: HybridRetrievalProfile): void {
  if ((profile.fusion !== "rrf" && profile.fusion !== "minmax") ||
    !Number.isFinite(profile.vector_min_score) || profile.vector_min_score < -1 || profile.vector_min_score > 1 ||
    !Number.isFinite(profile.semantic_evidence_score) || profile.semantic_evidence_score < -1 || profile.semantic_evidence_score > 1 ||
    !Number.isFinite(profile.vector_weight) || profile.vector_weight < 0 || profile.vector_weight > 1 ||
    !Number.isFinite(profile.lexical_weight) || profile.lexical_weight < 0 || profile.lexical_weight > 1 ||
    (profile.fusion === "minmax" && Math.abs(profile.vector_weight + profile.lexical_weight - 1) > 1e-9)) {
    throw new Error("Invalid hybrid retrieval profile");
  }
}

export function fuseHybridRoute(
  profile: HybridRetrievalProfile,
  route: { lexicalRank?: number; lexicalScore?: number; vectorRank?: number; vectorScore?: number },
  lexicalRange: { min: number; max: number },
  vectorRange: { min: number; max: number },
): number {
  if (profile.fusion === "rrf") {
    const score = (route.lexicalRank ? 1 / (RRF_K + route.lexicalRank) : 0) +
      (route.vectorRank ? 1 / (RRF_K + route.vectorRank) : 0);
    return Number((score * (RRF_K + 1) / 2).toFixed(9));
  }
  const lexical = route.lexicalScore === undefined ? 0 : relativeScore(route.lexicalScore, lexicalRange);
  const vector = route.vectorScore === undefined ? 0 : relativeScore(route.vectorScore, vectorRange);
  return Number((profile.lexical_weight * lexical + profile.vector_weight * vector).toFixed(9));
}

function scoreRange(values: number[]): { min: number; max: number } {
  if (values.length === 0) return { min: 0, max: 0 };
  return { min: Math.min(...values), max: Math.max(...values) };
}

function relativeScore(score: number, range: { min: number; max: number }): number {
  if (range.max === range.min) return 1;
  return (score - range.min) / (range.max - range.min);
}

function lexicalScore(value: RetrievedContextCandidate): number {
  const scores = value.candidate.scores;
  return 3 * (scores.exact_match ?? 0) + 2 * (scores.lexical ?? 0);
}

function rerankThreads(
  candidates: Map<string, RetrievedContextCandidate>,
  allowed: Map<string, AuthorizedContextSourceEvent>,
  routes: Map<string, ContextRetrievalTrace["routes"][number]>,
  query: string,
): void {
  const queryTerms = new Set(contextLexicalQueryTerms(query));
  const groups = new Map<string, {
    threadId?: string;
    members: Array<{
      eventId: string;
      evidenceKey: string;
      coveredTerms: Set<string>;
      hybrid: number;
    }>;
  }>();
  for (const [eventId, candidate] of candidates) {
    const source = allowed.get(eventId);
    if (!source) continue;
    const threadId = source.thread_id?.trim() || undefined;
    const key = threadId ? `thread:${threadId}` : `event:${eventId}`;
    const text = source.search_body ?? source.text ?? "";
    const terms = new Set(contextLexicalTerms(text).filter((term) => queryTerms.has(term)));
    const group = groups.get(key) ?? { ...(threadId ? { threadId } : {}), members: [] };
    group.members.push({
      eventId,
      evidenceKey: normalizedEvidenceKey(text, source.event.content_hash!, eventId),
      coveredTerms: terms,
      hybrid: candidate.candidate.scores.hybrid ?? 0,
    });
    groups.set(key, group);
  }
  const ranked = [...groups.values()].map((group) => {
    const uniqueEvidence = new Set(group.members.map((member) => member.evidenceKey));
    const coveredTerms = new Set(group.members.flatMap((member) => [...member.coveredTerms]));
    const best = Math.max(...group.members.map((member) => member.hybrid));
    const coverage = queryTerms.size ? coveredTerms.size / queryTerms.size : 0;
    const support = Math.min(1, Math.max(0, uniqueEvidence.size - 1) / 2);
    return {
      ...group,
      score: Number((0.8 * best + 0.15 * coverage + 0.05 * support).toFixed(9)),
    };
  }).sort((left, right) =>
    right.score - left.score ||
    compare(left.threadId ?? left.members[0].eventId, right.threadId ?? right.members[0].eventId));

  ranked.forEach((group, threadIndex) => {
    const seenEvidence = new Set<string>();
    const coveredTerms = new Set<string>();
    let uniqueOrdinal = 0;
    group.members.sort((left, right) =>
      right.hybrid - left.hybrid || compare(left.eventId, right.eventId));
    for (const member of group.members) {
      const candidate = candidates.get(member.eventId)!;
      const duplicate = seenEvidence.has(member.evidenceKey);
      let diversity = 0;
      if (!duplicate) {
        uniqueOrdinal += 1;
        seenEvidence.add(member.evidenceKey);
        const newlyCovered = [...member.coveredTerms].filter((term) => !coveredTerms.has(term));
        for (const term of newlyCovered) coveredTerms.add(term);
        diversity = Math.max(
          1 / uniqueOrdinal,
          queryTerms.size ? newlyCovered.length / queryTerms.size : 0,
        );
      }
      candidate.candidate.scores = {
        ...candidate.candidate.scores,
        thread: duplicate ? 0 : group.score,
        evidence_diversity: Number(diversity.toFixed(9)),
      };
      const route = routes.get(member.eventId);
      if (route && group.threadId) {
        routes.set(member.eventId, {
          ...route,
          thread_id: group.threadId,
          thread_rank: threadIndex + 1,
          thread_score: group.score,
          evidence_diversity: Number(diversity.toFixed(9)),
        });
      } else if (route) {
        routes.set(member.eventId, {
          ...route,
          evidence_diversity: Number(diversity.toFixed(9)),
        });
      }
    }
  });
}

function normalizedEvidenceKey(text: string, contentHash: string, eventId: string): string {
  const normalized = text.normalize("NFKC").toLocaleLowerCase().replace(/\s+/gu, " ").trim();
  return normalized ? createHash("sha256").update(normalized).digest("hex") : contentHash || eventId;
}

function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
