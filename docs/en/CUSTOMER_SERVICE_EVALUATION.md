# Customer-service evaluation gate

Regenic includes a frozen, privacy-safe customer-service regression corpus and a deterministic merge gate. It verifies that authorized retrieval, conversation expansion, evidence binding, member closure, business-result boundaries, stale-context handling, and pre-send invalidation continue to work together.

## Run the gate

```powershell
pnpm --filter @regenic/context-engine eval:customer-service
```

The command builds the required workspace packages, executes all 60 cases, prints a deterministic JSON report, and exits non-zero when a threshold fails. The same gate is covered by the Context Engine test suite:

```powershell
pnpm --filter @regenic/context-engine test
```

## Corpus

`customer-service-synthetic-regression-v1` contains 60 cases: five variants in each of 12 categories.

| Category | Required behavior |
|---|---|
| `reference_resolution` | Recover the scope behind phrases such as “the previously selected people.” |
| `set_closure` | Preserve the expected count and exact member set. |
| `reply_chain` | Include native reply targets in evidence. |
| `continuation_gap` | Continue a bounded read without losing required messages. |
| `identity_ambiguity` | Clarify instead of accepting an ambiguous identity. |
| `cross_conversation_scope` | Reject related-conversation search before customer/project scope is verified. |
| `business_not_found` | Never translate `not_found` into “has not replied.” |
| `business_denied` | Do not draft claims from `permission_denied`. |
| `business_unavailable` | Do not invent status while the business source is unavailable. |
| `internal_visibility` | Reject customer-visible claims based on internal-only fields. |
| `stale_context` | Reject continuation reads after the Authority read epoch changes. |
| `business_changed` | Invalidate approval when business facts change before send. |

Every case runs through the real deterministic Context Engine retriever and `CustomerServiceCoordinator`. The executor uses an oracle interpretation for entity extraction so the gate remains model-independent and reproducible.

## Merge thresholds

| Metric | Threshold |
|---|---:|
| Cases | at least 60 |
| Required evidence recall | at least 95% |
| Exact member closure | 100% |
| Citation/Event/content-hash validity | 100% |
| Expected action accuracy | 100% |
| Required stale-context detection | 100% |
| Forbidden customer-facing claims | 0 |

The report contains per-case missing evidence, closure status, invalid citations, action mismatches, forbidden claims, and a canonical `content_hash`. Timing is intentionally excluded from the quality hash.

## Corpus governance

- Cases must contain only synthetic or irreversibly anonymized content.
- Existing labels are frozen. Change the dataset ID when case meaning, labels, or category composition changes.
- Add a regression case before fixing a newly observed failure.
- Do not lower a threshold to make a code change pass.
- Keep development cases separate from future real held-out confirmation data.
- Review corpus changes independently from retrieval implementation changes when practical.

## Scope and limitations

This gate certifies deterministic local retrieval and workflow safety boundaries. It does **not** certify:

- model reasoning or prompt quality;
- production connector synchronization completeness;
- real tenant authorization configuration;
- remote business-service correctness;
- production latency, concurrency, or capacity.

After this gate passes, run the [system-level acceptance suite](./CUSTOMER_SERVICE_SYSTEM_ACCEPTANCE.md) across MCP, the Personal API, and a controlled business service. A real Cursor/MCP client, production-like connectors, and a separately governed held-out confirmation set are still required for deployment acceptance.
