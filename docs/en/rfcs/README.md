# Architecture RFCs

Phase 0 of Regenic lands as accepted RFCs before production code.
Methodology source: [regenic-ai/regenic-book](https://github.com/regenic-ai/regenic-book).

[简体中文](../../zh/rfcs/README.md)

| RFC | Title | Status |
| --- | --- | --- |
| [0001](0001-standards-data-model.md) | Standards data model | Accepted |
| [0002](0002-context-graph.md) | Context graph | Accepted |
| [0003](0003-collaboration-objects.md) | Collaboration objects | Accepted |
| [0004](0004-human-agent-api.md) | Human + Agent API surface | Accepted |
| [0005](0005-context-storage-lifecycle.md) | Context storage & lifecycle | Accepted |
| [0006](0006-acl-agent-identity.md) | ACL scopes & Agent identity | Accepted |
| [0007](0007-daily-distillation.md) | Daily distillation | Accepted |
| [0008](0008-thread-surface.md) | Thread Surface | Accepted |
| [0009](0009-work-orchestration.md) | Record class, thread facet, hosted execution (L0–L6) | Accepted |
| [0010](0010-cross-channel-forward.md) | Cross-channel forward | Draft |

Phase 0 closeout + product path:

| Path | Related |
| --- | --- |
| [accept-checklists.md](accept-checklists.md) | Wave A–D Accept checklists |
| [book-schema-map.md](book-schema-map.md) | Book ↔ RFC 0001 SoftGate map |
| [personal-to-org.md](personal-to-org.md) | Personal store → org canonical |
| [sketch/d0-daily-distill.sql](sketch/d0-daily-distill.sql) | RFC 0007 D0 |
| [../PRODUCT.md](../PRODUCT.md) | Product |
| [../MESSAGE_ORCHESTRATION.md](../MESSAGE_ORCHESTRATION.md) | Message flow and plugin assembly |

Milestone: [Phase 0 — RFC acceptance](https://github.com/regenic-ai/regenic/milestone/1) (closed; HardGate met).

## Conventions

- One RFC per concern; later RFCs may depend on earlier numbers.
- Schemas use JSON-compatible field names (`snake_case`).
- Status values: `Draft` → `Accepted` → `Superseded`.
- Public standard markdown in `regenic-book` remains human-readable; these RFCs
  define the machine-readable product model that maps to it.
- Code identifiers, API paths, and enum values stay English everywhere.

## Layering (read order for context path)

```
0001 Standards
0002 Context graph (logical claims / snapshots)
0003 Collaboration objects
0004 Symmetric API
0005 Physical storage (Event / Blob / Digest / GC)
0006 ACL + Agent identity (implements AccessPolicy for ops data)
0007 Daily distillation (standards-machine intake)
0008 Thread Surface (live prompts + attention)
0009 Record class / thread facet / work items / executors (L0–L6)
0010 Cross-channel forward (compile + send, do not move)
```

## Review

Discussion: [GitHub Issues](https://github.com/regenic-ai/regenic/issues).
Phase 0 HardGate met — all RFCs Accepted. Feature PRs may cite these RFCs
(see root README).
