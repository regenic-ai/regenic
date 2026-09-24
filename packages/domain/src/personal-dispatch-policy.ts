import type { MessageDisposition } from "./arrangement";

export const PERSONAL_DISPATCH_POLICY_VERSION = 1 as const;

export interface PersonalDispatchPolicy {
  version: typeof PERSONAL_DISPATCH_POLICY_VERSION;
  high_hint_disposition: MessageDisposition;
  actionable_disposition: MessageDisposition;
  short_text_disposition: MessageDisposition;
  default_disposition: MessageDisposition;
}

export const DEFAULT_PERSONAL_DISPATCH_POLICY: PersonalDispatchPolicy = {
  version: PERSONAL_DISPATCH_POLICY_VERSION,
  high_hint_disposition: "current_work",
  actionable_disposition: "current_work",
  short_text_disposition: "pending",
  default_disposition: "current_work",
};

const DISPOSITIONS: readonly MessageDisposition[] = [
  "current_work",
  "outside_current_work",
  "pending",
];

export function validatePersonalDispatchPolicy(
  policy: PersonalDispatchPolicy,
): PersonalDispatchPolicy {
  if (!policy || policy.version !== PERSONAL_DISPATCH_POLICY_VERSION
    || !DISPOSITIONS.includes(policy.high_hint_disposition)
    || !DISPOSITIONS.includes(policy.actionable_disposition)
    || !DISPOSITIONS.includes(policy.short_text_disposition)
    || !DISPOSITIONS.includes(policy.default_disposition)) {
    throw new Error("Invalid personal dispatch policy");
  }
  return { ...policy };
}
