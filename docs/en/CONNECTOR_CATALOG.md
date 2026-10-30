# Connector catalog

Connectors bring messages from other tools into Regenic. This page lists the connectors available today, what each one can do, and how to load it.

- **简体中文:** [../zh/CONNECTOR_CATALOG.md](../zh/CONNECTOR_CATALOG.md)
- **Related:** [Build a connector](CONNECTOR.md) · [Built-in connector notes](CONNECTOR_DRIVERS.md) · [Example plugins](../../examples/connectors/README.md) · [Setup and CLI](SETUP_AND_CLI.md)

## At a glance

| Source | Package | Connects as | Read | Reply | Platforms |
| --- | --- | --- | --- | --- | --- |
| Feishu | Built in | Your user account, via `lark-cli` | Selected groups and DMs, with history | Text | macOS, Linux, Windows |
| DSH | Built in | Local `dsh` | Agent sessions | Prompts; new sessions in web mode | Where `dsh` runs |
| Cursor | Built in | Cursor API key | Local SDK agent sessions | Tasks; new sessions | Where the Cursor SDK runs |
| Slack | [regenic-connector-slack](https://github.com/regenic-ai/regenic-connector-slack) | Bot (recommended) or your user account (opt-in) | Bot: one channel. User: selected conversations, with history | User mode only: text and thread replies | macOS, Linux |
| WhatsApp | [regenic-connector-whatsapp](https://github.com/regenic-ai/regenic-connector-whatsapp) | Chat exports, WhatsApp Web via browser extension, or linked device (opt-in) | Exports; live messages from WhatsApp Web | Text, via WhatsApp Web or linked device | Browser; linked device verified on macOS arm64 |
| Telegram | [regenic-connector-telegram](https://github.com/regenic-ai/regenic-connector-telegram) | Your user account, via TDLib | Selected private and group chats, with history | Text, including replies to a message | macOS on Apple silicon |
| DingTalk | [dingtalk-connector](https://github.com/regenic-ai/dingtalk-connector) | Your user account, via `dws` | Recent, all, or selected groups and DMs, with history and attachments | Text | Where `dws` runs |
| WeCom | [wecom-connector](https://github.com/regenic-ai/wecom-connector) | Smart bot over a long connection | Messages sent to the bot after it connects; in groups, only when @mentioned | Markdown, after the bot receives a message in that chat | Where Node.js runs |
| CSV / JSONL | CLI import | Exported files | Imported records | — | Any |

"Read" and "Reply" describe what each connector implements. What you can actually access also depends on the platform's permissions, your account, and your organization's policies.

## Choosing a connection mode

Some sources offer more than one way to connect. Prefer official, documented routes:

- **Official APIs and bots** (Slack bot, WeCom smart bot) are the most stable, but usually see less: often only one channel, or only messages addressed to the bot.
- **Official user CLIs** (Feishu `lark-cli`, DingTalk `dws`) read as you, through tools the platform provides.
- **User-session clients** (Slack user mode, Telegram via TDLib, WhatsApp linked device) see what you see, but may conflict with platform terms and can lead to account restrictions. These modes are off by default and require explicit confirmation.

Regenic defines the connector standard. Each connector decides how it connects to its source and documents the risks. Install only connectors you trust: plugins run in the same process as the kernel.

## Load an external connector

External connectors are separate repositories. Build one, then load it before starting Regenic:

```bash
# In the connector repository
pnpm install
pnpm build

# Option 1: point at a single package
export REGENIC_CHANNEL_PLUGIN=/absolute/path/to/connector

# Option 2: link it into the plugin directory (default ~/.regenic/plugins)
ln -s /absolute/path/to/connector ~/.regenic/plugins/<name>
```

Then open **Engine**, find the connector, and choose **Install**. Credentials are entered on the install form or stored in the system keychain; they are not saved in the connector config.

Some connectors need `REGENIC_ROOT` to point at a Regenic checkout during the build. Follow each repository's README for build steps and prerequisites.

## Connector notes

### Feishu

Sign in with `lark-cli`, then choose recent, all, or selected conversations on the install form. See [Setup: Feishu](SETUP_AND_CLI.md#feishu) and [built-in connector notes](CONNECTOR_DRIVERS.md#feishu).

### DSH and Cursor

Read and drive local agent sessions. They can also serve as [executors](EXECUTOR.md) for tasks and search answers. See [built-in connector notes](CONNECTOR_DRIVERS.md).

### Slack

- **Bot mode (recommended):** set `REGENIC_SLACK_TOKEN` and install **Slack bot (read-only)**. Syncs one channel; cannot send.
- **User mode (opt-in):** requires `REGENIC_SLACK_USER_BRIDGE=1` and explicit risk acknowledgement. Syncs selected conversations by polling and sends plain-text messages and thread replies. Not tested against real accounts.

### WhatsApp

- **Export import:** read-only. Imports chat exports you choose.
- **WhatsApp Web (default live path):** a browser extension forwards messages from WhatsApp Web. Replies fill the composer; clicking Send requires a separate opt-in.
- **Linked device (opt-in):** an unofficial protocol, off by default, that may lead to account restrictions. Supports selected conversations and text replies.

### Telegram

Signs in as your user account through a locally built TDLib. API credentials and the database key stay in the macOS Keychain. Syncs text from selected private and group chats and sends text replies. No media, secret chats, or channels.

### DingTalk

Uses the DingTalk Workspace CLI (`dws`) with your account; an admin must enable CLI access first. Syncs history from recent, all, or selected conversations, downloads images and files, and sends text replies.

### WeCom

Uses an official smart bot over a long connection. Receives only messages sent after it connects; in groups, only messages that @mention the bot. It can reply only in a chat where it has already received a message.

### CSV / JSONL

Import exported messages with a field mapping. See [Setup: file import](SETUP_AND_CLI.md#file-import).

## Build your own

A connector can be read-only; it does not need to implement a full chat client. Start with an example:

| Example | Use when |
| --- | --- |
| [`import-only`](../../examples/connectors/import-only) | Importing files the user exports |
| [`webhook`](../../examples/connectors/webhook) | A browser extension or service pushes messages |
| [`poll`](../../examples/connectors/poll) | Polling a local or LAN HTTP endpoint |
| [`catalog-only`](../../examples/connectors/catalog-only) | Declaring work types before live sync |

The full contract is in [Build a connector](CONNECTOR.md).
