# Regenic

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D20-blue.svg)](https://nodejs.org/)
[![pnpm](https://img.shields.io/badge/pnpm-9-blue.svg)](https://pnpm.io)

[简体中文](README.zh-CN.md) | [English](README.md)

**Give your AI the context behind your work.**

Work happens across Feishu groups, customer chats, email, and agent sessions. But the AI tools you use can’t see those conversations. To get help, you have to find the messages, paste them in, and explain the context all over again.

Regenic is an open-source, local-first app that connects those conversations to the AI you already use. Add sources with built-in connectors, community plugins, or connectors of your own. Once connected, your AI can find what someone said, catch you up on a project, flag messages that need a reply, or draft a customer response grounded in the conversation.

Your messages stay in their original apps. Regenic doesn’t replace them or lock you into a particular AI.

> Connectors are extensible, but that doesn’t mean every source is built in. See [connectors](docs/en/CONNECTOR.md) for how to add one and [features](#features) for what’s supported today. Regenic is currently for individual use, with your device as the source of truth. Shared team records aren’t available yet. See [PRODUCT.md](docs/en/PRODUCT.md) and [MESSAGE_ORCHESTRATION.md](docs/en/MESSAGE_ORCHESTRATION.md).

[Install](#installation--quick-start) · [Add Feishu or DSH](#add-feishu-or-dsh) · [Login and tokens](#login-and-tokens) · [Local CLI](#local-cli) · [Status](#status) · [Security](#security) · [Docs](#documentation) · [Contributing](#contributing)

## Why Regenic

You might need to:

- Track down what a customer said in a busy group chat.
- Catch up on conversations after a day of meetings.
- Pull together project updates from several chats.
- Ask AI to draft a reply without first copying the conversation into the chat.

Regenic makes those conversations available to your AI without moving them out of their original apps. It keeps each message’s source and thread details, then brings forward what needs attention—not another firehose of every group chat.

## What it does

- **Connect work conversations** — selected sources have built-in connectors; add others with plugins. What a connector can read or send depends on how it’s built and what you authorize.
- **Give your AI searchable context** — messages keep their source and thread details and can be read through Regenic’s API and context integrations.
- **Help you follow through** — find the original message, catch up on a project, spot a message that needs a reply, or draft a response.
- **Keep using the apps you already have** — Feishu stays Feishu; DSH stays DSH. Sending is available only when a connector supports it and you grant permission.
- **Focus on what needs attention** — the workbench surfaces relevant messages instead of recreating every channel’s firehose.
- **Keep credentials out of the database** — tokens live in environment variables or your OS keychain; the installer never asks you to paste them.
- **Start with personal, local-first use** — your device is the source of truth today. Shared team records aren’t available yet.

## Personal or team

| You are… | What to do |
| --- | --- |
| **One person** — desktop app on this computer, plus Feishu or DSH | Follow [Quick Start](#installation--quick-start) |
| **Working from a terminal** — sync, import, export | See [Local CLI](#local-cli) |
| **A team sharing one record** | Not built yet. See [personal → org](docs/en/rfcs/personal-to-org.md) |

## Features

| Area | What you can do | Now |
| --- | --- | --- |
| Desktop app | Local window: messages that need you, engine, settings. Closing it does not quit | works |
| DSH | Read sessions, send text; leave session empty to follow all of them, and create new ones | works |
| Feishu | Read groups and direct messages, send text. Sign in as yourself with official `lark-cli` | works |
| File import | CSV / JSONL, with a map of which column is which | CLI |
| Export | Message JSONL, daily Markdown, a citation list for another tool | CLI |
| Context | Deterministic snapshots and optional cited model answers | API + CLI |

## Installation & Quick Start

### Requirements

- Node.js 20+
- [pnpm](https://pnpm.io)

Feishu and DSH each need their own tool installed first. See [Add Feishu or DSH](#add-feishu-or-dsh).

### Quick Start (for you)

#### Open the app

```bash
pnpm install
pnpm dev:desktop
```

#### Add Feishu or DSH in the app

In the app: **Engine** → **DSH** / **Feishu** → **Install**.

Install and sign in to that tool first, then click Install. Feishu needs `lark-cli` signed in. DSH needs `dsh web` running. Steps are under [Add Feishu or DSH](#add-feishu-or-dsh).

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

**Engine** → the one you just prepared → **Install**. Feishu defaults to **recently active** conversations (recommended); switch to **All** or **Choose conversations** if you need a wider set. Change later with **Edit sync**. DSH Session ID can stay empty.

## Add Feishu or DSH

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

In the app: **Engine** → **Feishu** → **Install**. Default is **Recently active (recommended)**. Use **All conversations** only when you need a full census, or **Choose conversations** to tick specific ones. After install, **Edit sync** changes the same set. The form loads groups and p2p chats from `lark-cli`. You do not paste `oc_…`.

The Engine page checks whether `lark-cli` is installed and whether you are signed in. The two cases show different hints. The app will not install it for you.

If `lark-cli` is not on PATH, set `REGENIC_LARK_CLI` to the command before you start the desktop app. This version follows the conversations you select and can send text back. It does not create a new group.

### Other connectors

The core repository ships only the DSH, Feishu, and Cursor connectors. Other connectors are separate plugin packages: put them in `REGENIC_PLUGIN_DIR` (or point `REGENIC_CHANNEL_PLUGIN` at one package) before you start the app, and they appear under **Engine**. Slack: [regenic-connector-slack](https://github.com/regenic-ai/regenic-connector-slack). WhatsApp: [regenic-connector-whatsapp](https://github.com/regenic-ai/regenic-connector-whatsapp). See [Connector drivers](docs/en/CONNECTOR_DRIVERS.md).

## Login and tokens

| | How you sign in | Install form |
| --- | --- | --- |
| DSH | Local `dsh`; `REGENIC_DSH_TOKEN` if the web host asks | no token |
| Feishu | `lark-cli auth login`; login stays in the OS keychain | no token |

The form only takes non-secret fields (group selection, session). Tokens are not written to the database and do not appear on `/v1/me`.

## Local development

Daily use is the desktop app above. Docker Compose starts the API and background workers.

```bash
pnpm install
docker compose up --build
curl -s http://localhost:3000/health
```

The API process for a personal kernel needs a local data folder (`REGENIC_DATABASE` and `REGENIC_BLOB_ROOT`). Official Compose bakes PostgreSQL (`REGENIC_AUTHORITY_DRIVER=postgres`) and an attachments volume; you do not pick a database engine in the app. If `REGENIC_DSH_API_TOKEN` is set, callers send `Authorization: Bearer`.

```http
POST /v1/dsh/api/session.history
POST /v1/dsh/api/session.prompt
POST /v1/dsh/api/session.list
POST /v1/dsh/api/session.create
```

## Local CLI

Same job as the desktop app, from a terminal. Data lives in SQLite and a local file directory. Tokens are not written to the database. Pass them in through the environment when you sync.

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

pnpm local status --database ./regenic.db --org local-owner
pnpm local quarantines --database ./regenic.db --installation dsh-main

pnpm local connector-disable --database ./regenic.db --org local-owner \
	--installation dsh-main
pnpm local connector-enable --database ./regenic.db --org local-owner \
	--installation dsh-main
pnpm local reset-cursor --database ./regenic.db --org local-owner \
	--installation dsh-main --stream <stream-key>
```

`--session` is optional; omit it to follow every session. Call local `dsh` directly (no `dsh web`):

```bash
pnpm local dsh-install --database ./regenic.db --org local-owner \
	--transport cli --mailbox dsh-main --id dsh-main
```

If `dsh web` wants a token, set `REGENIC_DSH_TOKEN`.

### File import

When you import CSV or JSONL, also provide a JSON file that says which column is the message ID, time, body, and author. Bad rows are reported. Good rows become the same kind of message as a Feishu or DSH sync.

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

### Inbox

List the messages that need you now. Receipts, deletions, and ordinary thread replies stay in the store and stay out of this list.

```bash
pnpm local inbox --database ./regenic.db --org local-owner

# Acknowledge exactly this Event's inbound read cursor.
pnpm local inbox-ack --database ./regenic.db --org local-owner \
	--event <event-id>

# Fold or restore this Event's conversation on the message console.
pnpm local inbox-fold --database ./regenic.db --org local-owner \
	--event <event-id>
pnpm local inbox-unfold --database ./regenic.db --org local-owner \
	--event <event-id>

# Pin or unpin this Event's conversation above the live message list.
pnpm local inbox-pin --database ./regenic.db --org local-owner \
	--event <event-id>
pnpm local inbox-unpin --database ./regenic.db --org local-owner \
	--event <event-id>

# Inspect or update the versioned personal dispatch policy.
# A saved policy applies to the next ingest batch. It does not rewrite existing dispositions.
pnpm local dispatch-policy-get --database ./regenic.db --org local-owner
pnpm local dispatch-policy-set --database ./regenic.db --org local-owner \
	--policy ./dispatch-policy.json

# Explicitly reapply the saved policy to one existing inbox event.
pnpm local inbox-dispatch-reapply --database ./regenic.db --blob-root ./blobs \
	--org local-owner --event <event-id>

# Review events held for explicit attention without widening the work inbox.
pnpm local inbox-pending --database ./regenic.db --org local-owner

# Review overdue replies, or snooze one outbound message until a specific time.
pnpm local follow-ups --database ./regenic.db --blob-root ./blobs --org local-owner
pnpm local follow-up-snooze --database ./regenic.db --org local-owner \
	--thread <thread-id> --outbound <external-id> --until 2026-10-01T09:00:00.000Z

# Human triage overrides the current-work layer without changing the Event.
pnpm local inbox-triage --database ./regenic.db --org local-owner \
	--event <event-id> --disposition pending

# Reapply the automatic arrangement for an event previously triaged by hand.
pnpm local inbox-triage-reset --database ./regenic.db --blob-root ./blobs \
	--org local-owner --event <event-id>
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
restart. Personal uses a rebuildable SQLite FTS5 sidecar for literal Unicode
search. ACL and lifecycle resolution happen before the index receives exact
Event/hash keys; unavailable or partial indexes fall back to the same local
scoring rules.

```bash
pnpm local context-assemble --database ./regenic.db --blob-root ./blobs \
	--org local-owner --query "release approved"

pnpm local context-snapshot --database ./regenic.db --blob-root ./blobs \
	--org local-owner --snapshot <snapshot-id>

pnpm local context-replay --database ./regenic.db --blob-root ./blobs \
	--org local-owner --snapshot <snapshot-id>
```

Create a deterministic UTC-day digest proposal, then accept it through the
Artifact lifecycle before reading it. The date is explicit and uses `YYYY-MM-DD`.

```bash
pnpm local context-daily-digest-project --database ./regenic.db --blob-root ./blobs \
	--org local-owner --utc-date 2026-09-06

pnpm local context-daily-digest-get --database ./regenic.db --blob-root ./blobs \
	--org local-owner --utc-date 2026-09-06

pnpm local context-daily-digest-jobs --database ./regenic.db --blob-root ./blobs \
	--org local-owner

pnpm local context-daily-digest-alerts --database ./regenic.db --blob-root ./blobs \
	--org local-owner

pnpm local context-daily-digest-alert-resolve --database ./regenic.db --blob-root ./blobs \
	--org local-owner --alert <alert-id>

pnpm local context-proposal-create --database ./regenic.db --blob-root ./blobs \
	--org local-owner --digest <digest-id> --direction product --event <event-id>

pnpm local context-proposals --database ./regenic.db --blob-root ./blobs \
	--org local-owner

pnpm local context-proposal-new-decision --database ./regenic.db --blob-root ./blobs \
	--org local-owner --request release-1 --title "Approve release" \
	--summary "Approve the bounded release." --boundary "Release only" \
	--snapshot <snapshot-id> --event <event-id>

pnpm local context-review-new-decision --database ./regenic.db --blob-root ./blobs \
	--org local-owner --decision <decision-id> --request review-1 \
	--result falsified --severity bad_news --action revise_standard \
	--evidence-kind data --event <event-id>

pnpm local context-decision-reviews --database ./regenic.db --blob-root ./blobs \
	--org local-owner --decision <decision-id>

pnpm local context-review-get --database ./regenic.db --blob-root ./blobs \
	--org local-owner --review <review-id>

pnpm local context-handoff-create --database ./regenic.db --blob-root ./blobs \
	--org local-owner --request handoff-1 --direction agent_to_human \
	--agent agent-1 --reason evidence_conflict --snapshot <snapshot-id> \
	--payload '{"summary":"Two cited claims disagree."}'

pnpm local context-handoffs --database ./regenic.db --blob-root ./blobs \
	--org local-owner --status open --direction agent_to_human

pnpm local context-handoff-ack --database ./regenic.db --blob-root ./blobs \
	--org local-owner --handoff <handoff-id>

pnpm local context-handoff-resolve --database ./regenic.db --blob-root ./blobs \
	--org local-owner --handoff <handoff-id>

pnpm local context-proposal-new-standard --database ./regenic.db --blob-root ./blobs \
	--org local-owner --request standard-1 --title "Release safety" \
	--summary "Create a bounded release standard." --boundary "Release only" \
	--snapshot <snapshot-id> --event <event-id> \
	--uncertainty "Can this process prevent regressions?"

pnpm local context-standard-version-commit --database ./regenic.db --blob-root ./blobs \
	--org local-owner --proposal <proposal-id> --spec ./standard-version.json

pnpm local context-standard-version-publish-trial --database ./regenic.db --blob-root ./blobs \
	--org local-owner --version <version-id>

pnpm local context-standard-version-promote --database ./regenic.db --blob-root ./blobs \
	--org local-owner --version <version-id> --upgrade-evidence ./upgrade-evidence.json

pnpm local context-standard-gap-from-review --database ./regenic.db --blob-root ./blobs \
	--org local-owner --review <review-id> --summary "Release safety is uncovered." \
	--uncertainty "Can a release gate prevent this failure?"

pnpm local context-standard-gap-new --database ./regenic.db --blob-root ./blobs \
	--org local-owner --request gap-1 --summary "Release safety is uncovered." \
	--uncertainty "Can a release gate prevent regressions?"

pnpm local context-standard-gap-convert --database ./regenic.db --blob-root ./blobs \
	--org local-owner --gap <gap-id> --kind new_standard \
	--title "Release safety" --proposal-summary "Create a bounded standard." \
	--boundary "Release only" --snapshot <snapshot-id> --event <event-id>

pnpm local context-run-new --database ./regenic.db --blob-root ./blobs \
	--org local-owner --request run-1 --agent agent-1 \
	--intent "Apply the release standard." --snapshot <snapshot-id> \
	--bindings <standard-id>@<version-id> --input '{"release_id":"release-1"}'

pnpm local context-run-start --database ./regenic.db --blob-root ./blobs \
	--org local-owner --run <run-id>

pnpm local context-run-complete --database ./regenic.db --blob-root ./blobs \
	--org local-owner --run <run-id> --status succeeded --output ./run-output.json

pnpm local context-run-handoff --database ./regenic.db --blob-root ./blobs \
	--org local-owner --run <run-id> --reason evidence_conflict \
	--payload '{"summary":"Two claims disagree."}'

pnpm local context-review-new-run --database ./regenic.db --blob-root ./blobs \
	--org local-owner --run <run-id> --request review-1 \
	--result falsified --severity bad_news --action revise_standard \
	--evidence-kind data --event <event-id>

pnpm local context-run-reviews --database ./regenic.db --blob-root ./blobs \
	--org local-owner --run <run-id>

pnpm local context-run-drift-scan --database ./regenic.db --blob-root ./blobs \
	--org local-owner --minimum-failures 2

pnpm local context-standard-usage --database ./regenic.db --blob-root ./blobs \
	--org local-owner --standard <standard-id> --version <version-id> \
	--source-kind agent_run

pnpm local context-standard-usage-project --database ./regenic.db --blob-root ./blobs \
	--org local-owner --source-kind agent_run --source <run-id>

pnpm local context-standard-health --database ./regenic.db \
	--org local-owner --observed-at 2027-12-31T00:00:00.000Z \
	--stale-after-days 90 --limit 100

# Continue from the previous response's next_after cursor.
pnpm local context-standard-health --database ./regenic.db \
	--org local-owner --observed-at 2027-12-31T00:00:00.000Z \
	--stale-after-days 90 --after-created-at <created-at> --after-id <standard-id>
```

Run a versioned synthetic evaluation dataset and optionally persist its
deterministic report. The report includes Recall@K, MRR@K, nDCG@K, citation
coverage, and forbidden/stale-selection safety gates, but no message bodies.

```bash
pnpm local context-evaluate --database ./regenic.db --blob-root ./blobs \
	--org local-owner --dataset ./context-evaluation.json --k 10 \
	--output ./context-evaluation-report.json
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
POST /v1/me/context/diff
GET  /v1/me/context/snapshots?thread_id=...&limit=...
GET  /v1/me/context/snapshots/:snapshot_id
POST /v1/me/context/replay
POST /v1/me/context/ask
```

Thread snapshot history is scoped to the current organization and principal and to
the `desktop-context-pilot` consumer. Results are newest-first with a default limit
of 20 and a maximum of 100. To read the next stable page, pass the final entry's
`created_at` and `snapshot_id` as `before_created_at` and `before_snapshot_id`.

### Context Pilot thread history

To create a history entry, assemble Context for exactly one thread with the desktop
consumer. A Snapshot is immutable, so a repeated request with the same authorized
inputs converges on the same Snapshot rather than replacing it.

```bash
curl -X POST http://127.0.0.1:4370/v1/me/context/assemble \
  -H "content-type: application/json" \
  -d '{
    "consumer_id": "desktop-context-pilot",
    "purpose": "display context for the open personal conversation",
    "allowed_uses": ["display"],
    "filters": { "thread_ids": ["synthetic-chat:chat-1"] },
    "temporal": { "mode": "current" },
    "budget": {
      "profile": "desktop-thread-preview-v1",
      "max_tokens": 2000,
      "max_items": 20,
      "max_raw_evidence": 20
    },
    "requested_kinds": ["event"]
  }'
```

Then list saved history for that thread:

```bash
curl "http://127.0.0.1:4370/v1/me/context/snapshots?thread_id=synthetic-chat%3Achat-1"
```

Each result is an association, not a new grant. To replay a selected Snapshot,
use its `snapshot_id` with the same consumer, purpose, and allowed uses that
created it. The history endpoint does not expand replay permissions.

`POST /v1/me/context/diff` compares two Snapshot IDs using one shared replay
grant. Both Snapshots must be replayable by the current organization and
principal with the submitted consumer, purpose, and allowed uses. The response
contains stable candidate references and hashes, never evidence text.

#### Compare two saved Snapshots

Use the older Snapshot as `from_snapshot_id` and the newer Snapshot as
`to_snapshot_id`. The replay grant must exactly match the grant used to create
both bundles:

```bash
curl -X POST http://127.0.0.1:4370/v1/me/context/diff \
  -H "content-type: application/json" \
  -d '{
    "from_snapshot_id": "context-snapshot:older",
    "to_snapshot_id": "context-snapshot:newer",
    "consumer_id": "desktop-context-pilot",
    "purpose": "display context for the open personal conversation",
    "allowed_uses": ["display"]
  }'
```

The result classifies candidates as:

- `added`: selected only by the newer Snapshot;
- `removed`: selected only by the older Snapshot;
- `changed`: the same candidate identity has different selected content or
  metadata;
- `unchanged`: the candidate is identical in both authorized bundles.

Candidate references are sorted deterministically. A consumer mismatch returns
the same not-found response as a missing bundle, so callers cannot probe whether
a Snapshot exists under another grant. A diff does not read current source data,
modify either Snapshot, or grant replay access.

#### Troubleshooting empty thread history

History is intentionally empty unless the original assemble request used exactly
one `filters.thread_ids` value. Requests without a thread filter or with multiple
threads still create usable Snapshots, but do not create a thread-history
association. Existing Snapshots are not backfilled because their source thread
cannot be inferred reliably.

The list is also isolated by organization, principal, and consumer. Confirm that
the request is using the same Personal API identity and
`desktop-context-pilot` consumer as the assemble request. For a local
diagnostic, run `context-snapshot-history --thread <thread-id>` with the same
local org, principal, and consumer options used to create the Snapshot.

Evidence text is sent as untrusted user data, never as model instructions. A
model answer is returned only when every submitted citation names a candidate
and Event already present in the authorized bundle. Model output is not written
back as an Event, Artifact, Claim, or accepted fact.

Browser-origin requests to `/v1/me` also require a Personal API key. The desktop
creates and injects an ephemeral key for its owned loopback sidecar without
exposing it to renderer code or storing it. Remote kernels auto-generate a key on
first boot unless `REGENIC_PERSONAL_API_KEY` is set. Bootstrap pairing stays open
for 30 minutes and closes after the first successful desktop pair; later connections
need the shared key (paste in Settings or via env). Public binds stay off by default;
set `REGENIC_PERSONAL_API=1` on that server so a desktop can point at it.

## Status

Phase 0 is complete. RFCs 0001–0007 are Accepted. Phase 1 is Feishu / DSH / Cursor on this machine, plus the local service.

| Capability | Description | Status |
| --- | --- | --- |
| Handle messages | Read in → one message shape → rank → decide whether to handle → optional reply | [PRODUCT](docs/en/PRODUCT.md) · [architecture](docs/en/MESSAGE_ORCHESTRATION.md) |
| Feishu / DSH / Cursor | These work now, plus file import; more later | Phase 1 (now) |
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
[Local model service](docs/en/LOCAL_MODEL_SERVICE.md) ·
[Ingestion](docs/en/INGESTION_ARCHITECTURE.md)

## Contributing

Pull requests should cite the owning RFC and stay aligned with [PRODUCT.md](docs/en/PRODUCT.md). Discussion: [Issues](https://github.com/regenic-ai/regenic/issues).

Follow the [Code of Conduct](https://github.com/regenic-ai/regenic-book/blob/main/CODE_OF_CONDUCT.md).
Report security issues with a [private advisory](https://github.com/regenic-ai/regenic/security/advisories/new).

## License

[MIT](LICENSE).

Methodology in `regenic-ai/regenic-book` remains CC BY-NC 4.0 where that license applies.
