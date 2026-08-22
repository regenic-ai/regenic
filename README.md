# Regenic

Message orchestration for people and organizations.

Regenic is an open-source message orchestration layer. It connects to chat, mail, tickets, and documents already in use. Judgment standards and personal habits decide which messages need handling now; those land in a console shared by humans and agents. The rest stay outside the current work. Replies go back to the original channel.

Access control and judgment standards stay in a small kernel.

Delivery order is **Personal (local-first)**, then Org. See [PRODUCT.md](docs/en/PRODUCT.md) and [MESSAGE_ORCHESTRATION.md](docs/en/MESSAGE_ORCHESTRATION.md).

[简体中文](README.zh-CN.md)

## Desktop app

Need Node 20+ and [pnpm](https://pnpm.io).

```bash
pnpm install
pnpm dev:desktop
```

## Connect DSH

`dsh` has to work in your terminal. Start the web server first:

```bash
dsh web --port 3080
```

In the app: **Engine** → **DSH** → **Install**. Transport: **Web**. Leave Session ID empty to follow every session, or fill one. Base URL defaults to `http://127.0.0.1:3080` (localhost only). If `dsh web` wants a token, set `REGENIC_DSH_TOKEN` before you start the desktop app.

## Status

Phase 0 is complete. RFCs 0001–0007 are Accepted. Phase 1 is local-first connectors and the kernel.

| Capability | Description | Status |
| --- | --- | --- |
| Message orchestration | Connect sources → unify messages → rank → dispatch → optional reply | [PRODUCT](docs/en/PRODUCT.md) · [architecture](docs/en/MESSAGE_ORCHESTRATION.md) |
| Connectors | Slack, DSH, file import; more channels later | Phase 1 (now) |
| Personal | One principal; open export; optional remote history | Phase 1 (now) |
| Org | Canonical Event + projections across people | Phase 3 ([personal → org](docs/en/rfcs/personal-to-org.md)) |
| Standards | Versioned shared standards | RFC Accepted ([0001](docs/en/rfcs/0001-standards-data-model.md)) |
| Context | Claims, snapshots, Event/Blob | RFC Accepted ([0002](docs/en/rfcs/0002-context-graph.md), [0005](docs/en/rfcs/0005-context-storage-lifecycle.md)) |
| Collaboration | Proposal / Decision / Review / Handoff | RFC Accepted ([0003](docs/en/rfcs/0003-collaboration-objects.md)) |
| API | Humans and agents use the same `/v1` | RFC Accepted ([0004](docs/en/rfcs/0004-human-agent-api.md)) |
| ACL | `visible()`; distill does not raise privilege; send is a grant | RFC Accepted ([0006](docs/en/rfcs/0006-acl-agent-identity.md)) |
| Distillation | Intake for the standards machine | RFC Accepted ([0007](docs/en/rfcs/0007-daily-distillation.md)) |

Method, site, and public standards: [regenic-ai/regenic-book](https://github.com/regenic-ai/regenic-book). Store and runtime defaults: [TECH_STACK.md](docs/en/TECH_STACK.md).

## Local development

Daily use is the [desktop app](#desktop-app). Compose is for API and worker work.

```bash
pnpm install
docker compose up --build
curl -s http://localhost:3000/health
```

## Local CLI

The local CLI syncs connectors against SQLite and a filesystem Blob store. Access tokens are not written to the database. Pass the token through the referenced environment variable when synchronizing.

### Slack connector

```bash
pnpm local slack-install --database ./regenic.db --org local-owner \
	--channel C123 --channel-name engineering --id slack-engineering

REGENIC_SLACK_TOKEN=xoxb-... pnpm local slack-sync \
	--database ./regenic.db --blob-root ./blobs --installation slack-engineering \
	--max-pages 20

pnpm local status --database ./regenic.db --org local-owner
pnpm local inbox --database ./regenic.db --org local-owner
pnpm local quarantines --database ./regenic.db --installation slack-engineering

pnpm local connector-disable --database ./regenic.db --org local-owner \
	--installation slack-engineering
pnpm local connector-enable --database ./regenic.db --org local-owner \
	--installation slack-engineering
	pnpm local reset-cursor --database ./regenic.db --org local-owner \
		--installation slack-engineering --stream channel:C123
```

### DSH from the CLI

Same job as [Connect DSH](#connect-dsh), from a terminal. Start `dsh web --port 3080` first if you use Web.

```bash
pnpm local dsh-install --database ./regenic.db --org local-owner \
	--transport web --session <sessionId> --base-url http://127.0.0.1:3080 \
	--id dsh-main

pnpm local dsh-sync --database ./regenic.db --blob-root ./blobs \
	--installation dsh-main --max-pages 20

pnpm local dsh-send --database ./regenic.db --installation dsh-main \
	--text "Follow up on the last turn"
```

`--session` is optional; omit it to follow every session. CLI transport (no `dsh web`):

```bash
pnpm local dsh-install --database ./regenic.db --org local-owner \
	--transport cli --mailbox dsh-main --id dsh-main
```

If `dsh web` wants a token, set `REGENIC_DSH_TOKEN`. The API process needs `REGENIC_DATABASE` and `REGENIC_BLOB_ROOT`. If `REGENIC_DSH_API_TOKEN` is set, callers send `Authorization: Bearer`.

```http
POST /v1/dsh/api/session.history
POST /v1/dsh/api/session.prompt
POST /v1/dsh/api/session.list
POST /v1/dsh/api/session.create
```

### File import

Import CSV or JSONL through an explicit JSON mapping file. Invalid rows are reported; valid rows become the same kind of message as a channel sync.

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

### Personal WhatsApp export

Personal WhatsApp uses a user-triggered, read-only JSONL export. The first
bridge does not receive browser cookies, scan chats in the background, or send
messages. Each exported message has stable `chat_id` and `message_id` values.

```bash
pnpm local whatsapp-import --database ./regenic.db --blob-root ./blobs \
	--file ./whatsapp-personal.jsonl --org local-owner \
	--local-principal local-user
```

### Inbox

List current-work messages after kernel filter and layer. Acknowledgements, tombstones, and ordinary thread replies stay stored as Events and stay out of this list.

```bash
pnpm local inbox --database ./regenic.db --org local-owner
```

### JSONL export

Export append-only Event metadata as JSONL. Each line includes provenance and a content hash, never inline Blob bytes.

```bash
pnpm local export-jsonl --database ./regenic.db --org local-owner \
	--output ./events.jsonl
```

### Markdown digest

Render a date-grouped Markdown view of append-only text Events. Every entry keeps Event and Blob evidence references.

```bash
pnpm local render-digest --database ./regenic.db --blob-root ./blobs \
	--org local-owner --output ./digest.md
```

### Evidence bundle

Publish bounded committed Event references for a declared consumer and purpose. The local JSONL driver never includes Blob bodies or connector credentials.

```bash
pnpm local publish-evidence-bundle --database ./regenic.db --org local-owner \
	--consumer teamily-workspace --purpose research-context --max-events 100 \
	--output ./evidence-bundles.jsonl
```

## Documentation

[Message orchestration](docs/en/MESSAGE_ORCHESTRATION.md) ·
[PRODUCT](docs/en/PRODUCT.md) · [ROADMAP](docs/en/ROADMAP.md) ·
[TECH_STACK](docs/en/TECH_STACK.md) ·
[Desktop](docs/zh/DESKTOP.md) ·
[Ingestion](docs/en/INGESTION_ARCHITECTURE.md)

## Contributing

Pull requests should cite the owning RFC and stay aligned with [PRODUCT.md](docs/en/PRODUCT.md). Discussion: [Issues](https://github.com/regenic-ai/regenic/issues).

Follow the [Code of Conduct](https://github.com/regenic-ai/regenic-book/blob/main/CODE_OF_CONDUCT.md).
Report security issues with a [private advisory](https://github.com/regenic-ai/regenic/security/advisories/new).

## License

[MIT](LICENSE).

Methodology in `regenic-ai/regenic-book` remains CC BY-NC 4.0 where that license applies.
