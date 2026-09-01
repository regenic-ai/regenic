# Regenic

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D20-blue.svg)](https://nodejs.org/)
[![pnpm](https://img.shields.io/badge/pnpm-9-blue.svg)](https://pnpm.io)

[简体中文](README.zh-CN.md) | [English](README.md)

**Everything is Context. Unified Context.**

Regenic is an open-source message orchestration layer for people and agents.

It does not replace Feishu, Slack, WhatsApp, or your local agent. Those tools keep writing messages where they already live. Regenic sits underneath them: it turns channel traffic into one shared context — evidence with provenance, a console that lists only what needs you now, and replies that go back to the original app.

If an agent harness says *everything is a plugin*, Regenic says *everything is context*. Chat, agent turns, files, and digests become the same kind of record. Versioned judgment standards decide what enters the workbench. Humans and automation share one `/v1`. Accounts, tokens, and rules stay on this computer.

What ships today is **one person, data on this machine**. Shared records across a team come later. See [PRODUCT.md](docs/en/PRODUCT.md) and [MESSAGE_ORCHESTRATION.md](docs/en/MESSAGE_ORCHESTRATION.md).

[Install](#installation--quick-start) · [Add Feishu, Slack, or DSH](#add-feishu-slack-or-dsh) · [Login and tokens](#login-and-tokens) · [Local CLI](#local-cli) · [Status](#status) · [Security](#security) · [Docs](#documentation) · [Contributing](#contributing)

## Why context

Agents need tools. People need channels. Both already exist.

What is missing is a place where Feishu, Slack, a local agent session, and a file export mean the **same thing** — one message shape, one evidence trail, one inbox of work that actually needs a human or an agent right now. That place is Regenic.

Context is not a dump of every chat. It is the curated, attributable record that judgment standards and personal habits use to decide what enters the console and what stays outside the current work.

## What it does

- **Channels stay channels** — Feishu stays Feishu, Slack stays Slack. Regenic reads, ranks, and writes back. It does not replace them.
- **One context, many sources** — connectors normalize traffic into Event / Blob; digests and claims keep provenance.
- **The console lists what needs you now** — not every group chat dumped in one place.
- **People and automation share one API** — the desktop app and scripts both use `/v1`.
- **Tokens stay out of the database** — environment variables or the OS keychain. The install form does not take them.
- **One person first, then a team** — this computer is the source of truth. Shared records across people come later.

## Personal or team

| You are… | What to do |
| --- | --- |
| **One person** — desktop app on this computer, plus Feishu, Slack, or DSH | Follow [Quick Start](#installation--quick-start) |
| **Working from a terminal** — sync, import, export | See [Local CLI](#local-cli) |
| **A team sharing one record** | Not built yet. See [personal → org](docs/en/rfcs/personal-to-org.md) |

## Features

| Area | What you can do | Now |
| --- | --- | --- |
| Desktop app | Local window: messages that need you, engine, settings. Closing it does not quit | works |
| DSH | Read sessions, send text; leave session empty to follow all of them, and create new ones | works |
| Feishu | Read groups and direct messages, send text. Sign in as yourself with official `lark-cli` | works |
| Slack | Read one channel | read only, no reply |
| File import | CSV / JSONL, with a map of which column is which | CLI |
| WhatsApp | Read-only Purr WA CSV or Export v1 JSONL selected by the user | desktop + CLI |
| Export | Message JSONL, daily Markdown, a citation list for another tool | CLI |
| Context | Deterministic snapshots and optional cited model answers | API + CLI |

## Installation & Quick Start

### Requirements

- Node.js 20+
- [pnpm](https://pnpm.io)

Feishu, Slack, and DSH each need their own tool installed first. See [Add Feishu, Slack, or DSH](#add-feishu-slack-or-dsh).

### Quick Start (for you)

#### Open the app

```bash
pnpm install
pnpm dev:desktop
```

#### Add Feishu, Slack, or DSH in the app

In the app: **Engine** → **DSH** / **Feishu** / **Slack** → **Install**.

Install and sign in to that tool first, then click Install. Feishu needs `lark-cli` signed in. DSH needs `dsh web` running. Steps are under [Add Feishu, Slack, or DSH](#add-feishu-slack-or-dsh).

### Quick Start (for an AI assistant)

These steps are for an assistant helping with install. Some of them need the user in a browser.

**Step 1 — Open the app**

```bash
pnpm install
pnpm dev:desktop
```

**Step 2 — Get the tool ready for whichever one they want**

Feishu:

```bash
npx @larksuite/cli@latest install
```

`lark-cli config init` and `lark-cli auth login --recommend` print an authorization URL. Send that URL to the user. The command exits after they finish in the browser. Then run `lark-cli auth status`.

DSH: confirm `dsh` works in the terminal, then `dsh web --port 3080`.

**Step 3 — Have the user click Install in the app**

**Engine** → the one you just prepared → **Install**. Feishu: all groups and direct messages by default, or tick the ones to sync. You can change that later with **Edit sync**. DSH Session ID can stay empty.

## Add Feishu, Slack, or DSH

### DSH

`dsh` has to work in your terminal. Start the web server first:

```bash
dsh web --port 3080
```

In the app: **Engine** → **DSH** → **Install**. Transport: **Web**. Leave Session ID empty to follow every session, or fill one. Base URL defaults to `http://127.0.0.1:3080` (localhost only). If `dsh web` wants a token, set `REGENIC_DSH_TOKEN` before you start the desktop app.

### Feishu

Sign in as yourself with the official [lark-cli](https://github.com/larksuite/cli). Full steps: [lark-cli README](https://github.com/larksuite/cli/blob/main/README.md).

**Install**

```bash
npx @larksuite/cli@latest install
```

**Configure and sign in**

```bash
# 1. Set up the app (once; finishes in the browser)
lark-cli config init

# 2. Sign in (--recommend picks the common scopes)
lark-cli auth login --recommend

# 3. Confirm you are signed in
lark-cli auth status
```

`config init` and `auth login` each print an authorization URL. Complete it in the browser; the command exits on its own.

**Add conversations in the app**

In the app: **Engine** → **Feishu** → **Install**. Default is **All groups** and **All direct messages**. Switch to **Choose conversations** to tick specific ones. After install, **Edit sync** changes the same set. The form loads groups and p2p chats from `lark-cli`. You do not paste `oc_…`.

The Engine page checks whether `lark-cli` is installed and whether you are signed in. The two cases show different hints. The app will not install it for you.

If `lark-cli` is not on PATH, set `REGENIC_LARK_CLI` to the command before you start the desktop app. This version follows the conversations you select and can send text back. It does not create a new group.

### Slack

Set `REGENIC_SLACK_TOKEN` before you start the desktop app. In the app: **Engine** → **Slack** → **Install**. Fill the channel ID (`C…`). Channel name is optional. This version only reads that channel and cannot reply.

## Login and tokens

| | How you sign in | Install form |
| --- | --- | --- |
| DSH | Local `dsh`; `REGENIC_DSH_TOKEN` if the web host asks | no token |
| Feishu | `lark-cli auth login`; login stays in the OS keychain | no token |
| Slack | `REGENIC_SLACK_TOKEN` | no token |

The form only takes non-secret fields (group selection, channel ID, session). Tokens are not written to the database and do not appear on `/v1/me`.

## Local development

Daily use is the desktop app above. Docker Compose starts the API and background workers.

```bash
pnpm install
docker compose up --build
curl -s http://localhost:3000/health
```

The API process needs `REGENIC_DATABASE` and `REGENIC_BLOB_ROOT`. If `REGENIC_DSH_API_TOKEN` is set, callers send `Authorization: Bearer`.

```http
POST /v1/dsh/api/session.history
POST /v1/dsh/api/session.prompt
POST /v1/dsh/api/session.list
POST /v1/dsh/api/session.create
```

## Local CLI

Same job as the desktop app, from a terminal. Data lives in SQLite and a local file directory. Tokens are not written to the database. Pass them in through the environment when you sync.

### Slack

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

### DSH

Same job as [Add DSH](#dsh). Start `dsh web --port 3080` first if you use Web.

```bash
pnpm local dsh-install --database ./regenic.db --org local-owner \
	--transport web --session <sessionId> --base-url http://127.0.0.1:3080 \
	--id dsh-main

pnpm local dsh-sync --database ./regenic.db --blob-root ./blobs \
	--installation dsh-main --max-pages 20

pnpm local dsh-send --database ./regenic.db --installation dsh-main \
	--text "Follow up on the last turn"
```

`--session` is optional; omit it to follow every session. Call local `dsh` directly (no `dsh web`):

```bash
pnpm local dsh-install --database ./regenic.db --org local-owner \
	--transport cli --mailbox dsh-main --id dsh-main
```

If `dsh web` wants a token, set `REGENIC_DSH_TOKEN`.

### File import

When you import CSV or JSONL, also provide a JSON file that says which column is the message ID, time, body, and author. Bad rows are reported. Good rows become the same kind of message as a Feishu or Slack sync.

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

Personal WhatsApp is a user-triggered, read-only flow. The desktop imports one or more CSV files from the reviewed open-source [Purr WA Export](https://github.com/0xheycat/purr-wa), or WhatsApp Personal Export v1 JSONL. Regenic does not receive browser cookies, scan chats in the background, or send messages.

For the complete one-time setup, per-export steps, manual/automatic boundary, known `@lid` limitation, and acceptance checks, see [Personal WhatsApp Bridge](docs/en/WHATSAPP_PERSONAL.md) and [WhatsApp test and acceptance](docs/en/WHATSAPP_PERSONAL_TESTING.md).

```bash
pnpm local whatsapp-import --database ./regenic.db --blob-root ./blobs \
	--file ./whatsapp-personal.jsonl --org local-owner \
	--local-principal local-user
```

### Inbox

List the messages that need you now. Receipts, deletions, and ordinary thread replies stay in the store and stay out of this list.

```bash
pnpm local inbox --database ./regenic.db --org local-owner
```

### JSONL export

Export message records as JSONL. Each line includes where it came from and a content fingerprint, never the attachment bytes.

```bash
pnpm local export-jsonl --database ./regenic.db --org local-owner \
	--output ./events.jsonl
```

### Markdown digest

Group text messages by date into a Markdown file. Every entry keeps a pointer to the original record and its attachments.

```bash
pnpm local render-digest --database ./regenic.db --blob-root ./blobs \
	--org local-owner --output ./digest.md
```

### Evidence bundle

Export a bounded list of message citations for a named consumer and purpose. The file does not include attachment bodies or tokens.

```bash
pnpm local publish-evidence-bundle --database ./regenic.db --org local-owner \
	--consumer teamily-workspace --purpose research-context --max-events 100 \
	--output ./evidence-bundles.jsonl
```

### Context and cited model answers

Context assembly is deterministic and works without a model. It reads only
committed Event/Blob evidence, applies the Personal authority boundary before
ranking, persists an immutable snapshot and bundle, and supports replay after a
restart.

```bash
pnpm local context-assemble --database ./regenic.db --blob-root ./blobs \
	--org local-owner --query "release approved"

pnpm local context-snapshot --database ./regenic.db --blob-root ./blobs \
	--org local-owner --snapshot <snapshot-id>

pnpm local context-replay --database ./regenic.db --blob-root ./blobs \
	--org local-owner --snapshot <snapshot-id>
```

Project a replayed Context bundle into the existing EvidenceBundle v1 JSONL
format when another consumer needs citations only. `--consumer` and `--purpose`
must match the grant stored in the snapshot. The output contains no evidence
text or Blob bodies.

```bash
pnpm local context-publish-evidence-bundle --database ./regenic.db --blob-root ./blobs \
	--org local-owner --snapshot <snapshot-id> --consumer local-cli \
	--purpose "inspect authorized local context" --output ./evidence-bundles.jsonl
```

Model answers are optional. The first driver accepts an OpenAI-compatible API
on numeric loopback, such as a local Ollama server. Remote model URLs are not
accepted in this version. The API key setting is a reference to an environment
variable; the key itself is not stored.

```bash
export REGENIC_MODEL_DRIVER=openai_compatible
export REGENIC_MODEL_BASE_URL=http://127.0.0.1:11434/v1
export REGENIC_MODEL_NAME=<local-model>
# For a provider that requires a key:
# export REGENIC_MODEL_API_KEY_REF=env:OPENAI_API_KEY

pnpm local context-ask --database ./regenic.db --blob-root ./blobs \
	--org local-owner --question "What was approved?"
```

The Personal API exposes the same durable path:

```http
POST /v1/me/context/assemble
GET  /v1/me/context/snapshots/:snapshot_id
POST /v1/me/context/replay
POST /v1/me/context/ask
```

Evidence text is sent as untrusted user data, never as model instructions. A
model answer is returned only when every submitted citation names a candidate
and Event already present in the authorized bundle. Model output is not written
back as an Event, Artifact, Claim, or accepted fact.

Browser-origin requests to `/v1/me` also require a Personal API key. The desktop
creates and injects an ephemeral key for its owned loopback sidecar without
exposing it to renderer code or storing it. A custom or remote kernel, and a
manually started loopback browser client, must share `REGENIC_PERSONAL_API_KEY`.
Requests without an `Origin` remain available to local CLI tools. Public binds
stay off by default; set `REGENIC_PERSONAL_API=1` on that server so a desktop
can point at it.

## Status

Phase 0 is complete. RFCs 0001–0007 are Accepted. Phase 1 is Feishu / Slack / DSH on this machine, plus the local service.

| Capability | Description | Status |
| --- | --- | --- |
| Handle messages | Read in → one message shape → rank → decide whether to handle → optional reply | [PRODUCT](docs/en/PRODUCT.md) · [architecture](docs/en/MESSAGE_ORCHESTRATION.md) |
| Feishu / Slack / DSH | These work now, plus file import; more later | Phase 1 (now) |
| Personal | One person; export; optional remote backup | Phase 1 (now) |
| Team | One shared record, each person sees their own view | Phase 3 ([personal → org](docs/en/rfcs/personal-to-org.md)) |
| Rules | Shared rules you can change and version | RFC Accepted ([0001](docs/en/rfcs/0001-standards-data-model.md)) |
| Context | Durable Event-backed snapshots, replay, and optional cited model answers | Personal API + CLI baseline ([architecture](docs/en/CONTEXT_MANAGEMENT_ARCHITECTURE.md)) |
| Collaboration | Proposal / Decision / Review / Handoff | RFC Accepted ([0003](docs/en/rfcs/0003-collaboration-objects.md)) |
| API | People and automation use the same `/v1` | RFC Accepted ([0004](docs/en/rfcs/0004-human-agent-api.md)) |
| Access | `visible()`; summarizing does not grant extra access; sending is a separate grant | RFC Accepted ([0006](docs/en/rfcs/0006-acl-agent-identity.md)) |
| Daily digest | Turn daily messages into material for the rules | RFC Accepted ([0007](docs/en/rfcs/0007-daily-distillation.md)) |

Method, site, and public standards: [regenic-ai/regenic-book](https://github.com/regenic-ai/regenic-book). Store and runtime defaults: [TECH_STACK.md](docs/en/TECH_STACK.md).

## Security

The personal API listens on this computer only, by default. When it reads or replies, it uses the account already signed in on this machine. Feishu especially: `lark-cli` calls Feishu as you, inside the permissions you granted. Only add the conversations or channels you mean to handle.

Do not put tokens in the install form, the repo, or chat logs.

## Documentation

[Message orchestration](docs/en/MESSAGE_ORCHESTRATION.md) ·
[Connectors](docs/en/CONNECTOR.md) ·
[Executors](docs/en/EXECUTOR.md) ·
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
