# Built-in connectors

The contract is in [Connectors](CONNECTOR.md). This page is implementation
notes for Slack / DSH / Feishu / Cursor / WhatsApp Web, not kernel branching
rules. First-party packages declare `regenic.plugin` and `contributes` in
`package.json`; the kernel discovers them from its dependencies and
loads only the named exports. Built-in chat / agent channels
have no business ticket types and omit `subjectCatalog`. A private plugin
publishes its own vocabulary and stamps `unit_kind` under the declarative
contract.

- **简体中文:** [../zh/CONNECTOR_DRIVERS.md](../zh/CONNECTOR_DRIVERS.md)
- **Status:** Phase 1

## Capabilities

| Driver | `source` | Sync | Reply | Create | Credentials |
| --- | --- | --- | --- | --- | --- |
| `slack-channel` | `slack` | one channel | no | no | `REGENIC_SLACK_TOKEN` |
| `dsh-session` web, no `session_id` | `dsh` | every session | yes | yes | `REGENIC_DSH_TOKEN` if the host asks |
| `dsh-session` web, with `session_id` | `dsh` | that session | yes | no | same |
| `dsh-session` cli | `dsh` | one mailbox | yes | no | local `dsh` |
| `feishu-chat` | `feishu` | selected conversations, or all visible groups and/or p2p chats | yes | no | local `lark-cli` user login |
| `cursor-agent` | `cursor` | local SDK sessions | yes | yes | paste on install or `CURSOR_API_KEY` |
| `whatsapp-web-live` | `whatsapp-personal` | visible WhatsApp Web chats via local extension webhook | yes | no | pairing code created on install |

Slack does not implement `createThread` / `bindEgress`. Feishu does not
implement `createThread`. Undeclared methods do not exist. DSH web
create opens an empty `session.create`; the first user text is a normal
reply (`session.prompt` queue) and the kernel awaits the first poll.
Cursor declares `create_with_task`: the desktop keeps a local draft;
the first task is `Agent.create` + `send`; the kernel seeds that
outbound and does not await the first poll. A pasted Cursor API key is stored in the
machine keychain (or `~/.regenic/credentials/cursor`), never in install
config.

Credential refs: Slack uses `env:REGENIC_SLACK_TOKEN`; DSH web uses
`env:REGENIC_DSH_TOKEN` (optional); Feishu uses `keychain:lark-cli`;
Cursor uses `keychain:regenic-cursor:<install id>` or
`env:CURSOR_API_KEY`. WhatsApp Web live stores a pairing code in the
machine keychain on install (`REGENIC_PERSONAL_LIVE_KEY` is an optional
CLI override). `oauth:HANDLE` / `app:HANDLE` are reserved;
built-in drivers do not use them in this phase.

WhatsApp Web live is webhook-only. The local extension posts observed
messages to `POST /v1/me/connectors/:id/webhook` and drains
`bindEgress` through the generic connector egress queue. Chat identity is
the WhatsApp JID, shared with a personal export import. See
[WhatsApp Web live connector](WHATSAPP_WEB_LIVE_CONNECTOR.md).

## Kind maps

DSH:

| Native event | `kind` |
| --- | --- |
| `user/message` with `source.kind=user` | `user` |
| `assistant/message` (text) | `assistant` |
| plugin-injected `user/message` | `system` |

Slack humans map to `user`.

Cursor local agents:

| Native event | `kind` |
| --- | --- |
| user turn | `user` (outbound, so local write-back can echo-match) |
| final assistant reply in that turn | `assistant` (thinking / progress / tools dropped) |
| extra assistant envelopes in the same gap | tombstoned; only the last reply is kept |
| Agent still running | `thread_status` + `activity: working` (in-flight assistant not ingested) |
| other nodes | dropped |

Cursor:

Thread id: `cursor:<agent_id>`. Local only, following
[cursor/cookbook `sdk/coding-agent-cli`](https://github.com/cursor/cookbook/tree/main/sdk/coding-agent-cli):
the first inbox task calls `Agent.create` + `send` immediately (not
queued). Follow-ups `Agent.resume` then `send` only when the agent is
IDLE. Two clocks: **accept** is seconds — Inbox HTTP returns after
`create` / `resume` / `send()` starts the run, and must not wait for
`run.wait()` or Chromium aborts with a false “cannot reach the
kernel”. The desktop 120s timeout covers only that start (cold
`resume`), not the whole job. **Completion** can take hours: poll
`Agent.get` + `Agent.messages.list` for `thread_status` +
`activity: working`, then the final assistant line. Do not `resume` to
observe, and do not `force` a follow-up onto an ACTIVE / CREATING run
(including a live run that has not finished `wait()`). Those follow-ups
are queued in `~/.regenic/cursor-pending-sends.json` (no API key on
disk) and flushed one at a time after an IDLE observation — after the
poll page is built, or when background `pumpRun` finishes. `Agent.get`
/ `list` stay read-only so that poll can emit `ended` for the run that
just finished. Background `wait()` is only leak control, not
completion truth; after the sidecar exits, the next open only polls.
Sync scans the local SDK store. Message times follow conversation
order at poll time, not `Agent.createdAt`, so a later turn cannot land
beside the first prompt. It does not scrape IDE chat history or
follow Cloud Agents. The install form keeps a **default model** (SDK
runs require one; default `composer-2.5`).
Capabilities follow the session-agent profile: `await_reply`,
`list_title: "prompt"`, `create_with_task`, and `hold_while_working`.
There is no official question-card API, so
`prompts` is unset. Tests override the host with `REGENIC_CURSOR_API_BASE`.

Feishu:

| Native message | `kind` |
| --- | --- |
| `sender_type=user`, `msg_type` `text` / `post` / `image` / `file` / `audio` / `media` | `user` |
| `sender_type=app` (or `bot`), same | `assistant` |
| interactive cards and other `msg_type` | dropped |

## Feishu

Thread id: `feishu:<chat_id>`. Login stays on `lark-cli`. History uses in-process HTTP with the `user_access_token` from the OS credential store (macOS Keychain, Linux libsecret, Windows Credential Manager), and falls back to `lark-cli api --as user` if the token cannot be read. Images and files download through `im/v1/messages/:id/resources/:file_key` into `attachment` parts when HTTP returns file bytes. User-token HTTP often returns a JSON error instead; then the connector falls back to `lark-cli im +messages-resources-download`. `img` nodes inside `post` are included. Already-synced conversations re-fetch the latest page once to backfill media that used to be dropped, and once more if those rows were empty placeholders so a `revise` can store the bytes. Inbox preview shows images up to 8MB, including `octet-stream` files sniffed as PNG/JPEG/GIF/WebP. New conversations, and ones still paging oldest-first, fetch the latest page first (`ByCreateTimeDesc`), then backfill older messages. Up to 50 messages per page. The conversation list is cached for about 30 seconds. Each record stores the chat name, `group` or `direct`, and the sender name. Mentions in the body use the native `mentions[]` names (`@_user_1` becomes `@Ben`; `@all` becomes `@所有人`). `contact +search-user` is only for remaining sender ids. **Group** census uses Open API `GET /im/v1/chats` when a user token is available; **p2p** still uses `lark-cli im +chat-list --types=p2p` because the official list API is groups-only. The install form merges both. It does not take tokens or a pasted `oc_…`. Default is both kinds. The set can be changed after install. Inbox **heads** and default thread reads skip live `read_status` overlays unless the client passes `live=1`; list unread dots rely on local cursor until a periodic full refresh with `live=1`.

## Setup

The Engine page always opens the install dialog. When required
prerequisites are not ready the card button says Set up; submit stays
blocked. Steps live on `installCatalog().setup_steps`. The user does
them; the kernel only probes.

| Driver | When `ready` is false | What to run |
| --- | --- | --- |
| `slack-channel` | `REGENIC_SLACK_TOKEN` unset | Set a bot token from your Slack app, then restart the desktop |
| `dsh-session` web | `dsh` not on PATH | `dsh` must work in the terminal. Then `dsh web --port 3080` |
| `dsh-session` web | `dsh` present, port 3080 down | `dsh web --port 3080` |
| `dsh-session` cli | local `dsh` | `dsh` must work in the terminal |
| `feishu-chat` | `lark-cli` not on PATH | `npx @larksuite/cli@latest install` ([lark-cli](https://github.com/larksuite/cli)) |
| `feishu-chat` | CLI present, user not signed in | `lark-cli config init` then `lark-cli auth login --recommend` |
| `cursor-agent` | no key | Paste a Cursor API key on the install form, or set `CURSOR_API_KEY` |
| `whatsapp-web-live` | — | Install in Engine, copy the pairing code into the extension |

Feishu tokens stay in the OS credential store. Optional `REGENIC_LARK_CLI` points
at a binary that is not on PATH.
