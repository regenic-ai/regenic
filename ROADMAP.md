# Roadmap

Regenic ships in layers. Each layer must be usable on its own before the next
starts — the same progressive iteration gate described in the Regenic book.

## Phase 0 — Architecture (now)

- [ ] RFC: data model for standards (definition, scope, version, lifecycle)
- [ ] RFC: context graph (entities, relationships, provenance, access)
- [ ] RFC: human + agent API surface
- [ ] Align public schemas with `regenic-ai/regenic-book/content/*/standards/`

**Exit criteria:** Accepted RFCs, no production code required.

## Phase 1 — Judgment standards

Encode the book's **标准机器** (standards machine):

- [ ] Standard definition format (machine-readable + human-readable)
- [ ] Versioning and revision history
- [ ] Application hooks — how agents and humans cite / apply a standard
- [ ] Validation — detect drift between stated standard and observed behavior

**Exit criteria:** A team can publish, apply, and revise one org-wide standard
without a separate chat thread per team.

## Phase 2 — Shared context

Encode the book's **共识机器** (consensus machine):

- [ ] Organizational context layer (not per-app silos)
- [ ] Provenance — where each context claim came from
- [ ] Access boundaries — who and which agents see what
- [ ] Sync with standards — context updates trigger standard review when needed

**Exit criteria:** Two teams and one agent can share the same context snapshot
for a decision without copy-pasting from Slack.

## Phase 3 — Org management product

The default management surface for AI-native organizations:

- [ ] Operations workflows built on standards + context (not forms-first ERP)
- [ ] Agent-native interfaces alongside human UI
- [ ] Integration adapters (identity, notifications, existing tools) — last, not first

**Exit criteria:** bioby.ai runs a real workflow end-to-end on Regenic.

---

## Non-goals (for now)

- Rebuilding generic ERP modules (HR, finance, inventory)
- Per-team chat replacement as the primary product story
- Importing private material from `regenic-internal`

## Tracking

Milestones and issues: [github.com/regenic-ai/regenic/issues](https://github.com/regenic-ai/regenic/issues)
