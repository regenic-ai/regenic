# Personal WhatsApp Bridge

- **Chinese:** [../zh/WHATSAPP_PERSONAL.md](../zh/WHATSAPP_PERSONAL.md)
- **Related:** [Message orchestration](MESSAGE_ORCHESTRATION.md) · [Source intake](COLLABORATION_PLATFORM_SOURCE_INTAKE.md) · [WhatsApp Web live connector](WHATSAPP_WEB_LIVE_CONNECTOR.md) · [Test and acceptance](WHATSAPP_PERSONAL_TESTING.md)
- **Status:** Purr WA CSV + WhatsApp Personal Export v1 + optional WhatsApp Web live driver

## Boundary

Personal WhatsApp support has two local paths that share the same source
(`whatsapp-personal`) and the same chat identity (WhatsApp JID).

The import bridge begins with a user-triggered, read-only export from WhatsApp
Web. That path does not ship or modify a browser extension. The reviewed import
uses the upstream Purr WA userscript, then explicitly imports its CSV into the
local personal kernel. The import bridge does not receive browser cookies, run
hidden background collection, inspect every chat, or send messages.

The optional live path is a separate `ChannelDriver` (`whatsapp-web-live`). It
is not published to a browser store. A local MV3 extension observes only the
currently open WhatsApp Web chat, posts to
`POST /v1/me/connectors/:id/webhook`, and sends only Inbox replies the kernel
already accepted through `bindEgress`. See
[WhatsApp Web live connector](WHATSAPP_WEB_LIVE_CONNECTOR.md).

Purr WA writes one CSV per selected chat. Regenic validates and converts each
file, then sends the result through the normal plugin-host ingestion path. The
general WhatsApp Personal Export v1 JSONL format remains supported. Neither path
writes the authority database directly.

In the desktop console, open **Engine** and choose **Import files** in the
**WhatsApp personal export** section. The desktop accepts one or more Purr WA
CSV and Export v1 JSONL files. It reads only files selected in that picker and
sends their UTF-8 contents to the local personal kernel one at a time. One bad
file does not stop the remaining files. The kernel accepts each file up to
20 MiB and reports processed files, accepted messages, duplicates, invalid
lines, and failed files. It does not keep the uploaded files after import.

## User workflow

### One-time setup (manual)

1. Install Tampermonkey or Violentmonkey in the browser profile used for
  WhatsApp Web.
2. Install Purr WA 1.0.1 from the reviewed commit:
  `https://raw.githubusercontent.com/0xheycat/purr-wa/b5527a349c1ee64d16c0ffff51ad934f52343291/purr-wa-export.user.js`.
3. Disable automatic updates for this userscript, or review a newer upstream
  revision before enabling it. The pinned script declares an update URL for
  the upstream `main` branch.
4. Sign in to WhatsApp Web yourself. Regenic never handles the QR code or the
  resulting browser session.

### Each export and import

1. Open Purr WA in the signed-in WhatsApp Web tab and select **Scan chats**.
2. Select **Clear**, then tick only the chats you intend to export. This is the
  data-consent step and is always manual.
3. Enable **CSV**. For the Regenic text workflow, leave TXT, HTML, media,
  participants, contacts, and ZIP disabled. Set a date range if required.
4. Select **Export selected**. Purr WA opens only the selected chats, attempts
  to load their web-synced history, and downloads one CSV per chat.
5. Keep the generated filenames unchanged. In Regenic, open **Engine** →
  **WhatsApp personal export** → **Import files**, then select all downloaded
  CSV files in one picker operation.
6. Review the aggregate import result, then open **Inbox**. Re-importing the
  same files is safe: stable identities produce duplicates rather than new
  messages.

| Step | Manual | Automatic |
| --- | --- | --- |
| Browser authentication | User scans the QR code | None |
| Export scope | User selects chats and optional dates | Purr opens and scrolls only those chats |
| File creation | User clicks Export | Purr writes one CSV per chat |
| File consent | User selects files in Regenic | Desktop imports selected files sequentially |
| Validation | User reviews counts | Parser validates CSV/JSONL and isolates bad rows/files |
| Identity and display | None | Regenic derives stable IDs, deduplicates, maps senders/system events, and refreshes Inbox |
| Reply | Inbox, only after installing WhatsApp Web live | Import stays read-only. The same JID becomes sendable only when `whatsapp-web-live` is enabled |

## Export v1

Each nonempty line is one object:

```json
{
  "schema_version": "1.0",
  "kind": "whatsapp_personal_message",
  "message_id": "stable-message-id",
  "chat_id": "stable-chat-id",
  "chat_name": "Optional chat display name",
  "sender_id": "stable-sender-id",
  "sender_name": "Optional sender display name",
  "direction": "incoming",
  "sent_at": "2026-08-21T00:00:00.000Z",
  "text": "Please confirm the plan.",
  "reply_to_message_id": "optional-parent-message-id",
  "operation": "create",
  "revision_id": "optional-source-revision"
}
```

`message_id`, `chat_id`, `sender_id`, `direction`, and `sent_at` are required.
`text` is required for `create` and `revise`, and absent for `tombstone`.
Operations are `create`, `revise`, and `tombstone`. The optional `message_kind`
is `user` by default; exporters may set it to `system` for group events, calls,
revocations, and similar control messages.

## Canonical Mapping

| Export v1 | Regenic |
| --- | --- |
| `chat_id` + `message_id` | Stable `external_id` |
| `chat_id` / `chat_name` | `scope.id` / `scope.name` |
| Incoming sender | External actor provenance |
| Outgoing message | Local principal actor |
| `reply_to_message_id` | `thread` and `parent_external_id` |
| `operation` / `revision_id` | Revision and tombstone lifecycle |
| `text` | Canonical `text/plain` Blob |

Run the import locally:

```bash
pnpm local whatsapp-import --database ./regenic.db --blob-root ./blobs \
  --file ./whatsapp-personal.jsonl --org local-owner \
  --local-principal local-user
```

The same CLI command detects Purr CSV by extension. Keep the generated filename:

```bash
pnpm local whatsapp-import --database ./regenic.db --blob-root ./blobs \
  --file ./Team_120363000000000000_g_us.csv --org local-owner \
  --local-principal local-user
```

The same explicit import is available to local desktop clients through
`POST /v1/me/imports` with `{ "connector_type": "whatsapp-web-live",
"content": "<file text>", "file_name": "<original name>" }`.
`POST /v1/me/imports/whatsapp` is an alias. `file_name` is required for
Purr CSV identity recovery. The Engine card shows this picker from
`installCatalog().import_files`; import does not require installing the
live connector. Import itself has no egress; reply requires the WhatsApp
Web live driver on the same JID.

## Open-source WhatsApp Web exporter

The import bridge does not ship a browser extension. The optional live
connector is a separate local MV3 package and is not published to a store.
The reviewed import integration uses
[Purr WA Export](https://github.com/0xheycat/purr-wa), MIT-licensed version
1.0.1 pinned at commit `b5527a349c1ee64d16c0ffff51ad934f52343291`.
Install it with the upstream Tampermonkey or Violentmonkey instructions. In its
panel, scan chats, clear the default selection, select only the chats you intend
to export, enable **CSV**, disable contacts/participants/media/ZIP unless needed,
and optionally set a date range. Keep the original generated filename: Regenic
uses its `_c_us` / `_g_us` suffix to recover the stable WhatsApp chat JID.

Purr WA runs in the signed-in WhatsApp Web tab and has no application server or
analytics. Its userscript does load JSZip from cdnjs for optional ZIP output;
the userscript manager may fetch that declared dependency even when Regenic's
CSV workflow leaves ZIP disabled. Purr may open selected chats and scroll their
web-synced history while exporting. It cannot recover history that WhatsApp Web
has not synced from the phone.

Purr WA 1.0.1 lists `@c.us` direct chats and `@g.us` groups. Current WhatsApp
accounts may expose some direct chats only as `@lid`; those chats do not appear
in this pinned Purr version. Regenic does not patch the third-party userscript,
so `@lid` export remains an upstream limitation. Do not rename generated CSV
files: the `_c_us.csv` or `_g_us.csv` suffix carries the stable chat identity.

Purr CSV does not include WhatsApp's original message ID or timezone offset.
Regenic derives a deterministic message identity from normalized row fields;
re-importing the same file deduplicates, but a changed sender display name or
edited text may appear as a new message. Purr timestamps are interpreted in the
kernel machine's local timezone, so import on the exporting machine or in the
same timezone.

Invalid lines are reported without discarding valid messages. The normal kernel
then arranges accepted messages into current work, outside current work, or
pending. Sending replies is out of scope for the import bridge. After
`whatsapp-web-live` is installed, Inbox can reply on the same JID.

Run the reproducible checks in [WhatsApp test and acceptance](WHATSAPP_PERSONAL_TESTING.md)
before merging changes to this workflow.