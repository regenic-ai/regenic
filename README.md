# Regenic

**Bring work messages together. Search, organize, and process them your way.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D20-blue.svg)](https://nodejs.org/)
[![pnpm](https://img.shields.io/badge/pnpm-9-blue.svg)](https://pnpm.io)

[English](README.md) · [简体中文](README.zh-CN.md)

Project discussions, customer feedback, and agent transcripts often live in different tools. They belong to the same work, but are hard to review, analyze, or act on together.

We're building an open-source platform for work messages. Pluggable connectors bring messages from different channels into one place to browse and search, with executors, APIs, and MCP providing ways to process them further. Finding information across conversations, analyzing customer feedback, and handing a task to an agent are different uses of the same foundation—not the limits of the product.

Our goal is to make what you can do with a message independent of where it came from. Extend the sources, bring your own processing logic, and build workflows around your work. Regenic starts with a local-first personal workbench and is growing toward broader message orchestration and team collaboration.

[Quick start](#quick-start) · [Connectors](#connectors) · [MCP setup](docs/en/CONTEXT_SEARCH_MCP.md) · [Docs](docs/en/README.md)

## What you can do today

| Task | How it works today |
| --- | --- |
| Work through messages | Browse connected conversations in the workbench and reply where sending is supported and authorized. |
| Find information across channels | Use Search to find conversations from different sources, expand surrounding context, and open the original messages. No MCP setup required. |
| Analyze related conversations | Choose an installed executor in Search to answer from retrieved conversations—for example, to summarize project updates or check commitments—with citations. |
| Move context between channels | Forward selected messages or a conversation to another send-capable conversation, editing the content before sending. |
| Delegate work to agents | Use Recipes to select an executor for matching tasks, then start runs in the workbench, track their status, and respond to requests for human input. |
| Integrate your own tools | External AI tools can retrieve conversations through read-only MCP; scripts and other systems can integrate through the API. |

These features operate on connected, authorized data. Search answers require an available executor; sending, forwarding, and execution depend on connector and executor capabilities and permissions. See [executors](docs/en/EXECUTOR.md), and [MCP](docs/en/CONTEXT_SEARCH_MCP.md).

## Features

- **One message format.** Messages from every channel are normalized, then stored, searched, and processed the same way.
- **Extensible sources.** Connectors follow an open standard and support file imports, webhooks, and polling. Install an existing plugin or build a connector for another source.
- **Extensible processing.** Search, reply, and forward in the workbench, use executors to process search results and tasks, or integrate your own tools through the API and MCP.
- **Traceable answers.** Every result carries its channel, conversation, and message IDs, so you can always go back to the source.
- **Sending is opt-in.** Reading and sending are authorized separately, and sending also depends on the connector.
- **Your data stays local.** Messages are stored on your machine and can be exported as Markdown or JSONL. If you use an external AI, retrieved content is sent to that provider.

## Where we're headed

Today's release provides message ingestion, a workbench, search, executors, and integration interfaces—not a complete autonomous workflow system. We're working toward connecting these capabilities into customizable workflows:

- **Broader orchestration.** Combine filtering, transformation, analysis, routing, and delivery to suit the work—not just search and Q&A.
- **Proactive triage and follow-through.** Use personal habits and team standards to identify what needs attention, distill sourced conclusions and follow-ups, and route work to the right person or agent.
- **From individuals to teams.** Start with personal use, then extend to organizations so teams work from the same context.

See the [product overview](docs/en/PRODUCT.md) and [roadmap](docs/en/ROADMAP.md).

## Quick start

Requires **Node.js 20+** and **pnpm 9**. Run from source:

```bash
git clone https://github.com/regenic-ai/regenic.git
cd regenic
pnpm install
pnpm dev:desktop
```

1. **Connect a source.** For Feishu, [install and sign in to `lark-cli`](docs/en/SETUP_AND_CLI.md#feishu), then open **Engine → Feishu → Install** and choose conversations.
2. **Browse and search.** Open synced conversations in the workbench, or use **Search** to find information across conversations and inspect the context.
3. **Choose how to process it.** For answers based on search results, configure an available [executor](docs/en/EXECUTOR.md) in **Engine**, then select it in Search. To query from an external AI tool instead, follow the [MCP setup guide](docs/en/CONTEXT_SEARCH_MCP.md). MCP is not required for the workbench or search.

For other connectors, see the [connector catalog](docs/en/CONNECTOR_CATALOG.md). For DSH, Docker, and CLI commands, see the [setup and CLI reference](docs/en/SETUP_AND_CLI.md).

## Connectors

Feishu, DSH, and Cursor are built in. Other sources ship as separate plugins built on the same open standard.

| Source | Available through | Connects as | Reply |
| --- | --- | --- | --- |
| Feishu | Built in | Your account, via `lark-cli` | Text |
| DSH / Cursor | Built in | Local agent sessions | Prompts and tasks |
| Slack | [Plugin](https://github.com/regenic-ai/regenic-connector-slack) | Bot (read-only), or your account (opt-in) | Text, in user mode |
| WhatsApp | [Plugin](https://github.com/regenic-ai/regenic-connector-whatsapp) | Exports, WhatsApp Web extension, or linked device (opt-in) | Text |
| Telegram | [Plugin](https://github.com/regenic-ai/regenic-connector-telegram) | Your account, via TDLib | Text |
| DingTalk | [Plugin](https://github.com/regenic-ai/dingtalk-connector) | Your account, via `dws` | Text |
| WeCom | [Plugin](https://github.com/regenic-ai/wecom-connector) | Smart bot | Markdown |
| CSV / JSONL | CLI import | Exported files | — |

See the [connector catalog](docs/en/CONNECTOR_CATALOG.md) for capabilities, platform requirements, risks, and how to load a plugin. To add another source, start with the [connector guide](docs/en/CONNECTOR.md) and [example plugins](examples/connectors/README.md). A connector can be read-only; it does not have to implement a full chat client.

## Current scope

Regenic is currently for **individual use**; team sharing is on the roadmap. What you can read, how it syncs, and whether you can send all depend on the connector and the permissions you grant.

The Context Search MCP is **read-only**: it does not approve or send messages. Third-party plugins run in the kernel process, so install only plugins you trust. See the [roadmap](docs/en/ROADMAP.md) and [security notes](docs/en/SETUP_AND_CLI.md#security).

## Documentation and contributing

[All docs](docs/en/README.md) · [Setup & CLI](docs/en/SETUP_AND_CLI.md) · [Connector catalog](docs/en/CONNECTOR_CATALOG.md) · [Connector development](docs/en/CONNECTOR.md) · [MCP](docs/en/CONTEXT_SEARCH_MCP.md) · [Architecture](docs/en/MESSAGE_ORCHESTRATION.md) · [Executors](docs/en/EXECUTOR.md)

Bug reports, connector contributions, and feedback are welcome in [Issues](https://github.com/regenic-ai/regenic/issues). For implementation PRs, follow the [product boundaries](docs/en/PRODUCT.md) and cite the relevant RFC.

Please follow the [Code of Conduct](https://github.com/regenic-ai/regenic-book/blob/main/CODE_OF_CONDUCT.md). Report security issues through a [private advisory](https://github.com/regenic-ai/regenic/security/advisories/new).

## License

[MIT](LICENSE). Methodology in [regenic-book](https://github.com/regenic-ai/regenic-book) remains CC BY-NC 4.0 where applicable.
