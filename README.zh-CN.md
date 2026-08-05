# Regenic

**AI 原生组织的默认管理软件。**

Regenic 实现《重写基因》中的[双能力模型](https://regenic.ai/zh/method)：

1. **统一判断标准** — 编码、应用并修订人与 Agent 共用的标准
2. **统一上下文** — 组织级上下文层，而非各团队聊天孤岛

不是用更多控制修补分裂的上下文。

[English](README.md)

## 方法论来源

书稿、[regenic.ai](https://regenic.ai) 与公开标准在
[**regenic-ai/regenic-book**](https://github.com/regenic-ai/regenic-book)。

## 状态

**早期。** 先架构 RFC，再按 `regenic-book` 公开方法实现。

| 能力 | 说明 | 状态 |
| --- | --- | --- |
| 判断标准 | 定义、版本、应用、修订组织级标准 | RFC Draft（[0001](docs/zh/rfcs/0001-standards-data-model.md)） |
| 共享上下文 | 人、团队与 Agent 共用同一上下文层 | RFC Draft（[0002](docs/zh/rfcs/0002-context-graph.md)、[0005](docs/zh/rfcs/0005-context-storage-lifecycle.md)） |
| 人机协作 | 共享对象上的 Proposal / Decision / Review / Handoff | RFC Draft（[0003](docs/zh/rfcs/0003-collaboration-objects.md)） |
| 对称 API | 人机 UI 与 Agent 读写同一表面 | RFC Draft（[0004](docs/zh/rfcs/0004-human-agent-api.md)） |
| ACL + Agent 身份 | 人机同一 `visible()`；蒸馏不升权 | RFC Draft（[0006](docs/zh/rfcs/0006-acl-agent-identity.md)） |
| 日蒸馏 | 加权日进料进标准机器（D0 规则 → D1 LLM） | RFC Draft（[0007](docs/zh/rfcs/0007-daily-distillation.md)） |
| 组织管理 | 基于标准与上下文的 AI 原生运营——而非以层级与审批作信息层 | Planned |

## 架构 RFC

Phase 0 草案见 [`docs/zh/rfcs/`](docs/zh/rfcs/README.md)：

1. [标准数据模型](docs/zh/rfcs/0001-standards-data-model.md) — 生命周期、五闸门、渐进式生成
2. [上下文图谱](docs/zh/rfcs/0002-context-graph.md) — claim、snapshot、provenance、access
3. [协作对象](docs/zh/rfcs/0003-collaboration-objects.md) — 人与人机交接
4. [人机对称 API](docs/zh/rfcs/0004-human-agent-api.md) — 对称 `/v1` 契约
5. [上下文存储与生命周期](docs/zh/rfcs/0005-context-storage-lifecycle.md) — Event / Blob / Digest / GC
6. [ACL 与 Agent 身份](docs/zh/rfcs/0006-acl-agent-identity.md) — scope、绑定、`visible()`
7. [日蒸馏](docs/zh/rfcs/0007-daily-distillation.md) — 标准机器进料（+ D0 草图）

## 路线图

[docs/zh/ROADMAP.md](docs/zh/ROADMAP.md)

## 贡献

初始架构 RFC 未 Accepted 前不接受功能 PR。讨论欢迎开
[Issues](https://github.com/regenic-ai/regenic/issues)。

遵守组织 [Code of Conduct](https://github.com/regenic-ai/regenic-book/blob/main/CODE_OF_CONDUCT.md)。
安全报告：[private advisory](https://github.com/regenic-ai/regenic/security/advisories/new)。

## 许可

MIT — 见 [LICENSE](LICENSE)。

`regenic-ai/regenic-book` 中的方法论内容在适用处仍为 CC BY-NC 4.0。
