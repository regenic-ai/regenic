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
then `SOURCE`. Those catalog fields are `CopyRef`s; the API view resolves
them for `GET /v1/me/engine?locale=` or `Accept-Language`. Built-in dsh /
slack / feishu stay in `CHANNELS` for old Events when no driver is loaded.

The ingest service is the only writer of Event, Blob, ACL, and identity rows.
`ChannelConnector` and `EgressAdapter` do not persist those records.

Capabilities are declared on the installation. The kernel does not infer them
from the driver name.

A connector is a **declarative** plugin, not a scheduler. It declares
capabilities, catalogs, vocabularies, and write-back aliases, and
translates one channel's wire into closed fields. It does not pick a
Recipe, call an executor, or branch on business types inside the plugin.
The kernel only reads declarations: equality match, exact aliases,
catalog rendering. Adding a task type means one `subjectCatalog` entry
plus stamping `unit_kind` on ingest. Do not change the kernel or the
desktop.

You do not rebuild the API or the desktop to add a source. Every driver
declares `installCatalog()` and optional `locales` / `presentInstall` /
`writeBackLabels` / `subjectCatalog` / `parseImport`. The host assembles
Engine from registered drivers.

Shipped packages declare themselves with `regenic.plugin`, `id`,
`displayName`, `engines.regenic`, and `contributes` in `package.json`.
The kernel scans its own dependencies and loads only the named
`contributes.drivers` / `contributes.executors` exports. It does not
scan `Object.values`. Extra packages use the same manifest; missing
`contributes` is a load failure, not a duck-type fallback. Nest does
not import driver symbols. Extra packages still load from
`REGENIC_PLUGIN_DIR` or `REGENIC_CHANNEL_PLUGIN`. New extra types can
appear later (directory watch, or `POST /v1/me/plugins/reload`).
`GET /v1/me/plugins` and the Engine view list loaded, skipped, and
failed packages. Extra packages are unsigned and run in-process. The
default drop folder is `~/.regenic/plugins` (`REGENIC_PLUGIN_DIR`
overrides). Engine shows that path. Drivers receive `ConnectorHost`
(`connectors`, `egress`, `plugin`, `now`, `secrets`) — not `authority`
or `ingest`. `plugin()` apply() sees the same narrow `get`. Catalog fields marked `secret` are written to the keychain;
stored `config` keeps no token. Four starter shapes live in
`examples/connectors`. An already registered `connector_type` is never
replaced; restart to pick up a changed package. The kernel matches the
first result line exactly to a live prompt option.

## Ports

A driver implements only the facets it declares. Undeclared methods do not
exist; the kernel returns 501. Drivers must not stub them.

| Port | Responsibility | When |
| --- | --- | --- |
| `ChannelDriverCore` | Install, match threads, declare capabilities | Every driver |
| `ChannelSourcePort` | `resolveStreams` / `resolveThreadStream` + `poll` | `sync` when `source_mode` is poll / hybrid |
| Webhook | `bindWebhook` + `verifyWebhook` / `handleWebhook` | `source_mode` is webhook / hybrid |
| `ChannelSinkPort` | `bindEgress` / `outboundId` / optional `createThread` / optional generic egress queue | `reply`; `create` also needs `createThread` |
| Catalog | `locales` / `installCatalog` / `presentInstall` / `probeCatalog` / `listCatalogFieldOptions` / `subjectCatalog` / optional `parseImport` | To appear on Engine; own UI copy; load form dropdowns when the install dialog opens; declare a vocabulary when the source has task types; file import when `import_files` is set |
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
- Read credentials through `credentials_ref`: `env:NAME`,
  `keychain:SERVICE`, and reserved `oauth:HANDLE` / `app:HANDLE`. The
  part after the colon is a handle, not a token. The install form may
  collect a `secret` field; the kernel writes it to the keychain and
  strips it from stored `config`. Drivers read it with
  `readInstallSecret` / `host.secrets`. The kernel still reads env refs
  with `readEnvCredential`. `oauth` / `app` are not resolved in this
  phase.
- A driver may declare `connector_protocol`. Omit it for `1.0`. The kernel
  skips an unsupported version.
- Fail independently. One install must not stall another. The tick pulls
  enabled installs in parallel. Each `poll` and each tick/catch-up sync
  has a deadline; a timeout releases the lease.
- Declare `source_mode`. Omit it for poll. `webhook` / `hybrid` must
  implement `verifyWebhook` + `handleWebhook` and `bindWebhook` on the
  driver. Webhook-only must not declare `poll`; the tick does not pull
  it. After verify/translate, the kernel ingest path writes Events.
- Installation quota is a token bucket. Default 60 / 60s
  (`REGENIC_CONNECTOR_QUOTA_TOKENS` /
  `REGENIC_CONNECTOR_QUOTA_WINDOW_MS`). `0` disables it. A connector may
  declare a tighter `quota`. The kernel does not keep per-source rate
  constants. Poll acquires the lease before spending a token; a missed
  lease spends nothing. Exhaustion releases the lease and returns
  `throttled`, not a pull error.
- Implement `installCatalog()` to appear on Engine. Optional
  `presentInstall` labels the installed row. Optional `writeBackLabels`
  lists exact aliases for write-back. When the source splits work into
  types, implement `subjectCatalog()` and stamp `unit_kind` on records.
  Optional `parseImport` + `installCatalog().import_files` puts a file
  picker on that card. The kernel writes Events; the driver only
  returns ingest batches. Import does not require an installation.

The following are not allowed:

- Writing Event, Blob, Principal, or ACL rows from the connector.
- Storing tokens in `config`, or returning them from `/v1/me`.
- Mapping an unknown native type to `message`.
- Putting bodies or secrets in `attrs`, logs, or quarantine metadata.
- Writing `recipe_id` / `executor_type` on a record or install, or
  choosing an executor by task type inside the plugin. Type is a
  declaration. Binding is a Recipe.
- Adding per-channel switches in the API or desktop. The desktop reads
  `can_send`, `can_create`, `create_with_task`, `await_reply`,
  `hold_while_working`, `list_title`,
  `surface.activity`, and inbox `prompts` / `unread` / `can_receipt` /
  `receipt`. The Recipes type picker only renders `subjectCatalog`.

## Isolation

Connectors stay in-process. The kernel isolates with deadlines,
`ConnectorHost` (no authority / ingest, including inside `plugin()`
apply), and failure containment. It
does not spawn a child process by default.

- The tick pulls enabled installs in parallel. One throw or timeout
  does not stall the others. An install still in `inflight` is skipped
  on the next tick.
- `ConnectorRunner.poll` applies a deadline to `connector.poll`. A
  timeout releases the lease and does not advance the cursor. A webhook
  `source_mode` does not call `poll`.
- `ConnectorRunner.webhook` runs `verifyWebhook` then `handleWebhook`,
  then ingest. It does not take a poll lease or advance a poll cursor.
  The HTTP entry is `POST /v1/me/connectors/:id/webhook`.
- Defaults: 20s per poll (`REGENIC_CONNECTOR_POLL_TIMEOUT_MS`) and 30s
  per tick/catch-up sync (`REGENIC_CONNECTOR_SYNC_TIMEOUT_MS`). Set
  either to `0` to disable.
- Each install has one token bucket. Default 60 / 60s; a connector may
  declare `quota`. The kernel does not hard-code Slack / Feishu /
  DingTalk rates.
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
| `capabilities` | `{ sync, reply, create, await_reply?, list_title?, hydrate_on_open?, prompts?, attention?, receipts?, create_with_task?, hold_while_working? }` | Returned by `ChannelDriver.capabilities()` |

`channelRecord()` attaches surface metadata (`channel`, `kind`, `direction`,
and optional `conversation_label` / `conversation_kind` / `unit_kind` /
`actor_label` / `activity`) to the record. `conversation_kind` is topology
(`group` / `direct`) for display. `unit_kind` is the work-unit type for
Recipe equality match. It is not a conversation title and not a
`record_class`. `activity` is channel-agnostic thread state:
`working` (the other side is still processing with no visible body) or
`awaiting_user` (it is waiting for an answer in the original channel). The
desktop reads that field. It does not infer role, direction, or a stuck
state from the driver name.
`await_reply` is also a driver declaration: set it when the other side
keeps working after a send (a session agent). Chat channels such as Feishu
omit it. The desktop shows “Sent. Waiting for a reply” only when
`await_reply` is true and the latest message is outbound. That banner is
not a third `activity` value; it is presentation of the driver flag.
`create_with_task`: creating a conversation requires the first user task.
The desktop keeps a local draft; `createThread` receives `text` and starts
the run; the kernel seeds that outbound and does not await the first poll.
Omit it to open an empty session immediately; the first text is a normal
send (DSH).
`hold_while_working`: follow-ups during `working` are held by this
connector; the desktop may count them. Omit it to treat follow-ups as
already accepted (the peer queues, DSH `session.prompt` queue).
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

### Work-unit type (`unit_kind`)

Private plugins often split work into types, and send **one conversation
per task instance**. Conversation titles are not stable, so they must not
be routing keys. `record_class=task` only means “this is a ticket.” It
cannot tell “order review” from “lead follow-up.”

A connector does three declarative things:

1. `subjectCatalog()` publishes the vocabulary. The connector keeps `id`
   unique across plugins (convention `{source}.{native}`, e.g.
   `private.order_review`). The kernel does not parse the dot.
2. Stamp `channelRecord({ unit_kind })` on ingest. Read the type from the
   source API, form, or pipeline. Guessing stays at L0. Do not treat a
   conversation title as the type, and do not write the type into
   `conversation_kind`. Stamp the **same** id on every record of that
   task instance. The list only loads heads (the last visible message).
   Stamping only the first record drops the chip.
3. If the install form should limit what to sync, filter types with
   catalog `fields`. That is “what to ingest,” not “how to handle it.”

The kernel only equality-matches `Recipe.match.unit_kind`. Specificity:
`thread_id` > `unit_kind` > `source` > `record_class` > `thread_facet`.
`unit_kind` alone is specific enough to save. The org binds an executor
with a Recipe. `executor_config` stays an opaque bag. A connector must
not write `recipe_id`.

Chat channels with no business types omit `subjectCatalog`. If the source
has no type field, omit the stamp and let a coarse Recipe
(`source` + `task`) catch the rest.

The list and thread header render a type chip from the catalog `label`.
They do not branch on channel name. If the vocabulary has no entry, the
chip shows the `unit_kind` id. Conversation titles stay titles. A local
reply and an automatic work write-back copy the thread's existing
`unit_kind` onto the outbound record so a new head does not wipe the chip.

## ChannelDriver

```ts
interface ChannelDriver extends ChannelDriverCore, ChannelSourcePort, Partial<ChannelSinkPort> {
  capabilities(installation): {
    sync; reply; create;
    await_reply?; list_title?; hydrate_on_open?;
    prompts?; attention?; receipts?;
    create_with_task?; hold_while_working?;
  };
  resolveConversationLabels?(installation, threads, env): Promise<Map<string, string>>;
  listPrompts?(installation, thread, host, env): Promise<ThreadPrompt[]>;
  answerPrompt?(installation, thread, answer, host, env): Promise<{ accepted: boolean }>;
  waitThread?(installation, thread, host, env, onNotify): (() => void) | undefined;
  readAttention?(installation, threads, host, env): Promise<Map<string, ThreadAttention>>;
  ackAttention?(installation, thread, ack, host, env): Promise<void>;
  readReceipts?(installation, threads, host, env): Promise<Map<string, MessageReceipt>>;
  surfaceGeneration?(installation, host): string;
  locales?(): PluginLocaleTable[];
  installCatalog?(input?): DriverInstallCatalog;
  presentInstall?(installation, input?): { label: CopyRef; detail: CopyRef | null };
  writeBackLabels?(label): string[];
  subjectCatalog?(): { kinds: Array<{ id: string; label: CopyRef }> };
  probeCatalog?(input): Promise<ConnectorCatalogProbe>;
  listCatalogFieldOptions?(input): Promise<ConnectorCatalogProbe["field_options"]>;
}
```

| Method | Description |
| --- | --- |
| `install` | Persist non-secret config. Slack requires `channel_id`. Feishu stores `selection=all` plus `kinds` (`group` and/or `p2p`, default both) or a picked `chat_ids` list. `POST /v1/me/connectors/:id/config` runs the same validation and overwrites config without dropping cursors. DSH web may omit `session_id` (follow every session). A hosted API ignores a public DSH URL and uses `REGENIC_DSH_BASE_URL`. |
| `matchesThread` | True if this install can address the thread. |
| `ownsThread` | True if this install is the preferred match. Used when more than one install matches. |
| `capabilities` | `sync` / `reply` / `create`, plus optional `await_reply`, `list_title`, `hydrate_on_open`, `prompts`, `attention`, `receipts`, `create_with_task`, and `hold_while_working`. `await_reply`: DSH / Cursor set it; Feishu / Slack omit it. `list_title`: Feishu / Slack set `conversation`; DSH / Cursor set `prompt` (first user message). `hydrate_on_open`: pull a recent page when opening a thread; Feishu sets it. `prompts`: DSH web sets it; CLI omits it. `attention`: Feishu sets it (source hint; every channel still has the local cursor). `receipts`: Feishu sets it; DSH / Slack / Cursor omit it. `create_with_task` / `hold_while_working`: Cursor sets them; DSH omits them. |
| `resolveConversationLabels` | Optional. Fills conversation names for older threads that lack `conversation_label`. Local names only: Feishu uses install `chat_names`, Slack uses `channel_name`. Must not call `listAllChats` or block opening a thread. |
| `listPrompts` / `answerPrompt` | Optional. Live pending decisions. DSH web mounts mux, maps `question/requested` / `approval/requested` to a channel-agnostic Prompt, and answers on `/api/respond`. `not-pending` is treated as settled. |
| `waitThread` | Optional. Wait fd for one inferior. DSH web subscribes to mux `session/event` (`turn/start` / `turn/end`) and prompt frames. The kernel follow/polls that stream so live pages ingest, then `status()` reaps. Drivers must not write Events. Channels without wait still catch up on history poll. |
| `readAttention` / `ackAttention` | Optional. Source overlay for *my* unread of their inbound. Feishu calls user-identity `read_status` on the latest inbound `om_`. Failure or an official “read” must not hide a thread the PC has never opened. Ack writes the local cursor first. |
| `readReceipts` | Optional. Peer read of my outbound. Feishu calls user-identity `read_users` on `:out:om_`. Empty items stay Sent. Do not reuse this as conversation unread. |
| `surfaceGeneration` | Optional. Live surface generation, appended to `inbox_digest` as `&s=` so a new approval is visible to desktop polling. |
| `resolveStreams` | One `ConnectorStream` per pull unit. Slack: `channel:<id>`. Feishu: `chat:<id>` for picked chats; when `selection=all`, follow `options.threads` from the kernel (current work ∪ the open thread) plus new `chat_id`s from the latest directory page (cached about 2 minutes). Unmount streams outside that set. Must not read the inbox or call `listAllChats` on every tick. DSH web: `session:<id>` per listed session. Optional `pace`: `idle_ms` (skip after an empty tick) and `catch_up_pages` (max pages while catching up). Omit both to poll one page every tick. The kernel reads the declaration; it does not branch on channel name. |
| `createThread` | Optional. Required when `create` is true. Absent means the kernel returns 501. When `create_with_task` is set, it receives `options.text` and starts the run; otherwise it opens an empty session and the first user text is a normal send. |
| `bindEgress` | Optional. Required when `reply` is true. Absent means the kernel returns 501. |
| `outboundId` | Stable id for a console send. Includes `:out:`. |
| `listEgressQueue` / `ackEgressQueue` | Optional. Generic drain for an adapter that cannot write the channel in-process (a local browser extension). Exposed as `GET/POST /v1/me/connectors/:id/egress`, not a per-channel API. |
| `locales` | Optional. Plugin-owned English (source) and Chinese tables. First-party drivers implement this so catalog keys resolve. |
| `installCatalog` | Optional. Engine card. Absent means this driver does not appear. Slack, DSH, Feishu, and extra plugins use this same method. Copy fields are `CopyRef`s, not translated sentences. `setup_steps` are the numbered steps in the dialog; the desktop renders already-resolved strings. |
| `presentInstall` | Optional. Label and detail for an installed row (`CopyRef`). |
| `writeBackLabels` | Optional. Exact aliases for a prompt option. The kernel matches the first result line. |
| `subjectCatalog` | Optional. Work-unit type vocabulary. The Recipes page renders `id` / `label`. The kernel only equality-matches. Omit it when the source has no type dimension. |
| `probeCatalog` | Optional. Local service / env readiness. Must not enumerate source resources (chat lists, agents). |
| `listCatalogFieldOptions` | Optional. Dropdown options for the install/edit dialog. The kernel calls this when the user opens the form, never on `GET /v1/me/engine`. |

`ChannelDriverError` codes: `invalid_config`, `missing_credentials`,
`sync_failed`, `send_failed`, `unsupported_channel`, `no_sender`,
`throttled`.

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

The runtime calls methods that match `source_mode`. Omit it for
poll-only. Undeclared webhook, backfill, and member-sync methods do not
exist; the kernel never calls them. Acceptance is
`verifyConnectorSourceMode`.

```ts
interface ChannelConnector {
  readonly source: string;
  readonly source_mode?: "poll" | "webhook" | "hybrid";
  readonly quota?: { tokens: number; window_ms: number };
  poll?(cursor: ConnectorCursor | null, options?: ConnectorPollOptions): Promise<PollResult>;
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
those catalog fields on Install and on Edit sync. When required
prerequisites are not ready, the card button says Set up and still
opens that same dialog.

A driver appears there only when it implements `installCatalog()`. Slack,
DSH, Feishu, and extra plugins use that same method. The host does not
keep a parallel list. `singleton: true` allows one install.
`presentInstall` labels an installed row; without it the host uses
`instance_label` / `instance_detail_key`, then the installation id. The
desktop does not hard-code fields, titles, or importers per type. Installations
include `settings` (non-secret config as strings) so the edit form can
prefill. The engine catalog also carries the driver's `source` and
`subjectCatalog` vocabulary so the Recipes page can pick `unit_kind`.

Catalog, presentation, subject labels, probe hints, and executor invoke
fields return `CopyRef`: a message id, `{ key, params }`, or
`{ literal }`. A bare string missing from the table is shown as-is
(extras and machine names). `locales()` is the plugin table. The API view
resolves copy for `GET /v1/me/engine?locale=` / `Accept-Language` (same
for inbox, conversations, and executors). Poll, ingest, and send never
take a locale. Docs URLs use `href: string | { en, zh }`, not a `_zh`
suffix. The host does not keep a parallel translation list.

Extra packages load from `REGENIC_PLUGIN_DIR` (each child directory with
a `package.json`) or `REGENIC_CHANNEL_PLUGIN` (one module id or path).
Each extra `package.json` must name `regenic.contributes`. The public
tree does not name private packages. A loaded extra cannot replace an
already registered `connector_type`. New extra types can be
hot-discovered after start; replacing a loaded package still needs a
restart. A missing or invalid explicit plugin is recorded as failed or
skipped and logged. `GET /v1/me/plugins` returns that inventory.

When a finished job writes back, the kernel matches the first result line
exactly to a live prompt option. `writeBackLabels(label)` may add aliases
for that option. The host does not keep a synonym list.

| Field | Description |
| --- | --- |
| `fields` | `key`, `label` (`CopyRef`), required, default, `visible_when`, optional `multiple` + `options` |
| `prerequisites` | Environment variable or local service, with `ready` and a `hint` (`CopyRef`) |
| `setup_steps` | Numbered setup: `title` (`CopyRef`), optional `body` / `command` / `href` / `visible_when`. `href` is a URL or `{ en, zh }`. Rendered above the dialog form; `command` is copyable. The desktop does not hard-code steps per channel |
| `import_files` | File picker on the Engine card: `accept`, optional `max_bytes` / `title` / `description` (`CopyRef`). Requires `parseImport`. `POST /v1/me/imports` is the generic route |
| `docs` | R&D specs. The Engine page renders these once next to the Connectors title and opens the GitHub page. They are not the install wizard |

Tokens are prerequisites, not form fields. The kernel does not install a
CLI or start a local server. `hint` says what the user should run when
`ready` is false. Feishu distinguishes a missing binary from a signed-out
CLI. DSH probes the same way: whether `dsh web` is reachable, and whether
`dsh` is on PATH.

The driver owns that check (`probeCatalog()`). The API returns the last
cached `ready` / `hint` on `GET /v1/me/engine` and does not wait on CLI
or network. Form dropdowns load from `GET /v1/me/engine/catalog-options`.
The desktop only renders the catalog. Adding a source does not change
the API or the desktop.

Capability tables, kind maps, and setup for Slack / DSH / Feishu are in
[Built-in drivers](CONNECTOR_DRIVERS.md).

## Out of scope

- OAuth install
- Connector marketplace
- Slack send
- Out-of-process / stdio plugin host
