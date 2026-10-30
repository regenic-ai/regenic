# Roadmap

[简体中文](../zh/ROADMAP.md)

Regenic ships in layers. Each layer has to be useful on its own before the next one starts. The order is **individuals first (local-first), then teams and organizations**. For positioning, see the [product overview](PRODUCT.md).

| Phase | Goal | Status |
| --- | --- | --- |
| [Phase 0](#phase-0--architecture) | Data model and design RFCs | Done |
| [Phase 1](#phase-1--personal-message-workbench) | Connect, read, search, and reply to messages on your own machine | Mostly done |
| [Phase 2](#phase-2--processing-and-orchestration) | Analyze, route, and automatically process messages | In progress |
| [Phase 3](#phase-3--teams-and-organizations) | Merge several people's message streams into shared team context | Planned |
| [Phase 4](#phase-4--organization-workflows) | Run organization workflows on standards and context | Planned |

## Phase 0 — Architecture

Settle on a single data model, aligned with the public standards in [regenic-book](https://github.com/regenic-ai/regenic-book).

- [x] Data model for judgment standards — [RFC 0001](rfcs/0001-standards-data-model.md)
- [x] Context graph — [RFC 0002](rfcs/0002-context-graph.md)
- [x] Collaboration objects (Proposal / Decision / Review / Handoff) — [RFC 0003](rfcs/0003-collaboration-objects.md)
- [x] One API for humans and agents — [RFC 0004](rfcs/0004-human-agent-api.md)
- [x] Storage and lifecycle (Event / Blob / Digest / GC) — [RFC 0005](rfcs/0005-context-storage-lifecycle.md)
- [x] Permissions and agent identity — [RFC 0006](rfcs/0006-acl-agent-identity.md)
- [x] Daily distillation — [RFC 0007](rfcs/0007-daily-distillation.md)
- [x] [Technology stack](TECH_STACK.md) and [book schema map](rfcs/book-schema-map.md)

## Phase 1 — Personal message workbench

One person can connect real channels on their own machine, read, search, and reply in one place, without a vendor cloud, and export their data.

- [x] Local authoritative store (SQLite) and local blob storage
- [x] Connector host and an open [connector standard](CONNECTOR.md); uninstalling leaves no extra writes or grants behind
- [x] Built-in Feishu, DSH, and Cursor connectors
- [x] Plugin connectors for Slack, WhatsApp, Telegram, DingTalk, and WeCom (see the [connector catalog](CONNECTOR_CATALOG.md))
- [x] CSV / JSONL file import
- [x] Desktop workbench: conversations, unread state, pinning, hiding, manual triage
- [x] Replies go back to the original channel; read and send are granted separately
- [x] Cross-channel forwarding — [RFC 0010](rfcs/0010-cross-channel-forward.md)
- [x] Export as JSONL or Markdown
- [x] Remote kernel: run on your own server and pair the desktop app securely
- [ ] Optional remote history backup (off by default, turned on by the user)

## Phase 2 — Processing and orchestration

Make connected messages searchable, analyzable, and easy to hand to the right person or agent.

**Shipped**

- [x] Cross-channel search: keyword and local semantic retrieval, with sources and context
- [x] Executors: plug in an agent or model to answer from search results with citations — [Executors](EXECUTOR.md)
- [x] Recipes: route work items to executors by rule, on a schedule, with human confirmation — [RFC 0009](rfcs/0009-work-orchestration.md)
- [x] Swappable model service, including local models — [Local model service](LOCAL_MODEL_SERVICE.md)
- [x] Read-only MCP for external AI tools — [MCP](CONTEXT_SEARCH_MCP.md)
- [x] Follow-ups: surface conversations waiting on a reply in the workbench
- [x] Daily digests with sources, coverage gaps, and anomaly signals
- [x] Versioned judgment standards, gap intake, and drift signals
- [x] Policy-filtered Evidence Bundles for collaboration platforms and agents
- [x] Evidence-bound customer-service agent workflow — [Customer-service agent](CUSTOMER_SERVICE_AGENT.md)

**Next**

- [ ] Composable processing: filter, transform, analyze, route, and write back
- [ ] Proactive triage: decide what needs attention now against personal standards, and defer when unsure
- [ ] Review and revise digests, standards, and follow-ups in the workbench
- [ ] More connectors, and validation of existing ones on real accounts

**Done when:** a person's daily messages are identified, distilled, and routed by their own standards, with sourced conclusions, and at least one personal standard has been revised.

## Phase 3 — Teams and organizations

With consent, merge several people's message streams into shared team context.

- [ ] One canonical Event per source message, with a projection for each person — [Personal → org](rfcs/personal-to-org.md)
- [ ] Identity mapping and work-scope consent; merging never widens access (RFC 0006)
- [ ] Team digests, claims, and snapshots recomputed by team jobs, not copied from personal labels (RFC 0002, 0007)
- [ ] Collaboration and handoff on shared snapshots (RFC 0003)
- [ ] Full lifecycle for team-wide standards (RFC 0001)

**Done when:** two people ingest the same source message and get one canonical Event and two projections; team digests cite evidence without widening access.

## Phase 4 — Organization workflows

- [ ] Operations workflows built on standards and context, not form-first ERP
- [ ] One interface and API for both humans and agents (RFC 0004)
- [ ] Enterprise identity, notification, and compliance adapters, last rather than first

**Done when:** at least one real team (starting with bioby.ai) runs an end-to-end organization workflow on Regenic.

## Not planned

- Generic ERP modules (HR, finance, inventory)
- Positioning Regenic primarily as a chat replacement or a "second brain"
- Unbounded agent loops without standards and context constraints
- Turning personal AI labels into organizational facts without a team distillation step

## Get involved

Issues and milestones: [github.com/regenic-ai/regenic/issues](https://github.com/regenic-ai/regenic/issues). Design discussions live in the [RFCs](rfcs/README.md).
