# 协作平台集成架构

- **English:** [../en/CONTEXT_PLATFORM_INTEGRATION.md](../en/CONTEXT_PLATFORM_INTEGRATION.md)
- **相关：** [产品](PRODUCT.md) · [消息编排](MESSAGE_ORCHESTRATION.md) · [采集架构](INGESTION_ARCHITECTURE.md) · RFC 0005、RFC 0006、RFC 0007
- **状态：** Phase 1 和 Phase 2 的交付方向

## 1. 概述

Regenic 在已有协作与消息工具之下编排消息。插件翻译渠道流量。内核负责证据、出处与调度。

协作平台可以同时是上游来源（对话、Agent 回合、文档、工作流结果），以及有边界、有证据输出的下游消费者。

对话体验和 Agent 循环由协作平台负责。Regenic 负责消息编排：证据采集、版本、provenance、边界、处理状态和可迁移输出。详见[消息编排](MESSAGE_ORCHESTRATION.md)。

## 2. 边界

```text
协作平台 / 消息渠道 / 文件 / 业务系统
                    |
                    v
         来源适配器或文件导入
                    |
                    v
Canonical Event + Blob + revision/tombstone + quarantine
                    |
                    v
    证据加工：digest、claim、标准、跟进信号
                    |
                    v
      Context Consumer / Evidence Bundle 边界
                    |
                    v
 Teamily Agent、工作空间、Studio 或其他应用
```

上游平台不能直接写 Event、Blob、Digest、Claim 或 Standard。下游 Agent 不能获得未提交记录、连接器凭据，或超出其证据与 ACL 边界的数据。

## 3. 集成协议

### 3.1 上游来源适配器

平台适配器将其导出、webhook 或 poll 协议映射为 `IngestBatch`。它必须保留稳定外部身份，并将来源编辑和删除表示为 `revise` 与 `tombstone`。Agent 产出是 provenance，不是权威事实：来源、外部 actor、会话/thread 与来源时间必须明确。

轮询适配器必须通过 poll connector conformance suite。稳定原生导出 schema 出现之前，文件导出走现有的显式 mapping 导入路径。

### 3.2 Evidence Bundle 消费者

未来的 `ContextConsumer` 端口发布有边界的 bundle，而不是无限制的记忆 dump。bundle 包含被选择的 Event ID 与 content hash 引用、已批准的 Digest/Claim/Snapshot ID（这些领域对象存在后）、来源/时间/scope/evidence 链接，以及 consumer principal 与允许用途。

它不包含连接器 token、原始 webhook payload、quarantine 的正文，或尚未提交到 AuthorityStore 的记录。消费者可以提出工作，但其输出必须经适配器重新进入，不能自行认证为事实。

### 3.3 处理状态

当前本地 digest 是确定性的证据索引。它可以展示 Event 操作计数和安全 quarantine 状态，但没有 evidence 链接与明确生命周期状态时，不得把模型输出呈现为事实。

## 4. 交付任务

1. **来源协议发现：** 使用[来源协议收集表](COLLABORATION_PLATFORM_SOURCE_INTAKE.md)收集有代表性的 Teamily 导出或 API payload、权限模型、分页行为、编辑/删除语义和 Agent 回合标识。这是硬前置条件；不能从营销材料猜测私有协议。
2. **Teamily 导出适配器：** 为已批准 payload 添加 canonical fixture 与导入 profile。覆盖 chat、thread、人类/Agent actor、文档/工作流输出、编辑、删除、重放和坏记录隔离。
3. **Teamily 增量连接器：** 只有得到稳定 API 访问后，才添加有界 poll 或 webhook，并通过 conformance suite。
4. **Evidence Bundle 端口：** 定义 consumer identity、用途、证据列表和按策略过滤的发布。先实现本地 JSONL driver，再考虑直连 Teamily API driver。
5. **提案返回路径：** 将 Agent 创建的建议映射为 proposal 类待处理对象；必须由人或受治理的 distill job 接受。

## 5. 范围外

- 重做 Teamily 的聊天、Studio、公共 feed、Agent 市场、模型路由或多 Agent 编排。
- 没有 Event 证据与生命周期控制时，把 Agent 记忆或生成摘要视为权威。
- 未收到真实 schema 与同意模型前就构建来源适配器。