# Regenic

**连接不同渠道的工作消息，自由组织、检索和处理。**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D20-blue.svg)](https://nodejs.org/)
[![pnpm](https://img.shields.io/badge/pnpm-9-blue.svg)](https://pnpm.io)

[English](README.md) · [简体中文](README.zh-CN.md)

一个项目的讨论、客户反馈和 Agent 的执行记录，可能分别留在不同的工具里。它们属于同一件工作，却很难放在一起查阅、分析和处理。

我们在构建一个开源的工作消息平台：通过可插拔连接器汇集不同渠道的消息，让你在同一处查看和搜索，并通过执行器、API 或 MCP 进一步处理。跨对话查找信息、整理客户反馈、把工单交给 Agent，都是这套能力的不同用法，而不是产品的全部。

我们的目标是让消息的使用方式不再受来源工具限制：你可以扩展消息来源，也可以接入自己的处理逻辑，将消息组织成适合自己工作的流程。Regenic 从本地优先的个人工作台起步，逐步扩展到更完整的消息编排与团队协作。

[快速开始](#快速开始) · [连接器](#连接器) · [MCP 配置](docs/zh/CONTEXT_SEARCH_MCP.md) · [文档](docs/zh/README.md)

## 现在可以做什么

| 工作 | 当前的使用方式 |
| --- | --- |
| 集中处理消息 | 在工作台查看已接入的会话，在支持发送且已授权的会话中直接回复。 |
| 跨渠道追溯信息 | 在 Search 中搜索不同来源的对话、展开前后文、定位原始消息；不需要配置 MCP。 |
| 根据多段对话分析问题 | 在 Search 中选择已安装的执行器，根据检索结果回答问题，例如梳理项目进展或核对客户承诺，并查看引用。 |
| 跨渠道传递上下文 | 将选定消息或会话转发到另一个支持发送的会话，发送前可编辑内容。 |
| 交给 Agent 处理工作 | 通过规则（Recipes）为匹配的工单选择执行器，在工作台启动执行、跟踪状态并响应人工确认。 |
| 接入自己的工具 | 外部 AI 可通过只读 MCP 检索对话；脚本和其他系统可通过 API 集成。 |

上述功能覆盖已接入并授权的数据。搜索回答需要可用的执行器；发送、转发和执行能力取决于连接器、执行器及相应授权。参见[桌面工作台](docs/zh/DESKTOP.md)、[执行器](docs/zh/EXECUTOR.md)和 [MCP](docs/zh/CONTEXT_SEARCH_MCP.md)。

## 特点

- **统一的消息格式。** 不同渠道的消息转换成同一种格式，统一存储、检索和处理。
- **可扩展的消息来源。** 连接器遵循开放标准，支持文件导入、Webhook 和轮询。可以安装现成插件，也可以为新的消息来源开发连接器。
- **可扩展的处理方式。** 在工作台搜索、回复、转发，通过执行器处理检索结果和工单，或通过 API、MCP 接入自己的工具。
- **出处可以追溯。** 每条结果都带有渠道、会话和消息标识，随时可以回到原始对话。
- **发送需要授权。** 读取和发送分开授权；能否发送消息，也取决于具体连接器。
- **数据保存在本地。** 消息存储在你的电脑上，可导出为 Markdown 和 JSONL。使用外部 AI 时，检索到的内容会发送给对应的服务商。

## 我们的方向

当前版本已经提供消息接入、工作台、搜索、执行器和集成接口，但这还不是完整的自主工作流系统。我们希望把这些能力逐步连接成可自定义的工作流程：

- **更完整的处理编排。** 根据工作需要组合筛选、转换、分析、分派和结果回传，而不局限于检索问答。
- **主动识别与跟进。** 按个人习惯和团队标准，识别需要处理的信息，提炼有出处的结论和待办，交给合适的人或 Agent。
- **从个人到团队。** 先服务个人，再扩展到组织，让团队基于同一份上下文协作。

详见[产品说明](docs/zh/PRODUCT.md)和[路线图](docs/zh/ROADMAP.md)。

## 快速开始

需要 **Node.js 20+** 和 **pnpm 9**。从源码启动：

```bash
git clone https://github.com/regenic-ai/regenic.git
cd regenic
pnpm install
pnpm dev:desktop
```

1. **接入消息。** 以飞书为例，先[安装并登录 `lark-cli`](docs/zh/SETUP_AND_CLI.md#飞书)，再进入 **Engine → Feishu → Install**，选择要同步的对话。
2. **查看和搜索。** 在工作台打开已同步的会话，或进入 **Search** 跨对话搜索并查看上下文。
3. **选择处理方式。** 如需基于搜索结果生成回答，先在 **Engine** 配置可用的[执行器](docs/zh/EXECUTOR.md)，再在 Search 中选择它；如需在外部 AI 中查询，再按 [MCP 指南](docs/zh/CONTEXT_SEARCH_MCP.md)配置客户端。MCP 不是使用工作台或搜索的前提。

其他连接器见[连接器目录](docs/zh/CONNECTOR_CATALOG.md)。DSH、Docker 和 CLI 用法见[安装与 CLI 参考](docs/zh/SETUP_AND_CLI.md)。

## 连接器

飞书、DSH 和 Cursor 为内置连接器。其他来源以独立插件提供，遵循同一套开放标准。

| 来源 | 接入方式 | 接入身份 | 回复 |
| --- | --- | --- | --- |
| 飞书 | 内置 | 你的账号，通过 `lark-cli` | 文本 |
| DSH / Cursor | 内置 | 本机 Agent 会话 | 提示词和任务 |
| Slack | [插件](https://github.com/regenic-ai/regenic-connector-slack) | 机器人（只读），或你的账号（需主动开启） | 用户模式下支持文本 |
| WhatsApp | [插件](https://github.com/regenic-ai/regenic-connector-whatsapp) | 导出文件、WhatsApp Web 扩展，或关联设备（需主动开启） | 文本 |
| Telegram | [插件](https://github.com/regenic-ai/regenic-connector-telegram) | 你的账号，通过 TDLib | 文本 |
| 钉钉 | [插件](https://github.com/regenic-ai/dingtalk-connector) | 你的账号，通过 `dws` | 文本 |
| 企业微信 | [插件](https://github.com/regenic-ai/wecom-connector) | 智能机器人 | Markdown |
| CSV / JSONL | CLI 导入 | 导出文件 | — |

各连接器的能力、平台要求、风险和插件加载方式，见[连接器目录](docs/zh/CONNECTOR_CATALOG.md)。接入其他来源，可以从[连接器开发文档](docs/zh/CONNECTOR.md)和[示例插件](examples/connectors/README.md)开始。连接器可以只读，不必实现完整的聊天客户端。

## 当前范围

Regenic 目前面向**个人使用**，团队共享功能还在规划中。能读取哪些消息、如何同步、能否发送，取决于具体连接器和你授予的权限。

Context Search MCP **只读**，不会批准或发送消息。第三方插件与内核运行在同一进程中，请只安装可信插件。详见[路线图](docs/zh/ROADMAP.md)和[安全说明](docs/zh/SETUP_AND_CLI.md#安全)。

## 文档与贡献

[全部文档](docs/zh/README.md) · [安装与 CLI](docs/zh/SETUP_AND_CLI.md) · [连接器目录](docs/zh/CONNECTOR_CATALOG.md) · [连接器开发](docs/zh/CONNECTOR.md) · [MCP](docs/zh/CONTEXT_SEARCH_MCP.md) · [架构](docs/zh/MESSAGE_ORCHESTRATION.md) · [执行器](docs/zh/EXECUTOR.md)

欢迎通过 [Issues](https://github.com/regenic-ai/regenic/issues) 反馈问题、讨论场景或贡献连接器。实现类 PR 请遵循[产品边界](docs/zh/PRODUCT.md)，并注明对应 RFC。

请遵守[行为准则](https://github.com/regenic-ai/regenic-book/blob/main/CODE_OF_CONDUCT.md)。安全问题请通过 [private advisory](https://github.com/regenic-ai/regenic/security/advisories/new) 报告。

## 许可

[MIT](LICENSE)。[regenic-book](https://github.com/regenic-ai/regenic-book) 中的方法论内容，在适用范围内仍采用 CC BY-NC 4.0。
