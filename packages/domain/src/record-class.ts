export const RECORD_CLASSES = [
  "utterance",
  "task",
  "status",
  "prompt",
] as const;

export type RecordClass = (typeof RECORD_CLASSES)[number];

export const INGEST_RECORD_TYPES = [
  "message",
  "thread_reply",
  "task",
  "thread_status",
  "prompt",
] as const;

export type IngestRecordType = (typeof INGEST_RECORD_TYPES)[number];

const TYPE_TO_CLASS: Record<IngestRecordType, RecordClass> = {
  message: "utterance",
  thread_reply: "utterance",
  task: "task",
  thread_status: "status",
  prompt: "prompt",
};

export function isIngestRecordType(value: unknown): value is IngestRecordType {
  return (
    value === "message" ||
    value === "thread_reply" ||
    value === "task" ||
    value === "thread_status" ||
    value === "prompt"
  );
}

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
  return isIngestRecordType(type) ? TYPE_TO_CLASS[type] : undefined;
}
