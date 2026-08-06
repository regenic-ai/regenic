# RFC 0004 — Human + Agent API surface

- **Status:** Accepted
- **中文:** [../../zh/rfcs/0004-human-agent-api.md](../../zh/rfcs/0004-human-agent-api.md)
- **Depends on:** RFC 0001, RFC 0002, RFC 0003
- **Methodology:** Dual-capability model — humans own consensus and the next
  standard; agents execute what standards cover

## 1. Problem

If humans use a UI schema and agents use ad-hoc prompts against different
data, context fragments again. Regenic needs **one object model, two
presentations** (human UI and agent API) with hard bindings to
`standard_version` + `context_snapshot` on every execution.

## 2. Goals

1. Expose a **symmetric resource API** for standards, context, collaboration,
   and runs.
2. Force **pinned** standard + context on agent execution and human “apply
   standard” actions.
3. Return **observable** results (bindings, exceptions, handoff reasons).
4. Remain transport-agnostic in v1 (HTTP/JSON as the reference binding).

## 3. Non-goals

- Choosing a specific LLM vendor or agent framework.
- Slack/email adapters (Phase 3).
- Streaming token protocols (may be added later; resource contracts stay).

## 4. Authn / Authz

| Concept | Rule |
| --- | --- |
| Principal | Every request authenticates as `ActorRef` (`human` \| `agent` \| `system`) |
| Org | All paths are org-scoped: `/v1/orgs/{org_id}/...` |
| Access | Claim visibility follows RFC 0002 `AccessPolicy`; agents never receive denied claim bodies |
| Audit | Every mutating call writes an audit event with actor, resource, before/after hash |

Agents are first-class principals with scoped tokens; they do not impersonate
humans silently. Acting “on behalf of” a human requires an explicit
`on_behalf_of` field and policy allow.

## 5. Resource map

Symmetric resources (Human UI and Agent clients call the same routes):

| Resource | Path prefix | RFCs |
| --- | --- | --- |
| Standards | `/standards` | 0001 |
| Standard versions | `/standards/{id}/versions` | 0001 |
| Standard gaps | `/standard-gaps` | 0001 |
| Entities / claims / edges | `/context/...` | 0002 |
| Snapshots / bundles | `/context/snapshots`, `/context/bundles` | 0002 |
| Proposals | `/proposals` | 0003 |
| Decisions | `/decisions` | 0003 |
| Reviews | `/reviews` | 0003 |
| Handoffs | `/handoffs` | 0003 |
| Agent runs | `/runs` | this RFC |

### 5.1 Common conventions

- JSON request/response; `snake_case` fields matching RFC types.
- Idempotency: mutating POSTs accept `Idempotency-Key`.
- Errors: `{ "error": { "code", "message", "details?" } }`
- List endpoints support cursor pagination.

**Error codes (selected):**

| Code | When |
| --- | --- |
| `standard_binding_required` | Execute/decide without pinned version |
| `snapshot_required` | Missing `context_snapshot_id` |
| `gate_incomplete` | Promote without UpgradeEvidence |
| `evidence_required` | Submit Proposal without evidence |
| `access_denied` | Policy block |
| `single_uncertainty_required` | Standard proposal missing gate 1 |
| `handoff_required` | Agent hit boundary; must create Handoff |

## 6. Standards API (sketch)

```http
POST   /v1/orgs/{org_id}/standards
GET    /v1/orgs/{org_id}/standards/{standard_id}
POST   /v1/orgs/{org_id}/standards/{standard_id}/versions
POST   /v1/orgs/{org_id}/standards/versions/{version_id}:publish_trial
POST   /v1/orgs/{org_id}/standards/versions/{version_id}:promote
POST   /v1/orgs/{org_id}/standards/versions/{version_id}:deprecate
GET    /v1/orgs/{org_id}/standards/versions/{version_id}
```

Promotion validates RFC 0001 `UpgradeEvidence`. Failure → `gate_incomplete`.

## 7. Context API (sketch)

```http
POST   /v1/orgs/{org_id}/context/entities
POST   /v1/orgs/{org_id}/context/claims
POST   /v1/orgs/{org_id}/context/edges
POST   /v1/orgs/{org_id}/context/snapshots
GET    /v1/orgs/{org_id}/context/snapshots/{snapshot_id}
POST   /v1/orgs/{org_id}/context/bundles:resolve
```

`bundles:resolve` body:

```json
{
  "snapshot_id": "...",
  "principal": { "actor_type": "agent", "actor_id": "..." }
}
```

Response is a `ContextBundle` (RFC 0002). Two principals with equivalent policy
MUST see equal visible `content_hash`.

## 8. Collaboration API (sketch)

```http
POST   /v1/orgs/{org_id}/proposals
POST   /v1/orgs/{org_id}/proposals/{id}:submit
POST   /v1/orgs/{org_id}/proposals/{id}:accept
POST   /v1/orgs/{org_id}/proposals/{id}:reject
POST   /v1/orgs/{org_id}/decisions
POST   /v1/orgs/{org_id}/reviews
POST   /v1/orgs/{org_id}/handoffs
POST   /v1/orgs/{org_id}/handoffs/{id}:ack
POST   /v1/orgs/{org_id}/handoffs/{id}:resolve
```

`proposals:submit` enforces evidence + snapshot rules from RFC 0003.

## 9. Agent runs (execution surface)

### 9.1 `AgentRun`

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | |
| `agent` | `ActorRef` | `actor_type = agent` |
| `on_behalf_of` | `ActorRef` \| null | |
| `intent` | string | What to do |
| `status` | enum | `queued` \| `running` \| `succeeded` \| `failed` \| `handed_off` \| `cancelled` |
| `context_snapshot_id` | string | Required |
| `standard_bindings` | `StandardBinding[]` | Required, non-empty |
| `input` | object | Task-specific |
| `output` | `RunOutput` \| null | |
| `handoff_id` | string \| null | Set when `handed_off` |
| `started_at` | datetime \| null | |
| `finished_at` | datetime \| null | |

### 9.2 `RunOutput`

| Field | Type | Notes |
| --- | --- | --- |
| `summary` | string | |
| `artifacts` | object[] | |
| `applied_standard_version_ids` | string[] | Echo of bindings actually used |
| `context_snapshot_id` | string | Echo |
| `acceptance_check` | enum | `pass` \| `fail` \| `not_applicable` |
| `exceptions` | string[] | Boundary / uncovered cases |
| `confidence` | number \| null | |

### 9.3 Endpoints

```http
POST   /v1/orgs/{org_id}/runs
GET    /v1/orgs/{org_id}/runs/{run_id}
POST   /v1/orgs/{org_id}/runs/{run_id}:cancel
```

Create body MUST include `context_snapshot_id` and `standard_bindings`.
Missing either → hard error (no implicit “use latest org brain”).

When the agent hits a boundary, the run transitions to `handed_off` and
creates a `Handoff` with an Agent→Human reason. Continuing requires a
Human→Agent handoff resolve (or a new run with updated bindings/snapshot).

### 9.4 Human “apply standard” parity

```http
POST   /v1/orgs/{org_id}/decisions
```

Human UI “decide under this standard” is the same resource create as above:
pinned snapshot + bindings. There is no parallel undocumented path.

## 10. Closed loop (normative sequence)

```text
StandardGap or human intent
  → Proposal (+ evidence, snapshot, single_uncertainty)
  → accept → StandardVersion trial/active and/or Decision
  → Run (agent) or human execution under bindings
  → Review (validate | falsify)
  → revise standard / open gap / solidify
```

Copy-paste from chat is not an API step and MUST NOT be required to complete
the loop.

## 11. Drift detection hook

Implementations SHOULD periodically compare:

- cited `StandardVersion` acceptance criteria
- recent `AgentRun.output.acceptance_check` and human `Decision` outcomes

Repeated `fail` opens a `Review` (RFC 0003 §7). Exact scheduling is
implementation-defined.

## 12. Versioning

- API version prefix `/v1`.
- Additive changes preferred; breaking changes bump major.
- RFC object fields may evolve under Draft status without `/v1` bump until
  first production release freezes the contract.

## 13. Acceptance criteria

A human and one agent complete
Proposal → cite standard → Run → Review → revise
using only this API (plus Human UI as a client of the same API), without
exchanging private chat transcripts as the system of record.

## 14. Decisions (#5 — approved)

- [x] **Handoff notification in v1 is poll.** Optional webhook lands in Phase 3.
- [x] **Runs are always async.** Create returns immediate `202` + `run_id`.
