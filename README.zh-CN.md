# Regenic

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D20-blue.svg)](https://nodejs.org/)
[![pnpm](https://img.shields.io/badge/pnpm-9-blue.svg)](https://pnpm.io)

[简体中文](README.zh-CN.md) | [English](README.md)

**一切皆上下文。统一上下文。**

Regenic 是面向人与 Agent 的开源消息编排层。

它不取代飞书、Slack、WhatsApp 或本地 Agent。消息仍写在原来的地方。Regenic 在它们之下：把渠道流量收成同一份上下文——带出处的证据、只列出此刻要处理事项的控制台，以及发回原渠道的回复。

如果说 Agent Harness 是「一切皆插件」，那 Regenic 是「一切皆上下文」。聊天、Agent 回合、文件与摘要收成同一种记录；版本化的判断标准决定什么进入工作台；人与自动化共用一套 `/v1`。账号、token 与规则留在这台电脑上。

现在能用的是**单人、数据在本机**。多人共用一份记录以后再做。见[产品](docs/zh/PRODUCT.md)与[消息编排](docs/zh/MESSAGE_ORCHESTRATION.md)。

[安装](#安装与快速开始) · [加上飞书、Slack 或 DSH](#加上飞书slack-或-dsh) · [登录和 token](#登录和-token) · [本地 CLI](#本地-cli) · [状态](#状态) · [安全](#安全) · [文档](#文档) · [贡献](#贡献)

## 为什么是上下文

Agent 需要工具，人需要渠道——这些都已经有了。

缺的是一个地方：让飞书、Slack、本地 Agent 会话和一份文件导出**说的是同一件事**——同一种消息形态、同一条证据链、同一份「此刻真的需要人或 Agent 动手」的工作列表。那个地方就是 Regenic。

上下文不是把所有聊天倒进一个桶。它是可归因、可裁决的记录：判断标准和各人习惯用它决定什么进入控制台，什么不进入当前工作。

## 它做什么

- **渠道仍是渠道** — 飞书还是飞书，Slack 还是 Slack。Regenic 只读、排序、写回，不换掉它们。
- **多源，一份上下文** — 连接器把流量收成 Event / Blob；摘要与 Claim 保留出处。
- **控制台只放现在要处理的** — 不会把所有群聊摊开。
- **人和自动化用同一套接口** — 桌面应用和脚本都走 `/v1`。
- **token 不进数据库** — 放在环境变量或系统钥匙串。安装表单不收。
- **先单人，后多人** — 数据以这台电脑为准。多人共用一份记录是后面的事。

## 个人还是组织

| 你是… | 怎么走 |
| --- | --- |
| **个人** — 在这台电脑上用桌面应用，加上飞书、Slack 或 DSH | 按下面[快速开始](#安装与快速开始) |
| **在终端里同步、导入、导出** | 看[本地 CLI](#本地-cli) |
| **组织 / 多人共用一份记录** | 还没做。见[从个人到组织](docs/zh/rfcs/personal-to-org.md) |

## 功能

| 类别 | 能做什么 | 现在 |
| --- | --- | --- |
| 桌面应用 | 本机窗口：要处理的消息、引擎、设置。关掉窗口不会退出 | 能用 |
| DSH | 读会话、回文字；不填 session 就跟全部会话，也可以新建 | 能用 |
| 飞书 | 读群和单聊，回文字。用官方 `lark-cli` 登录你自己的账号 | 能用 |
| Slack | 读一个频道 | 只能读，不能回 |
| 文件导入 | CSV / JSONL，用一份对照表说明哪一列是什么 | CLI |
| WhatsApp | 用户明确选择的只读 Purr WA CSV 或 Export v1 JSONL | 桌面端 + CLI |
| 导出 | 消息记录 JSONL、按日整理的 Markdown、给外部用的引用清单 | CLI |
| Context | 确定性 snapshot 与可选的带引用模型回答 | API + CLI |

## 安装与快速开始

### 环境要求

- Node.js 20+
- [pnpm](https://pnpm.io)

飞书、Slack、DSH 各自还要先装好自己的工具，见[加上飞书、Slack 或 DSH](#加上飞书slack-或-dsh)。

### 快速开始（给你）

#### 打开应用

```bash
pnpm install
pnpm dev:desktop
```

#### 在应用里加上飞书、Slack 或 DSH

打开应用：**Engine** → 选 **DSH** / **Feishu** / **Slack** → **Install**。

先把对应软件装好并登录，再点 Install。飞书要先登录 `lark-cli`，DSH 要先起 `dsh web`。具体步骤在[加上飞书、Slack 或 DSH](#加上飞书slack-或-dsh)。

### 快速开始（给 AI 助手）

下面给帮忙安装的 AI。有的步骤要用户在浏览器里点完。

**第 1 步 — 打开应用**

```bash
pnpm install
pnpm dev:desktop
```

**第 2 步 — 按用户要加的那个，先把工具准备好**

飞书：

```bash
npx @larksuite/cli@latest install
```

`lark-cli config init` 和 `lark-cli auth login --recommend` 会打印授权链接。把链接发给用户，用户在浏览器里完成后命令会自己退出。然后跑 `lark-cli auth status` 确认。

DSH：先确认终端能跑 `dsh`，再执行 `dsh web --port 3080`。

**第 3 步 — 让用户在应用里点 Install**

**Engine** → 选刚准备好的那一项 → **Install**。飞书默认同步全部群和全部单聊，也可以勾选具体会话；装好后用 **Edit sync** 再改。DSH 的 Session ID 可以空着。

## 加上飞书、Slack 或 DSH

### DSH

终端里要能跑 `dsh`。先把 web 起起来：

```bash
dsh web --port 3080
```

打开应用：**Engine** → **DSH** → **Install**。Transport 选 **Web**。Session ID 空着跟全部会话，填了只跟一条。Base URL 默认 `http://127.0.0.1:3080`，只接受本机。`dsh web` 要 token 的话，启动桌面应用前设好 `REGENIC_DSH_TOKEN`。

### 飞书

通过飞书官方 [lark-cli](https://github.com/larksuite/cli) 登录你自己的账号。完整说明见 [lark-cli 中文 README](https://github.com/larksuite/cli/blob/main/README.zh.md)。

**安装**

```bash
npx @larksuite/cli@latest install
```

**配置与登录**

```bash
# 1. 配置应用（只需一次，浏览器里走完）
lark-cli config init

# 2. 登录（--recommend 带上常用权限）
lark-cli auth login --recommend

# 3. 确认已登录
lark-cli auth status
```

`config init` 和 `auth login` 都会给出授权链接，在浏览器里完成后命令会自己结束。

**在应用里加会话**

打开应用：**Engine** → **Feishu** → **Install**。默认勾选「全部群」和「全部单聊」。改成「勾选会话」再点具体对话。装好后随时 **Edit sync** 改同一套范围。表单从 `lark-cli` 拉群和单聊，不用手填 `oc_…`。

引擎页会检查 `lark-cli` 有没有装、有没有登录，两种情况提示不一样。应用不会替你安装。

`lark-cli` 不在 PATH 上时，启动桌面应用前设 `REGENIC_LARK_CLI` 指向这个命令。按你的选择拉群和单聊，可以回文字，不能从这里开新群。

### Slack

启动桌面应用前设好 `REGENIC_SLACK_TOKEN`。打开应用：**Engine** → **Slack** → **Install**。填频道 ID（`C…`）。频道名可选。现在只读这个频道，不能回复。

## 登录和 token

| | 怎么登录 | 安装表单 |
| --- | --- | --- |
| DSH | 本机 `dsh`；web 要 token 时用 `REGENIC_DSH_TOKEN` | 不收 token |
| 飞书 | `lark-cli auth login`，登录信息在系统钥匙串 | 不收 token |
| Slack | `REGENIC_SLACK_TOKEN` | 不收 token |

表单只收群选择、频道 ID、session 这类非密钥项。token 不会写入数据库，也不会出现在 `/v1/me`。

## 本地开发

日常用上面的桌面应用。Docker Compose 用来起后台接口和后台任务。

```bash
pnpm install
docker compose up --build
curl -s http://localhost:3000/health
```

个人内核需要本机数据目录（`REGENIC_DATABASE` 和 `REGENIC_BLOB_ROOT`）。官方 Compose 烘焙 PostgreSQL（`REGENIC_AUTHORITY_DRIVER=postgres`）和附件卷；应用里不用选数据库引擎。设了 `REGENIC_DSH_API_TOKEN` 的话，请求带 `Authorization: Bearer`。

```http
POST /v1/dsh/api/session.history
POST /v1/dsh/api/session.prompt
POST /v1/dsh/api/session.list
POST /v1/dsh/api/session.create
```

## 本地 CLI

和桌面应用做的是同一件事，只是走终端。数据在 SQLite 和本地文件目录里。token 不写入数据库，同步时用环境变量传入。

### Slack

```bash
pnpm local slack-install --database ./regenic.db --org local-owner \
	--channel C123 --channel-name engineering --id slack-engineering

REGENIC_SLACK_TOKEN=xoxb-... pnpm local slack-sync \
	--database ./regenic.db --blob-root ./blobs --installation slack-engineering \
	--max-pages 20

pnpm local status --database ./regenic.db --org local-owner
pnpm local inbox --database ./regenic.db --org local-owner
pnpm local quarantines --database ./regenic.db --installation slack-engineering

pnpm local connector-disable --database ./regenic.db --org local-owner \
	--installation slack-engineering
pnpm local connector-enable --database ./regenic.db --org local-owner \
	--installation slack-engineering
pnpm local reset-cursor --database ./regenic.db --org local-owner \
	--installation slack-engineering --stream channel:C123
```

### DSH

和[加上 DSH](#dsh)同一件事。用 Web 的话先跑 `dsh web --port 3080`。

```bash
pnpm local dsh-install --database ./regenic.db --org local-owner \
	--transport web --session <sessionId> --base-url http://127.0.0.1:3080 \
	--id dsh-main

pnpm local dsh-sync --database ./regenic.db --blob-root ./blobs \
	--installation dsh-main --max-pages 20

pnpm local dsh-send --database ./regenic.db --installation dsh-main \
	--text "Follow up on the last turn"
```

`--session` 可以不填，不填就跟所有会话。不跑 `dsh web`、直接调本机 `dsh`：

```bash
pnpm local dsh-install --database ./regenic.db --org local-owner \
	--transport cli --mailbox dsh-main --id dsh-main
```

`dsh web` 要 token 就设 `REGENIC_DSH_TOKEN`。

### 文件导入

导入 CSV 或 JSONL 时，另备一份 JSON，写明哪一列是消息 ID、时间、正文、作者。坏行会被报告；合格的行会收成和飞书、Slack 同步进来的同一种消息。

```json
{
	"mapping": {
		"external_id": "id",
		"occurred_at": "timestamp",
		"text": "body",
		"actor_id": "author"
	},
	"defaults": {
		"actor_id": "local-owner",
		"scope_id": "personal",
		"type": "text"
	}
}
```

```bash
pnpm local import-file --database ./regenic.db --blob-root ./blobs \
	--file ./messages.csv --mapping ./mapping.json --format csv \
	--org local-owner --source local-file
```

### 个人 WhatsApp 导出

个人 WhatsApp 是由用户明确触发的只读流程。桌面端可一次导入多份经审计的开源 [Purr WA Export](https://github.com/0xheycat/purr-wa) CSV，也支持 WhatsApp Personal Export v1 JSONL。Regenic 不接收浏览器 Cookie、不在后台扫描聊天，也不发送消息。

一次性设置、每次导出步骤、手动/自动边界、已知 `@lid` 限制和验收清单见[个人 WhatsApp Bridge](docs/zh/WHATSAPP_PERSONAL.md)与[WhatsApp 测试与验收](docs/zh/WHATSAPP_PERSONAL_TESTING.md)。

```bash
pnpm local whatsapp-import --database ./regenic.db --blob-root ./blobs \
	--file ./whatsapp-personal.jsonl --org local-owner \
	--local-principal local-user
```

### Inbox

列出现在要处理的消息。已处理的回执、删除记录和普通跟帖还在库里，但不出现在这份列表里。

```bash
pnpm local inbox --database ./regenic.db --org local-owner
```

### JSONL 导出

把消息记录导出成 JSONL。每行带出处和内容指纹，不含附件正文。

```bash
pnpm local export-jsonl --database ./regenic.db --org local-owner \
	--output ./events.jsonl
```

### Markdown Digest

按日期把文本消息收成一份 Markdown。每条保留指向原始记录和附件的引用。

```bash
pnpm local render-digest --database ./regenic.db --blob-root ./blobs \
	--org local-owner --output ./digest.md
```

### Evidence Bundle

按使用方和用途，导出一份有上限的消息引用。文件里不含附件正文，也不含 token。

```bash
pnpm local publish-evidence-bundle --database ./regenic.db --org local-owner \
	--consumer teamily-workspace --purpose research-context --max-events 100 \
	--output ./evidence-bundles.jsonl
```

### Context 与带引用的模型回答

Context 装配是确定性的，不配置模型也能使用。它只读取已提交的 Event/Blob 证据，在排名前
应用 Personal 权威边界，持久化不可变 snapshot 与 bundle，并支持进程重启后 replay。
个人版通过可重建的 SQLite FTS5 sidecar 执行 literal Unicode 搜索；只有完成 ACL 与生命周期
解析后，精确的 Event/hash key 才会进入索引。索引不可用或覆盖不完整时，使用同一套本地
评分规则 fallback。

```bash
pnpm local context-assemble --database ./regenic.db --blob-root ./blobs \
	--org local-owner --query "release approved"

pnpm local context-snapshot --database ./regenic.db --blob-root ./blobs \
	--org local-owner --snapshot <snapshot-id>

pnpm local context-replay --database ./regenic.db --blob-root ./blobs \
	--org local-owner --snapshot <snapshot-id>
```

先创建确定性的 UTC 日级 digest proposal，再经 Artifact lifecycle accepted 后读取。日期必须
显式提供，格式为 `YYYY-MM-DD`。

```bash
pnpm local context-daily-digest-project --database ./regenic.db --blob-root ./blobs \
	--org local-owner --utc-date 2026-09-06

pnpm local context-daily-digest-get --database ./regenic.db --blob-root ./blobs \
	--org local-owner --utc-date 2026-09-06
```

可以运行版本化 synthetic evaluation dataset，并按需保存确定性报告。报告包含 Recall@K、
MRR@K、nDCG@K、citation coverage 和 forbidden/stale selection 安全门，但不包含消息正文。

```bash
pnpm local context-evaluate --database ./regenic.db --blob-root ./blobs \
	--org local-owner --dataset ./context-evaluation.json --k 10 \
	--output ./context-evaluation-report.json
```

当已有使用方只需要 citation 时，可将 replay 后的 Context bundle 投射为现有的
EvidenceBundle v1 JSONL 格式。`--consumer` 与 `--purpose` 必须匹配 snapshot 中保存的
授权。输出不含证据正文或 Blob body。

```bash
pnpm local context-publish-evidence-bundle --database ./regenic.db --blob-root ./blobs \
	--org local-owner --snapshot <snapshot-id> --consumer local-cli \
	--purpose "inspect authorized local context" --output ./evidence-bundles.jsonl
```

模型回答是可选能力。第一版 driver 接受 numeric loopback 上的 OpenAI-compatible API，例如
本机 Ollama；本版本不接受远程模型 URL。API key 配置只保存环境变量引用，不保存 key 本身。

```bash
export REGENIC_MODEL_DRIVER=openai_compatible
export REGENIC_MODEL_BASE_URL=http://127.0.0.1:11434/v1
export REGENIC_MODEL_NAME=<local-model>
# 供应商需要 key 时：
# export REGENIC_MODEL_API_KEY_REF=env:OPENAI_API_KEY

pnpm local context-ask --database ./regenic.db --blob-root ./blobs \
	--org local-owner --question "What was approved?"
```

Personal API 提供同一条持久化路径：

```http
POST /v1/me/context/assemble
GET  /v1/me/context/snapshots/:snapshot_id
POST /v1/me/context/replay
POST /v1/me/context/ask
```

证据正文作为不可信 user data 发送给模型，绝不作为模型 instruction。只有当模型提交的每条
citation 都指向授权 bundle 中已有的 candidate 与 Event 时，回答才会返回。模型输出不会
写回 Event、Artifact、Claim，也不会直接成为已接受事实。

带浏览器 Origin 的 `/v1/me` 请求还必须携带 Personal API key。桌面端为自己拥有的
loopback sidecar 每次生成并自动注入临时 key。远程内核若未设 `REGENIC_PERSONAL_API_KEY`，首次启动会
生成 key，并在 **30 分钟 bootstrap 窗口** 内允许**一次**自动配对；配对成功后窗口立即关闭。之后桌面需
在设置里粘贴 key，或使用相同的 `REGENIC_PERSONAL_API_KEY` env。公网部署需设
`REGENIC_PERSONAL_API=1`。

## 状态

Phase 0 已完成。RFC 0001–0007 均已接纳。Phase 1 是本机上的飞书 / Slack / DSH 和后台服务。

| 能力 | 说明 | 状态 |
| --- | --- | --- |
| 处理消息 | 读进来 → 收成同一种消息 → 排序 → 决定要不要处理 → 可选回复 | [PRODUCT](docs/zh/PRODUCT.md) · [架构](docs/zh/MESSAGE_ORCHESTRATION.md) |
| 飞书 / Slack / DSH | 已能加上这几个；文件导入也有；更多以后再加 | Phase 1（进行中） |
| 个人 | 单人；可导出；远端备份可选 | Phase 1（进行中） |
| 组织 | 多人共用一份记录，每人看到自己的那一份 | Phase 3（[从个人到组织](docs/zh/rfcs/personal-to-org.md)） |
| 判断规则 | 可改、可版本化的共用规则 | RFC 已接纳（[0001](docs/zh/rfcs/0001-standards-data-model.md)） |
| 上下文 | Event-backed 持久 snapshot、replay 与可选的带引用模型回答 | Personal API + CLI baseline（[架构](docs/zh/CONTEXT_MANAGEMENT_ARCHITECTURE.md)） |
| 协作 | Proposal / Decision / Review / Handoff | RFC 已接纳（[0003](docs/zh/rfcs/0003-collaboration-objects.md)） |
| API | 人和自动化使用同一套 `/v1` | RFC 已接纳（[0004](docs/zh/rfcs/0004-human-agent-api.md)） |
| 权限 | `visible()`；整理摘要时不会多拿到权限；能发消息是单独授权 | RFC 已接纳（[0006](docs/zh/rfcs/0006-acl-agent-identity.md)） |
| 日常整理 | 把日常消息收成规则要用的材料 | RFC 已接纳（[0007](docs/zh/rfcs/0007-daily-distillation.md)） |

方法、站点与公开标准：[regenic-ai/regenic-book](https://github.com/regenic-ai/regenic-book)。存储与运行时默认：[技术栈](docs/zh/TECH_STACK.md)。

## 安全

后台默认只在本机提供个人接口。读消息、发回复时，用的是你在这台电脑上已经登录的账号。飞书尤其是这样：`lark-cli` 以你的身份调飞书接口，你授权过的操作都会发生。只加上你打算处理的群或频道。

不要把 token 写进安装配置、仓库或聊天记录。

## 文档

[消息编排](docs/zh/MESSAGE_ORCHESTRATION.md) ·
[连接器](docs/zh/CONNECTOR.md) ·
[执行器](docs/zh/EXECUTOR.md) ·
[产品](docs/zh/PRODUCT.md) · [路线图](docs/zh/ROADMAP.md) ·
[技术栈](docs/zh/TECH_STACK.md) · [桌面端](docs/zh/DESKTOP.md) · [采集架构](docs/zh/INGESTION_ARCHITECTURE.md)

## 贡献

提 PR 时请标明对应 RFC，并对照[产品](docs/zh/PRODUCT.md)。讨论开 [Issues](https://github.com/regenic-ai/regenic/issues)。

请遵守[行为准则](https://github.com/regenic-ai/regenic-book/blob/main/CODE_OF_CONDUCT.md)。
安全问题请走 [private advisory](https://github.com/regenic-ai/regenic/security/advisories/new)。

## 许可

[MIT](LICENSE)。

`regenic-ai/regenic-book` 里的方法论内容，在适用范围内仍为 CC BY-NC 4.0。
