import type { ActorRef } from "./actor";

export const CUSTOMER_SERVICE_TASK_SCHEMA_VERSION = "1.0" as const;

export const CUSTOMER_SERVICE_TASK_STATUSES = [
  "resolving_context",
  "ready_for_query",
  "querying",
  "verifying",
  "awaiting_review",
  "approved",
  "sending",
  "sent",
  "needs_clarification",
  "needs_human",
  "failed",
] as const;

export type CustomerServiceTaskStatus =
  (typeof CUSTOMER_SERVICE_TASK_STATUSES)[number];

export type CustomerResolutionStatus =
  | "unresolved"
  | "candidate"
  | "verified"
  | "conflicting";

export interface CustomerResolvedValue {
  status: CustomerResolutionStatus;
  value?: string;
  evidence: string[];
  candidates?: Array<{ value: string; evidence: string[] }>;
}

export interface CustomerTaskSource {
  event_id: string;
  content_hash: string;
  thread_id: string;
  source: string;
  external_id: string;
  received_at: string;
  reply_to_event_id?: string;
}

export interface CustomerTaskMember {
  member_key: string;
  display_name: string;
  business_id?: string;
  status: CustomerResolutionStatus;
  evidence: string[];
  identity_evidence?: string;
}

export interface CustomerTaskBrief {
  version: number;
  question: string;
  source: CustomerTaskSource;
  customer: CustomerResolvedValue;
  project: CustomerResolvedValue;
  batch: CustomerResolvedValue;
  intent: CustomerResolvedValue;
  query_at: string;
  expected_member_count?: number;
  expected_count_evidence?: string;
  members_closed: boolean;
  members: CustomerTaskMember[];
  requested_fields: string[];
  unresolved: string[];
  context_snapshot_ids: string[];
}

export type CustomerContextSelectionReason =
  | "source"
  | "hit"
  | "reply_target"
  | "neighbor"
  | "continuation";

export interface CustomerContextEvidence {
  citation_id: string;
  snapshot_id: string;
  event_id: string;
  content_hash: string;
  source: string;
  thread_id: string;
  actor_id?: string;
  native_thread_id?: string;
  reply_to_event_id?: string;
  occurred_at: string;
  text: string;
  selection_reason: CustomerContextSelectionReason;
}

export interface CustomerContextContinuation {
  handle: string;
  thread_id: string;
  direction: "before" | "after";
  boundary_occurred_at: string;
  boundary_event_id: string;
  read_epoch: string;
  expires_at: string;
}

export type BusinessResultStatus =
  | "found"
  | "not_found"
  | "ambiguous"
  | "permission_denied"
  | "unavailable";

export interface BusinessFieldValue {
  field: string;
  value: string | number | boolean | null;
  visibility: "customer" | "internal" | "restricted";
  authority: string;
  updated_at: string;
}

export interface BusinessEntityResult {
  member_key: string;
  business_id: string;
  status: BusinessResultStatus;
  record_id?: string;
  record_version?: string;
  fields: BusinessFieldValue[];
  reason_code?: string;
}

export interface BusinessEvidence {
  citation_id: string;
  query_id: string;
  task_id: string;
  brief_version: number;
  provider_id: string;
  customer_id: string;
  project_id: string;
  batch_id: string;
  requested_fields: string[];
  queried_at: string;
  complete: boolean;
  next_page?: string;
  results: BusinessEntityResult[];
}

export interface CustomerReplyClaim {
  claim_id: string;
  text: string;
  member_keys: string[];
  fields: string[];
  evidence: string[];
}

export interface CustomerReplyDraft {
  version: number;
  text: string;
  claims: CustomerReplyClaim[];
  covered_member_keys: string[];
  unresolved: string[];
  brief_version: number;
  business_query_ids: string[];
  created_at: string;
  review?: {
    result: "approved" | "rejected";
    reviewer: ActorRef;
    reviewed_at: string;
    note?: string;
  };
  sent?: {
    client_request_id: string;
    event_id: string;
    sent_at: string;
  };
}

export interface CustomerServiceTask {
  schema_version: typeof CUSTOMER_SERVICE_TASK_SCHEMA_VERSION;
  id: string;
  org_id: string;
  status: CustomerServiceTaskStatus;
  revision: number;
  brief: CustomerTaskBrief;
  context_evidence: CustomerContextEvidence[];
  continuations: CustomerContextContinuation[];
  business_evidence: BusinessEvidence[];
  draft?: CustomerReplyDraft;
  failure_code?: string;
  created_at: string;
  updated_at: string;
}

export interface CustomerServiceTaskStore {
  putCustomerServiceTask(
    task: CustomerServiceTask,
    expectedRevision?: number,
  ): Promise<CustomerServiceTask>;
  getCustomerServiceTask(
    orgId: string,
    taskId: string,
  ): Promise<CustomerServiceTask | null>;
  listCustomerServiceTasks(input: {
    org_id: string;
    statuses?: CustomerServiceTaskStatus[];
    limit?: number;
  }): Promise<CustomerServiceTask[]>;
}

export class CustomerServiceTaskConflictError extends Error {
  constructor(message = "Customer service task changed; reload and retry") {
    super(message);
    this.name = "CustomerServiceTaskConflictError";
  }
}

export function validateCustomerServiceTask(
  task: CustomerServiceTask,
): CustomerServiceTask {
  if (
    !task
    || task.schema_version !== CUSTOMER_SERVICE_TASK_SCHEMA_VERSION
    || !nonBlank(task.id)
    || !nonBlank(task.org_id)
    || !CUSTOMER_SERVICE_TASK_STATUSES.includes(task.status)
    || !Number.isInteger(task.revision)
    || task.revision < 1
    || !validTimestamp(task.created_at)
    || !validTimestamp(task.updated_at)
    || !validBrief(task.brief)
    || !Array.isArray(task.context_evidence)
    || task.context_evidence.some((item) => !validContextEvidence(item))
    || duplicate(task.context_evidence.map((item) => item.citation_id))
    || !Array.isArray(task.continuations)
    || task.continuations.some((item) => !validContinuation(item))
    || duplicate(task.continuations.map((item) => item.handle))
    || !Array.isArray(task.business_evidence)
    || task.business_evidence.some((item) => !validBusinessEvidence(item))
    || duplicate(task.business_evidence.map((item) => item.query_id))
    || (task.draft !== undefined && !validDraft(task.draft))
  ) {
    throw new Error("Invalid CustomerServiceTask");
  }
  if (task.brief.source.received_at > task.updated_at || task.created_at > task.updated_at) {
    throw new Error("Invalid CustomerServiceTask timestamps");
  }
  return structuredClone(task);
}

export function validateBusinessEvidence(
  evidence: BusinessEvidence,
): BusinessEvidence {
  if (!validBusinessEvidence(evidence)) {
    throw new Error("Invalid BusinessEvidence");
  }
  return structuredClone(evidence);
}

function validBrief(value: CustomerTaskBrief): boolean {
  return Number.isInteger(value?.version)
    && value.version >= 1
    && nonBlank(value.question)
    && validSource(value.source)
    && validResolved(value.customer)
    && validResolved(value.project)
    && validResolved(value.batch)
    && validResolved(value.intent)
    && validTimestamp(value.query_at)
    && (value.expected_member_count === undefined
      || (Number.isInteger(value.expected_member_count) && value.expected_member_count >= 0))
    && typeof value.members_closed === "boolean"
    && Array.isArray(value.members)
    && value.members.every(validMember)
    && !duplicate(value.members.map((member) => member.member_key))
    && stringArray(value.requested_fields)
    && !duplicate(value.requested_fields)
    && stringArray(value.unresolved)
    && stringArray(value.context_snapshot_ids);
}

function validSource(value: CustomerTaskSource): boolean {
  return nonBlank(value?.event_id)
    && /^[a-f0-9]{64}$/.test(value.content_hash)
    && nonBlank(value.thread_id)
    && nonBlank(value.source)
    && nonBlank(value.external_id)
    && validTimestamp(value.received_at)
    && (value.reply_to_event_id === undefined || nonBlank(value.reply_to_event_id));
}

function validResolved(value: CustomerResolvedValue): boolean {
  return !!value
    && ["unresolved", "candidate", "verified", "conflicting"].includes(value.status)
    && stringArray(value.evidence)
    && (value.value === undefined || nonBlank(value.value))
    && (value.status !== "verified" || (nonBlank(value.value) && value.evidence.length > 0))
    && (value.candidates === undefined || (
      Array.isArray(value.candidates)
      && value.candidates.every((item) => nonBlank(item.value) && stringArray(item.evidence))
    ));
}

function validMember(value: CustomerTaskMember): boolean {
  return nonBlank(value?.member_key)
    && nonBlank(value.display_name)
    && ["unresolved", "candidate", "verified", "conflicting"].includes(value.status)
    && (value.business_id === undefined || nonBlank(value.business_id))
    && (value.status !== "verified" || (
      nonBlank(value.business_id)
      && value.evidence.length > 0
      && nonBlank(value.identity_evidence)
    ))
    && stringArray(value.evidence)
    && (value.identity_evidence === undefined || nonBlank(value.identity_evidence));
}

function validContextEvidence(value: CustomerContextEvidence): boolean {
  return nonBlank(value?.citation_id)
    && nonBlank(value.snapshot_id)
    && nonBlank(value.event_id)
    && /^[a-f0-9]{64}$/.test(value.content_hash)
    && nonBlank(value.source)
    && nonBlank(value.thread_id)
    && validTimestamp(value.occurred_at)
    && typeof value.text === "string"
    && value.text.length > 0
    && (value.native_thread_id === undefined || nonBlank(value.native_thread_id))
    && (value.reply_to_event_id === undefined || nonBlank(value.reply_to_event_id))
    && ["source", "hit", "reply_target", "neighbor", "continuation"].includes(value.selection_reason);
}

function validContinuation(value: CustomerContextContinuation): boolean {
  return nonBlank(value?.handle)
    && nonBlank(value.thread_id)
    && ["before", "after"].includes(value.direction)
    && validTimestamp(value.boundary_occurred_at)
    && nonBlank(value.boundary_event_id)
    && nonBlank(value.read_epoch)
    && validTimestamp(value.expires_at);
}

function validBusinessEvidence(value: BusinessEvidence): boolean {
  return nonBlank(value?.citation_id)
    && nonBlank(value.query_id)
    && nonBlank(value.task_id)
    && Number.isInteger(value.brief_version)
    && value.brief_version >= 1
    && nonBlank(value.provider_id)
    && nonBlank(value.customer_id)
    && nonBlank(value.project_id)
    && nonBlank(value.batch_id)
    && stringArray(value.requested_fields)
    && validTimestamp(value.queried_at)
    && typeof value.complete === "boolean"
    && (value.next_page === undefined || nonBlank(value.next_page))
    && Array.isArray(value.results)
    && !duplicate(value.results.map((item) => item.member_key))
    && value.results.every((item) =>
      nonBlank(item.member_key)
      && nonBlank(item.business_id)
      && ["found", "not_found", "ambiguous", "permission_denied", "unavailable"].includes(item.status)
      && Array.isArray(item.fields)
      && !duplicate(item.fields.map((field) => field.field))
      && item.fields.every((field) =>
        nonBlank(field.field)
        && (["string", "number", "boolean"].includes(typeof field.value)
          || field.value === null)
      )
      && item.fields.every((field) =>
        ["customer", "internal", "restricted"].includes(field.visibility)
        && nonBlank(field.authority)
        && validTimestamp(field.updated_at)
      )
    );
}

function validDraft(value: CustomerReplyDraft): boolean {
  return Number.isInteger(value?.version)
    && value.version >= 1
    && nonBlank(value.text)
    && Array.isArray(value.claims)
    && value.claims.every((claim) =>
      nonBlank(claim.claim_id)
      && nonBlank(claim.text)
      && stringArray(claim.member_keys)
      && stringArray(claim.fields)
      && stringArray(claim.evidence)
      && claim.evidence.length > 0
    )
    && !duplicate(value.claims.map((claim) => claim.claim_id))
    && stringArray(value.covered_member_keys)
    && stringArray(value.unresolved)
    && Number.isInteger(value.brief_version)
    && value.brief_version >= 1
    && stringArray(value.business_query_ids)
    && validTimestamp(value.created_at)
    && (value.review === undefined || (
      ["approved", "rejected"].includes(value.review.result)
      && nonBlank(value.review.reviewer?.actor_id)
      && ["human", "agent", "system"].includes(value.review.reviewer.actor_type)
      && validTimestamp(value.review.reviewed_at)
    ))
    && (value.sent === undefined || (
      nonBlank(value.sent.client_request_id)
      && nonBlank(value.sent.event_id)
      && validTimestamp(value.sent.sent_at)
    ));
}

function nonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validTimestamp(value: unknown): value is string {
  return nonBlank(value) && !Number.isNaN(Date.parse(value));
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(nonBlank);
}

function duplicate(values: string[]): boolean {
  return new Set(values).size !== values.length;
}
