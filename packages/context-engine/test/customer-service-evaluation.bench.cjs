const {
  assertCustomerServiceEvaluationGate,
  evaluateCustomerServiceWorkflow,
} = require("../dist");
const {
  CATEGORY_SPECS,
  customerServiceEvaluationFixture,
} = require("./fixtures/customer-service-evaluation.cjs");

async function main() {
  const fixture = customerServiceEvaluationFixture();
  const report = await evaluateCustomerServiceWorkflow(
    fixture.dataset,
    fixture.execute,
  );
  console.log(JSON.stringify({
    dataset_id: report.dataset_id,
    scope: "Frozen synthetic coordinator corpus; deterministic retrieval, workflow safety and business-boundary gate; no model-quality or production connector certification.",
    categories: Object.fromEntries(CATEGORY_SPECS.map((spec) => [
      spec.category,
      report.cases.filter((value) => value.category === spec.category).length,
    ])),
    thresholds: report.thresholds,
    metrics: report.metrics,
    failed_gates: report.failed_gates,
    content_hash: report.content_hash,
  }, null, 2));
  assertCustomerServiceEvaluationGate(report);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
