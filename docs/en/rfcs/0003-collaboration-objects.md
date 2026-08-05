# RFC 0003 — Collaboration objects

- **Status:** Draft
- **中文:** [../../zh/rfcs/0003-collaboration-objects.md](../../zh/rfcs/0003-collaboration-objects.md)
- **Depends on:** RFC 0001 (standards), RFC 0002 (context snapshots)
- **Related:** RFC 0004 (API)
- **Methodology:** Regenic Book ch. 9 (meeting / document / review workshops),
  ch. 10 (decision-rights ladder)

## 1. Problem

Human collaboration and human–agent handoffs today happen in chat. Chat
optimizes for messages, not for judgment artifacts. Regenic needs shared
objects whose **only valid exits** are: a new/revised standard, a recorded
decision under a context snapshot, or a validated/falsified hypothesis — never
an unbounded thread.

## 2. Goals

1. Productize the three workshops: **meeting (decision session)**, **document
   (citable context/standard body)**, **review (feedback loop)**.
2. Define **Proposal**, **Decision**, **Review**, and **Handoff** as first-class
   objects usable by humans and agents.
3. Make the **decision-rights ladder** visible on every collaborative object.
4. Treat **bad-news / deviation reports** as first-class, not comment side-channels.

## 3. Non-goals

- Chat product or real-time messaging.
- Generic task/ticket tracker.
- Calendar/video conferencing integration (Phase 3 adapters).

## 4. Shared enums

### 4.1 `DecisionRightsLevel`

| Value | Meaning |
| --- | --- |
| `direct` | Manager decides; member executes |
| `coach` | Manager shows how judgment is made |
| `negotiate` | Joint choice; shared commitment |
| `authorize` | Member decides inside fixed boundaries |
| `delegate` | Member may also optimize boundaries |

### 4.2 `EvidenceKind`

Aligned with “no runnable DEMO, no meeting”:

| Value | Notes |
| --- | --- |
| `data` | Metrics, tables, queries |
| `demo` | Runnable artifact / URL / recording of run |
| `user_quote` | Primary user language |
| `document` | Citable doc entity (RFC 0002) |
| `other` | Requires justification; discouraged |

Pure opinion without one of the above MUST NOT advance a Proposal past
`submitted`.

## 5. Core types

### 5.1 `Proposal`

Someone (human or agent) proposes a change to standards, context, or a
decision under existing standards.

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | |
| `kind` | enum | `new_standard` \| `revise_standard` \| `decision` \| `context_update` \| `hypothesis` |
| `title` | string | |
| `summary` | string | |
| `status` | enum | `draft` \| `submitted` \| `in_review` \| `accepted` \| `rejected` \| `withdrawn` |
| `author` | `ActorRef` | |
| `rights_level` | `DecisionRightsLevel` | Level at which this proposal is being handled |
| `boundary` | string | What is in/out of scope for the decision |
| `context_snapshot_id` | string \| null | Required before `submitted` for `decision` / standard kinds |
| `standard_bindings` | `StandardBinding[]` | Standards in force or under change |
| `single_uncertainty` | string \| null | Required for standard kinds (RFC 0001 gate 1) |
| `evidence` | `EvidenceRef[]` | At least one non-`other` to submit |
| `gap_id` | string \| null | Link to `StandardGap` |
| `outcome_ref` | `OutcomeRef` \| null | Set when accepted |
| `created_at` | datetime | |
| `updated_at` | datetime | |

### 5.2 `EvidenceRef`

| Field | Type |
| --- | --- |
| `kind` | `EvidenceKind` |
| `uri_or_ref` | string |
| `note` | string \| null |
| `claim_ids` | string[] | Optional links into context graph |

### 5.3 `OutcomeRef`

| Field | Type |
| --- | --- |
| `outcome_kind` | enum | `standard_version` \| `decision` \| `claim` \| `none` |
| `ref_id` | string \| null | |

`learning_output = no_standard_needed` maps to `outcome_kind = none` with an
audited reason on the Proposal.

### 5.4 `Decision`

A recorded judgment under pinned standards + context.

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | |
| `proposal_id` | string \| null | |
| `summary` | string | What was decided |
| `rationale` | string | |
| `decided_by` | `ActorRef` | |
| `rights_level` | `DecisionRightsLevel` | |
| `context_snapshot_id` | string | Required |
| `standard_bindings` | `StandardBinding[]` | Required, non-empty for operational decisions |
| `status` | enum | `committed` \| `superseded` \| `void` |
| `committed_at` | datetime | |

### 5.5 `Review`

Feedback loop: validate or falsify standards / hypotheses / decisions.

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | |
| `subject_kind` | enum | `standard_version` \| `decision` \| `hypothesis_claim` \| `agent_run` |
| `subject_id` | string | |
| `result` | enum | `validated` \| `falsified` \| `inconclusive` |
| `severity` | enum | `normal` \| `bad_news` | `bad_news` is first-class |
| `evidence` | `EvidenceRef[]` | |
| `context_snapshot_id` | string \| null | Snapshot used during review |
| `recommended_action` | enum | `solidify` \| `revise_standard` \| `open_gap` \| `none` |
| `author` | `ActorRef` | |
| `created_at` | datetime | |

`result = falsified` with `recommended_action = revise_standard` SHOULD open a
`Proposal(kind=revise_standard)` or `StandardGap`.

### 5.6 `Handoff`

Explicit human ↔ agent transfer. Not a chat DM.

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | |
| `direction` | enum | `agent_to_human` \| `human_to_agent` |
| `from` | `ActorRef` | |
| `to` | `ActorRef` | |
| `reason` | `HandoffReason` | |
| `proposal_id` | string \| null | |
| `decision_id` | string \| null | |
| `agent_run_id` | string \| null | RFC 0004 |
| `context_snapshot_id` | string | |
| `standard_bindings` | `StandardBinding[]` | |
| `payload` | object | Structured request/result; schema per reason |
| `status` | enum | `open` \| `acked` \| `resolved` \| `cancelled` |
| `created_at` | datetime | |
| `resolved_at` | datetime \| null | |

### 5.7 `HandoffReason`

**Agent → Human**

| Value | When |
| --- | --- |
| `standard_uncovered` | No applicable standard / boundary hit |
| `evidence_conflict` | Claims disagree inside snapshot |
| `permission_denied` | Access policy blocks needed claims |
| `acceptance_failed` | Output failed standard acceptance |
| `escalation_boundary` | Standard requires human judgment |

**Human → Agent**

| Value | When |
| --- | --- |
| `approve_proposal` | Run accepted proposal |
| `revise_standard` | Apply new version then continue |
| `enrich_context` | Rebuild snapshot with added claims |
| `set_boundary` | Execute inside explicit boundary |
| `retry_with_binding` | Re-run with pinned standard version |

## 6. Workshop mapping

| Workshop | Primary objects | Hard exit |
| --- | --- | --- |
| Meeting / decision session | `Proposal` → `Decision` | New/revised standard, decision, or hypothesis claim |
| Document | Context `Claim`/`Entity`, `StandardVersion` body | Citable ids only; oral does not count |
| Review | `Review` → optional `Proposal` / `StandardGap` | Validate / falsify / revise |

A session that produces none of the exits is a failed session (product should
surface this, not auto-create a chat archive as success).

## 7. Drift signal

When observed behavior (agent runs + human decisions) diverges from cited
`StandardVersion.action` / `acceptance`, the system opens a `Review` with
`severity` elevated when acceptance fails repeatedly. This is the product
hook for “declared standard vs observed behavior.”

## 8. Acceptance criteria

Two humans can move a Proposal to a Decision on one snapshot without private
alignment chat. A human and an agent can complete
Proposal → bound standard → execute → Review → revise using `Handoff` objects
only.

## 9. Open questions

- Whether `negotiate` requires dual `decided_by` signatures (proposal: yes,
  `co_deciders: ActorRef[]`).
- Minimum evidence count per Proposal kind.
