import { canonicalContextJson } from "./context-canonical";
import { validateAgentRun, type AgentRunRecord } from "./agent-run";

export const STANDARD_DRIFT_DETECTOR_VERSION = "acceptance-failure-v1" as const;

export interface StandardDriftCandidate {
  detector_version: typeof STANDARD_DRIFT_DETECTOR_VERSION;
  standard_id: string;
  version_id: string;
  run_ids: string[];
  context_snapshot_id: string;
  detected_at: string;
}

export function detectStandardDrift(
  inputs: AgentRunRecord[],
  minimumFailures = 2,
): StandardDriftCandidate[] {
  if (!Array.isArray(inputs) || !Number.isSafeInteger(minimumFailures) || minimumFailures < 2) {
    throw new Error("Invalid Standard drift detection input");
  }
  const groups = new Map<string, {
    standard_id: string;
    version_id: string;
    runs: AgentRunRecord[];
  }>();
  for (const input of inputs) {
    const run = validateAgentRun(input);
    if (run.status !== "failed" || run.output?.acceptance_check !== "fail" || !run.finished_at) continue;
    for (const binding of run.standard_bindings) {
      const key = canonicalContextJson([binding.standard_id, binding.version_id]);
      const group = groups.get(key) ?? {
        standard_id: binding.standard_id,
        version_id: binding.version_id,
        runs: [],
      };
      group.runs.push(run);
      groups.set(key, group);
    }
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      runs: group.runs.sort((left, right) =>
        Date.parse(left.finished_at!) - Date.parse(right.finished_at!)
        || left.id.localeCompare(right.id)
      ),
    }))
    .filter(({ runs }) => runs.length >= minimumFailures)
    .map(({ standard_id, version_id, runs }) => {
      const thresholdRuns = runs.slice(0, minimumFailures);
      const latest = thresholdRuns[thresholdRuns.length - 1];
      return {
        detector_version: STANDARD_DRIFT_DETECTOR_VERSION,
        standard_id,
        version_id,
        run_ids: thresholdRuns.map(({ id }) => id),
        context_snapshot_id: latest.context_snapshot_id,
        detected_at: latest.finished_at!,
      };
    })
    .sort((left, right) =>
      left.standard_id.localeCompare(right.standard_id)
      || left.version_id.localeCompare(right.version_id)
    );
}
