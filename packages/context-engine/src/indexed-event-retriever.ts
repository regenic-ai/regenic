import {
  CONTEXT_LEXICAL_ALGORITHM_VERSION,
  canonicalContextJson,
  type AuthorizedContextRetrievalPlan,
  type ContextLexicalIndex,
  type ContextLexicalKey,
  type ContextRetrievalCapabilities,
  type ContextRetrievalResult,
  type ContextRetriever,
  type MatchAuthorizedContextLexicalResult,
  type RetrievedContextCandidate,
} from "@regenic/domain";
import {
  eligibleEventSources,
  eventCandidateFor,
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
    };
  }

  async retrieve(plan: AuthorizedContextRetrievalPlan): Promise<ContextRetrievalResult> {
    if (plan.request.requested_kinds && !plan.request.requested_kinds.includes("event")) {
      return { candidates: [] };
    }
    const eligible = eligibleEventSources(plan);
    if (!plan.request.query) {
      return { candidates: toCandidates(eligible, plan) };
    }
    const authorized = eligible.flatMap((source) => source.event.content_hash
      ? [{ event_id: source.event.event_id, content_hash: source.event.content_hash }]
      : []);
    const result = await this.index.matchAuthorized({
      org_id: plan.request.org_id,
      query: plan.request.query,
      authorized,
    });
    const { covered, matched } = validateIndexResult(result, authorized);
    const candidates = eligible
      .filter((source) => {
        const contentHash = source.event.content_hash;
        if (!contentHash) {
          return false;
        }
        const key = keyOf({ event_id: source.event.event_id, content_hash: contentHash });
        return matched.has(key) || !covered.has(key);
      });
    return {
      candidates: toCandidates(candidates, plan),
      degradation_flags: degradationFlags(result, covered.size, authorized.length),
    };
  }
}

function toCandidates(
  sources: ReturnType<typeof eligibleEventSources>,
  plan: AuthorizedContextRetrievalPlan,
): RetrievedContextCandidate[] {
  const retrievalTime = retrievalTimeFor(plan);
  return sources
    .map((source) => eventCandidateFor(source, plan.request, retrievalTime))
    .filter((candidate): candidate is RetrievedContextCandidate => candidate !== null)
    .sort((left, right) => left.candidate.candidate_id.localeCompare(right.candidate.candidate_id));
}

function validateIndexResult(
  result: MatchAuthorizedContextLexicalResult,
  authorized: ContextLexicalKey[],
): { covered: Set<string>; matched: Set<string> } {
  const allowed = new Set(authorized.map(keyOf));
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
  const covered = validateKeys(result.covered, allowed);
  const matched = validateKeys(result.matched, allowed);
  if ([...matched].some((key) => !covered.has(key))) {
    throw new Error("Context lexical index matched an uncovered Event");
  }
  return { covered, matched };
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
