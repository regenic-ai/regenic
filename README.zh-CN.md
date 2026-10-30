# Regenic

**把工作消息接入你常用的 AI。**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D20-blue.svg)](https://nodejs.org/)
[![pnpm](https://img.shields.io/badge/pnpm-9-blue.svg)](https://pnpm.io)

[English](README.md) · [简体中文](README.zh-CN.md)

Regenic 是一个开源、本地优先的应用，通过可插拔连接器，把不同渠道的工作对话变成 AI 可用的上下文。让你常用的 AI 查询聊天记录、汇总项目进展、起草回复，不必再手动复制整段对话。

聊天工具照常用，AI 也不用换。

[快速开始](#快速开始) · [连接器](#连接器) · [MCP 配置](docs/zh/CONTEXT_SEARCH_MCP.md) · [文档](docs/zh/README.md)

## 用它做什么

| 场景 | 试着这样问 AI |
| --- | --- |
| 跟进项目 | “汇总这几个对话里的最新进展。” |
| 核对约定 | “我们之前答应过客户什么？列出原始消息。” |
| 起草回复 | “参考前面的聊天记录，帮我拟一条回复。” |

这些场景基于你已接入并授权的消息。Regenic 提供上下文，由你使用的 AI 分析和处理。

## 为什么选择 Regenic

- **渠道可以自己接。** 统一的连接器标准支持文件导入、Webhook 和轮询。既可以安装现成插件，也可以为自己的工作流程编写连接器。
- **AI 用你习惯的。** Cursor 等 MCP 客户端可直接查询和读取对话，脚本和其他工具也能通过 API 接入。
- **回答有据可查。** 检索结果保留消息来源、线程和标识，方便回到原始对话核对。
- **处理过程可控。** 在桌面工作台查看消息；读取和发送分别授权，能否发送还取决于连接器。
- **本地优先，方便迁移。** 数据以本机为准，支持 Markdown 和 JSONL 导出。接入外部 AI 时，检索出的内容可能发送给对应服务商。

## 快速开始

需要 **Node.js 20+** 和 **pnpm 9**。从源码启动：

```bash
git clone https://github.com/regenic-ai/regenic.git
cd regenic
pnpm install
pnpm dev:desktop
```

1. **接入消息。** 以飞书为例，先[安装并登录 `lark-cli`](docs/zh/SETUP_AND_CLI.md#飞书)，再进入 **Engine → Feishu → Install**，选择要同步的对话。
2. **连接 AI。** 按照 [MCP 配置指南](docs/zh/CONTEXT_SEARCH_MCP.md)，让 MCP 客户端能够查询和读取这些对话。
3. **开始提问。** 试试：“汇总项目的最新进展，并附上消息出处。”

DSH、插件安装、Docker 和 CLI 用法见[安装与 CLI 参考](docs/zh/SETUP_AND_CLI.md)。

## 连接器

内置渠道只是起点，其他消息来源可按同一标准接入。

| 来源 | 接入方式 | 支持范围 |
| --- | --- | --- |
| 飞书 | 内置 | 同步选定的群和私聊；以你的授权账号发送文字 |
| DSH | 内置 | 读取本地 Agent 会话、发送提示词；部分模式支持新建会话 |
| Cursor | 内置 | 读取和运行本地 SDK Agent 会话；不包含 IDE 聊天记录和 Cloud Agents |
| Slack | [独立插件](https://github.com/regenic-ai/regenic-connector-slack) | 需单独安装，具体能力见插件说明 |
| WhatsApp | [独立插件](https://github.com/regenic-ai/regenic-connector-whatsapp) | 需单独安装，配置与限制见插件说明 |
| CSV / JSONL | CLI 导入 | 通过字段映射导入导出的消息记录 |

**想接入其他来源？** 查看[连接器开发文档](docs/zh/CONNECTOR.md)和[示例插件](examples/connectors/README.md)。连接器可以只读，不必实现一个完整的聊天客户端。

## 当前范围

目前支持**个人使用**，团队共享记录尚未推出。可读取的消息、同步方式和发送能力，取决于具体连接器及你的授权。

Context Search MCP **只读**，不会批准或发送消息。第三方插件与内核运行在同一进程中，请只安装可信插件。详见[路线图](docs/zh/ROADMAP.md)和[安全说明](docs/zh/SETUP_AND_CLI.md#安全)。

## 文档与贡献

[全部文档](docs/zh/README.md) · [安装与 CLI](docs/zh/SETUP_AND_CLI.md) · [连接器开发](docs/zh/CONNECTOR.md) · [MCP](docs/zh/CONTEXT_SEARCH_MCP.md) · [架构](docs/zh/MESSAGE_ORCHESTRATION.md) · [执行器](docs/zh/EXECUTOR.md)

欢迎通过 [Issues](https://github.com/regenic-ai/regenic/issues) 反馈问题、讨论场景或贡献连接器。实现类 PR 请遵循[产品边界](docs/zh/PRODUCT.md)，并注明对应 RFC。

请遵守[行为准则](https://github.com/regenic-ai/regenic-book/blob/main/CODE_OF_CONDUCT.md)。安全问题请通过 [private advisory](https://github.com/regenic-ai/regenic/security/advisories/new) 报告。

## 许可

[MIT](LICENSE)。[regenic-book](https://github.com/regenic-ai/regenic-book) 中的方法论内容，在适用范围内仍采用 CC BY-NC 4.0。
