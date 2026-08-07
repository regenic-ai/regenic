# Regenic

**面向个人与企业的信息加工层。**

Regenic **不生产**一手渠道内容（聊天、邮件、工单、文档）。
它**接入**信息（push 或 pull）并**加工**——过滤、分层、提炼事实、迭代判断标准——
使人与 Agent 能在统一标准与统一上下文下行动。

实现《重写基因》中的[双能力模型](https://regenic.ai/zh/method)：

1. **统一判断标准** — 编码、应用并修订标准
2. **统一上下文** — 同一决策同一事实集，带出处

交付顺序：**个人（开源、本地优先）→ 组织（汇聚）**。
见 [docs/zh/PRODUCT.md](docs/zh/PRODUCT.md)。

[English](README.md)

## 方法论来源

书稿、[regenic.ai](https://regenic.ai) 与公开标准在
[**regenic-ai/regenic-book**](https://github.com/regenic-ai/regenic-book)。

## 状态

**Phase 0 HardGate 已满足；Phase 1 = 个人加工。** 架构 RFC 0001–0007 已 Accepted。
当前构建焦点是本地优先的个人接入与加工 — 不是组织 ERP。

| 能力 | 说明 | 状态 |
| --- | --- | --- |
| 信息加工 | 接入 → 过滤 → 分层 → 蒸馏 → 标准（push/pull） | 产品命题（[PRODUCT](docs/zh/PRODUCT.md)） |
| 个人（本地优先） | 单一 principal；开放导出；可选云历史 | Phase 1（当前） |
| 组织叠加 | 跨人 Canonical Event + 投影 | Phase 3（[个人 → 组织](docs/zh/rfcs/personal-to-org.md)） |
| 判断标准 | 版本化共用标准 | RFC Accepted（[0001](docs/zh/rfcs/0001-standards-data-model.md)） |
| 共享上下文 | Claim、Snapshot、Event/Blob | RFC Accepted（[0002](docs/zh/rfcs/0002-context-graph.md)、[0005](docs/zh/rfcs/0005-context-storage-lifecycle.md)） |
| 协作 | Proposal / Decision / Review / Handoff | RFC Accepted（[0003](docs/zh/rfcs/0003-collaboration-objects.md)） |
| 对称 API | 人机同一 `/v1` | RFC Accepted（[0004](docs/zh/rfcs/0004-human-agent-api.md)） |
| ACL + Agent 身份 | `visible()`；蒸馏不升权 | RFC Accepted（[0006](docs/zh/rfcs/0006-acl-agent-identity.md)） |
| 日蒸馏 | 标准机器进料 | RFC Accepted（[0007](docs/zh/rfcs/0007-daily-distillation.md)） |

## 技术栈

[docs/zh/TECH_STACK.md](docs/zh/TECH_STACK.md)

| 层 | 技术 |
| --- | --- |
| API / worker | NestJS + BullMQ + Redis |
| 数据 | PostgreSQL + 可插拔 BlobStore / SearchIndex（个人可用 SQLite） |
| 接入 | ChannelConnector（push 与 pull） |
| 模型 / 身份 / 通知 | ModelProvider · IdentityProvider · Notifier · SecretStore |
| PC | Electron + React |
| 手机 | Expo |
| 契约 | OpenAPI |

## 架构 RFC

已 Accepted 的 RFC 见 [`docs/zh/rfcs/`](docs/zh/rfcs/README.md) — 现为个人形状、
后为组织叠加层的目标 schema。

## Spike 脚手架

Monorepo 骨架（health / 连通性）。产品加工在 Phase 1 落地。

```bash
pnpm install
docker compose up --build
curl -s http://localhost:3000/health
```

## 路线图

[docs/zh/ROADMAP.md](docs/zh/ROADMAP.md) · [PRODUCT.md](docs/zh/PRODUCT.md) ·
[技术栈](docs/zh/TECH_STACK.md)

## 贡献

功能 PR 应引用所属 RFC，并与 [PRODUCT.md](docs/zh/PRODUCT.md) 一致（加工层；
先个人后组织汇聚）。讨论：
[Issues](https://github.com/regenic-ai/regenic/issues)。

遵守组织 [Code of Conduct](https://github.com/regenic-ai/regenic-book/blob/main/CODE_OF_CONDUCT.md)。
安全报告：[private advisory](https://github.com/regenic-ai/regenic/security/advisories/new)。

## 许可

MIT — 见 [LICENSE](LICENSE)。

`regenic-ai/regenic-book` 中的方法论内容在适用处仍为 CC BY-NC 4.0。
