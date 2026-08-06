# 架构 RFC

Phase 0 在生产代码之前以 Accepted RFC 落地。
方法论来源：[regenic-ai/regenic-book](https://github.com/regenic-ai/regenic-book)。

[English](../../en/rfcs/README.md)

| RFC | 标题 | 状态 |
| --- | --- | --- |
| [0001](0001-standards-data-model.md) | 标准数据模型 | Accepted |
| [0002](0002-context-graph.md) | 上下文图谱 | Accepted |
| [0003](0003-collaboration-objects.md) | 协作对象 | Accepted |
| [0004](0004-human-agent-api.md) | 人机对称 API | Accepted |
| [0005](0005-context-storage-lifecycle.md) | 上下文存储与生命周期 | Accepted |
| [0006](0006-acl-agent-identity.md) | ACL 权限域与 Agent 身份 | Accepted |
| [0007](0007-daily-distillation.md) | 日蒸馏 | Accepted |

Phase 0 收口：

| 路径 | 说明 |
| --- | --- |
| [accept-checklists.md](accept-checklists.md) | Wave A–D Accept 清单 |
| [book-schema-map.md](book-schema-map.md) | Book ↔ RFC 0001 SoftGate 对照 |
| [d0-daily-distill.sql](../../en/rfcs/sketch/d0-daily-distill.sql) | RFC 0007 D0 草图（SQL 注释为英文） |

里程碑：[Phase 0 — RFC acceptance](https://github.com/regenic-ai/regenic/milestone/1)。

## 约定

- 一关注点一 RFC；后续 RFC 可依赖更早编号。
- Schema 字段名使用 JSON 兼容的 `snake_case`。
- 状态：`Draft` → `Accepted` → `Superseded`。
- 公开标准 Markdown 在 `regenic-book`；本目录定义映射到它的机读产品模型。
- 代码标识符、API 路径与枚举值保持英文。

## 阅读顺序（上下文路径）

```
0001 标准 → 0002 图谱 → 0003 协作 → 0004 API
→ 0005 物理存储 → 0006 ACL → 0007 日蒸馏
```

## 评审

讨论：[GitHub Issues](https://github.com/regenic-ai/regenic/issues)。
Phase 0 HardGate 已满足 — 全部 RFC Accepted。功能 PR 可引用这些 RFC（见根 README）。
