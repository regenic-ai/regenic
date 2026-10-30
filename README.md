# Regenic

**Connect your work messages to the AI you already use.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D20-blue.svg)](https://nodejs.org/)
[![pnpm](https://img.shields.io/badge/pnpm-9-blue.svg)](https://pnpm.io)

[English](README.md) · [简体中文](README.zh-CN.md)

Regenic is an open-source, local-first app that brings conversations from different work channels into your AI's context. Use pluggable connectors to add message sources, then let your AI search conversations, summarize progress, and draft replies—without copying chat logs by hand.

Keep your chat apps. Keep your AI. Connect the two.

[Quick start](#quick-start) · [Connectors](#connectors) · [MCP setup](docs/en/CONTEXT_SEARCH_MCP.md) · [Docs](docs/en/README.md)

## What you can do

| Task | Ask your AI |
| --- | --- |
| Catch up on a project | “Summarize the latest updates across these conversations.” |
| Find the original agreement | “What did we promise this customer? Show me the messages.” |
| Draft a reply | “Use the conversation so far to draft a response.” |

These workflows use messages you have connected and authorized. Regenic provides the context; your AI does the reasoning.

## Why Regenic

- **Add your own sources.** A shared connector contract supports imports, webhooks, and polling. Use an existing plugin or build one for your workflow.
- **Use your existing AI.** MCP clients such as Cursor can search and read conversation context. Scripts and other tools can use the API.
- **Keep the evidence.** Retrieved messages include their source, thread, and identifiers so answers can point back to the conversation.
- **Stay in control.** Review messages in the desktop workbench. Reading and sending have separate permissions; sending also requires connector support.
- **Local-first.** Your device is the source of truth, with Markdown and JSONL exports. Connecting an external AI may send retrieved content to its provider.

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

The connector standard is open to new sources; built-in support is intentionally small.

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

Regenic currently supports **individual use**. Shared team records are planned, not available today. Source coverage, sync behavior, and sending depend on each connector and the permissions you grant.

The Context Search MCP is **read-only**: it does not approve or send messages. Third-party plugins run in the kernel process, so install only plugins you trust. See the [roadmap](docs/en/ROADMAP.md) and [security notes](docs/en/SETUP_AND_CLI.md#security).

## Documentation and contributing

[All docs](docs/en/README.md) · [Setup & CLI](docs/en/SETUP_AND_CLI.md) · [Connector development](docs/en/CONNECTOR.md) · [MCP](docs/en/CONTEXT_SEARCH_MCP.md) · [Architecture](docs/en/MESSAGE_ORCHESTRATION.md) · [Executors](docs/en/EXECUTOR.md)

Bug reports, connector contributions, and feedback are welcome in [Issues](https://github.com/regenic-ai/regenic/issues). For implementation PRs, follow the [product boundaries](docs/en/PRODUCT.md) and cite the relevant RFC.

Please follow the [Code of Conduct](https://github.com/regenic-ai/regenic-book/blob/main/CODE_OF_CONDUCT.md). Report security issues through a [private advisory](https://github.com/regenic-ai/regenic/security/advisories/new).

## License

[MIT](LICENSE). Methodology in [regenic-book](https://github.com/regenic-ai/regenic-book) remains CC BY-NC 4.0 where applicable.
