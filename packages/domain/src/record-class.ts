export const RECORD_CLASSES = [
  "utterance",
  "task",
  "status",
  "prompt",
] as const;

export type RecordClass = (typeof RECORD_CLASSES)[number];

const TYPE_TO_CLASS: Record<string, RecordClass> = {
  message: "utterance",
  thread_reply: "utterance",
  task: "task",
  thread_status: "status",
  prompt: "prompt",
};

export function isRecordClass(value: unknown): value is RecordClass {
  return (
    value === "utterance" ||
    value === "task" ||
    value === "status" ||
    value === "prompt"
  );
}

export function recordClassFromType(type: string | undefined): RecordClass | undefined {
  if (!type) {
    return "utterance";
  }
  return TYPE_TO_CLASS[type];
}
