const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  assertCustomerServiceEvaluationGate,
  evaluateCustomerServiceWorkflow,
} = require("../dist");
const {
  CATEGORY_SPECS,
  customerServiceEvaluationFixture,
} = require("./fixtures/customer-service-evaluation.cjs");

describe("Customer-service evaluation", () => {
  it("runs the frozen 60-case workflow corpus through the real coordinator", async () => {
    const fixture = customerServiceEvaluationFixture();
    assert.equal(fixture.dataset.cases.length, 60);
    assert.equal(new Set(fixture.dataset.cases.map((value) => value.id)).size, 60);
    assert.deepEqual(
      Object.fromEntries(CATEGORY_SPECS.map((spec) => [
        spec.category,
        fixture.dataset.cases.filter((value) => value.category === spec.category).length,
      ])),
      Object.fromEntries(CATEGORY_SPECS.map((spec) => [spec.category, 5])),
    );

    const report = await evaluateCustomerServiceWorkflow(
      fixture.dataset,
      fixture.execute,
    );

    assert.deepEqual(report.metrics, {
      case_count: 60,
      evidence_recall: 1,
      evidence_complete_case_rate: 1,
      member_closure_accuracy: 1,
      citation_validity: 1,
      action_accuracy: 1,
      stale_detection_rate: 1,
      forbidden_claims: 0,
      passed: true,
    });
    assert.deepEqual(report.failed_gates, []);
    assert.match(report.content_hash, /^[a-f0-9]{64}$/);
    assert.doesNotThrow(() => assertCustomerServiceEvaluationGate(report));
  });

  it("reports actionable gate failures for unsafe or incomplete observations", async () => {
    const fixture = customerServiceEvaluationFixture();
    const report = await evaluateCustomerServiceWorkflow(
      fixture.dataset,
      async (value) => ({
        selected_event_ids: value.required_event_ids.slice(0, 1),
        citations: [{
          event_id: value.required_event_ids[0],
          content_hash_valid: false,
        }],
        resolved_member_keys: [],
        action: "query_business",
        claims: value.forbidden_claims ?? [],
        stale_detected: false,
      }),
    );

    assert.equal(report.metrics.passed, false);
    assert.ok(report.failed_gates.includes("evidence_recall"));
    assert.ok(report.failed_gates.includes("member_closure_accuracy"));
    assert.ok(report.failed_gates.includes("citation_validity"));
    assert.ok(report.failed_gates.includes("action_accuracy"));
    assert.ok(report.failed_gates.includes("stale_detection_rate"));
    assert.ok(report.failed_gates.includes("forbidden_claims"));
    assert.throws(
      () => assertCustomerServiceEvaluationGate(report),
      /evidence_recall/,
    );
  });

  it("rejects duplicate case IDs and invalid observations before producing a report", async () => {
    const fixture = customerServiceEvaluationFixture();
    fixture.dataset.cases[1].id = fixture.dataset.cases[0].id;
    await assert.rejects(
      evaluateCustomerServiceWorkflow(fixture.dataset, fixture.execute),
      /Invalid customer-service evaluation dataset/,
    );

    const valid = customerServiceEvaluationFixture();
    await assert.rejects(
      evaluateCustomerServiceWorkflow(valid.dataset, async () => ({
        selected_event_ids: ["duplicate", "duplicate"],
        citations: [],
        resolved_member_keys: [],
        action: "clarify",
        claims: [],
        stale_detected: false,
      })),
      /Invalid customer-service evaluation observation/,
    );
  });
});
