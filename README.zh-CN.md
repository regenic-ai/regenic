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

[docs/zh/TECH_STACK.md](docs/zh/TECH_STACK.md)

| 层 | 选型 |
| --- | --- |
| API / 后台任务 | NestJS + BullMQ + Redis |
| 数据 | PostgreSQL + 可替换的对象存储 / 检索（个人也可用 SQLite） |
| 接入 | ChannelConnector（拉取与推送） |
| 模型 / 身份 / 通知 | ModelProvider · IdentityProvider · Notifier · SecretStore |
| 桌面 | Electron + React |
| 手机 | Expo |
| 契约 | OpenAPI |

## 架构 RFC

已接纳的 RFC 在 [`docs/zh/rfcs/`](docs/zh/rfcs/README.md)。它们是个人阶段与组织阶段共用的目标模型。

## 脚手架

目前仓库是可跑通的骨架（健康检查与基础连通）。业务加工从 Phase 1 起落地。

```bash
pnpm install
docker compose up --build
curl -s http://localhost:3000/health
```

## 路线图

[路线图](docs/zh/ROADMAP.md) · [产品定位](docs/zh/PRODUCT.md) · [技术栈](docs/zh/TECH_STACK.md)

## 贡献

提功能请标明对应 RFC，并符合 [产品定位](docs/zh/PRODUCT.md)（信息加工；先个人后组织）。
讨论请开 [Issues](https://github.com/regenic-ai/regenic/issues)。

请遵守组织 [行为准则](https://github.com/regenic-ai/regenic-book/blob/main/CODE_OF_CONDUCT.md)。
安全问题请走 [private advisory](https://github.com/regenic-ai/regenic/security/advisories/new)。

## 许可

MIT — 见 [LICENSE](LICENSE)。

`regenic-ai/regenic-book` 中的方法论内容，在适用范围内仍为 CC BY-NC 4.0。
