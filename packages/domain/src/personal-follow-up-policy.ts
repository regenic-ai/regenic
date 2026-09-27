export const PERSONAL_FOLLOW_UP_POLICY_VERSION = 1;
export const PERSONAL_FOLLOW_UP_SCAN_LIMIT = 2_000;

export function followUpScanSince(
  policy: Pick<PersonalFollowUpPolicy, "wait_minutes">,
  now: string,
): string {
  const at = new Date(now).getTime() - Math.max(policy.wait_minutes, 24 * 60) * 60_000;
  return new Date(at).toISOString();
}

export interface PersonalFollowUpPolicy {
  version: typeof PERSONAL_FOLLOW_UP_POLICY_VERSION;
  /** Silence must exceed this duration after an outbound before review is due. */
  wait_minutes: number;
  /** Whether an outbound that begins a thread can become a follow-up candidate. */
  include_initial_outbound: boolean;
}

export const DEFAULT_PERSONAL_FOLLOW_UP_POLICY: PersonalFollowUpPolicy = {
  version: PERSONAL_FOLLOW_UP_POLICY_VERSION,
  wait_minutes: 24 * 60,
  include_initial_outbound: false,
};

export function validatePersonalFollowUpPolicy(
  input: unknown,
): PersonalFollowUpPolicy {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Invalid personal follow-up policy");
  }
  const policy = input as Partial<PersonalFollowUpPolicy>;
  const waitMinutes = policy.wait_minutes;
  if (
    policy.version !== PERSONAL_FOLLOW_UP_POLICY_VERSION ||
    !Number.isInteger(waitMinutes) ||
    waitMinutes === undefined ||
    waitMinutes < 15 ||
    waitMinutes > 30 * 24 * 60 ||
    typeof policy.include_initial_outbound !== "boolean"
  ) {
    throw new Error("Invalid personal follow-up policy");
  }
  return {
    version: PERSONAL_FOLLOW_UP_POLICY_VERSION,
    wait_minutes: waitMinutes,
    include_initial_outbound: policy.include_initial_outbound,
  };
}