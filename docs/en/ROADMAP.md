# Roadmap

[简体中文](../zh/ROADMAP.md)

Regenic ships in layers. Each layer must be usable on its own before the next
starts — the same progressive iteration gate described in the Regenic book.

## Phase 0 — Architecture (HardGate met)

- [x] RFC: data model for standards (definition, scope, version, lifecycle) —
  [rfc/0001](rfcs/0001-standards-data-model.md) — **Accepted**
- [x] RFC: context graph (entities, relationships, provenance, access) —
  [rfc/0002](rfcs/0002-context-graph.md) — **Accepted**
- [x] RFC: collaboration objects (Proposal / Decision / Review / Handoff) —
  [rfc/0003](rfcs/0003-collaboration-objects.md) — **Accepted**
- [x] RFC: human + agent API surface —
  [rfc/0004](rfcs/0004-human-agent-api.md) — **Accepted**
- [x] RFC: context storage & lifecycle (Event / Blob / Digest / GC) —
  [rfc/0005](rfcs/0005-context-storage-lifecycle.md) — **Accepted**
- [x] RFC: ACL scopes & Agent identity —
  [rfc/0006](rfcs/0006-acl-agent-identity.md) — **Accepted**
- [x] RFC: daily distillation (incl. D0 rules path) —
  [rfc/0007](rfcs/0007-daily-distillation.md) — **Accepted**
- [x] Technology stack — [TECH_STACK.md](TECH_STACK.md)
- [x] Align public schemas with `regenic-ai/regenic-book/content/*/standards/` —
  see [book-schema-map.md](rfcs/book-schema-map.md) (#8)
- [x] Accept RFCs (Draft → Accepted) via Issues review — **0001–0007 Accepted**
- [x] Spike: monorepo scaffold (no product semantics; see repo root)

**Exit criteria (HardGate):** Met — all seven RFCs Accepted and book schema
alignment done. Phase 1 product code may proceed on Accepted surfaces.

### Closeout order

Review in four waves by RFC dependency. On Accept, update both locale RFC
headers and [rfcs/README.md](rfcs/README.md).

| Wave | RFCs | Focus | Unlocks |
| --- | --- | --- | --- |
| A | 0001, 0002 | Standards model; Claim/Snapshot | SoftGate; `packages/domain` types |
| B | 0003, 0005 | Collaboration objects; Event/Blob/Digest | Collab + physical storage schema |
| C | 0004, 0006 | `/v1` API; ACL / Agent identity | OpenAPI + auth freeze |
| D | 0007 | Daily distill D0→accept | Worker distill jobs |

**SoftGate (Phase 1 product code allowed):** RFC **0001 Accepted** and book
schema alignment complete. All seven Accepted is not required.

**Spike (parallel with review):** `apps/api`, `apps/worker`, `packages/domain`,
`packages/config` + Docker Compose; health/connectivity only — no standards
CRUD, distillation, or ACL implementation.

Index: [rfcs/README.md](rfcs/README.md) · [TECH_STACK.md](TECH_STACK.md).

## Phase 1 — Judgment standards

Encode the book's **标准机器** (standards machine):

- [ ] Standard definition format (machine-readable + human-readable)
- [ ] Versioning and revision history
- [ ] Application hooks — how agents and humans cite / apply a standard
- [ ] Validation — detect drift between stated standard and observed behavior
- [ ] Progressive lifecycle — draft → trial → active with five gates
      (RFC 0001)

**Exit criteria:** A team can publish, apply, and revise one org-wide standard
without a separate chat thread per team.

## Phase 2 — Shared context

Encode the book's **共识机器** (consensus machine):

- [ ] Organizational context layer (not per-app silos)
- [ ] Provenance — where each context claim came from
- [ ] Access boundaries — who and which agents see what (RFC 0006)
- [ ] Physical ingest path — Event / Blob + hot-window index (RFC 0005)
- [ ] D0 daily distillation → human accept → Proposal/Standard feed (RFC 0007)
- [ ] Snapshots / bundles — same decision → same fact set (RFC 0002)
- [ ] Sync with standards — context updates trigger standard review when needed
- [ ] Collaboration loop — Proposal → Decision → Review on shared snapshots
      (RFC 0003)

**Exit criteria:** Two teams and one agent can share the same context snapshot
for a decision without copy-pasting from Slack; daily Digest respects ACL and
cites evidence Events.

## Phase 3 — Org management product

The default management surface for AI-native organizations:

- [ ] Operations workflows built on standards + context (not forms-first ERP)
- [ ] Agent-native interfaces alongside human UI (same API, RFC 0004)
- [ ] Integration adapters (identity, notifications, existing tools) — last, not first

**Exit criteria:** bioby.ai runs a real workflow end-to-end on Regenic.

---

## Non-goals (for now)

- Rebuilding generic ERP modules (HR, finance, inventory)
- Per-team chat replacement as the **primary** product story (ingest + distill
  first; optional Regenic-native comms shell is later)
- Importing private material from `regenic-internal`
- Unbounded agent orchestration without standard + context bindings

## Tracking

Milestones and issues: [github.com/regenic-ai/regenic/issues](https://github.com/regenic-ai/regenic/issues)
