import { scoreContextLexicalText } from "@regenic/domain";
import type {
  AuthorizedContextSourceEvent,
  AuthorizedContextRetrievalPlan,
  ContextCandidate,
  ContextRequest,
  ContextRetriever,
  ContextRetrievalCapabilities,
  RetrievedContextCandidate,
} from "@regenic/domain";

export const DETERMINISTIC_EVENT_RETRIEVER_ID = "event-deterministic";

export class DeterministicEventRetriever implements ContextRetriever {
  readonly id = DETERMINISTIC_EVENT_RETRIEVER_ID;

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

  async retrieve(plan: AuthorizedContextRetrievalPlan): Promise<RetrievedContextCandidate[]> {
    if (plan.request.requested_kinds && !plan.request.requested_kinds.includes("event")) {
      return [];
    }
    const retrievalTime = retrievalTimeFor(plan);
    return eligibleEventSources(plan)
      .map((source) => eventCandidateFor(source, plan.request, retrievalTime))
      .filter((candidate): candidate is RetrievedContextCandidate => candidate !== null)
      .sort((left, right) => compare(left.candidate.candidate_id, right.candidate.candidate_id));
  }
}

export function retrievalTimeFor(plan: AuthorizedContextRetrievalPlan): string {
  return plan.request.temporal.mode === "as_of"
    ? plan.request.temporal.recorded_at
    : plan.recorded_at;
}

export function eligibleEventSources(
  plan: AuthorizedContextRetrievalPlan,
): AuthorizedContextSourceEvent[] {
  const retrievalTime = retrievalTimeFor(plan);
  return plan.events
    .filter((source) => matchesFilters(source, plan.request))
    .filter((source) => matchesAnchors(source, plan.request))
    .filter((source) => withinMaxAge(source, plan.request, retrievalTime));
}

function matchesAnchors(source: AuthorizedContextSourceEvent, request: ContextRequest): boolean {
  if (!request.anchors || request.anchors.length === 0) {
    return true;
  }
  return request.anchors.some((anchor) => {
    if (anchor.kind === "event") {
      return source.event.event_id === anchor.id;
    }
    if (anchor.kind === "conversation") {
      return source.thread_id === anchor.id;
    }
    return source.attrs?.[`${anchor.kind}_id`] === anchor.id;
  });
}

function withinMaxAge(
  source: AuthorizedContextSourceEvent,
  request: ContextRequest,
  recordedAt: string,
): boolean {
  if (!request.budget.max_age_days) {
    return true;
  }
  const ageMs = Date.parse(recordedAt) - Date.parse(source.event.occurred_at);
  return ageMs <= request.budget.max_age_days * 86_400_000;
}

export function eventCandidateFor(
  source: AuthorizedContextSourceEvent,
  request: ContextRequest,
  recordedAt: string,
): RetrievedContextCandidate | null {
  const contentHash = source.event.content_hash;
  if (!contentHash) {
    return null;
  }
  const queryScore = scoreContextLexicalText(source.text, request.query);
  if (request.query && queryScore.lexical === 0) {
    return null;
  }
  const estimatedTokens = source.estimated_tokens ?? estimateTokens(source.text);
  const evidence = [{
    event_id: source.event.event_id,
    source: source.event.source,
    external_id: source.event.external_id,
    operation: source.event.operation,
    occurred_at: source.event.occurred_at,
    content_hash: contentHash,
  }];
  const candidate: ContextCandidate = {
    candidate_id: `event:${source.event.event_id}`,
    kind: "event",
    resource_id: source.event.event_id,
    evidence,
    required_scope_ids: [...source.required_scope_ids],
    recorded_at: source.event.ingested_at,
    status: source.status,
    content_hash: contentHash,
    scores: {
      anchor: anchorScore(source, request),
      exact_match: queryScore.exact_match,
      lexical: queryScore.lexical,
      recency: recencyScore(source.event.occurred_at, recordedAt),
    },
    estimated_tokens: estimatedTokens,
  };
  return {
    candidate,
    section: "evidence",
    item: {
      candidate_id: candidate.candidate_id,
      resource_id: candidate.resource_id,
      kind: candidate.kind,
      status: candidate.status,
      ...(source.text === undefined ? {} : { text: source.text }),
      content_hash: contentHash,
      evidence,
      estimated_tokens: estimatedTokens,
    },
  };
}

function anchorScore(source: AuthorizedContextSourceEvent, request: ContextRequest): number {
  if (!request.anchors || request.anchors.length === 0) {
    return 0;
  }
  return matchesAnchors(source, request) ? 1 : 0;
}

function recencyScore(occurredAt: string, recordedAt: string): number {
  const ageDays = Math.max(0, Date.parse(recordedAt) - Date.parse(occurredAt)) / 86_400_000;
  return 1 / (1 + ageDays);
}

function estimateTokens(text: string | undefined): number {
  return text ? Math.max(1, Math.ceil(text.length / 4)) : 0;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function matchesFilters(source: AuthorizedContextSourceEvent, request: ContextRequest): boolean {
  const filters = request.filters;
  if (!filters) {
    return true;
  }
  if (filters.sources && !filters.sources.includes(source.event.source)) {
    return false;
  }
  if (filters.thread_ids && (!source.thread_id || !filters.thread_ids.includes(source.thread_id))) {
    return false;
  }
  if (filters.actor_ids && (!source.actor_id || !filters.actor_ids.includes(source.actor_id))) {
    return false;
  }
  const occurredAt = Date.parse(source.event.occurred_at);
  if (filters.occurred_after && occurredAt < Date.parse(filters.occurred_after)) {
    return false;
  }
  if (filters.occurred_before && occurredAt > Date.parse(filters.occurred_before)) {
    return false;
  }
  return true;
}
