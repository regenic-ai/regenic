# RFC 0007 — Daily distillation

- **Status:** Accepted
- **中文:** [../../zh/rfcs/0007-daily-distillation.md](../../zh/rfcs/0007-daily-distillation.md)
- **Depends on:** RFC 0005 (Event/Digest/Blob), RFC 0006 (ACL), RFC 0001 (standards), RFC 0003 (proposals)
- **Related:** RFC 0002 (optional Claim promotion)
- **Methodology:** Regenic Book ch. 6 standards machine intake; ch. 9 review workshop

## 1. Problem

Raw Events are abundant; judgment assets are scarce. Regenic must **filter and
weight** daily operational context into a small set of typed items that can
enter the standards machine — without privilege escalation and without “daily
report literature.”

## 2. Goals

1. Per org-day × `direction`, emit ≤N typed items with evidence.
2. Model may **propose**; code owns score, conflict, ACL, quotas.
3. Outputs are standards-machine feed (`item_kind`), not chat summaries.
4. Ship **D0** (rules only, `ModelProvider = none`) before D1 (`ModelProvider.complete`).

## 3. Non-goals

- Full NLP topic model research.
- Auto-activating standards (human accept required).
- Using distillation as a backdoor org-wide readout.

## 4. Directions (controlled)

`product` | `sales` | `customer` | `org` | `finance` | `risk`

`finance` / `risk` may be disabled per org. Free-form tags are not partition keys.

## 5. Item kinds

| `item_kind` | Downstream |
| --- | --- |
| `new_judgment` | Standard draft candidate |
| `standard_amendment` | StandardVersion draft (RFC 0001) |
| `hypothesis` | Review loop (RFC 0003) |
| `bad_news` | Priority surface + extended keeplive |
| `metric_signal` | Requires evidence_class ≥ metric |
| `clarify_request` | `needs_clarify`; never auto-accepted |

## 6. Pipeline

```
Fetch C (ACL-visible Events in period) + A (active standards, recent digests)
→ Normalize/dedupe (content_hash, thread fold)
→ Direction route
→ Cluster (D0: thread_id / channel; D1+: embeddings optional)
→ Propose items (D0: rules; D1: LLM → JSON)
→ Score + conflict (deterministic)
→ Top-N + bad_news seat
→ Derive required_scope_ids
→ Write Digest + Evidence (proposed)
→ Notify direction owners (ACL-safe)
```

Job principal: `service` + `can_propose_digest` (RFC 0006).

## 7. Scoring (V1 tables, configurable)

```
base = role_tier × evidence_class × recency × source_trust × direction_fit
item.score = Σ(weight_e) × novelty × actionability
```

Suggested scalars:

| Factor | Examples |
| --- | --- |
| `role_tier` | CEO 5.0; direction lead 3.5; owner 2.0; member 1.0; agent 0.8 |
| `evidence_class` | metric 4; demo 3; user_verbatim 2.5; decision_record 2.5; opinion 1 |
| `source_trust` | regenic decision thread 1.2; ticket/cs 1.1; chat 0.7 |
| `recency` | in-day 1.0; backlog ×0.9^days |

Quotas: ≤7 items / direction / day; ≥1 `bad_news` seat when candidates exist;
1–12 evidence rows / item; body ≤800 chars.

## 8. Conflicts

| Type | Handling |
| --- | --- |
| `role_vs_evidence` | Emit `clarify_request`; keep both sides as evidence |
| `standard_vs_reality` | `standard_amendment` or `hypothesis` |
| `authority_split` | `clarify_request`; notify both admins |
| `acl_split` | Redacted digest or split digests — never widen |

## 9. Output schema (`schema_version: "1.0"`)

See §8 of design discussion; normative fields:

- JobRun: `org_id`, `period_start/end`, `job_principal_id`, `directions[]`
- Direction: `direction`, `digest_id`, `status`, `required_scope_ids`, `items[]`, `stats`
- Item: `item_kind`, `title`, `body`, `score`, `evidence[]`, `conflicts[]`, `linked_standard_id?`
- Evidence: `event_id`, `weight_applied`, `reason`, `span?`

Map to RFC 0005 tables. On human **accept** of `standard_amendment` /
`new_judgment`, open RFC 0003 Proposal (agent still cannot activate).

## 10. Phases

| Phase | Deliverable |
| --- | --- |
| **D0** | Rules only — high-weight / bad-news / metric skeletons (this RFC §11 + sketch SQL) |
| D1 | LLM propose + code finalize |
| D2 | Link Standard drafts |
| D3 | Redacted digests; cross-direction dedupe |
| D4 | Coverage / orphan_high_weight alerts |

## 11. D0 algorithm (normative sketch)

No LLM. For each direction bucket:

1. Select candidate Events: period ∩ `visible(job)` ∩ not tombstone.
2. Compute `base` score from `weight_hints` + membership role_tier map.
3. Thread-fold: keep max-score Event per `thread_id` (null thread → per event).
4. Classify:
   - `weight_hints.evidence_class = metric` → `metric_signal`
   - preview/attrs match bad-news lexicon OR `attrs.severity >= high` → `bad_news`
   - `role_tier >= 3.5` → `hypothesis` (title = preview truncated)
   - else drop (D0 does not emit low-signal chatter)
5. Conflict: if two retained items have opposite `attrs.stance` and both
   `role_tier >= 3.5` → replace with one `clarify_request` citing both.
6. Apply Top-N + bad_news seat; derive `required_scope_ids`; insert Digest.

Pseudocode / SQL: [`sketch/d0-daily-distill.sql`](sketch/d0-daily-distill.sql).

## 12. Acceptance criteria

1. D0 run on fixture data produces Digests with evidence and correct
   `required_scope_ids`.
2. Principal missing one evidence scope cannot read strict Digest body.
3. Re-run same period is idempotent for `proposed` (supersede old proposed;
   never mutate `accepted`).

## 13. Decisions (#7 — approved)

- [x] **`period_*` uses org-local day windows** (aligned with RFC 0005: Event
  `ts` in UTC; Digest day buckets use org timezone config).
- [x] **Per-unit sub-quotas defer to D3/D4.** v1 uses Top-N per direction first;
  unit quotas are later config.
- [x] **D0 bad-news lexicon is org-configurable** (ship a starter list; customer
  edits).
