# 架构 RFC

Phase 0 先以已接纳的 RFC 定模型，再写业务代码。
方法论来自：[regenic-ai/regenic-book](https://github.com/regenic-ai/regenic-book)。

[English](../../en/rfcs/README.md)

| RFC | 标题 | 状态 |
| --- | --- | --- |
| [0001](0001-standards-data-model.md) | 标准数据模型 | 已接纳 |
| [0002](0002-context-graph.md) | 上下文图谱 | 已接纳 |
| [0003](0003-collaboration-objects.md) | 协作对象 | 已接纳 |
| [0004](0004-human-agent-api.md) | 人机对称 API | 已接纳 |
| [0005](0005-context-storage-lifecycle.md) | 上下文存储与生命周期 | 已接纳 |
| [0006](0006-acl-agent-identity.md) | ACL 与 Agent 身份 | 已接纳 |
| [0007](0007-daily-distillation.md) | 日蒸馏 | 已接纳 |
| [0008](0008-thread-surface.md) | Thread Surface | 已接纳 |
| [0009](0009-work-orchestration.md) | 记录类、线程面与托管执行（L0–L6） | 已接纳 |

相关文档：

| 路径 | 说明 |
| --- | --- |
| [accept-checklists.md](accept-checklists.md) | 各波次接纳清单 |
| [book-schema-map.md](book-schema-map.md) | 与书稿公开标准的字段对照 |
| [personal-to-org.md](personal-to-org.md) | 从个人库到组织权威事件 |
| [d0-daily-distill.sql](../../en/rfcs/sketch/d0-daily-distill.sql) | RFC 0007 D0 草图（SQL 注释为英文） |
| [../PRODUCT.md](../PRODUCT.md) | 产品（消息编排） |
| [../MESSAGE_ORCHESTRATION.md](../MESSAGE_ORCHESTRATION.md) | 消息路径与插件组装 |

里程碑：[Phase 0 — RFC acceptance](https://github.com/regenic-ai/regenic/milestone/1)（已关闭）。

## 约定

- 一篇 RFC 只谈一个关注点；后面的可以依赖前面的编号。
- 字段名用 JSON 友好的 `snake_case`。
- 状态：`Draft` → `Accepted` → `Superseded`。
- 给人看的公开标准在 `regenic-book`；这里定义对应的机读产品模型。
- 代码标识符、API 路径、枚举值统一用英文。

## 建议阅读顺序

```
0001 标准 → 0002 图谱 → 0003 协作 → 0004 API
→ 0005 物理存储 → 0006 ACL → 0007 日蒸馏 → 0008 Thread Surface
→ 0009 记录类 / 线程面 / 工单 / 执行器（L0–L6）
```

## 讨论

[GitHub Issues](https://github.com/regenic-ai/regenic/issues)。
Phase 0 已完成，功能开发请引用对应 RFC（见根 README）。
