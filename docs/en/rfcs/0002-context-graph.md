# RFC 0002 — Context graph

- **Status:** Draft
- **中文:** [../../zh/rfcs/0002-context-graph.md](../../zh/rfcs/0002-context-graph.md)
- **Depends on:** RFC 0001 (standards identity for links)
- **Related:** RFC 0003 (collaboration), RFC 0004 (API)
- **Methodology:** Regenic Book ch. 9 (consensus machine / unified context)

## 1. Problem

Decision context today lives in per-team chat silos. Two humans and one agent
making the “same” decision often see different facts, cannot replay what they
saw, and cannot tell fact from hypothesis. Unified context is not “transparent
everything”; it is **the same fact set for the same decision**, with
provenance and access boundaries.

## 2. Goals

1. Represent organizational context as a **graph** of entities, claims, and
   relationships — not a folder of documents alone.
2. Provide **immutable snapshots** bound to decisions and agent runs.
3. Distinguish **fact / hypothesis / opinion**.
4. Enforce **access by decision need and scope**, not by chat membership.
5. Trigger **standard review** when material context changes (sync with RFC 0001).

## 3. Non-goals

- Replacing document editors or file storage vendors.
- Full-company social transparency or activity feeds.
- Real-time CRDT sync semantics (eventual consistency of claims is enough for v1).

## 4. Core types

### 4.1 `Entity`

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | |
| `kind` | enum | `person` \| `agent` \| `team` \| `customer` \| `product` \| `standard` \| `decision` \| `evidence` \| `document` \| `metric` \| `other` |
| `name` | string | |
| `attrs` | object | Kind-specific, schema-validated per kind |
| `org_id` | string | |
| `created_at` | datetime | |
| `created_by` | `ActorRef` | |

`standard` entities reference `standard_id` from RFC 0001; they do not duplicate
standard body text.

### 4.2 `Claim`

A typed assertion about the world, with provenance.

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | |
| `subject_entity_id` | string | |
| `predicate` | string | Controlled vocabulary preferred |
| `object` | string \| number \| boolean \| object \| `entity_ref` | |
| `claim_type` | enum | `fact` \| `hypothesis` \| `opinion` |
| `confidence` | number \| null | 0–1 optional |
| `valid_from` | datetime \| null | |
| `valid_to` | datetime \| null | Soft validity window |
| `provenance` | `Provenance` | Required |
| `access` | `AccessPolicy` | Required |
| `status` | enum | `active` \| `superseded` \| `retracted` |
| `superseded_by` | string \| null | |

**Rules:**

- `hypothesis` MUST include a `validation_window` (in `attrs` or `valid_to`)
  before it may feed a standard promotion (RFC 0001 gate 4).
- `opinion` MUST NOT be treated as evidence for trial→active without conversion
  to fact/hypothesis with new provenance.
- Retracting a claim does not rewrite history; snapshots keep the old claim ids.

### 4.3 `Edge`

| Field | Type |
| --- | --- |
| `id` | string |
| `from_entity_id` | string |
| `to_entity_id` | string |
| `rel_type` | string | e.g. `member_of`, `owns`, `depends_on`, `cites`, `evidences` |
| `provenance` | `Provenance` |
| `access` | `AccessPolicy` |

### 4.4 `Provenance`

| Field | Type | Notes |
| --- | --- | --- |
| `source_kind` | enum | `human_input` \| `agent_observation` \| `system_import` \| `document` \| `metric_pipeline` \| `decision` \| `review` |
| `source_ref` | string | External or internal id |
| `recorded_by` | `ActorRef` | |
| `recorded_at` | datetime | |
| `raw_excerpt` | string \| null | Optional quote / pointer |
| `uri` | string \| null | Stable link when available |

### 4.5 `AccessPolicy`

| Field | Type | Notes |
| --- | --- | --- |
| `visibility` | enum | `decision_scoped` \| `team` \| `org` \| `restricted` |
| `principal_ids` | string[] | Humans/agents/teams allowed |
| `decision_kinds` | string[] | If `decision_scoped`, which kinds may include this claim |
| `deny_exfiltrate` | boolean | If true, claim may appear in UI but not in agent export bundles without elevating |

Default: **decision-scoped**. Salary, compliance red lines, and unannounced M&A
stay `restricted` and never enter generic “org” bundles.

### 4.6 `ContextSnapshot`

Immutable cut of the graph for a decision or agent run.

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | |
| `org_id` | string | |
| `decision_kind` | string | |
| `purpose` | string | Why this snapshot was built |
| `entity_ids` | string[] | Included entities |
| `claim_ids` | string[] | Included claims (pinned) |
| `edge_ids` | string[] | Included edges |
| `standard_bindings` | `StandardBinding[]` | Applicable standards (RFC 0001) |
| `built_for_principals` | `ActorRef[]` | Who was authorized to see this cut |
| `content_hash` | string | Hash over sorted claim/edge ids + bodies |
| `created_at` | datetime | |
| `created_by` | `ActorRef` | |

### 4.7 `ContextBundle`

API-facing projection of a snapshot for a principal (human UI or agent).

| Field | Type |
| --- | --- |
| `snapshot_id` | string |
| `principal` | `ActorRef` |
| `claims` | Claim[] | Filtered by access |
| `entities` | Entity[] | |
| `edges` | Edge[] | |
| `standards` | resolved StandardVersion summaries |
| `redactions` | string[] | Claim ids omitted due to policy (ids only, no bodies) |

Two principals with the same decision role and policy MUST receive bundles with
the same `content_hash` of visible claims. Divergent hashes are a product bug.

### 4.8 `StandardBinding`

| Field | Type |
| --- | --- |
| `standard_id` | string |
| `standard_version_id` | string |
| `reason` | string | Why included in this snapshot |

### 4.9 `ContextChangeEvent`

| Field | Type |
| --- | --- |
| `id` | string |
| `claim_or_edge_id` | string |
| `change` | enum | `created` \| `superseded` \| `retracted` |
| `materiality` | enum | `low` \| `high` |
| `suggested_standard_ids` | string[] | Standards to review |
| `created_at` | datetime | |

`materiality = high` SHOULD open or update a review Proposal (RFC 0003) when
linked standards exist.

## 5. Consistency rules

1. **Same decision, same fact set:** builders of snapshots for a given
   `(org_id, decision_kind, purpose, principal_set)` use a deterministic
   selection algorithm (documented in implementation notes). Ad-hoc claim
   stuffing by one participant is forbidden without a new snapshot id.
2. **Replay:** any Decision or AgentRun stores `context_snapshot_id` and can
   rehydrate the exact claim set.
3. **No silent mutation:** editing a claim creates a new claim and marks the
   old one `superseded`; snapshots never mutate.
4. **Hypothesis quarantine:** hypotheses appear in bundles labeled as such;
   promotion paths to standards require validation evidence.

## 6. Acceptance criteria (Phase 2 exit)

Two teams and one agent share the same context snapshot for a decision without
copy-pasting from Slack. Out-of-policy content is invisible and does not
contaminate the decision hash.

## 7. Open questions

- Controlled vocabulary governance for `predicate` / `rel_type`.
- Whether documents are first-class entities or only provenance sources in v1
  (proposal: both — `document` entity + provenance pointer).
