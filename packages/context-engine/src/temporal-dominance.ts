import { contextLexicalTerms } from "@regenic/domain";

const DAY_MS = 86_400_000;
/** Only the head can enter the assembled window, so pairs outside it cannot change the result. */
const DOMINANCE_HEAD = 15;
const MIN_JACCARD = 0.12;
const MAX_JACCARD = 0.8;
/**
 * A query that names a calendar day pulls evidence toward that day.
 * Seven days is the same floor an `occurred_after` window already uses.
 * On the Chinese set, 7, 10, 14 and 21 days all hold the gate; 7 has the highest recall and nDCG.
 */
const DATE_DISTANCE_HALF_LIFE_DAYS = 7;

/** A query that asks for the earlier state. Mixed with a current cue, dominance stays off. */
const PAST_SEEKING = /一开始|最初|最早|当时|旧方案|曾经|之前一直|initially|originally|used to|just started|before getting/;
/** A query that asks for the state that still holds. */
const CURRENT_SEEKING = /现在|目前|当前|最新|还能|继续|是否已经|还主要|currently|right now|nowadays/;
/** The newer message withdraws or replaces the earlier one. */
const SUPERSESSION = /作废|先别|别按|重开|不再|撑不到|别排|改成|改到|别急着|不是那个/;

export interface TemporalDominanceCandidate {
  candidate: { kind: string; resource_id: string };
  item: { text?: string; evidence: ReadonlyArray<{ occurred_at: string }> };
  rank_score: number;
}

/**
 * GC-Mem temporal dominance on one retrieved head.
 * Two messages contradict when they share a query term, overlap in a middle band,
 * and the newer one explicitly supersedes the earlier one. A current-seeking query
 * drops the older message. A past-seeking query drops the newer one. Other queries
 * are unchanged, and a protected event is never dropped.
 */
export function suppressSupersededEvidence<T extends TemporalDominanceCandidate>(
  query: string | undefined,
  ranked: readonly T[],
  protectedEventIds: ReadonlySet<string>,
): T[] {
  const intent = temporalIntent(query);
  const queryTerms = contentTerms(query);
  if (!intent || queryTerms.size === 0) return [...ranked];
  const head = ranked.slice(0, DOMINANCE_HEAD).map((value) => ({
    value,
    terms: value.candidate.kind === "event" ? contentTerms(value.item.text) : new Set<string>(),
    at: occurredAt(value),
    text: value.item.text ?? "",
  }));
  const suppressed = new Set<string>();
  for (let leftIndex = 0; leftIndex < head.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < head.length; rightIndex += 1) {
      const left = head[leftIndex];
      const right = head[rightIndex];
      if (left.at === undefined || right.at === undefined) continue;
      if (!sharesQueryTerm(queryTerms, left.terms, right.terms)) continue;
      const overlap = jaccard(left.terms, right.terms);
      if (overlap < MIN_JACCARD || overlap > MAX_JACCARD) continue;
      const newer = left.at >= right.at ? left : right;
      const older = newer === left ? right : left;
      const newerAt = newer.at;
      const olderAt = older.at;
      if (newerAt === undefined || olderAt === undefined || newerAt - olderAt < DAY_MS) continue;
      if (!SUPERSESSION.test(newer.text)) continue;
      const victim = intent === "current" ? older : newer;
      if (victim.value.candidate.kind !== "event") continue;
      if (protectedEventIds.has(victim.value.candidate.resource_id)) continue;
      suppressed.add(victim.value.candidate.resource_id);
    }
  }
  if (suppressed.size === 0) return [...ranked];
  return ranked.filter((value) => !suppressed.has(value.candidate.resource_id));
}

/**
 * TimelyRAG-style distance for one named day. Evidence far from that day keeps its place
 * in the candidate list, but its rank falls by half each {@link DATE_DISTANCE_HALF_LIFE_DAYS}.
 * A protected event keeps the fused rank so the budget exception still fits.
 * Queries with no YYYY-MM-DD are unchanged, including the English memory set.
 */
export function preferEvidenceNearQueryDate<T extends TemporalDominanceCandidate>(
  query: string | undefined,
  ranked: readonly T[],
  protectedEventIds: ReadonlySet<string>,
): T[] {
  const anchor = queryDateAnchor(query);
  if (anchor === undefined) return [...ranked];
  return ranked.map((value) => {
    if (value.candidate.kind === "event" && protectedEventIds.has(value.candidate.resource_id)) return value;
    const at = occurredAt(value);
    if (at === undefined) return value;
    const days = Math.abs(at - anchor) / DAY_MS;
    const factor = Math.exp(-Math.LN2 * days / DATE_DISTANCE_HALF_LIFE_DAYS);
    if (factor === 1) return value;
    return { ...value, rank_score: value.rank_score * factor };
  });
}

function temporalIntent(query: string | undefined): "current" | "past" | undefined {
  if (!query) return undefined;
  const past = PAST_SEEKING.test(query);
  const current = CURRENT_SEEKING.test(query);
  if (past === current) return undefined;
  return current ? "current" : "past";
}

function contentTerms(value: string | undefined): Set<string> {
  return new Set(contextLexicalTerms(value).filter((term) => [...term].length > 1));
}

function sharesQueryTerm(queryTerms: Set<string>, left: Set<string>, right: Set<string>): boolean {
  for (const term of queryTerms) {
    if (left.has(term) && right.has(term)) return true;
  }
  return false;
}

function jaccard(left: Set<string>, right: Set<string>): number {
  let intersection = 0;
  for (const term of left) {
    if (right.has(term)) intersection += 1;
  }
  const union = left.size + right.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function queryDateAnchor(query: string | undefined): number | undefined {
  const match = query?.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  const anchor = Date.UTC(year, month - 1, day);
  const check = new Date(anchor);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return undefined;
  return anchor;
}

function occurredAt(value: TemporalDominanceCandidate): number | undefined {
  const occurred = value.item.evidence[0]?.occurred_at;
  if (!occurred) return undefined;
  const parsed = Date.parse(occurred);
  return Number.isNaN(parsed) ? undefined : parsed;
}
