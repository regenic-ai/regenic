# Regenic

**个人与组织的信息加工层。**

Regenic 不负责产生聊天、邮件、工单或文档本身。它把已有信息接进来（拉取或推送），
再过滤、分层、提炼事实，并支撑判断标准的修订，让人和 Agent 能在同一套标准、
同一份上下文里做事。

对应《重写基因》里的[双能力模型](https://regenic.ai/zh/method)：

1. **统一判断标准** — 写清楚、用起来、改得动  
2. **统一上下文** — 同一决策看到同一组事实，并知道出处  

交付顺序：**先个人（本地优先），后组织**。详见 [产品定位](docs/zh/PRODUCT.md)。

[English](README.md)

## 方法论从哪来

书稿、[regenic.ai](https://regenic.ai) 与公开标准在
[**regenic-ai/regenic-book**](https://github.com/regenic-ai/regenic-book)。

## 当前状态

**Phase 0 架构闸门已过；Phase 1 做个人加工。** RFC 0001–0007 均已接纳。
眼下优先把本地优先的个人接入与加工做出来，而不是组织 ERP。

| 能力 | 说明 | 状态 |
| --- | --- | --- |
| 信息加工 | 接入 → 过滤 → 分层 → 提炼 → 标准 | 产品定位见 [PRODUCT](docs/zh/PRODUCT.md) |
| 个人（本地优先） | 单人使用；可导出；远端历史可选 | Phase 1（进行中） |
| 组织层 | 多人权威事件与各人视角 | Phase 3（[从个人到组织](docs/zh/rfcs/personal-to-org.md)） |
| 判断标准 | 可版本化的共用标准 | RFC 已接纳（[0001](docs/zh/rfcs/0001-standards-data-model.md)） |
| 共享上下文 | Claim、Snapshot、Event/Blob | RFC 已接纳（[0002](docs/zh/rfcs/0002-context-graph.md)、[0005](docs/zh/rfcs/0005-context-storage-lifecycle.md)） |
| 协作 | Proposal / Decision / Review / Handoff | RFC 已接纳（[0003](docs/zh/rfcs/0003-collaboration-objects.md)） |
| 人机 API | 同一套 `/v1` | RFC 已接纳（[0004](docs/zh/rfcs/0004-human-agent-api.md)） |
| ACL 与 Agent | `visible()`；蒸馏不抬权 | RFC 已接纳（[0006](docs/zh/rfcs/0006-acl-agent-identity.md)） |
| 日蒸馏 | 向标准机器进料 | RFC 已接纳（[0007](docs/zh/rfcs/0007-daily-distillation.md)） |

## 技术栈

详见 [技术栈](docs/zh/TECH_STACK.md)。个人阶段默认 SQLite、本地 Blob、进程内队列和 Electron；
组织阶段再上 PostgreSQL、对象存储、Redis 和 Compose。渠道接入、模型、身份等走可换端口。

## 架构 RFC

已接纳的 RFC 在 [`docs/zh/rfcs/`](docs/zh/rfcs/README.md)。个人和组织共用同一套目标模型。

## 脚手架

仓库里目前是能跑通的骨架（健康检查、基础连通）。真正的加工逻辑从 Phase 1 开始写。
下面的 Compose 方便开发联调；个人产品默认是本机 / 桌面内嵌，不依赖这套云形态。

```bash
pnpm install
docker compose up --build
curl -s http://localhost:3000/health
```

## 本地 Slack 连接器

本地 CLI 使用 SQLite 和文件系统 BlobStore 配置并运行单个 Slack 频道。它不会把 access token 写入数据库；同步时仅通过所引用的环境变量提供 token。

```bash
pnpm local slack-install --database ./regenic.db --org local-owner \
	--channel C123 --channel-name engineering --id slack-engineering

REGENIC_SLACK_TOKEN=xoxb-... pnpm local slack-sync \
	--database ./regenic.db --blob-root ./blobs --installation slack-engineering

pnpm local status --database ./regenic.db --org local-owner
pnpm local quarantines --database ./regenic.db --installation slack-engineering
```

## 本地文件导入

通过显式 JSON 映射文件导入 CSV 或 JSONL。坏行会被报告，合法行仍沿同一 canonical 采集路径写入。

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

## 本地 JSONL 导出

将 append-only Event 元数据导出为 JSONL。每行包含 provenance 和内容 hash 引用，绝不内联 Blob 字节。

```bash
pnpm local export-jsonl --database ./regenic.db --org local-owner \
	--output ./events.jsonl
```

## 路线图

[路线图](docs/zh/ROADMAP.md) · [产品定位](docs/zh/PRODUCT.md) ·
[技术栈](docs/zh/TECH_STACK.md) · [采集架构](docs/zh/INGESTION_ARCHITECTURE.md)

## 贡献

提 PR 时请标明对应 RFC，并对照 [产品定位](docs/zh/PRODUCT.md)：我们做信息加工，先个人后组织。
讨论开 [Issues](https://github.com/regenic-ai/regenic/issues)。

请遵守 [行为准则](https://github.com/regenic-ai/regenic-book/blob/main/CODE_OF_CONDUCT.md)。
安全问题请走 [private advisory](https://github.com/regenic-ai/regenic/security/advisories/new)。

## 许可

MIT，见 [LICENSE](LICENSE)。

`regenic-ai/regenic-book` 里的方法论内容，在适用范围内仍为 CC BY-NC 4.0。
