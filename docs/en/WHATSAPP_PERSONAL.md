# Personal WhatsApp Bridge

- **Chinese:** [../zh/WHATSAPP_PERSONAL.md](../zh/WHATSAPP_PERSONAL.md)
- **Related:** [Message orchestration](MESSAGE_ORCHESTRATION.md) · [Source intake](COLLABORATION_PLATFORM_SOURCE_INTAKE.md)
- **Status:** WhatsApp Personal Export v1

## Boundary

Personal WhatsApp support begins with a user-triggered, read-only export from
WhatsApp Web. The bridge does not receive browser cookies, run hidden background
collection, inspect every chat, or send messages.

The bridge writes an explicit JSONL file. Regenic validates it and sends the
result through the normal plugin-host ingestion path. The bridge never writes
the authority database directly.

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
Operations are `create`, `revise`, and `tombstone`.

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

Invalid lines are reported without discarding valid messages. The normal kernel
then arranges accepted messages into current work, outside current work, or
pending. Sending replies is deliberately out of scope for this bridge.