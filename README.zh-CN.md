# Regenic

个人与组织的消息编排层。

Regenic 是开源的消息编排层。它接入已经在用的聊天、邮件、工单和文档。判断标准和各人习惯决定哪些消息需要现在处理：这些消息进入人与 Agent 共用的控制台，其余的不进入当前工作。回复发回原来的渠道。

权限与判断标准留在小内核里。

交付顺序是**先个人（本地优先），后组织**。见[产品](docs/zh/PRODUCT.md)与[消息编排](docs/zh/MESSAGE_ORCHESTRATION.md)。

[English](README.md)

## 状态

Phase 0 已完成。RFC 0001–0007 均已接纳。Phase 1 是本地优先的连接器和内核。

| 能力 | 说明 | 状态 |
| --- | --- | --- |
| 消息编排 | 接入渠道 → 统一成消息 → 排序 → 调度 → 可选回复 | [PRODUCT](docs/zh/PRODUCT.md) · [架构](docs/zh/MESSAGE_ORCHESTRATION.md) |
| 连接器 | Slack、文件导入；更多渠道随后 | Phase 1（进行中） |
| 个人 | 单人；可导出；远端历史可选 | Phase 1（进行中） |
| 组织 | 多人权威事件与各人视角 | Phase 3（[从个人到组织](docs/zh/rfcs/personal-to-org.md)） |
| 判断标准 | 可版本化的共用标准 | RFC 已接纳（[0001](docs/zh/rfcs/0001-standards-data-model.md)） |
| 上下文 | Claim、Snapshot、Event/Blob | RFC 已接纳（[0002](docs/zh/rfcs/0002-context-graph.md)、[0005](docs/zh/rfcs/0005-context-storage-lifecycle.md)） |
| 协作 | Proposal / Decision / Review / Handoff | RFC 已接纳（[0003](docs/zh/rfcs/0003-collaboration-objects.md)） |
| API | 人与 Agent 使用同一套 `/v1` | RFC 已接纳（[0004](docs/zh/rfcs/0004-human-agent-api.md)） |
| ACL | `visible()`；蒸馏不抬权；发送是授权 | RFC 已接纳（[0006](docs/zh/rfcs/0006-acl-agent-identity.md)） |
| 蒸馏 | 向标准机器进料 | RFC 已接纳（[0007](docs/zh/rfcs/0007-daily-distillation.md)） |

方法、站点与公开标准：[regenic-ai/regenic-book](https://github.com/regenic-ai/regenic-book)。存储与运行时默认：[技术栈](docs/zh/TECH_STACK.md)。

## 开始使用

本仓库目前是能跑通的骨架（健康检查和连通）。加工逻辑从 Phase 1 开始。Compose 用于本地开发。个人产品跑在本机。

```bash
pnpm install
docker compose up --build
curl -s http://localhost:3000/health
```

## 本地 CLI

本地 CLI 用 SQLite 和文件系统 BlobStore 同步连接器。access token 不会写入数据库。同步时通过所引用的环境变量传入 token。

### Slack 连接器

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

### 文件导入

通过显式 JSON 映射文件导入 CSV 或 JSONL。坏行会被报告，合法行与渠道同步写成同一种消息。

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

### Inbox

列出经过内核过滤 / 分层后进入当前工作的消息。致谢、tombstone 和普通跟帖仍作为 Event 留下，但不出现在这份列表里。

```bash
pnpm local inbox --database ./regenic.db --org local-owner
```

### JSONL 导出

将 append-only Event 元数据导出为 JSONL。每行包含 provenance 和内容 hash，不内联 Blob 字节。

```bash
pnpm local export-jsonl --database ./regenic.db --org local-owner \
	--output ./events.jsonl
```

### Markdown Digest

按日期渲染 append-only 文本 Event 的 Markdown 视图。每条保留 Event 与 Blob 证据引用。

```bash
pnpm local render-digest --database ./regenic.db --blob-root ./blobs \
	--org local-owner --output ./digest.md
```

### Evidence Bundle

为声明了身份和用途的 consumer 发布有限的已提交 Event 引用。本地 JSONL driver 不包含 Blob 正文或连接器凭据。

```bash
pnpm local publish-evidence-bundle --database ./regenic.db --org local-owner \
	--consumer teamily-workspace --purpose research-context --max-events 100 \
	--output ./evidence-bundles.jsonl
```

## 文档

[消息编排](docs/zh/MESSAGE_ORCHESTRATION.md) ·
[产品](docs/zh/PRODUCT.md) · [路线图](docs/zh/ROADMAP.md) ·
[技术栈](docs/zh/TECH_STACK.md) · [采集架构](docs/zh/INGESTION_ARCHITECTURE.md)

## 贡献

提 PR 时请标明对应 RFC，并对照[产品](docs/zh/PRODUCT.md)。讨论开 [Issues](https://github.com/regenic-ai/regenic/issues)。

请遵守[行为准则](https://github.com/regenic-ai/regenic-book/blob/main/CODE_OF_CONDUCT.md)。
安全问题请走 [private advisory](https://github.com/regenic-ai/regenic/security/advisories/new)。

## 许可

[MIT](LICENSE)。

`regenic-ai/regenic-book` 里的方法论内容，在适用范围内仍为 CC BY-NC 4.0。
