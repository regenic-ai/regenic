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

1. Add a channel-agnostic **Thread Surface** on the connector port: `prompts` (human intervention) and `attention` (read/unread).
2. Kernel and desktop read declarations only. No `dsh` / `feishu` branches.
3. Prompts are **not** Events. The local read cursor lives on `conversation_prefs`. A source overlay is optional.
4. The PC console can answer a far-side question or approval without opening the original UI.

## 3. Non-goals

- Permission presets, slash commands, or channel settings.
- Modeling a prompt as an `IngestRecord` or a new Event type.
- Pretending every chat OpenAPI exposes a conversation unread count.
- Remote DSH answers over CLI transport (no mux).

## 4. Invariants

| Face | Authority | Lifetime |
| --- | --- | --- |
| Event / Blob | Ingest service | Durable |
| `conversation_prefs.title` / `pinned` | Kernel | Durable |
| `conversation_prefs.last_read_*` | Kernel local cursor | Durable |
| Prompt | Connector control plane | Live; gone when the far side resolves |
| Source attention | Optional connector overlay | Live; fall back to the local cursor |

The kernel must not infer “this is an approval” or “this is Feishu unread” from a channel name.

## 5. Prompt

`prompt_id` is opaque to the kernel. Presentation changes UI only: `plan_review` highlights the option marked `emphasized`. Single-select `custom` replaces `selected`. Answering a prompt must **not** also call `egress.send`.

Unread is a **thread** property. The kernel compares the store’s latest inbound on that thread (not the list-face event) to `last_read_*`. A driver may treat that inbound id as an opaque hint; the kernel never learns `om_` or a mux `rpcId`.

## 6. Attention

Local cursor: `last_read_at`, `last_read_external_id`. Written when a thread is opened or via `POST /v1/me/conversations/attention`.

Inbox `unread` is computed by the kernel:

1. Pending `prompts` or `activity === awaiting_user` → unread.
2. Else a source overlay, if the driver returned one.
3. Else whether the latest inbound is newer than the local cursor.

## 7. Driver

Optional `prompts` / `attention` on `ChannelCapabilities`, plus `listPrompts`, `answerPrompt`, `readAttention`, `ackAttention`, and `surfaceGeneration`. Resolved by `installation + thread`. Disposing a plugin must drop that install’s live prompts.

## 8. Personal API

Inbox items carry `prompts`, `unread`, and `unread_count`. `POST /v1/me/conversations/prompts` answers. `POST /v1/me/conversations/attention` writes the cursor and acks the source when declared. `inbox_digest` appends `&s=` when a live surface generation exists.

## 9. Acceptance

1. No desktop/API `if (source === "dsh")` branch for answering or marking read.
2. A DSH web question/approval can be finished on the PC; the agent continues; no extra `session.prompt` echo.
3. Feishu unread still works from the local cursor when no source overlay exists.
4. Prompts never appear in the Event table.
