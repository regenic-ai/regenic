# Architecture RFCs

Phase 0 of Regenic lands as accepted RFCs before production code.
Methodology source: [regenic-ai/regenic-book](https://github.com/regenic-ai/regenic-book).

[简体中文](../../zh/rfcs/README.md)

| RFC | Title | Status |
| --- | --- | --- |
| [0001](0001-standards-data-model.md) | Standards data model | Accepted |
| [0002](0002-context-graph.md) | Context graph | Draft |
| [0003](0003-collaboration-objects.md) | Collaboration objects | Draft |
| [0004](0004-human-agent-api.md) | Human + Agent API surface | Draft |
| [0005](0005-context-storage-lifecycle.md) | Context storage & lifecycle | Draft |
| [0006](0006-acl-agent-identity.md) | ACL scopes & Agent identity | Draft |
| [0007](0007-daily-distillation.md) | Daily distillation | Draft |

Phase 0 closeout:

| Path | Related |
| --- | --- |
| [accept-checklists.md](accept-checklists.md) | Wave A–D Accept checklists |
| [book-schema-map.md](book-schema-map.md) | Book ↔ RFC 0001 SoftGate map |
| [sketch/d0-daily-distill.sql](sketch/d0-daily-distill.sql) | RFC 0007 D0 |

Milestone: [Phase 0 — RFC acceptance](https://github.com/regenic-ai/regenic/milestone/1).

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
```

## Review

Discussion: [GitHub Issues](https://github.com/regenic-ai/regenic/issues).
Scaffold/spike PRs are OK; feature PRs wait for Accepted RFCs (see root README).
