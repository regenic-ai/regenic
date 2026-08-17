# Regenic

**Information processing layer for people and organizations.**

Regenic does **not** produce primary channel content (chat, mail, tickets, docs).
It **ingests** information (push or pull) and **processes** it — filter, layer,
distill facts, iterate judgment standards — so humans and agents can act under
shared standards and shared context.

Implements the [dual-capability model](https://regenic.ai/en/method) from
*Rewrite the DNA* / 《重写基因》:

1. **Unified judgment standards** — encode, apply, and revise standards
2. **Unified context** — one fact set for a decision, with provenance

Delivery order: **Personal (local-first) → Org**.
See [docs/en/PRODUCT.md](docs/en/PRODUCT.md).

[简体中文](README.zh-CN.md)

## Methodology source

The book, [regenic.ai](https://regenic.ai), and public standards live in
[**regenic-ai/regenic-book**](https://github.com/regenic-ai/regenic-book).

## Status

**Phase 0 HardGate met; Phase 1 = Personal processing.** Architecture RFCs
0001–0007 are Accepted. Current build focus is local-first personal ingest and
processing — not org ERP.

| Capability | Description | Status |
| --- | --- | --- |
| Information processing | Ingest → filter → layer → distill → standards (push/pull) | Product thesis ([PRODUCT](docs/en/PRODUCT.md)) |
| Personal (local-first) | One principal; open export; optional cloud history | Phase 1 (now) |
| Org overlay | Canonical Event + projections across people | Phase 3 ([personal → org](docs/en/rfcs/personal-to-org.md)) |
| Judgment standards | Versioned shared standards | RFC Accepted ([0001](docs/en/rfcs/0001-standards-data-model.md)) |
| Shared context | Claims, snapshots, Event/Blob | RFC Accepted ([0002](docs/en/rfcs/0002-context-graph.md), [0005](docs/en/rfcs/0005-context-storage-lifecycle.md)) |
| Collaboration | Proposal / Decision / Review / Handoff | RFC Accepted ([0003](docs/en/rfcs/0003-collaboration-objects.md)) |
| Symmetric API | Human UI and agents, same `/v1` | RFC Accepted ([0004](docs/en/rfcs/0004-human-agent-api.md)) |
| ACL + Agent identity | `visible()`; no distill escalation | RFC Accepted ([0006](docs/en/rfcs/0006-acl-agent-identity.md)) |
| Daily distillation | Standards-machine intake | RFC Accepted ([0007](docs/en/rfcs/0007-daily-distillation.md)) |

## Technology stack

See [TECH_STACK.md](docs/en/TECH_STACK.md). Personal defaults: SQLite, local
Blob, in-process jobs, Electron. Org adds PostgreSQL, object storage, Redis,
and Compose. Connectors, models, identity, and similar stay behind swappable
ports.

## Architecture RFCs

Accepted RFCs live under [`docs/en/rfcs/`](docs/en/rfcs/README.md). Personal and
Org share the same target model.

## Scaffold

The repo is a runnable skeleton (health checks, basic wiring). Real processing
starts in Phase 1. Compose below is for local/dev wiring; the Personal product
defaults to on-machine / desktop-embedded, not this cloud-shaped stack.

```bash
pnpm install
docker compose up --build
curl -s http://localhost:3000/health
```

## Local Slack Connector

The local CLI configures and runs a single Slack channel against the SQLite and
filesystem stores. It never writes an access token to the database; provide the
token only through the referenced environment variable when synchronizing.

```bash
pnpm local slack-install --database ./regenic.db --org local-owner \
	--channel C123 --channel-name engineering --id slack-engineering

REGENIC_SLACK_TOKEN=xoxb-... pnpm local slack-sync \
	--database ./regenic.db --blob-root ./blobs --installation slack-engineering \
	--max-pages 20

pnpm local status --database ./regenic.db --org local-owner
pnpm local quarantines --database ./regenic.db --installation slack-engineering

pnpm local connector-disable --database ./regenic.db --org local-owner \
	--installation slack-engineering
pnpm local connector-enable --database ./regenic.db --org local-owner \
	--installation slack-engineering
pnpm local reset-cursor --database ./regenic.db --org local-owner \
	--installation slack-engineering --stream channel:C123
```

## Local File Import

Import CSV or JSONL through an explicit JSON mapping file. Invalid rows are
reported while valid rows are ingested through the same canonical path.

```json
{
	"mapping": {
		"external_id": "id",
		"occurred_at": "timestamp",
		"text": "body",
		"actor_id": "author"
	},
	"defaults": {
		"actor_id": "local-owner",
		"scope_id": "personal",
		"type": "text"
	}
}
```

```bash
pnpm local import-file --database ./regenic.db --blob-root ./blobs \
	--file ./messages.csv --mapping ./mapping.json --format csv \
	--org local-owner --source local-file
```

## Local JSONL Export

Export append-only Event metadata as JSONL. Each line includes provenance and a
content hash reference, never inline Blob bytes.

```bash
pnpm local export-jsonl --database ./regenic.db --org local-owner \
	--output ./events.jsonl
```

## Local Markdown Digest

Render a date-grouped Markdown view of append-only text Events. Every entry
keeps Event and Blob evidence references, with deterministic operation and
quarantine status counts.

```bash
pnpm local render-digest --database ./regenic.db --blob-root ./blobs \
	--org local-owner --output ./digest.md
```

## Roadmap

[ROADMAP](docs/en/ROADMAP.md) · [PRODUCT](docs/en/PRODUCT.md) ·
[TECH_STACK](docs/en/TECH_STACK.md) ·
[Ingestion architecture](docs/en/INGESTION_ARCHITECTURE.md)

## Contributing

Cite the owning RFC on feature PRs, and keep changes aligned with
[PRODUCT.md](docs/en/PRODUCT.md): information processing, Personal before Org.
Discussion: [Issues](https://github.com/regenic-ai/regenic/issues).

Please follow the [Code of Conduct](https://github.com/regenic-ai/regenic-book/blob/main/CODE_OF_CONDUCT.md).
Security reports: [private advisory](https://github.com/regenic-ai/regenic/security/advisories/new).

## License

MIT — see [LICENSE](LICENSE).

Methodology content in `regenic-ai/regenic-book` remains under CC BY-NC 4.0 where applicable.
