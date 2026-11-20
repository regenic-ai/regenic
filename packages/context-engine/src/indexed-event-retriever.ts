import {
  CONTEXT_LEXICAL_ALGORITHM_VERSION,
  canonicalContextJson,
  contextLexicalAuthorizationHash,
  type AuthorizedContextRetrievalPlan,
  type ContextLexicalIndex,
  type ContextLexicalKey,
  type ContextEventMaterializer,
  type ContextRetrievalCapabilities,
  type ContextRetrievalResult,
  type ContextRetriever,
  type MatchAuthorizedContextLexicalResult,
} from "@regenic/domain";
import {
  eligibleEventSources,
  eventCandidatesFor,
  retrievalTimeFor,
} from "./deterministic-event-retriever";

export const INDEXED_EVENT_RETRIEVER_ID = "event-lexical-indexed";
const HASH_PATTERN = /^[a-f0-9]{64}$/;

export class IndexedEventRetriever implements ContextRetriever {
  readonly id = INDEXED_EVENT_RETRIEVER_ID;

  constructor(private readonly index: ContextLexicalIndex) {}

  capabilities(): ContextRetrievalCapabilities {
    return {
      candidate_kinds: ["event"],
      lexical: true,
      vector: false,
      graph: false,
      rerank: false,
      multilingual: true,
      lazy_materialization: true,
    };
  }

  async retrieve(
    plan: AuthorizedContextRetrievalPlan,
    materialize?: ContextEventMaterializer,
  ): Promise<ContextRetrievalResult> {
    if (plan.request.requested_kinds && !plan.request.requested_kinds.includes("event")) {
      return { candidates: [] };
    }
    const eligible = eligibleEventSources(plan);
    const candidatesFor = async (sources: typeof eligible) => {
      const loaded = materialize
        ? await materialize(sources.map((source) => source.event.event_id))
        : sources;
      return eventCandidatesFor(loaded, plan.request, retrievalTimeFor(plan));
    };
    // Filename metadata is not part of legacy Event lexical coverage.
    if (!plan.request.query || plan.request.search_kind) {
      return { candidates: await candidatesFor(eligible) };
    }
    const authorized = eligible.flatMap((source) => source.event.content_hash
      ? [{ event_id: source.event.event_id, content_hash: source.event.content_hash }]
      : []);
    const authorizationHash = contextLexicalAuthorizationHash(authorized);
    const result = await this.index.matchAuthorized({
      org_id: plan.request.org_id,
      query: plan.request.query,
      authorized,
      authorization_hash: authorizationHash,
    });
    const { coveredCount, matched, uncovered } = validateIndexResult(
      result,
      authorized,
      authorizationHash,
    );
    const candidates = eligible
      .filter((source) => {
        const contentHash = source.event.content_hash;
        if (!contentHash) {
          return false;
        }
        const key = keyOf({ event_id: source.event.event_id, content_hash: contentHash });
        return matched.has(key) || uncovered.has(key);
      });
    return {
      candidates: await candidatesFor(candidates),
      degradation_flags: degradationFlags(result, coveredCount, authorized.length),
    };
  }
}

function validateIndexResult(
  result: MatchAuthorizedContextLexicalResult,
  authorized: ContextLexicalKey[],
  authorizationHash: string,
): { coveredCount: number; matched: Set<string>; uncovered: Set<string> } {
  if (
    !result ||
    typeof result.available !== "boolean" ||
    result.algorithm_version !== CONTEXT_LEXICAL_ALGORITHM_VERSION ||
    !Array.isArray(result.covered) ||
    !Array.isArray(result.matched) ||
    (result.generation !== undefined &&
      (typeof result.generation !== "string" || !result.generation.trim())) ||
    (result.watermark !== undefined &&
      (typeof result.watermark !== "string" || !result.watermark.trim()))
  ) {
    throw new Error("Context lexical index returned an invalid result");
  }
  if (result.coverage !== undefined) {
    const coverage = result.coverage;
    if (
      !coverage
      || coverage.authorization_hash !== authorizationHash
      || coverage.authorized_count !== authorized.length
      || !Number.isSafeInteger(coverage.covered_count)
      || coverage.covered_count < 0
      || coverage.covered_count > authorized.length
      || typeof coverage.complete !== "boolean"
      || !Array.isArray(coverage.uncovered)
    ) {
      throw new Error("Context lexical index returned an invalid coverage proof");
    }
    const needsAllowlist = result.matched.length > 0 || coverage.uncovered.length > 0;
    const allowed = needsAllowlist
      ? new Set(authorized.map(keyOf))
      : new Set<string>();
    const matched = validateKeys(result.matched, allowed);
    const uncovered = validateKeys(coverage.uncovered, allowed);
    if (
      coverage.covered_count !== authorized.length - uncovered.size
      || coverage.complete !== (uncovered.size === 0)
      || [...matched].some((key) => uncovered.has(key))
    ) {
      throw new Error("Context lexical index returned an inconsistent coverage proof");
    }
    return { coveredCount: coverage.covered_count, matched, uncovered };
  }
  const allowed = new Set(authorized.map(keyOf));
  const matched = validateKeys(result.matched, allowed);
  const covered = validateKeys(result.covered, allowed);
  if ([...matched].some((key) => !covered.has(key))) {
    throw new Error("Context lexical index matched an uncovered Event");
  }
  const uncovered = new Set(
    [...allowed].filter((key) => !covered.has(key)),
  );
  return { coveredCount: covered.size, matched, uncovered };
}

function validateKeys(keys: ContextLexicalKey[], allowed: Set<string>): Set<string> {
  const values = new Set<string>();
  for (const key of keys) {
    if (
      !key ||
      typeof key.event_id !== "string" ||
      !key.event_id.trim() ||
      typeof key.content_hash !== "string" ||
      !HASH_PATTERN.test(key.content_hash)
    ) {
      throw new Error("Context lexical index returned an invalid Event key");
    }
    const value = keyOf(key);
    if (!allowed.has(value) || values.has(value)) {
      throw new Error("Context lexical index returned an unauthorized or duplicate Event key");
    }
    values.add(value);
  }
  return values;
}

function degradationFlags(
  result: MatchAuthorizedContextLexicalResult,
  covered: number,
  authorized: number,
): string[] {
  if (!result.available) {
    return ["lexical_index_absent"];
  }
  if (!result.generation) {
    return ["lexical_index_unbuilt"];
  }
  if (covered < authorized) {
    return ["lexical_index_partial"];
  }
  return [];
}

function keyOf(key: ContextLexicalKey): string {
  return canonicalContextJson([key.event_id, key.content_hash]);
}
