const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  aggregateSpecHash,
  normalizeAggregateSpec,
} = require("../dist/aggregate-spec");

function countSpec() {
  return {
    version: 1,
    operation: "count",
    metric: { id: " Video-Count ", label: " Video   Count " },
    group_dimensions: [
      { id: "Month", label: "Month" },
      { id: "Customer", label: "Customer" },
    ],
    subject: {
      terms: [" ＨＯＬＬＹＬＡＮＤ ", "Video"],
      constraints: [
        { field: " Brand ", operator: "equals", value: " Hollyland " },
      ],
    },
    value_type: "count",
    dedupe_strategy: "external_id",
  };
}

describe("AggregateSpec", () => {
  it("normalizes identifiers, labels and unordered sets deterministically", () => {
    const normalized = normalizeAggregateSpec(countSpec());
    assert.equal(normalized.metric.id, "video_count");
    assert.equal(normalized.metric.label, "Video Count");
    assert.deepEqual(
      normalized.group_dimensions.map((entry) => entry.id),
      ["customer", "month"],
    );
    assert.deepEqual(normalized.subject.terms, ["hollyland", "video"]);
  });

  it("produces a stable order-invariant canonical hash", () => {
    const left = countSpec();
    const right = {
      dedupe_strategy: left.dedupe_strategy,
      value_type: left.value_type,
      subject: {
        constraints: [...left.subject.constraints].reverse(),
        terms: [...left.subject.terms].reverse(),
      },
      group_dimensions: [...left.group_dimensions].reverse(),
      metric: { label: "Video Count", id: "video_count" },
      operation: left.operation,
      version: left.version,
    };
    assert.equal(aggregateSpecHash(left), aggregateSpecHash(right));
    assert.match(aggregateSpecHash(left), /^[a-f0-9]{64}$/);
  });

  it("rejects unknown fields, blanks, oversize values and duplicates", () => {
    assert.throws(
      () => normalizeAggregateSpec({ ...countSpec(), prompt: "secret" }),
      /unknown field/,
    );
    assert.throws(
      () => normalizeAggregateSpec({
        ...countSpec(),
        metric: { id: " ", label: "Count" },
      }),
      /1-64/,
    );
    assert.throws(
      () => normalizeAggregateSpec({
        ...countSpec(),
        metric: { id: "x".repeat(65), label: "Count" },
      }),
      /1-64/,
    );
    assert.throws(
      () => normalizeAggregateSpec({
        ...countSpec(),
        group_dimensions: [
          { id: "Project", label: "Project" },
          { id: " project ", label: "Other" },
        ],
      }),
      /duplicate/,
    );
    assert.throws(
      () => normalizeAggregateSpec({
        ...countSpec(),
        operation: "status_summary",
        value_type: "category",
        allowed_categories: [
          { id: "Done", label: "Done" },
          { id: " done ", label: "Complete" },
        ],
      }),
      /duplicate/,
    );
    assert.throws(
      () => normalizeAggregateSpec({
        ...countSpec(),
        subject: {
          terms: Array.from({ length: 25 }, (_, index) => `term-${index}`),
          constraints: [],
        },
      }),
      /at most 24/,
    );
  });

  it("enforces every operation and value-type consistency rule", () => {
    assert.throws(
      () => normalizeAggregateSpec({ ...countSpec(), value_type: "category" }),
      /inconsistent/,
    );
    assert.throws(
      () => normalizeAggregateSpec({
        ...countSpec(),
        operation: "list",
        value_type: "count",
      }),
      /inconsistent/,
    );
    assert.throws(
      () => normalizeAggregateSpec({
        ...countSpec(),
        operation: "status_summary",
        value_type: "category",
      }),
      /requires allowed_categories/,
    );
    assert.throws(
      () => normalizeAggregateSpec({
        ...countSpec(),
        allowed_categories: [{ id: "done", label: "Done" }],
      }),
      /only valid/,
    );
    assert.doesNotThrow(() => normalizeAggregateSpec({
      ...countSpec(),
      operation: "list",
      value_type: "category",
    }));
    assert.doesNotThrow(() => normalizeAggregateSpec({
      ...countSpec(),
      operation: "status_summary",
      value_type: "category",
      allowed_categories: [
        { id: "done", label: "Done" },
        { id: "open", label: "Open" },
      ],
    }));
  });
});
