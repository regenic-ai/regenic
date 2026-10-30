# Regenic

**Let your AI work across every channel your team talks in.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D20-blue.svg)](https://nodejs.org/)
[![pnpm](https://img.shields.io/badge/pnpm-9-blue.svg)](https://pnpm.io)

[English](README.md) · [简体中文](README.zh-CN.md)

Work conversations are scattered across Feishu, Slack, WhatsApp, and more. When you want AI to help you catch up or reply, you usually have to dig through each app and paste the history in by hand.

Regenic fixes that. It collects work messages from all your channels on your machine and exposes them to AI tools like Cursor through MCP. Your AI can then search across channels, summarize progress, and draft replies for you.

Regenic is open source and local-first. Sources plug in through connectors: use an existing plugin, or write your own against a shared standard.

[Quick start](#quick-start) · [Connectors](#connectors) · [MCP setup](docs/en/CONTEXT_SEARCH_MCP.md) · [Docs](docs/en/README.md)

## Use cases

| Use case | Ask your AI |
| --- | --- |
| Search across channels | “Who mentioned the contract payment date last week?” |
| Catch up on a project | “Summarize this week's updates on the project from every group chat.” |
| Check a customer commitment | “What did we promise this customer? Show me the original messages.” |
| Draft a reply | “Based on our earlier conversation, draft a reply.” |

Your AI only sees conversations you've connected and authorized. Results include where each message came from, so you can check the original.

## Features

- **One place for every channel.** Conversations from different apps are stored and searched together, so you stop switching between them.
- **Extensible sources.** Connectors follow one standard and support file imports, webhooks, and polling. If no plugin fits, write your own.
- **Bring your own AI.** MCP clients such as Cursor can query conversations directly; scripts and other tools can use the API.
- **Traceable answers.** Every result carries its channel, conversation, and message IDs, so you can always go back to the source.
- **Sending is opt-in.** Reading and sending are authorized separately, and sending also depends on the connector.
- **Your data stays local.** Messages are stored on your machine and can be exported as Markdown or JSONL. If you use an external AI, retrieved content is sent to that provider.

## Quick start

Requires **Node.js 20+** and **pnpm 9**. Run from source:

```bash
git clone https://github.com/regenic-ai/regenic.git
cd regenic
pnpm install
pnpm dev:desktop
```

1. **Connect a source.** For Feishu, [install and sign in to `lark-cli`](docs/en/SETUP_AND_CLI.md#feishu), then open **Engine → Feishu → Install** and choose conversations.
2. **Connect your AI.** Follow the [MCP setup guide](docs/en/CONTEXT_SEARCH_MCP.md) to let your MCP client search and read those conversations.
3. **Ask about your work.** Try “Summarize the latest project updates and cite the messages.”

For DSH, plugin installation, Docker, and CLI commands, see the [setup and CLI reference](docs/en/SETUP_AND_CLI.md).

## Connectors

Feishu, DSH, and Cursor are built in; Slack and WhatsApp ship as separate plugins. Any other source can plug in through the same standard.

| Source | Available through | Scope |
| --- | --- | --- |
| Feishu | Built in | Sync selected groups and DMs; send text using your authorized account |
| DSH | Built in | Read local agent sessions, send prompts, and create sessions in supported modes |
| Cursor | Built in | Read and run local SDK agent sessions; not IDE chat history or Cloud Agents |
| Slack | [Separate plugin](https://github.com/regenic-ai/regenic-connector-slack) | Install separately; see the plugin's supported capabilities |
| WhatsApp | [Separate plugin](https://github.com/regenic-ai/regenic-connector-whatsapp) | Install separately; see the plugin's setup and limitations |
| CSV / JSONL | CLI import | Import exported messages with a field mapping |

**Need another source?** Start with the [connector guide](docs/en/CONNECTOR.md) and [example plugins](examples/connectors/README.md). A connector can be read-only; it does not have to implement a full chat client.

## Current scope

Regenic is currently for **individual use**; team sharing is on the roadmap. What you can read, how it syncs, and whether you can send all depend on the connector and the permissions you grant.

The Context Search MCP is **read-only**: it does not approve or send messages. Third-party plugins run in the kernel process, so install only plugins you trust. See the [roadmap](docs/en/ROADMAP.md) and [security notes](docs/en/SETUP_AND_CLI.md#security).

## Documentation and contributing

[All docs](docs/en/README.md) · [Setup & CLI](docs/en/SETUP_AND_CLI.md) · [Connector development](docs/en/CONNECTOR.md) · [MCP](docs/en/CONTEXT_SEARCH_MCP.md) · [Architecture](docs/en/MESSAGE_ORCHESTRATION.md) · [Executors](docs/en/EXECUTOR.md)

Bug reports, connector contributions, and feedback are welcome in [Issues](https://github.com/regenic-ai/regenic/issues). For implementation PRs, follow the [product boundaries](docs/en/PRODUCT.md) and cite the relevant RFC.

Please follow the [Code of Conduct](https://github.com/regenic-ai/regenic-book/blob/main/CODE_OF_CONDUCT.md). Report security issues through a [private advisory](https://github.com/regenic-ai/regenic/security/advisories/new).

## License

[MIT](LICENSE). Methodology in [regenic-book](https://github.com/regenic-ai/regenic-book) remains CC BY-NC 4.0 where applicable.
