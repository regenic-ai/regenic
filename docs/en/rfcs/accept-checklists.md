# RFC Accept checklists (Phase 0)

- **中文:** [../../zh/rfcs/accept-checklists.md](../../zh/rfcs/accept-checklists.md)
- **Tracking:** [Milestone — Phase 0 — RFC acceptance](https://github.com/regenic-ai/regenic/milestone/1)

Close the matching GitHub Issue only after the checklist is green and both
locale RFC headers say `Accepted`.

## Wave A

### RFC 0001 — Standards data model

Issue: [#1](https://github.com/regenic-ai/regenic/issues/1)

- [x] EN/ZH field names, enums, and lifecycle graph match
- [x] `Standard` / `StandardVersion` / `Scope` / `IterationGate` / `UpgradeEvidence` /
      `TrialConfig` / `ActorRef` / `StandardGap` complete for Phase 1
- [x] Five gates are machine-checkable (not prose-only)
- [x] [book-schema-map.md](book-schema-map.md) SoftGate items resolved or deferred in §9
- [x] No conflict with 0002 (standard entity id), 0003 (gaps→proposals), 0004 (cite pins)
- [x] §9 open questions closed or explicitly deferred with owner

**Contract points (must verify):**

1. Book five-part body ↔ `condition` / `action` / `acceptance` / `boundary` /
   `revision_trigger`
2. Trial→active requires `UpgradeEvidence` (or audited waiver)
3. Apply/run bindings pin `standard_version_id` (no floating stored “latest”)

### RFC 0002 — Context graph

Issue: [#2](https://github.com/regenic-ai/regenic/issues/2)

- [x] EN/ZH field names and enums match
- [x] `Entity.kind=standard` references RFC 0001 `standard_id` without copying body
- [x] Claim `fact` / `hypothesis` / `opinion` rules clear; hypothesis needs validation window
- [x] `Provenance` + `AccessPolicy` present on Claim/Edge
- [x] Snapshot / ContextBundle immutability and replay rules clear
- [x] No conflict with 0001 / 0003 / 0004; direction compatible with 0005/0006

**Contract points (must verify):**

1. Same decision → same fact set via Snapshot
2. Opinion cannot feed trial→active evidence without conversion
3. Retract does not rewrite history; snapshots keep old claim ids

## Wave B

### RFC 0003 — Collaboration objects

Issue: [#3](https://github.com/regenic-ai/regenic/issues/3)

- [x] EN/ZH consistent
- [x] Proposal / Decision / Review / Handoff evidence + snapshot rules clear
- [x] Agent cannot activate standards alone (human accept path preserved)
- [x] No conflict with 0001/0002/0004

### RFC 0005 — Context storage & lifecycle

Issue: [#4](https://github.com/regenic-ai/regenic/issues/4)

- [x] EN/ZH consistent
- [x] Event / Blob / Digest / GC durability tiers clear
- [x] Event feeds Claim; does not replace 0002 graph semantics
- [x] No conflict with 0006/0007

## Wave C

### RFC 0004 — Human + Agent API

Issue: [#5](https://github.com/regenic-ai/regenic/issues/5)

- [ ] EN/ZH consistent
- [ ] `/v1/orgs/{org_id}/...` resource graph covers standards, context, collab, runs
- [ ] ActorRef + `on_behalf_of` rules clear
- [ ] Apply/run pin standard + snapshot
- [ ] No conflict with 0006

### RFC 0006 — ACL & Agent identity

Issue: [#6](https://github.com/regenic-ai/regenic/issues/6)

- [ ] EN/ZH consistent
- [ ] `visible()` and distill non-escalation clear
- [ ] Principal ↔ ActorRef mapping clear
- [ ] Weight ≠ ACL bypass (0007)

## Wave D

### RFC 0007 — Daily distillation

Issue: [#7](https://github.com/regenic-ai/regenic/issues/7)

- [ ] EN/ZH consistent
- [ ] D0 rules path vs D1 LLM boundary clear
- [ ] Human accept → Proposal / Standard feed clear
- [ ] ACL non-escalation preserved

## Related issues

| Issue | Title |
| --- | --- |
| [#8](https://github.com/regenic-ai/regenic/issues/8) | Align public schemas with regenic-book |
| [#9](https://github.com/regenic-ai/regenic/issues/9) | Spike: monorepo scaffold (no product logic) |
