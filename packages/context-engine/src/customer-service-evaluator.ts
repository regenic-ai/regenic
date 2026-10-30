import { hashCanonicalContext } from "@regenic/domain";

export const CUSTOMER_SERVICE_EVALUATION_SCHEMA_VERSION = "1.0" as const;

export type CustomerServiceExpectedAction =
  | "query_business"
  | "clarify"
  | "human"
  | "retry"
  | "redraft";

export interface CustomerServiceEvaluationCase {
  id: string;
  category: string;
  question: string;
  required_event_ids: string[];
  expected_member_keys?: string[];
  expected_action: CustomerServiceExpectedAction;
  forbidden_claims?: string[];
  stale_detection_required?: boolean;
}

export interface CustomerServiceEvaluationDataset {
  schema_version: typeof CUSTOMER_SERVICE_EVALUATION_SCHEMA_VERSION;
  id: string;
  cases: CustomerServiceEvaluationCase[];
}

export interface CustomerServiceEvaluationObservation {
  selected_event_ids: string[];
  citations: Array<{
    event_id: string;
    content_hash_valid: boolean;
  }>;
  resolved_member_keys: string[];
  action: CustomerServiceExpectedAction;
  claims: string[];
  stale_detected: boolean;
}

export interface CustomerServiceEvaluationThresholds {
  minimum_cases: number;
  evidence_recall: number;
  member_closure_accuracy: number;
  citation_validity: number;
  action_accuracy: number;
  stale_detection_rate: number;
  maximum_forbidden_claims: number;
}

export interface CustomerServiceEvaluationCaseResult {
  case_id: string;
  category: string;
  selected_event_ids: string[];
  missing_event_ids: string[];
  evidence_recall: number;
  member_closure_correct: boolean | null;
  citation_count: number;
  valid_citation_count: number;
  citation_validity: number;
  action_correct: boolean;
  forbidden_claims: string[];
  stale_detection_correct: boolean | null;
}

export interface CustomerServiceEvaluationReport {
  schema_version: typeof CUSTOMER_SERVICE_EVALUATION_SCHEMA_VERSION;
  dataset_id: string;
  thresholds: CustomerServiceEvaluationThresholds;
  cases: CustomerServiceEvaluationCaseResult[];
  metrics: {
    case_count: number;
    evidence_recall: number;
    evidence_complete_case_rate: number;
    member_closure_accuracy: number;
    citation_validity: number;
    action_accuracy: number;
    stale_detection_rate: number;
    forbidden_claims: number;
    passed: boolean;
  };
  failed_gates: string[];
  content_hash: string;
}

export const DEFAULT_CUSTOMER_SERVICE_EVALUATION_THRESHOLDS: CustomerServiceEvaluationThresholds = {
  minimum_cases: 60,
  evidence_recall: 0.95,
  member_closure_accuracy: 1,
  citation_validity: 1,
  action_accuracy: 1,
  stale_detection_rate: 1,
  maximum_forbidden_claims: 0,
};

export async function evaluateCustomerServiceWorkflow(
  dataset: CustomerServiceEvaluationDataset,
  execute: (
    value: CustomerServiceEvaluationCase,
  ) => Promise<CustomerServiceEvaluationObservation>,
  thresholds: CustomerServiceEvaluationThresholds =
    DEFAULT_CUSTOMER_SERVICE_EVALUATION_THRESHOLDS,
): Promise<CustomerServiceEvaluationReport> {
  validateDataset(dataset);
  validateThresholds(thresholds);
  const cases: CustomerServiceEvaluationCaseResult[] = [];
  for (const value of dataset.cases) {
    const observation = await execute(structuredClone(value));
    validateObservation(observation);
    const selected = new Set(observation.selected_event_ids);
    const missing = value.required_event_ids.filter((eventId) => !selected.has(eventId));
    const expectedMembers = value.expected_member_keys;
    const invalidCitations = observation.citations.filter((citation) =>
      !citation.content_hash_valid || !selected.has(citation.event_id));
    const validCitationEvents = new Set(observation.citations.flatMap((citation) =>
      citation.content_hash_valid && selected.has(citation.event_id)
        ? [citation.event_id]
        : []));
    const validRequiredCitations = value.required_event_ids.filter((eventId) =>
      validCitationEvents.has(eventId)).length;
    const forbidden = (value.forbidden_claims ?? []).filter((claim) =>
      observation.claims.some((actual) => actual.includes(claim)));
    cases.push({
      case_id: value.id,
      category: value.category,
      selected_event_ids: observation.selected_event_ids,
      missing_event_ids: missing,
      evidence_recall: ratio(value.required_event_ids.length - missing.length, value.required_event_ids.length),
      member_closure_correct: expectedMembers
        ? sameSet(expectedMembers, observation.resolved_member_keys)
        : null,
      citation_count: value.required_event_ids.length + invalidCitations.length,
      valid_citation_count: validRequiredCitations,
      citation_validity: ratio(
        validRequiredCitations,
        value.required_event_ids.length + invalidCitations.length,
      ),
      action_correct: observation.action === value.expected_action,
      forbidden_claims: forbidden,
      stale_detection_correct: value.stale_detection_required
        ? observation.stale_detected
        : null,
    });
  }

  const memberCases = cases.filter((value) => value.member_closure_correct !== null);
  const staleCases = cases.filter((value) => value.stale_detection_correct !== null);
  const requiredEvidence = dataset.cases.reduce(
    (total, value) => total + value.required_event_ids.length,
    0,
  );
  const foundEvidence = cases.reduce(
    (total, value, index) =>
      total + dataset.cases[index].required_event_ids.length - value.missing_event_ids.length,
    0,
  );
  const citationCount = cases.reduce((total, value) => total + value.citation_count, 0);
  const validCitationCount = cases.reduce((total, value) => total + value.valid_citation_count, 0);
  const forbiddenClaims = cases.reduce((total, value) => total + value.forbidden_claims.length, 0);
  const metrics = {
    case_count: cases.length,
    evidence_recall: ratio(foundEvidence, requiredEvidence),
    evidence_complete_case_rate: ratio(
      cases.filter((value) => value.missing_event_ids.length === 0).length,
      cases.length,
    ),
    member_closure_accuracy: ratio(
      memberCases.filter((value) => value.member_closure_correct).length,
      memberCases.length,
    ),
    citation_validity: ratio(validCitationCount, citationCount),
    action_accuracy: ratio(cases.filter((value) => value.action_correct).length, cases.length),
    stale_detection_rate: ratio(
      staleCases.filter((value) => value.stale_detection_correct).length,
      staleCases.length,
    ),
    forbidden_claims: forbiddenClaims,
    passed: false,
  };
  const failedGates = [
    ...(metrics.case_count < thresholds.minimum_cases ? ["minimum_cases"] : []),
    ...(metrics.evidence_recall < thresholds.evidence_recall ? ["evidence_recall"] : []),
    ...(metrics.member_closure_accuracy < thresholds.member_closure_accuracy
      ? ["member_closure_accuracy"]
      : []),
    ...(metrics.citation_validity < thresholds.citation_validity ? ["citation_validity"] : []),
    ...(metrics.action_accuracy < thresholds.action_accuracy ? ["action_accuracy"] : []),
    ...(metrics.stale_detection_rate < thresholds.stale_detection_rate
      ? ["stale_detection_rate"]
      : []),
    ...(metrics.forbidden_claims > thresholds.maximum_forbidden_claims
      ? ["forbidden_claims"]
      : []),
  ];
  metrics.passed = failedGates.length === 0;
  const semantic = {
    schema_version: CUSTOMER_SERVICE_EVALUATION_SCHEMA_VERSION,
    dataset_id: dataset.id,
    thresholds: structuredClone(thresholds),
    cases,
    metrics,
    failed_gates: failedGates,
  };
  return {
    ...semantic,
    content_hash: hashCanonicalContext(semantic),
  };
}

export function assertCustomerServiceEvaluationGate(
  report: CustomerServiceEvaluationReport,
): void {
  if (!report.metrics.passed) {
    throw new Error(`Customer-service evaluation failed: ${report.failed_gates.join(", ")}`);
  }
}

function validateDataset(dataset: CustomerServiceEvaluationDataset): void {
  if (
    !dataset
    || dataset.schema_version !== CUSTOMER_SERVICE_EVALUATION_SCHEMA_VERSION
    || typeof dataset.id !== "string"
    || !dataset.id.trim()
    || !Array.isArray(dataset.cases)
    || dataset.cases.length === 0
    || new Set(dataset.cases.map((value) => value.id)).size !== dataset.cases.length
  ) {
    throw new Error("Invalid customer-service evaluation dataset");
  }
  for (const value of dataset.cases) {
    if (
      typeof value.id !== "string"
      || !value.id.trim()
      || typeof value.category !== "string"
      || !value.category.trim()
      || typeof value.question !== "string"
      || !value.question.trim()
      || !Array.isArray(value.required_event_ids)
      || value.required_event_ids.length === 0
      || !uniqueStrings(value.required_event_ids)
      || (value.expected_member_keys !== undefined && !uniqueStrings(value.expected_member_keys))
      || (value.forbidden_claims !== undefined && !uniqueStrings(value.forbidden_claims))
      || !["query_business", "clarify", "human", "retry", "redraft"].includes(value.expected_action)
    ) {
      throw new Error("Invalid customer-service evaluation case");
    }
  }
}

function validateObservation(value: CustomerServiceEvaluationObservation): void {
  if (
    !value
    || !uniqueStrings(value.selected_event_ids)
    || !uniqueStrings(value.resolved_member_keys)
    || !Array.isArray(value.citations)
    || value.citations.some((citation) =>
      typeof citation?.event_id !== "string"
      || !citation.event_id.trim()
      || typeof citation.content_hash_valid !== "boolean")
    || !["query_business", "clarify", "human", "retry", "redraft"].includes(value.action)
    || !uniqueStrings(value.claims)
    || typeof value.stale_detected !== "boolean"
  ) {
    throw new Error("Invalid customer-service evaluation observation");
  }
}

function validateThresholds(value: CustomerServiceEvaluationThresholds): void {
  const ratios = [
    value.evidence_recall,
    value.member_closure_accuracy,
    value.citation_validity,
    value.action_accuracy,
    value.stale_detection_rate,
  ];
  if (
    !Number.isSafeInteger(value.minimum_cases)
    || value.minimum_cases < 1
    || ratios.some((metric) => !Number.isFinite(metric) || metric < 0 || metric > 1)
    || !Number.isSafeInteger(value.maximum_forbidden_claims)
    || value.maximum_forbidden_claims < 0
  ) {
    throw new Error("Invalid customer-service evaluation thresholds");
  }
}

function uniqueStrings(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.every((item) => typeof item === "string" && item.trim())
    && new Set(value).size === value.length;
}

function sameSet(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : Number((numerator / denominator).toFixed(12));
}
