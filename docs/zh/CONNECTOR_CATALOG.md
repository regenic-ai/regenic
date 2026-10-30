# 连接器目录

连接器负责把其他工具里的消息接入 Regenic。本页列出目前可用的连接器、各自的能力和加载方式。

- **English:** [../en/CONNECTOR_CATALOG.md](../en/CONNECTOR_CATALOG.md)
- **相关：** [开发连接器](CONNECTOR.md) · [内置连接器说明](CONNECTOR_DRIVERS.md) · [示例插件](../../examples/connectors/README.md) · [安装与 CLI](SETUP_AND_CLI.md)

## 一览

| 来源 | 插件包 | 接入身份 | 读取 | 回复 | 平台 |
| --- | --- | --- | --- | --- | --- |
| 飞书 | 内置 | 你的用户账号，通过 `lark-cli` | 选定的群和单聊，含历史 | 文本 | macOS、Linux、Windows |
| DSH | 内置 | 本机 `dsh` | Agent 会话 | 发送提示词；web 模式可新建会话 | 能运行 `dsh` 的环境 |
| Cursor | 内置 | Cursor API key | 本机 SDK Agent 会话 | 发送任务；可新建会话 | 能运行 Cursor SDK 的环境 |
| Slack | [regenic-connector-slack](https://github.com/regenic-ai/regenic-connector-slack) | 机器人（推荐），或你的用户账号（需主动开启） | 机器人：一个频道。用户模式：选定会话，含历史 | 仅用户模式：文本和线程回复 | macOS、Linux |
| WhatsApp | [regenic-connector-whatsapp](https://github.com/regenic-ai/regenic-connector-whatsapp) | 聊天导出、浏览器扩展接入 WhatsApp Web，或关联设备（需主动开启） | 导出记录；WhatsApp Web 实时消息 | 文本，经 WhatsApp Web 或关联设备 | 浏览器；关联设备已在 macOS arm64 验证 |
| Telegram | [regenic-connector-telegram](https://github.com/regenic-ai/regenic-connector-telegram) | 你的用户账号，通过 TDLib | 选定的私聊和群聊，含历史 | 文本，可回复指定消息 | Apple 芯片 macOS |
| 钉钉 | [dingtalk-connector](https://github.com/regenic-ai/dingtalk-connector) | 你的用户账号，通过 `dws` | 最近活跃、全部或选定的群和单聊，含历史和附件 | 文本 | 能运行 `dws` 的环境 |
| 企业微信 | [wecom-connector](https://github.com/regenic-ai/wecom-connector) | 智能机器人长连接 | 连接建立后发给机器人的消息；群聊中仅 @机器人 的消息 | Markdown；需先在该会话收到消息 | 能运行 Node.js 的环境 |
| CSV / JSONL | CLI 导入 | 导出文件 | 导入的记录 | — | 任意 |

“读取”和“回复”指连接器实现了哪些能力。实际能访问的内容，还取决于平台权限、你的账号和组织策略。

## 选择接入方式

有些来源提供多种接入方式，建议优先使用官方、有文档的途径：

- **官方 API 和机器人**（Slack 机器人、企业微信智能机器人）最稳定，但能看到的范围通常较小：往往只有一个频道，或只有发给机器人的消息。
- **官方用户 CLI**（飞书 `lark-cli`、钉钉 `dws`）通过平台提供的工具，以你的身份读取。
- **用户会话客户端**（Slack 用户模式、基于 TDLib 的 Telegram、WhatsApp 关联设备）能看到你能看到的内容，但可能与平台条款冲突，存在账号受限的风险。这些模式默认关闭，需要明确确认后才能启用。

Regenic 制定连接器标准；每个连接器自行决定如何接入来源，并说明相应风险。插件与内核运行在同一进程中，请只安装可信的连接器。

## 加载外部连接器

外部连接器是独立仓库。先构建，再在启动 Regenic 前加载：

```bash
# 在连接器仓库中
pnpm install
pnpm build

# 方式一：直接指向单个插件包
export REGENIC_CHANNEL_PLUGIN=/absolute/path/to/connector

# 方式二：链接到插件目录（默认 ~/.regenic/plugins）
ln -s /absolute/path/to/connector ~/.regenic/plugins/<name>
```

然后打开 **Engine**，找到该连接器并点击 **Install**。凭证在安装表单中填写或保存在系统钥匙串，不会写进连接器配置。

部分连接器构建时需要用 `REGENIC_ROOT` 指向本地 Regenic 仓库。构建步骤和前置条件以各仓库 README 为准。

## 各连接器说明

### 飞书

用 `lark-cli` 登录后，在安装表单中选择最近活跃、全部或自选会话。参见[安装：飞书](SETUP_AND_CLI.md#飞书)和[内置连接器说明](CONNECTOR_DRIVERS.md)。

### DSH 和 Cursor

读取并驱动本机 Agent 会话，也可以作为[执行器](EXECUTOR.md)处理工单和搜索回答。参见[内置连接器说明](CONNECTOR_DRIVERS.md)。

### Slack

- **机器人模式（推荐）：** 设置 `REGENIC_SLACK_TOKEN`，安装 **Slack bot（只读）**。同步一个频道，不能发送。
- **用户模式（需主动开启）：** 需要设置 `REGENIC_SLACK_USER_BRIDGE=1` 并明确确认风险。通过轮询同步选定会话，可发送纯文本和线程回复。尚未在真实账号上测试。

### WhatsApp

- **导出导入：** 只读，导入你选择的聊天导出文件。
- **WhatsApp Web（默认实时方式）：** 浏览器扩展把 WhatsApp Web 中的消息转给 Regenic。回复会填入输入框；自动点击发送需要另行开启。
- **关联设备（需主动开启）：** 使用非官方协议，默认关闭，可能导致账号受限。支持选定会话和文本回复。

### Telegram

通过本地构建的 TDLib 以你的用户账号登录，API 凭证和数据库密钥保存在 macOS 钥匙串。同步选定私聊和群聊的文本，可发送文本回复。不支持媒体、私密聊天和频道。

### 钉钉

通过钉钉 Workspace CLI（`dws`）以你的账号接入，需要组织管理员先开启 CLI 访问。可同步最近活跃、全部或选定会话的历史，下载图片和文件，并发送文本回复。

### 企业微信

通过官方智能机器人长连接接入。只能收到连接建立后的消息；群聊中只收到 @机器人 的消息。机器人需要先在某个会话收到消息，才能在该会话回复。

### CSV / JSONL

通过字段映射导入导出的消息记录。参见[安装：文件导入](SETUP_AND_CLI.md#文件导入)。

## 开发自己的连接器

连接器可以只读，不必实现完整的聊天客户端。可以从示例开始：

| 示例 | 适用场景 |
| --- | --- |
| [`import-only`](../../examples/connectors/import-only) | 导入用户导出的文件 |
| [`webhook`](../../examples/connectors/webhook) | 浏览器扩展或外部服务推送消息 |
| [`poll`](../../examples/connectors/poll) | 轮询本机或局域网 HTTP 接口 |
| [`catalog-only`](../../examples/connectors/catalog-only) | 在接入实时同步前先声明工作类型 |

完整协议见[开发连接器](CONNECTOR.md)。
