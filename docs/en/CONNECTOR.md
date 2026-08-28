# Connectors

A connector is an in-process plugin that reads one source and, if it
supports send, writes replies back to that source.

This document describes the connector API. Types are defined in
`@regenic/domain`. For lease, quarantine, and cursor behavior, see
[Ingestion](INGESTION_ARCHITECTURE.md).

This page is for people who implement a connector.

- **简体中文:** [../zh/CONNECTOR.md](../zh/CONNECTOR.md)
- **Related:** [Built-in drivers](CONNECTOR_DRIVERS.md) · [Message orchestration](MESSAGE_ORCHESTRATION.md) ·
  [Executors](EXECUTOR.md) ·
  [Ingestion](INGESTION_ARCHITECTURE.md) · [Technology stack](TECH_STACK.md) ·
  RFC 0004, 0005, 0006, 0008, [0009](rfcs/0009-work-orchestration.md)
- **Status:** Phase 1

## What a connector is

A connector registers a `ChannelDriver` with a stable `connector_type` and a
`source` declared by the driver. `source` does not have to be listed in
`CHANNELS` first. The display name comes from
`installCatalog().channel_label`, then `CHANNELS`, then catalog `title`,
then `SOURCE`. Built-in dsh / slack / feishu stay in `CHANNELS` for old
Events when no driver is loaded.

The ingest service is the only writer of Event, Blob, ACL, and identity rows.
`ChannelConnector` and `EgressAdapter` do not persist those records.

Capabilities are declared on the installation. The kernel does not infer them
from the driver name.

You do not rebuild the API or the desktop to add a source. Every driver
declares `installCatalog()` and optional `presentInstall` /
`writeBackLabels`. The host assembles Engine from registered drivers.
Extra packages load at process start from `REGENIC_PLUGIN_DIR` or
`REGENIC_CHANNEL_PLUGIN`. The kernel matches the first result line
exactly to a live prompt option.

## Ports

A driver implements only the facets it declares. Undeclared methods do not
exist; the kernel returns 501. Drivers must not stub them.

| Port | Responsibility | When |
| --- | --- | --- |
| `ChannelDriverCore` | Install, match threads, declare capabilities | Every driver |
| `ChannelSourcePort` | `resolveStreams` / `resolveThreadStream` + `poll` | `sync` |
| `ChannelSinkPort` | `bindEgress` / `outboundId` / optional `createThread` | `reply`; `create` also needs `createThread` |
| Catalog | `installCatalog` / `presentInstall` / `probeCatalog` | To appear on Engine |
| Surface | `prompts` / `attention` / `receipts` | Matching capability flags |
| `EgressAdapter` | Write `ContentPart[]` back to the same source | After `bindEgress` |

## Requirements

Each connector must:

- Implement `install()`. Reject invalid config with
  `ChannelDriverError("invalid_config")`.
- Return `capabilities(installation)` for that install. A disabled install
  reports `sync`, `reply`, and `create` as `false`. `reply` requires
  `bindEgress` and `outboundId`. `create` requires `createThread`. The
  kernel reads the declaration, not `canReply`. Acceptance is
  `verifyChannelDriverConformance` / `verifyPollConnectorConformance`.
- Emit records through `channelRecord()`.
- Use a deterministic `external_id` inside the authority boundary. Console
  outbound ids include `:out:`.
- Advance a stream cursor only after the ingest service commits or
  quarantines the page.
- Read credentials through `credentials_ref`: `env:NAME` or
  `keychain:SERVICE`. The install form does not accept tokens. The kernel
  reads env refs with `readEnvCredential`. Keychain refs stay with the
  connector.
- A driver may declare `connector_protocol`. Omit it for `1.0`. The kernel
  skips an unsupported version.
- Fail independently. One install must not stall another. The tick pulls
  enabled installs in parallel. Each `poll` and each tick/catch-up sync
  has a deadline; a timeout releases the lease.
- Implement `installCatalog()` to appear on Engine. Optional
  `presentInstall` labels the installed row. Optional `writeBackLabels`
  lists exact aliases for write-back.

The following are not allowed:

- Writing Event, Blob, Principal, or ACL rows from the connector.
- Storing tokens in `config`, or returning them from `/v1/me`.
- Mapping an unknown native type to `message`.
- Putting bodies or secrets in `attrs`, logs, or quarantine metadata.
- Adding per-channel switches in the API or desktop. The desktop reads
  `can_send`, `can_create`, `await_reply`, `list_title`,
  `surface.activity`, and inbox `prompts` / `unread` / `can_receipt` /
  `receipt`.

## Isolation

Connectors stay in-process. The kernel isolates with deadlines and
failure containment. It does not spawn a child process by default.

- The tick pulls enabled installs in parallel. One throw or timeout
  does not stall the others. An install still in `inflight` is skipped
  on the next tick.
- `ConnectorRunner.poll` applies a deadline to `connector.poll`. A
  timeout releases the lease and does not advance the cursor.
- Defaults: 20s per poll (`REGENIC_CONNECTOR_POLL_TIMEOUT_MS`) and 30s
  per tick/catch-up sync (`REGENIC_CONNECTOR_SYNC_TIMEOUT_MS`). Set
  either to `0` to disable.
- `probeCatalog`, inbox receipts, and conversation-label lookups already
  swallow per-driver failures.
- A stdio out-of-process host is for untrusted third-party plugins, not
  this phase.

## Message format

A connector stops at L0: it translates one channel's wire. What it hands over is the L1 envelope (`IngestRecord`: identity, time, author, body, idempotency) and a closed L2 `record_class` (`utterance` / `task` / `status` / `prompt`, mapped from `type`). Speaker (L3) is written only on `utterance`. Thread facet (L4) is a kernel projection. A WorkItem (L5) is opened by policy. Execution (L6) is a separate plugin. See [Message orchestration · Layers](MESSAGE_ORCHESTRATION.md) and [RFC 0009](rfcs/0009-work-orchestration.md). Do not label an install as human-chat or agent.

| Name | Type | Description |
| --- | --- | --- |
| `source` | string | Channel id declared by the driver. The display name comes from the catalog; it does not have to be registered in `CHANNELS` first |
| `kind` | `user` \| `assistant` \| `system` | Mapped from the native event |
| `direction` | `inbound` \| `outbound` | Reads are inbound. Console replies are outbound |
| `content` | `ContentPart[]` | `body` plus optional `attachment` parts |
| `capabilities` | `{ sync, reply, create, await_reply?, list_title?, hydrate_on_open?, prompts?, attention?, receipts? }` | Returned by `ChannelDriver.capabilities()` |

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
interface ChannelDriver extends ChannelDriverCore, ChannelSourcePort, Partial<ChannelSinkPort> {
  capabilities(installation): {
    sync; reply; create;
    await_reply?; list_title?; hydrate_on_open?;
    prompts?; attention?; receipts?;
  };
  resolveConversationLabels?(installation, threads, env): Promise<Map<string, string>>;
  listPrompts?(installation, thread, host, env): Promise<ThreadPrompt[]>;
  answerPrompt?(installation, thread, answer, host, env): Promise<{ accepted: boolean }>;
  readAttention?(installation, threads, host, env): Promise<Map<string, ThreadAttention>>;
  ackAttention?(installation, thread, ack, host, env): Promise<void>;
  readReceipts?(installation, threads, host, env): Promise<Map<string, MessageReceipt>>;
  surfaceGeneration?(installation, host): string;
  installCatalog?(input?): DriverInstallCatalog;
  presentInstall?(installation, input?): { label; detail };
  writeBackLabels?(label): string[];
  probeCatalog?(input): Promise<ConnectorCatalogProbe>;
}
```

| Method | Description |
| --- | --- |
| `install` | Persist non-secret config. Slack requires `channel_id`. Feishu stores `selection=all` plus `kinds` (`group` and/or `p2p`, default both) or a picked `chat_ids` list. `POST /v1/me/connectors/:id/config` runs the same validation and overwrites config without dropping cursors. DSH web may omit `session_id` (follow every session). A hosted API ignores a public DSH URL and uses `REGENIC_DSH_BASE_URL`. |
| `matchesThread` | True if this install can address the thread. |
| `ownsThread` | True if this install is the preferred match. Used when more than one install matches. |
| `capabilities` | `sync` / `reply` / `create`, plus optional `await_reply`, `list_title`, `hydrate_on_open`, `prompts`, `attention`, and `receipts`. `await_reply`: DSH sets it; Feishu / Slack omit it. `list_title`: Feishu / Slack set `conversation`; DSH sets `prompt` (first user message). `hydrate_on_open`: pull a recent page when opening a thread; Feishu sets it. `prompts`: DSH web sets it; CLI omits it. `attention`: Feishu sets it (source hint; every channel still has the local cursor). `receipts`: Feishu sets it; DSH / Slack omit it. |
| `resolveConversationLabels` | Optional. Fills conversation names for older threads that lack `conversation_label`. Local names only: Feishu uses install `chat_names`, Slack uses `channel_name`. Must not call `listAllChats` or block opening a thread. |
| `listPrompts` / `answerPrompt` | Optional. Live pending decisions. DSH web mounts mux, maps `question/requested` / `approval/requested` to a channel-agnostic Prompt, and answers on `/api/respond`. `not-pending` is treated as settled. |
| `readAttention` / `ackAttention` | Optional. Source overlay for *my* unread of their inbound. Feishu calls user-identity `read_status` on the latest inbound `om_`. Failure or an official “read” must not hide a thread the PC has never opened. Ack writes the local cursor first. |
| `readReceipts` | Optional. Peer read of my outbound. Feishu calls user-identity `read_users` on `:out:om_`. Empty items stay Sent. Do not reuse this as conversation unread. |
| `surfaceGeneration` | Optional. Live surface generation, appended to `inbox_digest` as `&s=` so a new approval is visible to desktop polling. |
| `resolveStreams` | One `ConnectorStream` per pull unit. Slack: `channel:<id>`. Feishu: `chat:<id>` for picked chats; when `selection=all`, follow `options.threads` from the kernel (current work ∪ the open thread) plus new `chat_id`s from the latest directory page (cached about 2 minutes). Unmount streams outside that set. Must not read the inbox or call `listAllChats` on every tick. DSH web: `session:<id>` per listed session. Optional `pace`: `idle_ms` (skip after an empty tick) and `catch_up_pages` (max pages while catching up). Omit both to poll one page every tick. The kernel reads the declaration; it does not branch on channel name. |
| `createThread` | Optional. Required when `create` is true. Absent means the kernel returns 501. |
| `bindEgress` | Optional. Required when `reply` is true. Absent means the kernel returns 501. |
| `outboundId` | Stable id for a console send. Includes `:out:`. |
| `installCatalog` | Optional. Engine card. Absent means this driver does not appear. Slack, DSH, Feishu, and extra plugins use this same method. |
| `presentInstall` | Optional. Label and detail for an installed row. |
| `writeBackLabels` | Optional. Exact aliases for a prompt option. The kernel matches the first result line. |
| `probeCatalog` | Optional. Local service / env readiness and field options. |

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

`pace` is declared per stream. The kernel only reads the fields: after an empty tick, a background tick may skip a stream that set `idle_ms`. Background ticks stay out of the human's way: while the PC is in use they only poll a few streams from the kernel-computed eligible set for recent/live messages (one page each), do not walk history, and do not census every Feishu chat. The kernel derives that set from current-work inbox threads and the open thread, and passes it as `options.threads`; new conversations come from the latest directory page on a TTL. Streams outside the set are unmounted. After the human is idle they backfill one older page at a time. Opening an empty thread seeds the latest page; scrolling up asks for one older page when the local store has none. An explicit Engine Sync may use `catch_up_pages` (kernel-capped). Omit `pace` to poll one page every tick. Feishu sets `{ idle_ms: 15_000, catch_up_pages: 5 }`; DSH and Slack omit it.

## ChannelConnector

The runtime currently requires `source` + `poll`. Omit `source_mode` for
poll-only. Undeclared webhook, backfill, and member-sync methods do not
exist; the kernel never calls them.

```ts
interface ChannelConnector {
  readonly source: string;
  readonly source_mode?: "poll" | "webhook" | "hybrid";
  poll(cursor: ConnectorCursor | null, options?: ConnectorPollOptions): Promise<PollResult>;
  capabilities?(): ConnectorCapabilities;
  verifyWebhook?(request): Promise<VerifiedWebhook>;
  handleWebhook?(webhook): Promise<IngestBatch>;
  backfill?(range): AsyncIterable<IngestBatch>;
  syncMembers?(scope): Promise<MembershipBatch>;
}
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

`GET /v1/me/engine` returns a catalog. The Engine page opens a dialog for
those catalog fields on Install and on Edit sync.

A driver appears there only when it implements `installCatalog()`. Slack,
DSH, Feishu, and extra plugins use that same method. The host does not
keep a parallel list. `singleton: true` allows one install.
`presentInstall` labels an installed row; without it the host uses
`instance_label` / `instance_detail_key`, then the installation id. The
desktop does not hard-code fields or titles per type. Installations
include `settings` (non-secret config as strings) so the edit form can
prefill.

Extra packages load once at process start from `REGENIC_PLUGIN_DIR` (each
child directory with a `package.json`) or `REGENIC_CHANNEL_PLUGIN` (one
module id or path). `REGENIC_CRM_CONNECTOR` is a compat alias for the
latter. The public tree does not name private packages. A loaded extra
cannot replace an already registered `connector_type`. A missing or
invalid explicit plugin is skipped and logged.

When a finished job writes back, the kernel matches the first result line
exactly to a live prompt option. `writeBackLabels(label)` may add aliases
for that option. The host does not keep a synonym list.

| Field | Description |
| --- | --- |
| `fields` | `key`, `label`, required, default, `visible_when`, optional `multiple` + `options` |
| `prerequisites` | Environment variable or local service, with `ready` and a `hint` |
| `docs` | R&D specs. The Engine page renders these once next to the Connectors title and opens the GitHub page |

Tokens are prerequisites, not form fields. The kernel does not install a
CLI or start a local server. `hint` says what the user should run when
`ready` is false. Feishu distinguishes a missing binary from a signed-out
CLI. DSH probes the same way: whether `dsh web` is reachable, and whether
`dsh` is on PATH.

The driver owns that check (`probeCatalog()`). The API only merges each
driver's `ready` / `hint` / field options. The desktop only renders the
catalog. Adding a source does not change the API or the desktop.

Capability tables, kind maps, and setup for Slack / DSH / Feishu are in
[Built-in drivers](CONNECTOR_DRIVERS.md).

## Out of scope

- OAuth install
- Connector marketplace
- Slack send
- Out-of-process / stdio plugin host
