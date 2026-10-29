# Customer-service system acceptance

Regenic includes a black-box acceptance path for the customer-service integration boundary. It starts the real customer-service MCP stdio server, calls the Personal API, reads evidence through the Context Engine, and queries a controlled business HTTP service.

Run it with:

```powershell
pnpm --filter @regenic/api eval:customer-service-system
```

The command builds the MCP client and API dependency graphs, runs the acceptance suite, prints a stable JSON report, and exits non-zero when a contract assertion fails.

## Covered scenarios

| Scenario | Required behavior |
|---|---|
| Normal answer | Create a task through MCP, recover all required conversation evidence, submit an evidence-bound brief, query exactly two stable business identities, and create a customer-visible draft. |
| Human review boundary | MCP exposes neither review nor send. Approval is performed through the trusted Personal API boundary. |
| Changed business facts | A business record-version change after approval blocks send, clears the stale approval, and returns the task to verification. |
| Missing business record | `not_found` cannot support a claim that the member has not replied. The draft is rejected and remains unapproved. |
| Internal field | A field with `visibility: internal` cannot support a customer-visible claim. The draft is rejected and remains unapproved. |
| Scoped query | Every business request must use the verified customer, project, batch, member IDs, and requested field. |

The report excludes random task and query IDs and elapsed time from its content hash.

## Relationship to the deterministic gate

The [customer-service evaluation gate](./CUSTOMER_SERVICE_EVALUATION.md) runs 60 deterministic workflow cases and measures retrieval and safety metrics. This suite is intentionally smaller and proves that the same critical contracts survive the production interface boundaries:

```text
MCP stdio -> Personal API -> Context Engine -> controlled business HTTP service
```

Both suites are required. A passing system test does not replace the 60-case workflow corpus, and a passing workflow corpus does not prove the MCP/API integration.

## Limits

This suite uses synthetic connector events and oracle-provided tool arguments. It does not certify:

- model reasoning or prompt quality in a real Cursor session;
- production connector synchronization completeness;
- real tenant authorization and disclosure policy;
- a production business service;
- latency, concurrency, or capacity.

Those claims still require an authorized production-like connector, a scoped business test service, a real target Cursor/MCP client, and a separately governed held-out confirmation set.
