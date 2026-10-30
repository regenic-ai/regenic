# Regenic

**把所有工作消息汇成一条消息流，交给 AI 和自动化任意处理。**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D20-blue.svg)](https://nodejs.org/)
[![pnpm](https://img.shields.io/badge/pnpm-9-blue.svg)](https://pnpm.io)

[English](README.md) · [简体中文](README.zh-CN.md)

工作发生在消息里：群聊、私聊、工单、审批，还有和 AI Agent 的对话。这些消息分散在飞书、Slack、WhatsApp 等不同工具中，格式各不相同，很难被统一处理。

Regenic 是工作消息的统一层。任何消息来源都可以通过可插拔连接器接入，转换成同一种消息格式。之后怎么处理由你决定：跨渠道检索、交给 AI 总结和起草、转给 Agent 执行，再把结果回复到原来的渠道。

连接器遵循开放标准，可以用现成插件，也可以为任何工具自己实现。Regenic 开源、本地优先，数据保存在你自己的设备上。

[快速开始](#快速开始) · [连接器](#连接器) · [MCP 配置](docs/zh/CONTEXT_SEARCH_MCP.md) · [文档](docs/zh/README.md)

## 现在可以做什么

| 场景 | 你可以这样问 AI |
| --- | --- |
| 跨渠道查找 | “上周谁提过合同的付款时间？” |
| 跟进项目 | “汇总这个项目本周在各个群里的进展。” |
| 核对客户承诺 | “我们之前答应过这位客户什么？列出原始消息。” |
| 起草回复 | “根据之前的沟通，帮我起草一条回复。” |

以上场景通过 [Context Search MCP](docs/zh/CONTEXT_SEARCH_MCP.md) 在 Cursor 等 AI 工具中使用。AI 只能看到你已接入并授权的对话，检索结果附带消息出处，方便回到原文核对。

## 特点

- **统一的消息格式。** 不同渠道的消息转换成同一种格式，统一存储、检索和处理。
- **任何来源都能接入。** 连接器遵循开放标准，支持文件导入、Webhook 和轮询。不只是聊天工具，Agent 会话、工单也可以接入。
- **处理方式由你选择。** 可以通过 MCP 交给 AI，通过 API 交给脚本和自动化，或交给 DSH、Cursor 等本地 Agent 执行。
- **出处可以追溯。** 每条结果都带有渠道、会话和消息标识，随时可以回到原始对话。
- **发送需要授权。** 读取和发送分开授权；能否发送消息，也取决于具体连接器。
- **数据保存在本地。** 消息存储在你的电脑上，可导出为 Markdown 和 JSONL。使用外部 AI 时，检索到的内容会发送给对应的服务商。

## 我们的方向

当前版本解决的是第一步：把消息接进来、能查、能处理。我们最终要做的是工作消息的编排层：

- **自动筛选。** 按个人习惯和团队标准，从每天成百上千条消息中挑出真正需要处理的。
- **提炼与分派。** 把消息提炼成有出处的结论和待办，分派给合适的人或 Agent。
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
2. **连接 AI。** 按照 [MCP 配置指南](docs/zh/CONTEXT_SEARCH_MCP.md)，让 MCP 客户端能够查询和读取这些对话。
3. **开始提问。** 试试：“汇总项目的最新进展，并附上消息出处。”

DSH、插件安装、Docker 和 CLI 用法见[安装与 CLI 参考](docs/zh/SETUP_AND_CLI.md)。

## 连接器

目前内置飞书、DSH 和 Cursor，Slack 和 WhatsApp 以独立插件提供。其他消息来源都可以按同一标准接入。

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

Regenic 目前面向**个人使用**，团队共享功能还在规划中。能读取哪些消息、如何同步、能否发送，取决于具体连接器和你授予的权限。

Context Search MCP **只读**，不会批准或发送消息。第三方插件与内核运行在同一进程中，请只安装可信插件。详见[路线图](docs/zh/ROADMAP.md)和[安全说明](docs/zh/SETUP_AND_CLI.md#安全)。

## 文档与贡献

[全部文档](docs/zh/README.md) · [安装与 CLI](docs/zh/SETUP_AND_CLI.md) · [连接器开发](docs/zh/CONNECTOR.md) · [MCP](docs/zh/CONTEXT_SEARCH_MCP.md) · [架构](docs/zh/MESSAGE_ORCHESTRATION.md) · [执行器](docs/zh/EXECUTOR.md)

欢迎通过 [Issues](https://github.com/regenic-ai/regenic/issues) 反馈问题、讨论场景或贡献连接器。实现类 PR 请遵循[产品边界](docs/zh/PRODUCT.md)，并注明对应 RFC。

请遵守[行为准则](https://github.com/regenic-ai/regenic-book/blob/main/CODE_OF_CONDUCT.md)。安全问题请通过 [private advisory](https://github.com/regenic-ai/regenic/security/advisories/new) 报告。

## 许可

[MIT](LICENSE)。[regenic-book](https://github.com/regenic-ai/regenic-book) 中的方法论内容，在适用范围内仍采用 CC BY-NC 4.0。
