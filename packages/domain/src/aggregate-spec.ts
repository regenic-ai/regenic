import { createHash } from "node:crypto";

export const AGGREGATE_SPEC_VERSION = 1 as const;
export const AGGREGATE_SPEC_MAX_TERMS = 24;
export const AGGREGATE_SPEC_MAX_CONSTRAINTS = 24;
export const AGGREGATE_SPEC_MAX_DIMENSIONS = 8;
export const AGGREGATE_SPEC_MAX_CATEGORIES = 32;

export type AggregateOperation = "count" | "list" | "status_summary";
export type AggregateValueType = "count" | "category";
export type AggregateDedupeStrategy =
  | "business_id"
  | "url"
  | "external_id"
  | "event_id"
  | "text_signature";

export interface AggregateNamedValue {
  id: string;
  label: string;
}

export interface AggregateSubjectConstraint {
  field: string;
  operator: "equals" | "contains";
  value: string;
}

export interface AggregateSpec {
  version: typeof AGGREGATE_SPEC_VERSION;
  operation: AggregateOperation;
  metric: AggregateNamedValue;
  group_dimensions: AggregateNamedValue[];
  subject: {
    terms: string[];
    constraints: AggregateSubjectConstraint[];
  };
  value_type: AggregateValueType;
  allowed_categories?: AggregateNamedValue[];
  dedupe_strategy: AggregateDedupeStrategy;
}

export interface AggregateSpecSummary {
  operation: AggregateOperation;
  metric: AggregateNamedValue;
  group_dimensions: AggregateNamedValue[];
}

const ROOT_FIELDS = new Set([
  "version",
  "operation",
  "metric",
  "group_dimensions",
  "subject",
  "value_type",
  "allowed_categories",
  "dedupe_strategy",
]);
const NAMED_FIELDS = new Set(["id", "label"]);
const SUBJECT_FIELDS = new Set(["terms", "constraints"]);
const CONSTRAINT_FIELDS = new Set(["field", "operator", "value"]);
const OPERATIONS = new Set<AggregateOperation>(["count", "list", "status_summary"]);
const VALUE_TYPES = new Set<AggregateValueType>(["count", "category"]);
const DEDUPE_STRATEGIES = new Set<AggregateDedupeStrategy>([
  "business_id",
  "url",
  "external_id",
  "event_id",
  "text_signature",
]);

export function normalizeAggregateSpec(value: unknown): AggregateSpec {
  const input = strictRecord(value, ROOT_FIELDS, "aggregate spec");
  if (input.version !== AGGREGATE_SPEC_VERSION) {
    throw new Error(`aggregate spec version must be ${AGGREGATE_SPEC_VERSION}`);
  }
  if (!OPERATIONS.has(input.operation as AggregateOperation)) {
    throw new Error("aggregate spec operation is invalid");
  }
  if (!VALUE_TYPES.has(input.value_type as AggregateValueType)) {
    throw new Error("aggregate spec value_type is invalid");
  }
  if (!DEDUPE_STRATEGIES.has(input.dedupe_strategy as AggregateDedupeStrategy)) {
    throw new Error("aggregate spec dedupe_strategy is invalid");
  }
  const operation = input.operation as AggregateOperation;
  const valueType = input.value_type as AggregateValueType;
  if (
    (operation === "count" && valueType !== "count")
    || (operation !== "count" && valueType !== "category")
  ) {
    throw new Error("aggregate spec operation and value_type are inconsistent");
  }
  const dimensions = namedValues(
    input.group_dimensions,
    "group_dimensions",
    AGGREGATE_SPEC_MAX_DIMENSIONS,
  );
  const subject = strictRecord(input.subject, SUBJECT_FIELDS, "subject");
  const terms = strings(subject.terms, "subject.terms", AGGREGATE_SPEC_MAX_TERMS)
    .map(canonicalText)
    .sort(compareText);
  rejectDuplicates(terms, "subject terms");
  const constraints = array(subject.constraints, "subject.constraints", AGGREGATE_SPEC_MAX_CONSTRAINTS)
    .map((entry, index) => {
      const constraint = strictRecord(
        entry,
        CONSTRAINT_FIELDS,
        `subject.constraints[${index}]`,
      );
      if (constraint.operator !== "equals" && constraint.operator !== "contains") {
        throw new Error(`subject.constraints[${index}].operator is invalid`);
      }
      return {
        field: canonicalId(requiredText(constraint.field, "constraint field", 64)),
        operator: constraint.operator as "equals" | "contains",
        value: canonicalText(requiredText(constraint.value, "constraint value", 256)),
      };
    })
    .sort((left, right) => compareText(
      JSON.stringify(left),
      JSON.stringify(right),
    ));
  rejectDuplicates(
    constraints.map((constraint) => JSON.stringify(constraint)),
    "subject constraints",
  );
  const categories = input.allowed_categories === undefined
    ? undefined
    : namedValues(
        input.allowed_categories,
        "allowed_categories",
        AGGREGATE_SPEC_MAX_CATEGORIES,
      );
  if (operation === "status_summary" && (!categories || categories.length === 0)) {
    throw new Error("status_summary requires allowed_categories");
  }
  if (operation !== "status_summary" && categories !== undefined) {
    throw new Error("allowed_categories are only valid for status_summary");
  }
  return {
    version: AGGREGATE_SPEC_VERSION,
    operation,
    metric: namedValue(input.metric, "metric"),
    group_dimensions: dimensions,
    subject: { terms, constraints },
    value_type: valueType,
    ...(categories ? { allowed_categories: categories } : {}),
    dedupe_strategy: input.dedupe_strategy as AggregateDedupeStrategy,
  };
}

export function aggregateSpecHash(spec: AggregateSpec): string {
  const normalized = normalizeAggregateSpec(spec);
  return createHash("sha256")
    .update(JSON.stringify(normalized), "utf8")
    .digest("hex");
}

export function aggregateSpecSummary(spec: AggregateSpec): AggregateSpecSummary {
  const normalized = normalizeAggregateSpec(spec);
  return {
    operation: normalized.operation,
    metric: normalized.metric,
    group_dimensions: normalized.group_dimensions,
  };
}

export function canonicalAggregateId(value: string): string {
  return canonicalId(requiredText(value, "identifier", 64));
}

function namedValues(value: unknown, path: string, max: number): AggregateNamedValue[] {
  const values = array(value, path, max)
    .map((entry, index) => namedValue(entry, `${path}[${index}]`))
    .sort((left, right) => compareText(left.id, right.id));
  rejectDuplicates(values.map((entry) => entry.id), path);
  return values;
}

function namedValue(value: unknown, path: string): AggregateNamedValue {
  const input = strictRecord(value, NAMED_FIELDS, path);
  return {
    id: canonicalId(requiredText(input.id, `${path}.id`, 64)),
    label: displayText(requiredText(input.label, `${path}.label`, 120)),
  };
}

function strings(value: unknown, path: string, max: number): string[] {
  return array(value, path, max)
    .map((entry, index) => requiredText(entry, `${path}[${index}]`, 256));
}

function array(value: unknown, path: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) {
    throw new Error(`${path} must be an array with at most ${max} items`);
  }
  return value;
}

function strictRecord(
  value: unknown,
  fields: ReadonlySet<string>,
  path: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!fields.has(key)) throw new Error(`${path} contains unknown field ${key}`);
  }
  return record;
}

function requiredText(value: unknown, path: string, max: number): string {
  if (typeof value !== "string") throw new Error(`${path} must be a string`);
  const normalized = displayText(value);
  if (!normalized || normalized.length > max) {
    throw new Error(`${path} must contain 1-${max} characters`);
  }
  return normalized;
}

function displayText(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ");
}

function canonicalText(value: string): string {
  return displayText(value).toLocaleLowerCase("und");
}

function canonicalId(value: string): string {
  const canonical = canonicalText(value).replace(/[\s-]+/gu, "_");
  if (!/^[\p{L}\p{N}][\p{L}\p{N}_.:]*$/u.test(canonical)) {
    throw new Error("aggregate spec identifier contains unsafe characters");
  }
  return canonical;
}

function rejectDuplicates(values: readonly string[], path: string) {
  if (new Set(values).size !== values.length) {
    throw new Error(`${path} contains duplicate canonical values`);
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
