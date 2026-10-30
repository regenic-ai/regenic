# 路线图

[English](../en/ROADMAP.md)

Regenic 分层交付：一层可以独立使用，再开始下一层。顺序是**先个人（本地优先），再团队和组织**。产品定位见[产品说明](PRODUCT.md)。

| 阶段 | 目标 | 状态 |
| --- | --- | --- |
| [Phase 0](#phase-0--架构) | 数据模型与设计 RFC | 已完成 |
| [Phase 1](#phase-1--个人消息工作台) | 个人在本机接入、查看、检索和回复消息 | 基本完成 |
| [Phase 2](#phase-2--处理与编排) | 让消息可以被分析、分派和自动处理 | 进行中 |
| [Phase 3](#phase-3--团队与组织) | 多人消息流合成团队共享的上下文 | 规划中 |
| [Phase 4](#phase-4--组织工作流) | 在标准和上下文之上运行组织流程 | 规划中 |

## Phase 0 — 架构

确定统一的数据模型，并与 [regenic-book](https://github.com/regenic-ai/regenic-book) 的公开标准对齐。

- [x] 判断标准的数据模型 — [RFC 0001](rfcs/0001-standards-data-model.md)
- [x] 上下文图谱 — [RFC 0002](rfcs/0002-context-graph.md)
- [x] 协作对象（Proposal / Decision / Review / Handoff）— [RFC 0003](rfcs/0003-collaboration-objects.md)
- [x] 人和 Agent 共用的 API — [RFC 0004](rfcs/0004-human-agent-api.md)
- [x] 存储与生命周期（Event / Blob / Digest / GC）— [RFC 0005](rfcs/0005-context-storage-lifecycle.md)
- [x] 权限与 Agent 身份 — [RFC 0006](rfcs/0006-acl-agent-identity.md)
- [x] 每日提炼 — [RFC 0007](rfcs/0007-daily-distillation.md)
- [x] [技术栈](TECH_STACK.md)与[书稿 schema 对照](rfcs/book-schema-map.md)

## Phase 1 — 个人消息工作台

一个人可以在本机接入真实渠道，集中查看、检索和回复消息，不依赖厂商云，并能导出自己的数据。

- [x] 本机权威库（SQLite）和本地 Blob 存储
- [x] 连接器宿主与开放的[连接器标准](CONNECTOR.md)，卸载后不留额外写入或授权
- [x] 内置飞书、DSH、Cursor 连接器
- [x] 插件连接器：Slack、WhatsApp、Telegram、钉钉、企业微信（见[连接器目录](CONNECTOR_CATALOG.md)）
- [x] CSV / JSONL 文件导入
- [x] 桌面工作台：按会话查看、未读、置顶、折叠、手动分拣
- [x] 回复写回原渠道，读写分开授权
- [x] 跨渠道转发 — [RFC 0010](rfcs/0010-cross-channel-forward.md)
- [x] 导出为 JSONL 或 Markdown
- [x] 远程内核：在自己的服务器上运行，桌面端安全配对
- [ ] 可选的远端历史备份（默认关闭，由用户开启）

## Phase 2 — 处理与编排

让接入的消息可以被检索、分析，并交给合适的人或 Agent 处理。

**已交付**

- [x] 跨渠道检索：关键词和本地语义检索，带出处和上下文
- [x] 执行器：接入 Agent 或模型，基于检索结果回答并附引用 — [执行器](EXECUTOR.md)
- [x] Recipes：按规则把工单分派给执行器，支持定时运行和人工确认 — [RFC 0009](rfcs/0009-work-orchestration.md)
- [x] 可替换的模型服务，支持本地模型 — [本地模型服务](LOCAL_MODEL_SERVICE.md)
- [x] 只读 MCP，供外部 AI 检索对话 — [MCP](CONTEXT_SEARCH_MCP.md)
- [x] 跟进：识别等待回复的事项，在工作台集中处理
- [x] 每日摘要：有出处的提炼、覆盖缺口和异常提示
- [x] 判断标准的版本化、缺口收集和偏差提示
- [x] 按策略过滤的 Evidence Bundle 发布，供协作平台和 Agent 使用
- [x] 基于证据的客服 Agent 流程 — [客服 Agent](CUSTOMER_SERVICE_AGENT.md)

**下一步**

- [ ] 可组合的处理流程：筛选、转换、分析、分派和结果回传
- [ ] 主动分拣：按个人标准判断哪些消息需要现在处理，没把握时暂缓
- [ ] 在工作台中查看和修订摘要、标准与跟进
- [ ] 更多连接器，以及已有连接器在真实账号上的验证

**完成标准：** 个人的日常消息可以按自己的标准被识别、提炼和分派，结论有出处，并能修订至少一条个人标准。

## Phase 3 — 团队与组织

在当事人同意的前提下，把多人的消息流合成团队共享的上下文。

- [ ] 同一条源消息只保留一个权威 Event，每人保留自己的视角 — [从个人到组织](rfcs/personal-to-org.md)
- [ ] 身份映射、工作范围授权；汇总不扩大权限（RFC 0006）
- [ ] 团队级摘要、结论和快照，由团队任务重新计算，不照搬个人标签（RFC 0002、0007）
- [ ] 基于共享快照的协作与交接（RFC 0003）
- [ ] 团队级判断标准的完整生命周期（RFC 0001）

**完成标准：** 两个人接入同一条源消息，得到一个权威 Event 和两个个人视角；团队摘要引用证据且不扩大权限。

## Phase 4 — 组织工作流

- [ ] 建立在标准和上下文之上的运营流程，而不是以表单为中心的 ERP
- [ ] 人和 Agent 使用同一套界面与 API（RFC 0004）
- [ ] 企业身份、通知与合规适配，放在最后

**完成标准：** 至少一个真实团队（首个是 bioby.ai）在 Regenic 上跑通端到端的组织流程。

## 不在计划内

- 通用 ERP 模块（人事、财务、库存）
- 把「替代团队聊天」或「第二大脑」作为主要定位
- 没有标准和上下文约束的无界 Agent 循环
- 个人 AI 标签不经团队提炼就成为组织事实

## 参与

议题与里程碑：[github.com/regenic-ai/regenic/issues](https://github.com/regenic-ai/regenic/issues)。设计讨论见 [RFC](rfcs/README.md)。
