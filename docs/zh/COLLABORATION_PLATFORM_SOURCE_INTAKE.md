# 协作平台来源协议收集表

- **English:** [../en/COLLABORATION_PLATFORM_SOURCE_INTAKE.md](../en/COLLABORATION_PLATFORM_SOURCE_INTAKE.md)
- **相关：** [协作平台集成架构](CONTEXT_PLATFORM_INTEGRATION.md)
- **状态：** 构建厂商专用适配器前的必需输入

该表用于 Teamily 或其他协作/Agent 平台。必须拿到真实导出或获批 API 样本并填完，才能提出来源适配器。

## 必需材料

1. 已脱敏的代表性导出或 API 响应，覆盖会话、thread、人类消息、Agent 消息、文档/工作流结果，以及支持时的编辑和删除。
2. 权限模型：导出者身份、workspace/project 范围、数据归属，以及导出或发布证据所需同意。
3. 分页与排序语义，包括 cursor 是否稳定、opaque、会过期或可重放。
4. 限流、重试、webhook 验签，以及保留/删除行为。

## 映射表

| 来源概念 | 样本字段 | Canonical 目标 | 必须决定的事项 |
| --- | --- | --- | --- |
| Workspace / project |  | `org_id` / scope | 权威与同意边界 |
| 会话 / channel |  | `scope.id`、`scope.name` | 稳定外部身份 |
| 消息 / 对象 |  | `external_id` | 导出与重放时保持稳定 |
| Thread / parent |  | `thread`、`parent_external_id` | 根与回复语义 |
| 人类 / Agent actor |  | `actor` + `attrs` | Actor provenance；不能只凭标签取得权威 |
| 来源时间 |  | `occurred_at` | 时区与更新排序 |
| 内容 / 产物 |  | `content` | media type、bytes、text、external locator |
| 编辑 |  | `operation: revise` | revision identity 与前序规则 |
| 删除 / recall |  | `operation: tombstone` | tombstone 时间与保留证据 |
| 页标记 |  | `next_cursor` | 提交条件与重放行为 |

## 适配器验收

- 同一个来源 occurrence 映射为同一个 `(source, external_id)`。
- 编辑和删除保留来源身份与排序规则。
- Agent 回合保留平台、actor、会话与来源时间 provenance。
- 不支持或不完整的来源记录进入 quarantine，且不暴露正文。
- 轮询适配器通过 Regenic conformance suite。
- 已发布 Evidence Bundle 受用途约束，且不包含凭据、原始 payload、未提交记录或 Blob 正文。