import { validateStandard, validateStandardVersion, type StandardRecord, type StandardVersionRecord } from "./standard";
import { validateStandardUsage, type StandardUsageRecord } from "./standard-usage";

export const STANDARD_HEALTH_DETECTOR_VERSION = "usage-health-v1" as const;

export interface StandardHealthObservation {
  standard: StandardRecord;
  current_version: StandardVersionRecord;
  total_usage_count: number;
  current_version_usage_count: number;
  latest_usage?: StandardUsageRecord;
}

export interface StandardHealthCandidate {
  detector_version: typeof STANDARD_HEALTH_DETECTOR_VERSION;
  standard_id: string;
  version_id: string;
  reason: "never_cited" | "stale_usage";
  citation_count: number;
  standard_citation_count: number;
  last_cited_at?: string;
  stale_after_days: number;
  observed_at: string;
  recommendation: "review_deprecate_or_merge";
}

export function detectStandardHealth(
  inputs: StandardHealthObservation[],
  options: { observed_at: string; stale_after_days: number },
): StandardHealthCandidate[] {
  if (!Array.isArray(inputs) || !validOffsetTimestamp(options?.observed_at)
    || !Number.isSafeInteger(options?.stale_after_days) || options.stale_after_days < 1) {
    throw new Error("Invalid Standard health detection input");
  }
  const observedAt = Date.parse(options.observed_at);
  const staleMs = options.stale_after_days * 24 * 60 * 60 * 1_000;
  const candidates: StandardHealthCandidate[] = [];
  const seen = new Set<string>();
  for (const input of inputs) {
    const standard = validateStandard(input.standard);
    const version = validateStandardVersion(input.current_version);
    if (seen.has(standard.id)) throw new Error("Duplicate Standard health observation");
    seen.add(standard.id);
    if (standard.org_id !== version.org_id || standard.id !== version.standard_id
      || standard.current_version_id !== version.id) {
      throw new Error("Invalid Standard health observation");
    }
    if (!Number.isSafeInteger(input.total_usage_count) || input.total_usage_count < 0
      || !Number.isSafeInteger(input.current_version_usage_count) || input.current_version_usage_count < 0
      || input.current_version_usage_count > input.total_usage_count
      || standard.citation_count !== input.total_usage_count) {
      throw new Error("Standard citation count does not match usage ledger");
    }
    if (version.status !== "active") continue;
    const publishedAt = Date.parse(version.published_at!);
    if (publishedAt > observedAt) throw new Error("Standard health observation predates publication");
    const latestUsage = input.latest_usage ? validateStandardUsage(input.latest_usage) : undefined;
    if (latestUsage && (latestUsage.org_id !== standard.org_id
      || latestUsage.standard_id !== standard.id
      || latestUsage.version_id !== version.id
      || Date.parse(latestUsage.cited_at) > observedAt)) {
      throw new Error("Invalid Standard health usage");
    }
    if (input.current_version_usage_count === 0) {
      if (latestUsage) throw new Error("Standard citation count does not match usage ledger");
      if (observedAt - publishedAt < staleMs) continue;
      candidates.push(candidate(
        standard, version, input.current_version_usage_count, options, "never_cited",
      ));
      continue;
    }
    if (!latestUsage) throw new Error("Standard citation count does not match usage ledger");
    if (observedAt - Date.parse(latestUsage.cited_at) < staleMs) continue;
    candidates.push(candidate(
      standard, version, input.current_version_usage_count, options, "stale_usage", latestUsage.cited_at,
    ));
  }
  return candidates.sort((left, right) => left.standard_id.localeCompare(right.standard_id));
}

function candidate(
  standard: StandardRecord,
  version: StandardVersionRecord,
  currentVersionUsageCount: number,
  options: { observed_at: string; stale_after_days: number },
  reason: StandardHealthCandidate["reason"],
  lastCitedAt?: string,
): StandardHealthCandidate {
  return {
    detector_version: STANDARD_HEALTH_DETECTOR_VERSION,
    standard_id: standard.id,
    version_id: version.id,
    reason,
    citation_count: currentVersionUsageCount,
    standard_citation_count: standard.citation_count,
    ...(lastCitedAt ? { last_cited_at: lastCitedAt } : {}),
    stale_after_days: options.stale_after_days,
    observed_at: options.observed_at,
    recommendation: "review_deprecate_or_merge",
  };
}

function validOffsetTimestamp(value: unknown): value is string {
  return typeof value === "string"
    && /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && !Number.isNaN(Date.parse(value));
}
