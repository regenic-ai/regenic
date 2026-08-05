# Regenic

**Default organizational management software for AI-native organizations.**

Regenic implements the [dual-capability model](https://regenic.ai/en/method) from
*Rewrite the DNA* / 《重写基因》:

1. **Unified judgment standards** — encode, apply, and revise standards that humans and agents share
2. **Unified context** — one organizational context layer instead of per-team chat silos

Not more control on fragmented context.

[简体中文](README.zh-CN.md)

## Methodology source

The book, [regenic.ai](https://regenic.ai), and public standards live in
[**regenic-ai/regenic-book**](https://github.com/regenic-ai/regenic-book).

## Status

**Early stage.** Architecture RFCs first; implementation follows the public
methodology in `regenic-book`.

| Capability | Description | Status |
| --- | --- | --- |
| Judgment standards | Define, version, apply, and revise org-wide standards | RFC Draft ([0001](docs/en/rfcs/0001-standards-data-model.md)) |
| Shared context | Single context layer for people, teams, and agents | RFC Draft ([0002](docs/en/rfcs/0002-context-graph.md), [0005](docs/en/rfcs/0005-context-storage-lifecycle.md)) |
| Human + agent collaboration | Proposal / Decision / Review / Handoff on shared objects | RFC Draft ([0003](docs/en/rfcs/0003-collaboration-objects.md)) |
| Symmetric API | Human UI and agents read/write the same surface | RFC Draft ([0004](docs/en/rfcs/0004-human-agent-api.md)) |
| ACL + Agent identity | Same visible() for humans and agents; no privilege escalation via distill | RFC Draft ([0006](docs/en/rfcs/0006-acl-agent-identity.md)) |
| Daily distillation | Weighted daily intake into standards machine (D0 rules → D1 LLM) | RFC Draft ([0007](docs/en/rfcs/0007-daily-distillation.md)) |
| Org management | AI-native operations on standards and context—not hierarchy and approvals as the information layer | Planned |

## Architecture RFCs

Phase 0 drafts under [`docs/en/rfcs/`](docs/en/rfcs/README.md):

1. [Standards data model](docs/en/rfcs/0001-standards-data-model.md) — lifecycle, five gates, progressive generation
2. [Context graph](docs/en/rfcs/0002-context-graph.md) — claims, snapshots, provenance, access
3. [Collaboration objects](docs/en/rfcs/0003-collaboration-objects.md) — human and human–agent handoffs
4. [Human + Agent API surface](docs/en/rfcs/0004-human-agent-api.md) — symmetric `/v1` contract
5. [Context storage & lifecycle](docs/en/rfcs/0005-context-storage-lifecycle.md) — Event / Blob / Digest / GC
6. [ACL & Agent identity](docs/en/rfcs/0006-acl-agent-identity.md) — scopes, bindings, `visible()`
7. [Daily distillation](docs/en/rfcs/0007-daily-distillation.md) — standards-machine intake (+ D0 sketch)

## Roadmap

[docs/en/ROADMAP.md](docs/en/ROADMAP.md)

## Contributing

Regenic is not accepting feature PRs until the initial architecture RFCs are
Accepted. Discussion welcome via [Issues](https://github.com/regenic-ai/regenic/issues).

Follow the org [Code of Conduct](https://github.com/regenic-ai/regenic-book/blob/main/CODE_OF_CONDUCT.md).
Security reports: [private advisory](https://github.com/regenic-ai/regenic/security/advisories/new).

## License

MIT — see [LICENSE](LICENSE).

Methodology content in `regenic-ai/regenic-book` remains under CC BY-NC 4.0 where applicable.
