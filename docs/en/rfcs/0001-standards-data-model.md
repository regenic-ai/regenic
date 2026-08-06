# RFC 0001 — Standards data model

- **Status:** Accepted
- **中文:** [../../zh/rfcs/0001-standards-data-model.md](../../zh/rfcs/0001-standards-data-model.md)
- **Depends on:** —
- **Related:** RFC 0002 (context), RFC 0003 (collaboration), RFC 0004 (API)
- **Methodology:** Regenic Book ch. 6 (standards machine), public standard
  `product-iteration-standard`, standards README (condition / action /
  acceptance / boundary / revision trigger)

## 1. Problem

Organizations store judgment as tribal knowledge, chat threads, or static SOP
walls. Humans and agents cannot cite the same versioned artifact, cannot run a
canary before org-wide adoption, and cannot prove that an iteration learned
anything (a revised or new standard).

## 2. Goals

1. Encode a **judgment standard** as a versioned, citable object shared by
   humans and agents.
2. Support a **progressive lifecycle**: draft → trial → active → deprecated.
3. Enforce the book's **five iteration gates** as machine-checkable fields,
   not prose hope.
4. Map cleanly to public markdown standards in `regenic-book`.

## 3. Non-goals

- Workflow/UI for meetings (RFC 0003).
- Context graph storage (RFC 0002).
- Agent runtime or LLM prompts (RFC 0004 only defines the API contract).

## 4. Core types

### 4.1 `Standard`

Stable identity across versions.

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string (ULID/UUID) | Immutable |
| `slug` | string | Org-unique, URL-safe |
| `title` | string | Human label |
| `layer` | enum | `stable_core` \| `adjacent` \| `frontier` |
| `scope` | `Scope` | Who/what it applies to |
| `created_at` | datetime | |
| `created_by` | `ActorRef` | Human or system |
| `current_version_id` | string \| null | Points at latest non-draft if any |
| `citation_count` | integer | Rolling health metric; prefer over “how many standards exist” |

### 4.2 `StandardVersion`

Immutable once leaving `draft` (except metadata that does not change meaning).

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | |
| `standard_id` | string | |
| `version` | semver string | e.g. `1.2.0` |
| `status` | enum | `draft` \| `trial` \| `active` \| `deprecated` |
| `condition` | markdown/string | When it applies |
| `action` | markdown/string | Expected judgment or behavior |
| `acceptance` | markdown/string | Observable evidence of success |
| `boundary` | markdown/string | When to stop or escalate |
| `revision_trigger` | markdown/string | Evidence that forces change |
| `gate` | `IterationGate` | Required for `trial` and `active` |
| `trial` | `TrialConfig` \| null | Required when `status = trial` |
| `supersedes_version_id` | string \| null | Previous version |
| `body_hash` | string | Content-addressable integrity |
| `published_at` | datetime \| null | |
| `published_by` | `ActorRef` \| null | |

### 4.3 `Scope`

| Field | Type | Notes |
| --- | --- | --- |
| `org_id` | string | |
| `team_ids` | string[] | Empty = org-wide |
| `roles` | string[] | Optional role filters |
| `decision_kinds` | string[] | e.g. `pricing`, `hiring`, `release` |

### 4.4 `IterationGate`

Productization of the five gates in `product-iteration-standard`.

| Field | Type | Gate |
| --- | --- | --- |
| `single_uncertainty` | string | **1** — the one uncertainty this change validates |
| `target_user_tier` | enum | innovator / early_adopter / early_majority / late_majority / laggard |
| `consensus_hypothesis` | string | What user consensus is assumed |
| `value_metric` | string | How success is measured |
| `cost_budget` | string | Effort / money upper bound |
| `validation_window` | duration or date range | |
| `stop_condition` | string | When to abort |
| `stable_core_preserved` | boolean | **2** — must be true to leave draft for non-frontier |
| `compat_and_rollback` | string | **3** — migration + rollback plan |
| `upgrade_evidence` | `UpgradeEvidence` \| null | **4** — required to promote trial → active |
| `learning_output` | enum | **5** — `new_standard` \| `revision` \| `no_standard_needed` |

### 4.5 `UpgradeEvidence`

All must be true (or explicitly waived with `waiver_reason` audited) to promote
to `active`:

| Field | Type |
| --- | --- |
| `core_value_revalidated` | boolean |
| `delivery_standardized` | boolean |
| `unit_economics_or_roi_ok` | boolean |
| `next_tier_behavioral_evidence` | boolean |
| `rollback_safe` | boolean |
| `waiver_reason` | string \| null |

### 4.6 `TrialConfig` (canary)

| Field | Type |
| --- | --- |
| `audience` | `Scope` | Narrower than parent scope |
| `starts_at` | datetime |
| `ends_at` | datetime \| null |
| `success_metric` | string |
| `stop_condition` | string |

### 4.7 `ActorRef`

| Field | Type |
| --- | --- |
| `actor_type` | enum | `human` \| `agent` \| `system` |
| `actor_id` | string |

### 4.8 `StandardGap` (intake for progressive generation)

Created from execution failures, exceptions, daily three-questions output, or
reviews (RFC 0003).

| Field | Type |
| --- | --- |
| `id` | string |
| `summary` | string |
| `source_kind` | enum | `execution_failure` \| `exception` \| `three_questions` \| `review` \| `manual` |
| `source_ref` | string | ID of decision / run / review |
| `proposed_uncertainty` | string |
| `status` | enum | `open` \| `converted` \| `dismissed` |
| `converted_proposal_id` | string \| null | RFC 0003 |

## 5. Lifecycle rules

```text
draft ──publish_trial──► trial ──promote──► active ──deprecate──► deprecated
  │                        │
  └────────publish_active──┘   (only if UpgradeEvidence complete; rare fast-path)
```

1. **Single-variable rule:** a version that changes more than one of
   `{target_user_tier, decision_kind scope, commercial model, core tech
   assumption}` in `gate` MUST remain `draft` until split or waiver.
2. **Citation:** applications (RFC 0004) MUST bind `standard_id` +
   `version` (or `standard_version_id`). Floating “latest” is allowed only as a
   resolve-time convenience; the stored binding is always pinned.
3. **Deprecation:** `active` → `deprecated` requires `revision_trigger`
   evidence or an explicit superseding version.
4. **Health:** standards with `citation_count = 0` for a configurable window
   surface as candidates for deprecate or merge — bar count is not a KPI.

## 6. Progressive generation flow

1. Detect gap → `StandardGap`
2. Open Proposal (RFC 0003) with exactly one `single_uncertainty`
3. Author `StandardVersion` in `draft`
4. Enter `trial` with `TrialConfig`
5. On gate-4 evidence → `active`
6. Every closed iteration MUST set `learning_output` (gate 5)

## 7. Mapping to public markdown

| Markdown section | Field |
| --- | --- |
| Condition | `condition` |
| Action | `action` |
| Acceptance | `acceptance` |
| Boundary | `boundary` |
| Revision trigger | `revision_trigger` |

Export/import SHOULD preserve these five sections as first-class fields, with
optional extended markdown body for narrative.

## 8. Acceptance criteria (Phase 1 exit)

A team can publish, apply, and revise one org-wide standard without a separate
chat thread per team. Agents and humans cite the same `standard_version_id`.

## 9. Open questions

Resolved or deferred in Wave A review (Issues #1 / #8 — approved):

| Topic | Resolution | Status |
| --- | --- | --- |
| Book gate numbering vs product five gates | Keep product five gates; book rules are commentary + segment enum | Confirmed |
| `UpgradeEvidence` vs book headings | Productization; no 1:1 book headings required | Confirmed |
| `layer` enum | Product-only; not from public book markdown | Confirmed |
| Semver vs monotonic integer for org-private standards | **Defer to Phase 1 impl** — default semver string; migrate later if needed | Deferred |
| Whether `layer` is mutable without a new version | **No** — layer change requires new `StandardVersion` | Confirmed |
