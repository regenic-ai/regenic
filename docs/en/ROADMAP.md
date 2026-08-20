# Roadmap

[简体中文](../zh/ROADMAP.md)

Regenic ships in layers. Each layer must be usable on its own before the next starts.

Regenic orchestrates messages. It connects to existing channels. Judgment standards and personal habits decide which messages need handling now; those reach a message console. The rest stay outside the current work. Replies go back to the original channel. Delivery is **Personal (local-first)**, then Org. See [PRODUCT.md](PRODUCT.md) and [MESSAGE_ORCHESTRATION.md](MESSAGE_ORCHESTRATION.md).

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
alignment done.

Index: [rfcs/README.md](rfcs/README.md) · [TECH_STACK.md](TECH_STACK.md) ·
[PRODUCT.md](PRODUCT.md) · [MESSAGE_ORCHESTRATION.md](MESSAGE_ORCHESTRATION.md) ·
[personal → org](rfcs/personal-to-org.md).

## Phase 1 — Personal message orchestration (now)

Local-first orchestration for one person. Sync and webhook both count as real
connectors. Regenic orchestrates messages; it does not create the
channel content.

- [ ] Connector host: connectors mount beside the kernel; unload leaves no
      leftover writes or grants
- [ ] On-disk authority store (SQLite by default) + local Blob directory;
      in-process job queue
- [ ] At least one real channel connector (`ChannelConnector`, pull and/or push)
- [ ] Filter and layer into Event / Blob (RFC 0005 shapes, personal scope)
- [ ] Message console: what needs handling now (priority, “need to know”,
      follow-up such as unreplied)
- [ ] Open export (Markdown / JSONL)
- [ ] Optional remote history (off by default; user-controlled; not org DB)
- [ ] Personal rules / light standards hooks (path toward RFC 0001)
- [ ] Collaboration-platform source contract discovery and export adapter fixtures
  before any vendor-specific connector (see [integration architecture](CONTEXT_PLATFORM_INTEGRATION.md))

**Done when:** one person can connect a real channel locally, run
filter → layer → distill → dispatch without a vendor cloud, and export their data.

**Not in Phase 1:** outliner / general note suite, org canonical aggregation,
multi-tenant ACL.

## Phase 2 — Deepen personal processing + standards path

- [ ] Stronger distill (personal Digest; D0-style rules where useful)
- [ ] Personal standard / rule iteration (subset of RFC 0001 lifecycle)
- [ ] Drift signals between stated rules and observed follow-through
- [ ] More channel connectors; swappable ModelProvider for propose-only steps
- [ ] First send path (`EgressAdapter`) on the same channel as connect;
      send requires an explicit grant (distill does not imply `can_send`)
- [ ] Dispatcher: rest stay outside current work; uncertain → pending/defer, against a
      personal standard
- [ ] Policy-filtered Evidence Bundle publication for collaboration and Agent OS consumers

**Exit criteria:** Personal loop includes evidence-backed distill and at least
one revised personal rule/standard without chat as system of record.

## Phase 3 — Org overlay

Stitch consented personal streams into org-shared truth.

- [ ] Canonical Event + Projection model ([personal → org](rfcs/personal-to-org.md))
- [ ] Identity mapping; work-scope consent; no privilege escalation (RFC 0006)
- [ ] Org Digest / Claim / Snapshot (RFC 0002, 0007) — org job re-derives,
      does not blindly copy personal labels
- [ ] Collaboration loop on shared snapshots (RFC 0003)
- [ ] Full standards machine for org-wide standards (RFC 0001)

**Exit criteria:** Two people ingest the same source message → one canonical
Event + two projections; org Digest cites evidence without elevating ACL.

## Phase 4 — Org management product

- [ ] Operations workflows on standards + context (not forms-first ERP)
- [ ] Agent-native UI beside human UI (same API, RFC 0004)
- [ ] Enterprise adapters (IdP, notify, compliance) — last, not first

**Exit criteria:** bioby.ai runs a real org workflow end-to-end on Regenic.

---

## Out of scope

- Rebuilding generic ERP modules (HR, finance, inventory)
- Chat replacement or second-brain as the **primary** product story
- Importing private material from `regenic-internal`
- Unbounded agent loops without standard + context bindings
- Promoting personal AI labels to org truth without an org distill job

## Tracking

Milestones and issues: [github.com/regenic-ai/regenic/issues](https://github.com/regenic-ai/regenic/issues)
