# RFC 0010 — Cross-channel forward

- **Status:** Draft
- **简体中文:** [../../zh/rfcs/0010-cross-channel-forward.md](../../zh/rfcs/0010-cross-channel-forward.md)
- **Depends on:** RFC 0004, RFC 0008, RFC 0009, connector contract
- **Related:** [MESSAGE_ORCHESTRATION](../MESSAGE_ORCHESTRATION.md) · [CONNECTOR](../CONNECTOR.md) · [Desktop](../../zh/DESKTOP.md)

## 1. Problem

The console already folds Feishu, Slack, DSH, and Cursor into one message shape. When a person wants to hand a conversation to another writable place (especially a new agent session), today there are only two paths:

- `POST /v1/me/replies` writes back to **this** `thread_id`'s original channel.
- A Recipe / Handle now opens a WorkItem on the **same** thread; the result still writes back there.

Neither is a forward. Extending replies with `target_thread_id` dirties “replies go back to the original channel.” Letting connectors translate each other (Feishu wire → DSH wire) forks the kernel and desktop by source name.

Copy-to-clipboard is a desktop-surface gap. It is not this RFC.

## 2. Goals

1. Forward = **compile + send**. The source thread does not move, does not change `thread_id`, and does not pair with the target.
2. The kernel compiles source Events into a channel-agnostic `PortableForwardPacket`. The destination eats existing `ContentPart[]`.
3. New resource `POST /v1/me/forwards`. Do not extend replies.
4. The desktop asks only `can_send` / `can_create` and renders `channel_label`. No `if (source === …)`.
5. Provenance is queryable: the destination outbound carries `forwarded_from`; the source thread gets a `status` that stays out of `current_work` and carries `forwarded_to`. Wave 1 does not open a WorkItem and does not write an agent result back to the source channel.

## 3. Non-goals

- Cross-channel mirroring or bidirectional sync.
- Merging two `thread_id`s, or a cross-channel thread alias.
- Implementing chat forward as an RFC 0003 org Handoff object.
- Slack / WhatsApp as send targets (no live egress).
- Copying a message to the clipboard.

## 4. Invariants

| Rule | Meaning |
| --- | --- |
| One thread, one `source` | `thread_id = source:target` stays. Forward grows a new outbound on the **destination** thread. |
| Replies still return | Later replies on the destination thread still use that thread's own egress. |
| Seeing is not sending | A target with no `can_send` (existing) or `can_create` (new) must not appear in the picker. |
| Connectors only translate | A driver does not implement “forward to another channel.” |
| Write-back stays explicit | Forward must not raise `can_write_back`. |

## 5. Semantics

Two modes, one API:

| `mode` | Entry | Compiles | Target |
| --- | --- | --- | --- |
| `messages` | Forward on a message | The given `event_ids` utterances | An existing `can_send` thread |
| `transcript` | Forward conversation on the thread head | Visible utterances (drop status / prompt / ticket heads) | An existing writable thread, or `createThread` on a `can_create` install |

Attribution is on by default: `channel label · speaker · time`. The preview may edit it. Cursor `create_with_task` treats the first packet as the task text; otherwise `createThread` then `send`. The desktop still reads capability bits only.

## 6. API

```http
POST /v1/me/forwards
```

```ts
type ForwardInput = {
  source_thread_id: string;
  event_ids?: string[];
  target:
    | { thread_id: string }
    | { installation_id: string; create: true };
  mode: "messages" | "transcript";
  attribution?: boolean; // default true
};

type ForwardView = {
  accepted: true;
  source_thread_id: string;
  target_thread_id: string;
  created: boolean;
  item: InboxViewItem;
  truncated?: boolean;
};
```

Idempotency: `hash(org, source_thread, event_ids, target, mode)`. No writable target → 404 `no_sender`. A driver that cannot send must not appear in the picker; 501 is not the happy path.

Implementation lives in `PersonalForwardService`. Do not change the `PersonalReplyService` contract.

## 7. Compile

`compileForwardPacket()` lives in `@regenic/domain` and does not import channel names.

- Compile only `record_class === "utterance"`.
- Body is already-flattened markdown / plain.
- Attachments come from BlobStore as bytes for the destination egress. A hash is not enough.
- Truncate at the existing `MAX_TEXT` (32_000) and say so in the packet header.
- Destination Event surface attrs: `forwarded_from: { thread_id, event_ids, source }`.
- No new table. The source ingests a `thread_status` (`outside_current_work`) whose surface carries `forwarded_to: { thread_id, event_ids, source }`. Inbox joins that onto the source utterances by `event_ids`. The latest forward wins. A failed source ingest does not turn a delivered forward into 502.

## 8. Desktop

- Message hover: Copy (local) · Forward (this RFC) · Reply (existing). Right-click without a selection uses the same actions; a text selection uses the system Copy menu.
- Check utterances (Shift for a range) to forward or copy the selection.
- Destination bubble chip: `Forwarded from {channel_label}`.
- Source bubble chip: `Forwarded to {channel_label}`. The status trace is not drawn as a system bubble.
- Thread head: Forward conversation.
- Picker top: inbox threads with `can_send`. Bottom: existing `createTargets` as `New {channel}`.
- Preview the compiled packet before send. Jump to a newly created agent thread; stay on the source after sending into an existing one.

## 9. Waves

| Wave | Ships |
| --- | --- |
| P1 | `messages` → existing `can_send` thread (shipped) |
| P2 | `transcript` → new agent thread via `can_create` (shipped) |
| P3 | Multi-select, attachment fidelity, destination provenance chip (shipped) |
| P4 | Source-side “Forwarded to” chip (shipped) |

P0 copy does not block this RFC.
