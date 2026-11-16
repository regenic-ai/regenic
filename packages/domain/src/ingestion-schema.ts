export {
  CONNECTOR_LIMIT_RANGES,
  ContentPartSchema,
  ExternalPrincipalRefSchema,
  ExternalScopeRefSchema,
  ExternalThreadRefSchema,
  IngestBatchSchema,
  IngestRecordSchema,
  JsonValueSchema,
  PUSH_INGEST_MAX_EVENTS,
  PUSH_WATERMARK_PAGE_MAX,
  WeightHintsSchema,
  sanitizeConnectorLimits,
  validateConnectorLimits,
  validateIngestBatch,
  validatePushIngestBatch,
} from "@regenic/connector-contract";
export type {
  IngestBatchValidationResult,
  IngestValidationIssue,
  PushIngestAck,
  PushIngestBatch,
} from "@regenic/connector-contract";
