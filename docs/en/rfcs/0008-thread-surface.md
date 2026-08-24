# RFC 0008 — Thread Surface

- **Status:** Accepted
- **简体中文:** [../../zh/rfcs/0008-thread-surface.md](../../zh/rfcs/0008-thread-surface.md)
- **Depends on:** RFC 0004, connector contract
- **Related:** [CONNECTOR](../CONNECTOR.md) · [MESSAGE_ORCHESTRATION](../MESSAGE_ORCHESTRATION.md) · [DESKTOP](../DESKTOP.md)

## 1. Problem

Channels stall a human or mark attention *beside* message Events:

- A session agent (DSH) asks or requests approval on a live control plane. Pending work **does not hit history**. A new `session.prompt` does not settle a paused tool call.
- A chat channel (Feishu) has read/unread. That is not a message and must not be ingested as an Event.

Hard-coding either in the kernel or desktop forks the product per source. Persisting a pending prompt as an Event leaves a stale card after the far side already resolved it.

## 2. Goals

1. Add a channel-agnostic **Thread Surface** on the connector port: `prompts` (human intervention), `attention` (have I seen their inbound), and `receipts` (has the peer seen my outbound).
2. Kernel and desktop read declarations only. No `dsh` / `feishu` branches.
3. Prompts are **not** Events. The local read cursor lives on `conversation_prefs`. Receipts stay live on the connector, keyed by outbound id.
4. The PC console can answer a far-side question or approval without opening the original UI.

## 3. Non-goals

- Permission presets, slash commands, or channel settings.
- Modeling a prompt as an `IngestRecord` or a new Event type.
- Pretending every chat OpenAPI exposes a conversation unread count or peer-read receipts.
- Reusing inbox `unread` for “did they read what I sent.”
- Remote DSH answers over CLI transport (no mux).

## 4. Invariants

| Face | Authority | Lifetime |
| --- | --- | --- |
| Event / Blob | Ingest service | Durable |
| `conversation_prefs.title` / `pinned` | Kernel | Durable |
| `conversation_prefs.last_read_*` | Kernel local cursor | Durable |
| Prompt | Connector control plane | Live; gone when the far side resolves |
| Source attention | Optional connector overlay | Live; fall back to the local cursor |
| Receipt | Connector lookup by outbound `external_id` | Live; fall back to Sent |

The kernel must not infer “this is an approval” or “this is Feishu unread” from a channel name. The two read faces must not share a field.

## 5. Prompt

`prompt_id` is opaque to the kernel. Presentation changes UI only: `plan_review` highlights the option marked `emphasized`. Single-select `custom` replaces `selected`. Answering a prompt must **not** also call `egress.send`.

Unread is a **thread** property. The kernel compares the store’s latest inbound on that thread (not the list-face event) to `last_read_*`. A driver may treat that inbound id as an opaque hint; the kernel never learns `om_` or a mux `rpcId`.

## 6. Attention

Local cursor: `last_read_at`, `last_read_external_id`. Written when a thread is opened or via `POST /v1/me/conversations/attention`.

Inbox `unread` is computed by the kernel. The local cursor is the PC read authority. A source overlay can add unread; it cannot hide a thread the PC has never opened:

1. Pending `prompts` or `activity === awaiting_user` → unread.
2. When a latest inbound exists, compare only `last_read_*`. No cursor or a lagging cursor → unread. A caught-up PC cursor → read, even if the official app still shows unread.
3. With no inbound, a source unread overlay still counts. A source “read” overlay does not.

The list green dot reads this face only. Every channel uses the same local cursor. `attention` means “I have a source hint,” not “unread exists only here.”

## 7. Receipts

Peer read of **that outbound message**. Grain is the send, not the thread. Authority is a live connector lookup. It is not an Event and does not write `last_read_*`.

`ChannelCapabilities.receipts` is set only when a real API exists. Feishu uses user-identity `GET /im/v1/messages/:id/read_users` on `om_` ids I sent within 7 days. Empty `items` stays `sent`. Official bot `read_users` must not be used as conversation unread.

`readReceipts(ThreadReceiptQuery[])` returns `Map<external_id, MessageReceipt>`. Outbound ids stay opaque. Opened threads query receipts; list `heads` do not. The desktop paints Sent / Read on outbound bubbles only when `can_receipt` or `receipt` is present.

DSH and Slack omit `receipts`. No API means no receipt UI. Attention still works.

## 8. Driver

Optional `prompts` / `attention` / `receipts`, plus `listPrompts`, `answerPrompt`, `readAttention`, `ackAttention`, `readReceipts`, and `surfaceGeneration`. Resolved by `installation + thread`. Disposing a plugin must drop that install’s live prompts.

## 9. Personal API

Inbox items carry `prompts`, `unread`, and `unread_count`. Opened threads also carry `can_receipt` / `receipt`. `POST /v1/me/conversations/prompts` answers. `POST /v1/me/conversations/attention` writes the cursor and acks the source when declared. `inbox_digest` appends `&s=` when a live surface generation exists. Receipt changes do not bump the digest.

## 10. Acceptance

1. No desktop/API `if (source === "dsh")` branch for answering or marking read.
2. A DSH web question/approval can be finished on the PC; the agent continues; no extra `session.prompt` echo.
3. Feishu unread still works from the local cursor when no source overlay exists.
4. Prompts never appear in the Event table.
5. Inbox `unread` is never “did they read what I sent.”
6. Slack / DSH do not declare `receipts` and do not fake a read tick.
