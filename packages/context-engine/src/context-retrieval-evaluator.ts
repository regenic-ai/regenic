import {
  canonicalContextJson,
  hashCanonicalContext,
  type ContextBundle,
  type ContextEngine,
  type ContextRequest,
} from "@regenic/domain";

export const CONTEXT_EVALUATION_SCHEMA_VERSION = "1.0" as const;

export interface ContextEvaluationCase {
  id: string;
  request: ContextRequest;
  relevant_event_ids: string[];
  forbidden_event_ids?: string[];
  stale_event_ids?: string[];
}

export interface ContextEvaluationDataset {
  schema_version: typeof CONTEXT_EVALUATION_SCHEMA_VERSION;
  id: string;
  cases: ContextEvaluationCase[];
}

export interface ContextEvaluationCaseResult {
  case_id: string;
  has_relevant: boolean;
  selected_event_ids: string[];
  recall_at_k: number;
  reciprocal_rank_at_k: number;
  ndcg_at_k: number;
  citation_coverage: number;
  unauthorized_selections: number;
  stale_selections: number;
  selection_hash: string;
}

export interface ContextEvaluationReport {
  schema_version: typeof CONTEXT_EVALUATION_SCHEMA_VERSION;
  dataset_id: string;
  k: number;
  cases: ContextEvaluationCaseResult[];
  metrics: {
    mean_recall_at_k: number;
    mean_reciprocal_rank_at_k: number;
    mean_ndcg_at_k: number;
    citation_coverage: number;
    positive_case_count: number;
    negative_case_count: number;
    negative_selection_rate: number;
    unauthorized_selections: number;
    stale_selections: number;
    safety_passed: boolean;
  };
  content_hash: string;
}

export async function evaluateContextRetrieval(
  engine: ContextEngine,
  dataset: ContextEvaluationDataset,
  options: { k?: number } = {},
): Promise<ContextEvaluationReport> {
  const k = options.k ?? 10;
  validateDataset(dataset, k);
  const cases: ContextEvaluationCaseResult[] = [];
  for (const value of dataset.cases) {
    const result = await engine.assemble(structuredClone(value.request));
    const items = result.bundle.sections.flatMap((section) => section.items)
      .filter((item) => item.kind === "event")
      .slice(0, k);
    const selectedIds = items.map((item) => item.resource_id);
    const relevant = new Set(value.relevant_event_ids);
    const forbidden = new Set(value.forbidden_event_ids ?? []);
    const stale = new Set(value.stale_event_ids ?? []);
    const relevantRanks = selectedIds.flatMap((eventId, index) =>
      relevant.has(eventId) ? [index + 1] : [],
    );
    cases.push({
      case_id: value.id,
      has_relevant: relevant.size > 0,
      selected_event_ids: selectedIds,
      recall_at_k: relevant.size === 0
        ? 0
        : ratio(new Set(selectedIds.filter((eventId) => relevant.has(eventId))).size, relevant.size),
      reciprocal_rank_at_k: relevantRanks[0] ? stable(1 / relevantRanks[0]) : 0,
      ndcg_at_k: relevant.size === 0 ? 0 : ndcg(selectedIds, relevant, k),
      citation_coverage: citationCoverage(items, result.bundle),
      unauthorized_selections: selectedIds.filter((eventId) => forbidden.has(eventId)).length,
      stale_selections: selectedIds.filter((eventId) => stale.has(eventId)).length,
      selection_hash: hashCanonicalContext({
        selected_event_ids: selectedIds,
        citations: result.bundle.citations,
        degradation_flags: result.bundle.degradation_flags,
      }),
    });
  }
  const selectedItems = cases.reduce((sum, value) => sum + value.selected_event_ids.length, 0);
  const weightedCitationCoverage = selectedItems === 0
    ? 1
    : stable(cases.reduce(
      (sum, value) => sum + value.citation_coverage * value.selected_event_ids.length,
      0,
    ) / selectedItems);
  const unauthorized = cases.reduce((sum, value) => sum + value.unauthorized_selections, 0);
  const stale = cases.reduce((sum, value) => sum + value.stale_selections, 0);
  const positiveCases = cases.filter((value) => value.has_relevant);
  const negativeCases = cases.filter((value) => !value.has_relevant);
  const negativeSelectionRate = negativeCases.length === 0
    ? 0
    : ratio(
      negativeCases.filter((value) => value.selected_event_ids.length > 0).length,
      negativeCases.length,
    );
  const semantic = {
    schema_version: CONTEXT_EVALUATION_SCHEMA_VERSION,
    dataset_id: dataset.id,
    k,
    cases,
    metrics: {
      mean_recall_at_k: mean(positiveCases.map((value) => value.recall_at_k)),
      mean_reciprocal_rank_at_k: mean(positiveCases.map((value) => value.reciprocal_rank_at_k)),
      mean_ndcg_at_k: mean(positiveCases.map((value) => value.ndcg_at_k)),
      citation_coverage: weightedCitationCoverage,
      positive_case_count: positiveCases.length,
      negative_case_count: negativeCases.length,
      negative_selection_rate: negativeSelectionRate,
      unauthorized_selections: unauthorized,
      stale_selections: stale,
      safety_passed:
        unauthorized === 0 &&
        stale === 0 &&
        weightedCitationCoverage === 1 &&
        negativeSelectionRate === 0,
    },
  };
  return {
    ...semantic,
    content_hash: hashCanonicalContext(semantic),
  };
}

function citationCoverage(
  items: ContextBundle["sections"][number]["items"],
  bundle: ContextBundle,
): number {
  if (items.length === 0) {
    return 1;
  }
  const citations = new Set(bundle.citations.map((citation) => canonicalContextJson(citation)));
  const covered = items.filter((item) =>
    item.evidence.length > 0 && item.evidence.every((citation) => citations.has(canonicalContextJson(citation))),
  ).length;
  return ratio(covered, items.length);
}

function ndcg(selected: string[], relevant: Set<string>, k: number): number {
  const dcg = selected.slice(0, k).reduce((sum, eventId, index) =>
    sum + (relevant.has(eventId) ? 1 / Math.log2(index + 2) : 0),
  0);
  const idealCount = Math.min(relevant.size, k);
  const ideal = Array.from({ length: idealCount }).reduce<number>(
    (sum, _value, index) => sum + 1 / Math.log2(index + 2),
    0,
  );
  return ideal === 0 ? 1 : stable(dcg / ideal);
}

function validateDataset(dataset: ContextEvaluationDataset, k: number): void {
  if (
    !dataset ||
    dataset.schema_version !== CONTEXT_EVALUATION_SCHEMA_VERSION ||
    typeof dataset.id !== "string" ||
    !dataset.id.trim() ||
    !Array.isArray(dataset.cases) ||
    dataset.cases.length === 0 ||
    !Number.isSafeInteger(k) ||
    k < 1 ||
    k > 1_000 ||
    new Set(dataset.cases.map((value) => value.id)).size !== dataset.cases.length
  ) {
    throw new Error("Invalid Context evaluation dataset");
  }
  for (const value of dataset.cases) {
    const lists = [value.relevant_event_ids, value.forbidden_event_ids ?? [], value.stale_event_ids ?? []];
    if (
      typeof value.id !== "string" ||
      !value.id.trim() ||
      !value.request ||
      lists.some((list) =>
        !Array.isArray(list) ||
        list.some((eventId) => typeof eventId !== "string" || !eventId.trim()) ||
        new Set(list).size !== list.length,
      ) ||
      value.relevant_event_ids.some((eventId) => (value.forbidden_event_ids ?? []).includes(eventId))
    ) {
      throw new Error("Invalid Context evaluation case");
    }
  }
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : stable(numerator / denominator);
}

function mean(values: number[]): number {
  return values.length === 0
    ? 0
    : stable(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function stable(value: number): number {
  return Number(value.toFixed(12));
}
