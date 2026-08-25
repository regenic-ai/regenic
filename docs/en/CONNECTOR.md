# Connectors

A connector is an in-process plugin that reads one source and, if it
supports send, writes replies back to that source.

This document describes the connector API. Types are defined in
`@regenic/domain`. For lease, quarantine, and cursor behavior, see
[Ingestion](INGESTION_ARCHITECTURE.md).

This page is for people who implement a connector.

- **简体中文:** [../zh/CONNECTOR.md](../zh/CONNECTOR.md)
- **Related:** [Message orchestration](MESSAGE_ORCHESTRATION.md) ·
  [Ingestion](INGESTION_ARCHITECTURE.md) · [Technology stack](TECH_STACK.md) ·
  RFC 0004, 0005, 0006, 0008, [0009](rfcs/0009-work-orchestration.md)
- **Status:** Phase 1

## What a connector is

A connector registers a `ChannelDriver` with a stable `connector_type` and a
`source` that exists in `CHANNELS` (`dsh`, `slack`, `feishu`, …).

The ingest service is the only writer of Event, Blob, ACL, and identity rows.
`ChannelConnector` and `EgressAdapter` do not persist those records.

Capabilities are declared on the installation. The kernel does not infer them
from the driver name.

You do not rebuild the API or the desktop to add a source. You add a driver
and a catalog entry.

## Interfaces

| Interface | Responsibility |
| --- | --- |
| `ChannelDriver` | Install, resolve streams, bind send, declare `sync` / `reply` / `create` |
| `ChannelConnector` | Read the source into `IngestBatch` |
| `EgressAdapter` | Write `ContentPart[]` back to the same source |

## Requirements

Each connector must:

- Implement `install()`. Reject invalid config with
  `ChannelDriverError("invalid_config")`.
- Return `capabilities(installation)` for that install. A disabled install
  reports `sync`, `reply`, and `create` as `false`.
- Emit records through `channelRecord()`.
- Use a deterministic `external_id` inside the authority boundary. Console
  outbound ids include `:out:`.
- Advance a stream cursor only after the ingest service commits or
  quarantines the page.
- Read credentials from environment variables, or from a `credentials_ref`
  that names one. The install form does not accept tokens.
- Fail independently. One install must not stall another.

The following are not allowed:

- Writing Event, Blob, Principal, or ACL rows from the connector.
- Storing tokens in `config`, or returning them from `/v1/me`.
- Mapping an unknown native type to `message`.
- Putting bodies or secrets in `attrs`, logs, or quarantine metadata.
- Adding per-channel switches in the API or desktop. The desktop reads
  `can_send`, `can_create`, `await_reply`, `list_title`,
  `surface.activity`, and inbox `prompts` / `unread` / `can_receipt` /
  `receipt`.

## Message format

A connector stops at L0: it translates one channel's wire. What it hands over is the L1 envelope (`IngestRecord`: identity, time, author, body, idempotency) and a closed L2 `record_class` (`utterance` / `task` / `status` / `prompt`, mapped from `type`). Speaker (L3) is written only on `utterance`. Thread facet (L4) is a kernel projection. A WorkItem (L5) is opened by policy. Execution (L6) is a separate plugin. See [Message orchestration · Layers](MESSAGE_ORCHESTRATION.md) and [RFC 0009](rfcs/0009-work-orchestration.md). Do not label an install as human-chat or agent.

| Name | Type | Description |
| --- | --- | --- |
| `source` | string | Channel id from `CHANNELS` (`dsh`, `slack`, `feishu`) |
| `kind` | `user` \| `assistant` \| `system` | Mapped from the native event |
| `direction` | `inbound` \| `outbound` | Reads are inbound. Console replies are outbound |
| `content` | `ContentPart[]` | `body` plus optional `attachment` parts |
| `capabilities` | `{ sync, reply, create, await_reply?, list_title?, prompts?, attention?, receipts? }` | Returned by `ChannelDriver.capabilities()` |

`channelRecord()` attaches surface metadata (`channel`, `kind`, `direction`,
and optional `conversation_label` / `conversation_kind` / `actor_label` /
`activity`) to the record. `activity` is channel-agnostic thread state:
`working` (the other side is still processing with no visible body) or
`awaiting_user` (it is waiting for an answer in the original channel). The
desktop reads that field. It does not infer role, direction, or a stuck
state from the driver name.
`await_reply` is also a driver declaration: set it when the other side
keeps working after a send (a session agent). Chat channels such as Feishu
omit it. The desktop shows “Sent. Waiting for a reply” only when
`await_reply` is true and the latest message is outbound. That banner is
not a third `activity` value; it is presentation of the driver flag.
`list_title` is the same kind of declaration: chat channels set
`conversation` so the list title is `conversation_label` (group, channel,
or DM counterpart). Session agents set `prompt` so the list title is the
first user message (skip leading system injects; if none is found, keep
the visible-message face so the row does not collapse to a session id).
Omit it to keep the visible-message face. The desktop
does not branch on channel name. When an old
Event has no conversation name, a driver may implement
`resolveConversationLabels` so inbox decoration can fill it without
rewriting history.
`prompts` / `attention` / `receipts` are a second channel-agnostic seam
(Thread Surface). Keep the two read faces apart: `attention` is “have I
seen their inbound” (list green dot; local `last_read_*` is authority);
`receipts` is “have they seen this outbound” (bubble Sent/Read; live
connector lookup). Store keeps Events and `last_read_*`. Core computes
unread from the latest inbound plus that cursor, and normalizes answer
shape. Connectors only translate their control plane (mux /
`read_status` / `read_users`) and must not teach the kernel `om_` or a
mux `rpcId`. The kernel resolves `installation + thread`. The desktop
only reads inbox `prompts` / `unread` / `can_receipt` / `receipt`. It
does not branch on `dsh` / `feishu`. Prompts are not Events. Answers go
to `POST /v1/me/conversations/prompts` and must not take another trip
through egress. Local read cursors live on
`conversation_prefs.last_read_*` and are the PC read authority. A
source overlay can add unread; it cannot mark a never-opened thread
read. Declare `receipts` only when a real API exists. Feishu user
`read_users` must not be used as conversation unread. See
[RFC 0008](rfcs/0008-thread-surface.md).

When the other side has only invisible labor and no visible reply yet, a
connector may emit a `type: "thread_status"` record with
`activity: "working"`. Arrangement keeps it in current work. The desktop
uses it as a status banner, not a chat bubble or conversation title. If
the last visible message is already an assistant reply, leftover tool or
reasoning events after it do not keep the banner up. List `heads` keep the
last visible message. They do not ride a newer `working` marker or
hydrate the full reply. A conversation that is only a `working` marker
stays off the list so the title does not collapse to a session id. A
stale `working` marker is not shown as “still working.”

A local outbound and the channel-history echo of the same utterance in one
conversation stay a single Event.

### Thread id

Format: `source:target`.

Examples: `dsh:<sessionId>`, `slack:C123`, `feishu:oc_…`.

`ChannelDriverRegistry` resolves `installation + thread`. When more than one
install matches, `ownsThread` wins over the first match.

## ChannelDriver

```ts
interface ChannelDriver {
  readonly connector_type: string;
  readonly source: string;
  install(input): NewConnectorInstallation;
  matchesThread(installation, thread): boolean;
  ownsThread(installation, thread): boolean;
  capabilities(installation): { sync; reply; create; await_reply?; list_title?; prompts?; attention?; receipts? };
  resolveConversationLabels?(installation, threads, env): Promise<Map<string, string>>;
  listPrompts?(installation, thread, host, env): Promise<ThreadPrompt[]>;
  answerPrompt?(installation, thread, answer, host, env): Promise<{ accepted: boolean }>;
  readAttention?(installation, threads, host, env): Promise<Map<string, ThreadAttention>>;
  ackAttention?(installation, thread, ack, host, env): Promise<void>;
  readReceipts?(installation, threads, host, env): Promise<Map<string, MessageReceipt>>;
  surfaceGeneration?(installation, host): string;
  canReply(installation): boolean;
  createThread(installation, host, env): Promise<ConversationThread>;
  resolveStreams(installation, host, env): Promise<ConnectorStream[]>;
  resolveThreadStream(installation, thread, host, env): Promise<ConnectorStream>;
  bindEgress(installation, thread, host, env): Promise<RegisteredEgress>;
  outboundId(thread, receipt): string;
}
```

| Method | Description |
| --- | --- |
| `install` | Persist non-secret config. Slack requires `channel_id`. Feishu stores `selection=all` plus `kinds` (`group` and/or `p2p`, default both) or a picked `chat_ids` list. `POST /v1/me/connectors/:id/config` runs the same validation and overwrites config without dropping cursors. DSH web may omit `session_id` (follow every session). A hosted API ignores a public DSH URL and uses `REGENIC_DSH_BASE_URL`. |
| `matchesThread` | True if this install can address the thread. |
| `ownsThread` | True if this install is the preferred match. Used when more than one install matches. |
| `capabilities` | `sync` / `reply` / `create`, plus optional `await_reply`, `list_title`, `prompts`, `attention`, and `receipts`. `await_reply`: DSH sets it; Feishu / Slack omit it. `list_title`: Feishu / Slack set `conversation`; DSH sets `prompt` (first user message). `prompts`: DSH web sets it; CLI omits it. `attention`: Feishu sets it (source hint; every channel still has the local cursor). `receipts`: Feishu sets it; DSH / Slack omit it. |
| `resolveConversationLabels` | Optional. Fills conversation names for older threads that lack `conversation_label`. Feishu uses install `chat_names` or the live chat list (a nameless p2p chat resolves `p2p_target_id`). Slack uses `channel_name`. A lookup failure must not block inbox. |
| `listPrompts` / `answerPrompt` | Optional. Live pending decisions. DSH web mounts mux, maps `question/requested` / `approval/requested` to a channel-agnostic Prompt, and answers on `/api/respond`. `not-pending` is treated as settled. |
| `readAttention` / `ackAttention` | Optional. Source overlay for *my* unread of their inbound. Feishu calls user-identity `read_status` on the latest inbound `om_`. Failure or an official “read” must not hide a thread the PC has never opened. Ack writes the local cursor first. |
| `readReceipts` | Optional. Peer read of my outbound. Feishu calls user-identity `read_users` on `:out:om_`. Empty items stay Sent. Do not reuse this as conversation unread. |
| `surfaceGeneration` | Optional. Live surface generation, appended to `inbox_digest` as `&s=` so a new approval is visible to desktop polling. |
| `canReply` | Same value as `capabilities().reply`. |
| `resolveStreams` | One `ConnectorStream` per pull unit. Slack: `channel:<id>`. Feishu: `chat:<id>` per selected conversation, or every visible group and/or p2p chat when `selection=all`. DSH web: `session:<id>` per listed session. Optional `pace`: `idle_ms` (skip after an empty tick) and `catch_up_pages` (max pages while catching up). Omit both to poll one page every tick. The kernel reads the declaration; it does not branch on channel name. |
| `createThread` | Required when `create` is true. Otherwise throw `unsupported_channel`. |
| `bindEgress` | Required when `reply` is true. Otherwise throw `unsupported_channel`. |
| `outboundId` | Stable id for a console send. Includes `:out:`. |

`ChannelDriverError` codes: `invalid_config`, `missing_credentials`,
`sync_failed`, `send_failed`, `unsupported_channel`, `no_sender`.

```ts
interface ConnectorStreamPace {
  idle_ms?: number;
  catch_up_pages?: number;
}

interface ConnectorStream {
  stream_key: string;
  connector: Pick<ChannelConnector, "poll">;
  pace?: ConnectorStreamPace;
}
```

`pace` is declared per stream. The kernel only reads the fields: after an empty tick, a background tick may skip a stream that set `idle_ms`; while catching up it pulls at most `catch_up_pages` (kernel-capped). Omit `pace` to poll one page every tick. Feishu sets `{ idle_ms: 15_000, catch_up_pages: 5 }`; DSH and Slack omit it.

## ChannelConnector

A poll connector implements `poll`. Webhook, backfill, and member sync are
optional until the connector declares them.

```ts
poll(cursor: ConnectorCursor | null): Promise<PollResult>
```

`PollResult.batch` is an `IngestBatch` (`schema_version: "1.0"`).

| Field | Type | Description |
| --- | --- | --- |
| `connector_id` | string | Installation id |
| `org_id` | string | Authority boundary |
| `delivery_id` | string | Unique per poll page |
| `records` | `IngestRecord[]` | Built with `channelRecord()` |
| `received_at` | string | ISO timestamp |
| `next_cursor` | string, optional | Next poll position |

Record rules:

- Each content part has exactly one of `bytes`, `text`, or
  `external_locator`.
- The connector fetches `external_locator`. The core does not receive source
  credentials.
- Source-specific fields go in `attrs`. Do not put long bodies or secrets
  there.

## EgressAdapter

```ts
send(intent: SendIntent): Promise<DeliveryReceipt>
```

`SendIntent.content` is `ContentPart[]` (`body` plus attachments). The
adapter writes that envelope back to the same source and thread.

## Catalog

`GET /v1/me/engine` returns a catalog. The Engine page opens a dialog for those catalog fields on Install
and on Edit sync.
A new connector adds an entry there. The desktop does not hard-code fields
per type. Installations include `settings` (non-secret config as strings)
so the edit form can prefill.

| Field | Description |
| --- | --- |
| `fields` | `key`, `label`, required, default, `visible_when`, optional `multiple` + `options` |
| `prerequisites` | Environment variable or local service, with `ready` and a `hint` |

Tokens are prerequisites, not form fields. The kernel does not install a
CLI or start a local server. `hint` says what the user should run when
`ready` is false. Feishu distinguishes a missing binary from a signed-out
CLI. DSH probes the same way: whether `dsh web` is reachable, and whether
`dsh` is on PATH.

The driver owns that check (`probeCatalog()`). The API only merges each
driver's `ready` / `hint` / field options. The desktop only renders the
catalog. Adding a source does not change the API or the desktop.

## Built-in drivers

| Driver | `source` | Sync | Reply | Create | Credentials |
| --- | --- | --- | --- | --- | --- |
| `slack-channel` | `slack` | one channel | no | no | `REGENIC_SLACK_TOKEN` |
| `dsh-session` web, no `session_id` | `dsh` | every session | yes | yes | `REGENIC_DSH_TOKEN` if the host asks |
| `dsh-session` web, with `session_id` | `dsh` | that session | yes | no | same |
| `dsh-session` cli | `dsh` | one mailbox | yes | no | local `dsh` |
| `feishu-chat` | `feishu` | selected conversations, or all visible groups and/or p2p chats | yes | no | local `lark-cli` user login |

DSH `kind` map:

| Native event | `kind` |
| --- | --- |
| `user/message` with `source.kind=user` | `user` |
| `assistant/message` (text) | `assistant` |
| plugin-injected `user/message` | `system` |

Slack humans map to `user`.

Feishu `kind` map:

| Native message | `kind` |
| --- | --- |
| `sender_type=user`, `msg_type` `text` or `post` | `user` |
| `sender_type=app` (or `bot`), `msg_type` `text` or `post` | `assistant` |
| image, file, interactive, and other `msg_type` | dropped |

Thread id: `feishu:<chat_id>`. Login stays on `lark-cli`. History uses in-process HTTP with the `user_access_token` from the CLI keychain, and falls back to `lark-cli api --as user` if the token cannot be read. New conversations, and ones still paging oldest-first, fetch the latest page first (`ByCreateTimeDesc`), then backfill older messages. Up to 50 messages per page. The conversation list is cached for about 30 seconds. Each record stores the chat name, `group` or `direct`, and the sender name. Mentions in the body use the native `mentions[]` names (`@_user_1` becomes `@Ben`; `@all` becomes `@所有人`). `contact +search-user` is only for remaining sender ids. The form lists groups and p2p chats from `lark-cli im +chat-list --types=p2p,group`. It does not take tokens or a pasted `oc_…`. Default is both kinds. The set can be changed after install.

## Setup

The Engine page blocks Install until required visible prerequisites are
`ready`. The user does the steps; the kernel only probes.

| Driver | When `ready` is false | What to run |
| --- | --- | --- |
| `slack-channel` | `REGENIC_SLACK_TOKEN` unset | Set a bot token from your Slack app, then restart the desktop |
| `dsh-session` web | `dsh` not on PATH | `dsh` must work in the terminal. Then `dsh web --port 3080` |
| `dsh-session` web | `dsh` present, port 3080 down | `dsh web --port 3080` |
| `dsh-session` cli | local `dsh` | `dsh` must work in the terminal |
| `feishu-chat` | `lark-cli` not on PATH | `npx @larksuite/cli@latest install` ([lark-cli](https://github.com/larksuite/cli)) |
| `feishu-chat` | CLI present, user not signed in | `lark-cli config init` then `lark-cli auth login --recommend` |

Feishu tokens stay in the OS keychain. Optional `REGENIC_LARK_CLI` points
at a binary that is not on PATH.

## Out of scope

- OAuth install
- Connector marketplace
- Slack send
