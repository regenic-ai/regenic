import { z } from "zod";
import {
  INGEST_SCHEMA_VERSION,
  type ContentPart,
  type ExternalPrincipalRef,
  type ExternalScopeRef,
  type ExternalThreadRef,
  type IngestBatch,
  type IngestErrorCode,
  type IngestRecord,
  type JsonValue,
  type WeightHints,
} from "./ingestion";

const nonEmptyStringSchema = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0, "String cannot be blank");
const timestampSchema = z.string().datetime({ offset: true });

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(JsonValueSchema),
  ]),
);

export const ExternalPrincipalRefSchema: z.ZodType<ExternalPrincipalRef> = z
  .object({
    id: nonEmptyStringSchema,
    display_name: nonEmptyStringSchema.optional(),
  })
  .strict();

export const ExternalScopeRefSchema: z.ZodType<ExternalScopeRef> = z
  .object({
    id: nonEmptyStringSchema,
    name: nonEmptyStringSchema.optional(),
  })
  .strict();

export const ExternalThreadRefSchema: z.ZodType<ExternalThreadRef> = z
  .object({
    id: nonEmptyStringSchema,
  })
  .strict();

export const WeightHintsSchema: z.ZodType<WeightHints> = z
  .object({
    urgency: z.number().finite().optional(),
    importance: z.number().finite().optional(),
  })
  .strict();

const contentPartBase = {
  role: z.enum(["body", "attachment", "transcript", "metadata"]),
  media_type: nonEmptyStringSchema,
  source_filename: nonEmptyStringSchema.optional(),
};

export const ContentPartSchema: z.ZodType<ContentPart> = z.union([
  z
    .object({
      ...contentPartBase,
      bytes: z.instanceof(Uint8Array),
    })
    .strict(),
  z
    .object({
      ...contentPartBase,
      text: z.string(),
    })
    .strict(),
  z
    .object({
      ...contentPartBase,
      external_locator: nonEmptyStringSchema,
    })
    .strict(),
]);

export const IngestRecordSchema: z.ZodType<IngestRecord> = z
  .object({
    operation: z.enum(["create", "revise", "tombstone"]),
    source: nonEmptyStringSchema,
    external_id: nonEmptyStringSchema,
    revision_id: nonEmptyStringSchema.optional(),
    occurred_at: timestampSchema,
    actor: ExternalPrincipalRefSchema,
    scope: ExternalScopeRefSchema,
    type: nonEmptyStringSchema,
    thread: ExternalThreadRefSchema.optional(),
    parent_external_id: nonEmptyStringSchema.optional(),
    content: z.array(ContentPartSchema).min(1).optional(),
    direction_tags: z.array(nonEmptyStringSchema).optional(),
    weight_hints: WeightHintsSchema.optional(),
    attrs: z.record(JsonValueSchema).optional(),
  })
  .strict();

export const IngestBatchSchema: z.ZodType<IngestBatch> = z
  .object({
    schema_version: z.literal(INGEST_SCHEMA_VERSION),
    connector_id: nonEmptyStringSchema,
    org_id: nonEmptyStringSchema,
    delivery_id: nonEmptyStringSchema,
    records: z.array(IngestRecordSchema).min(1),
    next_cursor: nonEmptyStringSchema.optional(),
    received_at: timestampSchema,
  })
  .strict();

export interface IngestValidationIssue {
  path: Array<string | number>;
  message: string;
}

export type IngestBatchValidationResult =
  | { success: true; data: IngestBatch }
  | {
      success: false;
      error_code: Extract<IngestErrorCode, "invalid_envelope" | "invalid_record">;
      issues: IngestValidationIssue[];
    };

export function validateIngestBatch(input: unknown): IngestBatchValidationResult {
  const result = IngestBatchSchema.safeParse(input);

  if (result.success) {
    return { success: true, data: result.data };
  }

  const issues = result.error.issues.map((issue) => ({
    path: issue.path,
    message: issue.message,
  }));
  const hasRecordIssue = issues.some(
    (issue) => issue.path[0] === "records" && typeof issue.path[1] === "number",
  );

  return {
    success: false,
    error_code: hasRecordIssue ? "invalid_record" : "invalid_envelope",
    issues,
  };
}