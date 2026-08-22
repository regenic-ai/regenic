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
  RFC 0004, 0005, 0006
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
  `can_send` and `can_create`.

## Message format

Send and display shape is defined by `message-contract` in `@regenic/domain`.

| Name | Type | Description |
| --- | --- | --- |
| `source` | string | Channel id from `CHANNELS` (`dsh`, `slack`, `feishu`) |
| `kind` | `user` \| `assistant` \| `system` | Mapped from the native event |
| `direction` | `inbound` \| `outbound` | Reads are inbound. Console replies are outbound |
| `content` | `ContentPart[]` | `body` plus optional `attachment` parts |
| `capabilities` | `{ sync, reply, create }` | Returned by `ChannelDriver.capabilities()` |

`channelRecord()` attaches surface metadata (`channel`, `kind`, `direction`)
to the record. The desktop reads that metadata. It does not infer role or
direction from the driver name.

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
  capabilities(installation): { sync; reply; create };
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
| `install` | Persist non-secret config. Slack requires `channel_id`. Feishu requires `chat_id`. DSH web may omit `session_id` (follow every session). A hosted API ignores a public DSH URL and uses `REGENIC_DSH_BASE_URL`. |
| `matchesThread` | True if this install can address the thread. |
| `ownsThread` | True if this install is the preferred match. Used when more than one install matches. |
| `capabilities` | `sync` / `reply` / `create` for this install. |
| `canReply` | Same value as `capabilities().reply`. |
| `resolveStreams` | One `ConnectorStream` per pull unit. Slack: `channel:<id>`. Feishu: `chat:<id>`. DSH web: `session:<id>` per listed session. |
| `createThread` | Required when `create` is true. Otherwise throw `unsupported_channel`. |
| `bindEgress` | Required when `reply` is true. Otherwise throw `unsupported_channel`. |
| `outboundId` | Stable id for a console send. Includes `:out:`. |

`ChannelDriverError` codes: `invalid_config`, `missing_credentials`,
`sync_failed`, `send_failed`, `unsupported_channel`, `no_sender`.

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

`GET /v1/me/engine` returns a catalog. The Engine page renders the install
form from that catalog. A new connector adds an entry there. The desktop
does not hard-code fields per type.

| Field | Description |
| --- | --- |
| `fields` | `key`, `label`, required, default, `visible_when` |
| `prerequisites` | Environment variable or local service, with `ready` |

Tokens are prerequisites, not form fields.

## Built-in drivers

| Driver | `source` | Sync | Reply | Create | Credentials |
| --- | --- | --- | --- | --- | --- |
| `slack-channel` | `slack` | one channel | no | no | `REGENIC_SLACK_TOKEN` |
| `dsh-session` web, no `session_id` | `dsh` | every session | yes | yes | `REGENIC_DSH_TOKEN` if the host asks |
| `dsh-session` web, with `session_id` | `dsh` | that session | yes | no | same |
| `dsh-session` cli | `dsh` | one mailbox | yes | no | local `dsh` |
| `feishu-chat` | `feishu` | one group chat | yes | no | local `lark-cli` user login |

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

Thread id: `feishu:<chat_id>`. History uses `lark-cli api` with `--as user`. The install form does not take tokens.

## Out of scope

- OAuth install
- Connector marketplace
- Slack send
