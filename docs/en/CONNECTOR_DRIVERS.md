# Built-in connectors

The contract is in [Connectors](CONNECTOR.md). This page is implementation
notes for Slack / DSH / Feishu, not kernel branching rules.

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

Slack does not implement `createThread` / `bindEgress`. Feishu does not
implement `createThread`. Undeclared methods do not exist.

Credential refs: Slack uses `env:REGENIC_SLACK_TOKEN`; DSH web uses
`env:REGENIC_DSH_TOKEN` (optional); Feishu uses `keychain:lark-cli`. The
form does not take tokens.

## Kind maps

DSH:

| Native event | `kind` |
| --- | --- |
| `user/message` with `source.kind=user` | `user` |
| `assistant/message` (text) | `assistant` |
| plugin-injected `user/message` | `system` |

Slack humans map to `user`.

Feishu:

| Native message | `kind` |
| --- | --- |
| `sender_type=user`, `msg_type` `text` / `post` / `image` / `file` / `audio` / `media` | `user` |
| `sender_type=app` (or `bot`), same | `assistant` |
| interactive cards and other `msg_type` | dropped |

## Feishu

Thread id: `feishu:<chat_id>`. Login stays on `lark-cli`. History uses in-process HTTP with the `user_access_token` from the CLI keychain, and falls back to `lark-cli api --as user` if the token cannot be read. Images and files download through `im/v1/messages/:id/resources/:file_key` into `attachment` parts when HTTP returns file bytes. User-token HTTP often returns a JSON error instead; then the connector falls back to `lark-cli im +messages-resources-download`. `img` nodes inside `post` are included. Already-synced conversations re-fetch the latest page once to backfill media that used to be dropped, and once more if those rows were empty placeholders so a `revise` can store the bytes. Inbox preview shows images up to 8MB, including `octet-stream` files sniffed as PNG/JPEG/GIF/WebP. New conversations, and ones still paging oldest-first, fetch the latest page first (`ByCreateTimeDesc`), then backfill older messages. Up to 50 messages per page. The conversation list is cached for about 30 seconds. Each record stores the chat name, `group` or `direct`, and the sender name. Mentions in the body use the native `mentions[]` names (`@_user_1` becomes `@Ben`; `@all` becomes `@所有人`). `contact +search-user` is only for remaining sender ids. The form lists groups and p2p chats from `lark-cli im +chat-list --types=p2p,group`. It does not take tokens or a pasted `oc_…`. Default is both kinds. The set can be changed after install.

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
