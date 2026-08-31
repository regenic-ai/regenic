import { z } from "zod";
import {
  CONTEXT_ARTIFACT_KINDS,
  CONTEXT_ARTIFACT_STATUSES,
  type ContextArtifact,
} from "./context-artifact";
import {
  CONTEXT_BUNDLE_SCHEMA_VERSION,
  type ContextBundle,
  type ContextBundleItem,
} from "./context-bundle";
import {
  CONTEXT_SECTION_KINDS,
  type ContextBudget,
  type ContextBudgetLedger,
} from "./context-budget";
import {
  CONTEXT_CANDIDATE_KINDS,
  type ContextCandidate,
} from "./context-candidate";
import {
  hashContextArtifactInputs,
  hashContextBundle,
  hashContextSnapshot,
} from "./context-canonical";
import type { EvidenceReference } from "./context-consumer";
import type {
  ContextArtifactQuery,
  ContextProjectionCheckpoint,
  ContextReplayRequest,
} from "./context-port";
import {
  CONTEXT_ALLOWED_USES,
  CONTEXT_ANCHOR_KINDS,
  CONTEXT_REQUEST_SCHEMA_VERSION,
  type ContextRequest,
} from "./context-request";
import {
  CONTEXT_SNAPSHOT_SCHEMA_VERSION,
  type ContextSnapshot,
} from "./context-snapshot";
import { JsonValueSchema } from "./ingestion-schema";

const nonEmptyStringSchema = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0, "String cannot be blank");
const timestampSchema = z.string().datetime({ offset: true });
const contentHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const nonNegativeIntegerSchema = z.number().int().min(0);
const positiveIntegerSchema = z.number().int().positive();
const querySchema = z
  .string()
  .max(8_000)
  .refine((value) => value.trim().length > 0, "Query cannot be blank");

const uniqueNonEmptyStringsSchema = z
  .array(nonEmptyStringSchema)
  .min(1)
  .max(1_000)
  .refine((values) => !hasDuplicates(values), "Values must be unique");

function hasDuplicates(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

const ActorRefSchema = z
  .object({
    actor_type: z.enum(["human", "agent", "system"]),
    actor_id: nonEmptyStringSchema,
  })
  .strict();

const EvidenceReferenceSchema: z.ZodType<EvidenceReference> = z
  .object({
    event_id: nonEmptyStringSchema,
    source: nonEmptyStringSchema,
    external_id: nonEmptyStringSchema,
    operation: z.enum(["create", "revise", "tombstone"]),
    occurred_at: timestampSchema,
    content_hash: contentHashSchema.optional(),
  })
  .strict();

const sectionTokensSchema = z
  .object({
    policy: nonNegativeIntegerSchema.optional(),
    memory: nonNegativeIntegerSchema.optional(),
    working: nonNegativeIntegerSchema.optional(),
    facts: nonNegativeIntegerSchema.optional(),
    summaries: nonNegativeIntegerSchema.optional(),
    evidence: nonNegativeIntegerSchema.optional(),
  })
  .strict();

export const ContextBudgetSchema: z.ZodType<ContextBudget> = z
  .object({
    profile: nonEmptyStringSchema,
    max_tokens: positiveIntegerSchema.max(1_000_000),
    max_items: positiveIntegerSchema.max(10_000),
    max_raw_evidence: nonNegativeIntegerSchema.max(10_000),
    max_age_days: positiveIntegerSchema.max(36_500).optional(),
    section_tokens: sectionTokensSchema.optional(),
  })
  .strict()
  .superRefine((budget, context) => {
    const partitioned = Object.values(budget.section_tokens ?? {}).reduce(
      (sum, value) => sum + (value ?? 0),
      0,
    );
    if (partitioned > budget.max_tokens) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["section_tokens"],
        message: "Section token limits cannot exceed max_tokens",
      });
    }
  });

const ContextBudgetSectionLedgerSchema = z
  .object({
    kind: z.enum(CONTEXT_SECTION_KINDS),
    requested_tokens: nonNegativeIntegerSchema,
    selected_tokens: nonNegativeIntegerSchema,
    reserved_tokens: nonNegativeIntegerSchema,
    selected_items: nonNegativeIntegerSchema,
    truncated_items: nonNegativeIntegerSchema,
  })
  .strict()
  .superRefine((section, context) => {
    if (section.selected_tokens + section.reserved_tokens > section.requested_tokens) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Selected and reserved tokens cannot exceed requested tokens",
      });
    }
  });

export const ContextBudgetLedgerSchema: z.ZodType<ContextBudgetLedger> = z
  .object({
    profile: nonEmptyStringSchema,
    max_tokens: positiveIntegerSchema,
    max_items: positiveIntegerSchema,
    max_raw_evidence: nonNegativeIntegerSchema,
    requested_tokens: nonNegativeIntegerSchema,
    selected_tokens: nonNegativeIntegerSchema,
    reserved_tokens: nonNegativeIntegerSchema,
    selected_items: nonNegativeIntegerSchema,
    truncated_items: nonNegativeIntegerSchema,
    sections: z.array(ContextBudgetSectionLedgerSchema).max(CONTEXT_SECTION_KINDS.length),
  })
  .strict()
  .superRefine((ledger, context) => {
    if (hasDuplicates(ledger.sections.map((section) => section.kind))) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["sections"], message: "Section kinds must be unique" });
    }
    if (ledger.selected_tokens + ledger.reserved_tokens > ledger.max_tokens) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Ledger exceeds max_tokens" });
    }
    if (ledger.selected_tokens + ledger.reserved_tokens > ledger.requested_tokens) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Ledger allocation exceeds requested_tokens" });
    }
    if (ledger.selected_items > ledger.max_items) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["selected_items"], message: "Ledger exceeds max_items" });
    }
    const selectedTokens = ledger.sections.reduce((sum, section) => sum + section.selected_tokens, 0);
    const requestedTokens = ledger.sections.reduce((sum, section) => sum + section.requested_tokens, 0);
    const reservedTokens = ledger.sections.reduce((sum, section) => sum + section.reserved_tokens, 0);
    const selectedItems = ledger.sections.reduce((sum, section) => sum + section.selected_items, 0);
    const truncatedItems = ledger.sections.reduce((sum, section) => sum + section.truncated_items, 0);
    if (selectedTokens !== ledger.selected_tokens) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["selected_tokens"], message: "Selected token total does not match sections" });
    }
    if (requestedTokens !== ledger.requested_tokens) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["requested_tokens"], message: "Requested token total does not match sections" });
    }
    if (reservedTokens !== ledger.reserved_tokens) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["reserved_tokens"], message: "Reserved token total does not match sections" });
    }
    if (selectedItems !== ledger.selected_items) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["selected_items"], message: "Selected item total does not match sections" });
    }
    if (truncatedItems !== ledger.truncated_items) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["truncated_items"], message: "Truncated item total does not match sections" });
    }
  });

export const ContextRequestSchema: z.ZodType<ContextRequest> = z
  .object({
    schema_version: z.literal(CONTEXT_REQUEST_SCHEMA_VERSION),
    id: nonEmptyStringSchema,
    org_id: nonEmptyStringSchema,
    principal: ActorRefSchema,
    consumer_id: nonEmptyStringSchema,
    purpose: nonEmptyStringSchema,
    allowed_uses: z.array(z.enum(CONTEXT_ALLOWED_USES)).min(1).max(CONTEXT_ALLOWED_USES.length),
    query: querySchema.optional(),
    anchors: z
      .array(z.object({ kind: z.enum(CONTEXT_ANCHOR_KINDS), id: nonEmptyStringSchema }).strict())
      .max(100)
      .optional(),
    filters: z
      .object({
        sources: uniqueNonEmptyStringsSchema.optional(),
        thread_ids: uniqueNonEmptyStringsSchema.optional(),
        actor_ids: uniqueNonEmptyStringsSchema.optional(),
        occurred_after: timestampSchema.optional(),
        occurred_before: timestampSchema.optional(),
      })
      .strict()
      .superRefine((filters, context) => {
        if (Object.values(filters).every((value) => value === undefined)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: "At least one context filter is required",
          });
        }
        if (
          filters.occurred_after &&
          filters.occurred_before &&
          Date.parse(filters.occurred_after) > Date.parse(filters.occurred_before)
        ) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["occurred_before"],
            message: "occurred_before cannot precede occurred_after",
          });
        }
      })
      .optional(),
    temporal: z.discriminatedUnion("mode", [
      z.object({ mode: z.literal("current") }).strict(),
      z.object({ mode: z.literal("history"), valid_at: timestampSchema.optional() }).strict(),
      z.object({ mode: z.literal("as_of"), valid_at: timestampSchema.optional(), recorded_at: timestampSchema }).strict(),
    ]),
    budget: ContextBudgetSchema,
    requested_kinds: z
      .array(z.enum(CONTEXT_CANDIDATE_KINDS))
      .min(1)
      .max(CONTEXT_CANDIDATE_KINDS.length)
      .optional(),
  })
  .strict()
  .superRefine((request, context) => {
    if (hasDuplicates(request.allowed_uses)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["allowed_uses"], message: "Allowed uses must be unique" });
    }
    const anchors = request.anchors?.map((anchor) => `${anchor.kind}\u0000${anchor.id}`) ?? [];
    if (hasDuplicates(anchors)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["anchors"], message: "Anchors must be unique" });
    }
    if (request.requested_kinds && hasDuplicates(request.requested_kinds)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["requested_kinds"], message: "Requested kinds must be unique" });
    }
  });

export const ContextReplayRequestSchema: z.ZodType<ContextReplayRequest> = z
  .object({
    org_id: nonEmptyStringSchema,
    snapshot_id: nonEmptyStringSchema,
    principal: ActorRefSchema,
    consumer_id: nonEmptyStringSchema,
    purpose: nonEmptyStringSchema,
    allowed_uses: z.array(z.enum(CONTEXT_ALLOWED_USES)).min(1).max(CONTEXT_ALLOWED_USES.length),
  })
  .strict()
  .superRefine((request, context) => {
    if (hasDuplicates(request.allowed_uses)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["allowed_uses"],
        message: "Allowed uses must be unique",
      });
    }
  });

export const ContextArtifactSchema: z.ZodType<ContextArtifact> = z
  .object({
    id: nonEmptyStringSchema,
    org_id: nonEmptyStringSchema,
    kind: z.enum(CONTEXT_ARTIFACT_KINDS),
    schema_version: nonEmptyStringSchema,
    algorithm_version: nonEmptyStringSchema,
    generation: nonEmptyStringSchema,
    input_refs: z.array(EvidenceReferenceSchema).max(10_000),
    input_hash: contentHashSchema,
    body_hash: contentHashSchema.optional(),
    status: z.enum(CONTEXT_ARTIFACT_STATUSES),
    required_scope_ids: z.array(nonEmptyStringSchema).max(1_000),
    recorded_at: timestampSchema,
    supersedes_id: nonEmptyStringSchema.optional(),
    attrs: JsonValueSchema.optional(),
  })
  .strict()
  .superRefine((artifact, context) => {
    if (artifact.status === "accepted" && artifact.input_refs.length === 0) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["input_refs"], message: "Accepted artifacts require evidence" });
    }
    if (artifact.input_hash !== hashContextArtifactInputs(artifact)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["input_hash"], message: "input_hash does not match input_refs" });
    }
    if (hasDuplicates(artifact.required_scope_ids)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["required_scope_ids"], message: "Required scopes must be unique" });
    }
  });

export const ContextArtifactQuerySchema: z.ZodType<ContextArtifactQuery> = z
  .object({
    org_id: nonEmptyStringSchema,
    kinds: z
      .array(z.enum(CONTEXT_ARTIFACT_KINDS))
      .max(CONTEXT_ARTIFACT_KINDS.length)
      .refine((values) => !hasDuplicates(values), "Artifact kinds must be unique")
      .optional(),
    statuses: z
      .array(z.enum(CONTEXT_ARTIFACT_STATUSES))
      .max(CONTEXT_ARTIFACT_STATUSES.length)
      .refine((values) => !hasDuplicates(values), "Artifact statuses must be unique")
      .optional(),
    generation: nonEmptyStringSchema.optional(),
    limit: nonNegativeIntegerSchema.max(10_000).optional(),
  })
  .strict();

export const ContextProjectionCheckpointSchema: z.ZodType<ContextProjectionCheckpoint> = z
  .object({
    org_id: nonEmptyStringSchema,
    projector_id: nonEmptyStringSchema,
    algorithm_version: nonEmptyStringSchema,
    generation: nonEmptyStringSchema,
    sequence: nonNegativeIntegerSchema.max(Number.MAX_SAFE_INTEGER),
    watermark: nonEmptyStringSchema,
    updated_at: timestampSchema,
  })
  .strict();

const ContextProjectionReferenceSchema = z
  .object({
    projector_id: nonEmptyStringSchema,
    algorithm_version: nonEmptyStringSchema,
    generation: nonEmptyStringSchema,
  })
  .strict();

export const ContextCandidateSchema: z.ZodType<ContextCandidate> = z
  .object({
    candidate_id: nonEmptyStringSchema,
    kind: z.enum(CONTEXT_CANDIDATE_KINDS),
    resource_id: nonEmptyStringSchema,
    evidence: z.array(EvidenceReferenceSchema).min(1).max(10_000),
    required_scope_ids: z.array(nonEmptyStringSchema).max(1_000),
    valid_from: timestampSchema.optional(),
    valid_to: timestampSchema.optional(),
    recorded_at: timestampSchema,
    status: z.enum(["current", "superseded", "retracted"]).optional(),
    content_hash: contentHashSchema.optional(),
    scores: z.record(z.number().finite()),
    estimated_tokens: nonNegativeIntegerSchema,
    conflicts: z.array(nonEmptyStringSchema).optional(),
    projection: ContextProjectionReferenceSchema.optional(),
  })
  .strict()
  .superRefine((candidate, context) => {
    if (hasDuplicates(candidate.required_scope_ids)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["required_scope_ids"], message: "Required scopes must be unique" });
    }
    if (candidate.conflicts && hasDuplicates(candidate.conflicts)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["conflicts"], message: "Conflicts must be unique" });
    }
    if (
      candidate.valid_from &&
      candidate.valid_to &&
      Date.parse(candidate.valid_from) > Date.parse(candidate.valid_to)
    ) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["valid_to"], message: "valid_to cannot precede valid_from" });
    }
  });

const ContextSelectedReferenceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      candidate_id: nonEmptyStringSchema,
      resource_id: nonEmptyStringSchema,
      kind: z.literal("event"),
      content_hash: contentHashSchema,
    })
    .strict(),
  z
    .object({
      candidate_id: nonEmptyStringSchema,
      resource_id: nonEmptyStringSchema,
      kind: z.enum(["digest", "claim", "entity", "edge", "artifact"]),
      content_hash: contentHashSchema.optional(),
      projection_generation: nonEmptyStringSchema,
    })
    .strict(),
]);

export const ContextSnapshotSchema: z.ZodType<ContextSnapshot> = z
  .object({
    schema_version: z.literal(CONTEXT_SNAPSHOT_SCHEMA_VERSION),
    id: nonEmptyStringSchema,
    org_id: nonEmptyStringSchema,
    request_hash: contentHashSchema,
    principal_policy_hash: contentHashSchema,
    read_epoch: nonEmptyStringSchema,
    retrieval_profile_version: nonEmptyStringSchema,
    assembly_profile_version: nonEmptyStringSchema,
    bundle_payload_hash: contentHashSchema,
    selected: z.array(ContextSelectedReferenceSchema).max(10_000),
    budget_ledger: ContextBudgetLedgerSchema,
    degradation_flags: z.array(nonEmptyStringSchema).max(100),
    content_hash: contentHashSchema,
    created_at: timestampSchema,
  })
  .strict()
  .superRefine((snapshot, context) => {
    if (hasDuplicates(snapshot.selected.map((selected) => selected.candidate_id))) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["selected"], message: "Selected candidates must be unique" });
    }
    if (hasDuplicates(snapshot.degradation_flags)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["degradation_flags"], message: "Degradation flags must be unique" });
    }
    if (snapshot.content_hash !== hashContextSnapshot(snapshot)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["content_hash"], message: "content_hash does not match snapshot" });
    }
    if (snapshot.id !== `context-snapshot:${snapshot.content_hash}`) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["id"], message: "id does not match snapshot content_hash" });
    }
  });

const ContextBundleItemSchema: z.ZodType<ContextBundleItem> = z
  .object({
    candidate_id: nonEmptyStringSchema,
    resource_id: nonEmptyStringSchema,
    kind: z.enum(CONTEXT_CANDIDATE_KINDS),
    status: z.enum(["current", "superseded", "retracted"]).optional(),
    text: z.string().optional(),
    content_hash: contentHashSchema.optional(),
    evidence: z.array(EvidenceReferenceSchema).min(1).max(10_000),
    estimated_tokens: nonNegativeIntegerSchema,
  })
  .strict()
  .superRefine((item, context) => {
    if (item.text === undefined && item.content_hash === undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Bundle items require text or content_hash" });
    }
  });

const ContextBundleSectionSchema = z
  .object({
    kind: z.enum(CONTEXT_SECTION_KINDS),
    items: z.array(ContextBundleItemSchema).max(10_000),
    tokens: nonNegativeIntegerSchema,
  })
  .strict()
  .superRefine((section, context) => {
    const estimated = section.items.reduce((sum, item) => sum + item.estimated_tokens, 0);
    if (estimated !== section.tokens) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["tokens"], message: "Section tokens do not match items" });
    }
  });

const ContextConflictSchema = z
  .object({
    code: nonEmptyStringSchema,
    candidate_ids: z.array(nonEmptyStringSchema).min(2),
    message: z.string().optional(),
  })
  .strict();

const ContextRedactionSchema = z
  .object({
    section: z.enum(CONTEXT_SECTION_KINDS),
    category: nonEmptyStringSchema,
    count: positiveIntegerSchema,
  })
  .strict();

export const ContextBundleSchema: z.ZodType<ContextBundle> = z
  .object({
    schema_version: z.literal(CONTEXT_BUNDLE_SCHEMA_VERSION),
    snapshot_id: nonEmptyStringSchema,
    org_id: nonEmptyStringSchema,
    principal: ActorRefSchema,
    consumer_id: nonEmptyStringSchema,
    purpose: nonEmptyStringSchema,
    allowed_uses: z.array(z.enum(CONTEXT_ALLOWED_USES)).min(1).max(CONTEXT_ALLOWED_USES.length),
    sections: z.array(ContextBundleSectionSchema).max(CONTEXT_SECTION_KINDS.length),
    citations: z.array(EvidenceReferenceSchema).max(10_000),
    conflicts: z.array(ContextConflictSchema).max(1_000),
    redactions: z.array(ContextRedactionSchema).max(1_000),
    budget_ledger: ContextBudgetLedgerSchema,
    degradation_flags: z.array(nonEmptyStringSchema).max(100),
    content_hash: contentHashSchema,
  })
  .strict()
  .superRefine((bundle, context) => {
    if (hasDuplicates(bundle.sections.map((section) => section.kind))) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["sections"], message: "Bundle section kinds must be unique" });
    }
    if (hasDuplicates(bundle.allowed_uses)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["allowed_uses"], message: "Allowed uses must be unique" });
    }
    const candidateIds = bundle.sections.flatMap((section) => section.items.map((item) => item.candidate_id));
    if (hasDuplicates(candidateIds)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["sections"], message: "Bundle candidates must be unique" });
    }
    const tokens = bundle.sections.reduce((sum, section) => sum + section.tokens, 0);
    if (tokens !== bundle.budget_ledger.selected_tokens) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["budget_ledger", "selected_tokens"], message: "Bundle tokens do not match budget ledger" });
    }
    if (candidateIds.length !== bundle.budget_ledger.selected_items) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["budget_ledger", "selected_items"], message: "Bundle item count does not match budget ledger" });
    }
    const rawEvidenceItems = bundle.sections
      .flatMap((section) => section.items)
      .filter((item) => item.kind === "event" && item.text !== undefined)
      .length;
    if (rawEvidenceItems > bundle.budget_ledger.max_raw_evidence) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["sections"], message: "Bundle exceeds max_raw_evidence" });
    }
    for (const section of bundle.sections) {
      const sectionLedger = bundle.budget_ledger.sections.find((item) => item.kind === section.kind);
      if (
        !sectionLedger ||
        sectionLedger.selected_tokens !== section.tokens ||
        sectionLedger.selected_items !== section.items.length
      ) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["sections"], message: `Section ${section.kind} does not match budget ledger` });
      }
    }
    if (hasDuplicates(bundle.citations.map((citation) => citation.event_id))) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["citations"], message: "Citations must be unique" });
    }
    if (hasDuplicates(bundle.redactions.map((redaction) => `${redaction.section}\u0000${redaction.category}`))) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["redactions"], message: "Redaction summaries must be unique" });
    }
    if (hasDuplicates(bundle.degradation_flags)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["degradation_flags"], message: "Degradation flags must be unique" });
    }
    if (bundle.content_hash !== hashContextBundle(bundle)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["content_hash"], message: "content_hash does not match bundle" });
    }
  });

export interface ContextValidationIssue {
  path: Array<string | number>;
  message: string;
}

export type ContextValidationResult<T> =
  | { success: true; data: T }
  | { success: false; issues: ContextValidationIssue[] };

function validate<T>(schema: z.ZodType<T>, input: unknown): ContextValidationResult<T> {
  const result = schema.safeParse(input);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return {
    success: false,
    issues: result.error.issues.map((issue) => ({ path: issue.path, message: issue.message })),
  };
}

export function validateContextRequest(input: unknown): ContextValidationResult<ContextRequest> {
  return validate(ContextRequestSchema, input);
}

export function validateContextReplayRequest(input: unknown): ContextValidationResult<ContextReplayRequest> {
  return validate(ContextReplayRequestSchema, input);
}

export function validateContextBudget(input: unknown): ContextValidationResult<ContextBudget> {
  return validate(ContextBudgetSchema, input);
}

export function validateContextBudgetLedger(input: unknown): ContextValidationResult<ContextBudgetLedger> {
  return validate(ContextBudgetLedgerSchema, input);
}

export function validateContextArtifact(input: unknown): ContextValidationResult<ContextArtifact> {
  return validate(ContextArtifactSchema, input);
}

export function validateContextArtifactQuery(input: unknown): ContextValidationResult<ContextArtifactQuery> {
  return validate(ContextArtifactQuerySchema, input);
}

export function validateContextProjectionCheckpoint(
  input: unknown,
): ContextValidationResult<ContextProjectionCheckpoint> {
  return validate(ContextProjectionCheckpointSchema, input);
}

export function validateContextCandidate(input: unknown): ContextValidationResult<ContextCandidate> {
  return validate(ContextCandidateSchema, input);
}

export function validateContextSnapshot(input: unknown): ContextValidationResult<ContextSnapshot> {
  return validate(ContextSnapshotSchema, input);
}

export function validateContextBundle(input: unknown): ContextValidationResult<ContextBundle> {
  return validate(ContextBundleSchema, input);
}