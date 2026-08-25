import {
  recordClassFromType,
  type RecordClass,
} from "./record-class";

export const THREAD_FACETS = ["chat", "agent", "ticket"] as const;

export type ThreadFacet = (typeof THREAD_FACETS)[number];

export function isThreadFacet(value: unknown): value is ThreadFacet {
  return value === "chat" || value === "agent" || value === "ticket";
}

export function projectThreadFacet(input: {
  record_class?: RecordClass;
  type?: string;
  await_reply?: boolean;
  prompts?: boolean;
  hint?: ThreadFacet;
}): ThreadFacet {
  const recordClass = input.record_class ?? recordClassFromType(input.type);
  if (recordClass === "task") {
    return "ticket";
  }
  if (input.hint) {
    return input.hint;
  }
  if (input.prompts) {
    return "agent";
  }
  return "chat";
}

export function mergeThreadFacet(
  current: ThreadFacet | undefined,
  next: ThreadFacet,
): ThreadFacet {
  if (current === "ticket" || next === "ticket") {
    return "ticket";
  }
  if (current === "agent" || next === "agent") {
    return "agent";
  }
  return "chat";
}
