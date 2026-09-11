export const DAILY_DIGEST_POLICY_VERSION = 1 as const;

export const DAILY_DIGEST_DIRECTIONS = [
  "product",
  "sales",
  "customer",
  "org",
  "finance",
  "risk",
] as const;

export type DailyDigestDirection = (typeof DAILY_DIGEST_DIRECTIONS)[number];

export type DailyDigestEvidenceClass =
  | "metric"
  | "demo"
  | "user_verbatim"
  | "decision_record"
  | "opinion";

export interface DailyDigestPolicy {
  version: typeof DAILY_DIGEST_POLICY_VERSION;
  enabled_directions: DailyDigestDirection[];
  max_items_per_direction: number;
  bad_news_terms: string[];
  hypothesis_min_score: number;
  role_tier_threshold: number;
  evidence_weights: Record<DailyDigestEvidenceClass, number>;
}

export const DEFAULT_DAILY_DIGEST_POLICY: DailyDigestPolicy = {
  version: DAILY_DIGEST_POLICY_VERSION,
  enabled_directions: [...DAILY_DIGEST_DIRECTIONS],
  max_items_per_direction: 7,
  bad_news_terms: ["outage", "incident", "breach", "rollback", "blocked"],
  hypothesis_min_score: 1.5,
  role_tier_threshold: 3.5,
  evidence_weights: {
    metric: 4,
    demo: 3,
    user_verbatim: 2.5,
    decision_record: 2.5,
    opinion: 1,
  },
};

export interface DailyDigestPolicyStore {
  getDailyDigestPolicy(orgId: string): Promise<DailyDigestPolicy | null>;
  putDailyDigestPolicy(input: {
    org_id: string;
    policy: DailyDigestPolicy;
    updated_at: string;
  }): Promise<DailyDigestPolicy>;
}

export function validateDailyDigestPolicy(policy: DailyDigestPolicy): DailyDigestPolicy {
  if (!policy || policy.version !== DAILY_DIGEST_POLICY_VERSION) {
    throw new Error("Unsupported daily digest policy version");
  }
  const enabledDirections = [...new Set(policy.enabled_directions)].sort();
  if (!enabledDirections.length || enabledDirections.some((direction) =>
    !(DAILY_DIGEST_DIRECTIONS as readonly string[]).includes(direction),
  )) {
    throw new Error("Invalid daily digest policy directions");
  }
  const maxItems = policy.max_items_per_direction;
  if (!Number.isSafeInteger(maxItems) || maxItems < 1 || maxItems > 50) {
    throw new Error("Invalid daily digest policy item limit");
  }
  const terms = [...new Set(policy.bad_news_terms.map((term) => term.trim().toLowerCase()))]
    .filter(Boolean)
    .sort();
  if (terms.some((term) => term.length > 80)) {
    throw new Error("Invalid daily digest policy bad-news term");
  }
  if (!Number.isFinite(policy.hypothesis_min_score) || policy.hypothesis_min_score < 0
    || !Number.isFinite(policy.role_tier_threshold) || policy.role_tier_threshold < 0) {
    throw new Error("Invalid daily digest policy threshold");
  }
  const evidenceWeights = policy.evidence_weights;
  const evidenceClasses: DailyDigestEvidenceClass[] = [
    "metric", "demo", "user_verbatim", "decision_record", "opinion",
  ];
  if (evidenceClasses.some((kind) => !Number.isFinite(evidenceWeights?.[kind]) || evidenceWeights[kind] < 0)) {
    throw new Error("Invalid daily digest policy evidence weight");
  }
  return {
    version: DAILY_DIGEST_POLICY_VERSION,
    enabled_directions: enabledDirections as DailyDigestDirection[],
    max_items_per_direction: maxItems,
    bad_news_terms: terms,
    hypothesis_min_score: policy.hypothesis_min_score,
    role_tier_threshold: policy.role_tier_threshold,
    evidence_weights: { ...evidenceWeights },
  };
}
