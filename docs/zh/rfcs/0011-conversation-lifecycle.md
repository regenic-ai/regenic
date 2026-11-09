# RFC 0011 — 对话生命周期与策略钩子

- **状态：** Accepted（设计定稿，分阶段实现中；实际进度见第 12 节）。
- **日期：** 2026-11-09
- **依赖：** [RFC 0008](0008-thread-surface.md)、[RFC 0009](0009-work-orchestration.md)
- **定位：** 重构的产品与架构规格；目标设计不代表运行代码已经完成迁移。
- **公开边界：** 只描述渠道无关的协议与抽象，不包含私有连接器的身份、业务场景、配置、接口或实现细节。

## 1. 最终决策

| 关注点 | 决策 |
| --- | --- |
| 对话模型 | 不新增 Conversation 实体或万能 `conversation.status`；沿用 `(org_id, thread_id)` |
| 状态归属 | 对话是容器；WorkItem 是工作单元，WorkRun 是执行尝试，WorkDelivery 是渠道投递 |
| 自动隐藏 | 成功且本次必要投递已确认、没有其他待办时折叠；失败、待投递和发送不确定保持可发现 |
| 人工意图 | 人工隐藏不被策略展开；人工重新显示保护当前工作，下一工作单元／显式重试重新进入自动策略 |
| 解耦方式 | 纯状态转换、纯可见性策略、原子提交端口、提交后通知和有限的耐久任务；不将所有钩子异步化 |
| 一致性 | 工作状态、必要投递入队、显示偏好和耐久列表投影同事务完成 |
| 新增表 | 两张：生命周期审计事实、耐久副作用任务；不是通用订阅框架 |
| 耐久任务范围 | 第一版只有 `cancel_execution`；不为隐藏、列表刷新或进程内取消订阅创建持久任务 |
| 投递身份 | 改为每次运行最多一条不可变投递；一个工单可以保留多条历史投递 |
| 并发 | 对话级串行化 + 行版本 CAS + 每次认领独立 claim token |
| 业务办结 | 不新增持久办结枚举；从当前运行、投递、人工确认与其他工作组合推导 |
| 迁移发布 | 先兼容迁移，再通过一次明确的版本化发布启用最终可见性策略，不长期维护两套产品行为 |

本文取代先前草案中“所有处理器入队”“投递每工单一行”“人工意图与策略共用版本”等建议。下文无待选方案；实现偏离本规格时需修订 RFC。

## 2. 现状及重构边界

当前执行监督入口同时更新运行、安排回写、更新工单、释放监听、折叠来源及执行器对话和通知列表。人工确认／忽略也包含类似副作用。

已核实的关键事实：

- 非活跃 WorkItem 包括 `done / failed / skipped`，并不都代表成功。
- 当前执行完成即可进入 `done` 并折叠，实际投递在另一条 worker 路径执行。
- 当前 `work_deliveries.status = acked` 可能搭配 `sent` 或 `skipped`；不能仅凭 `acked` 判断发送成功。
- 一个来源对话可对应多个工单，一个工单可对应多次运行；只查询前台一项不足以决定整条对话折叠。
- 当前执行器内部对话还有根据运行关联推导的列表排除机制，不等同于用户的 Hidden 偏好。
- 普通聊天可以没有工单。生命周期不能强迫它进入“已办结”状态。

保留 RFC 0008／0009 的消息、Prompt、Attention、发送授权和类型边界。本文明确调整两项旧行为：失败不再自动隐藏；需要投递时不再把执行完成当成可折叠条件。同步节奏、执行失败重试次数、上下文读取范围不因此改变。

## 3. 产品语义

### 3.1 状态权威

| 对象／维度 | 权威 | 禁止混淆 |
| --- | --- | --- |
| 消息证据 | `events`、`source_heads` | 不存生命周期通知为聊天 Event |
| 当前工作面 | `message_dispositions`、`thread_heads` | current_work 不等于未读、未完成或显示 |
| 工作单元 | `work_items` | 不是对话身份 |
| 执行尝试 | `work_runs` | 执行结束不是投递成功，也不是外部系统办结 |
| 渠道投递 | `work_deliveries` | 发送确认不是所有外部业务流程的终态 |
| 显示偏好 | `conversation_prefs` | Hidden 不等于取消、确认或删除 |
| 人工介入 | 耐久 `waiting_human` 和 live surface | Prompt 仍不写入聊天消息表 |
| 审计／副作用 | 新增生命周期表 | 不是业务状态权威或事件溯源数据库 |

### 3.2 可见性决策表

“保持可发现”指不由自动策略隐藏；不强制撤销人工隐藏。Pinned 继续只影响排序，不作为永久显示承诺。

| 情况 | 来源对话 | 执行器与资源 |
| --- | --- | --- |
| 普通聊天，无受管工作 | 只走人工偏好及既有消息编排，不因生命周期折叠 | 不干预用户自行打开的执行器对话 |
| `open / running / waiting_human` | 保持可发现 | 保留当前尝试需要的监听和交互同步 |
| 当前尝试成功且不要求投递 | 无其他待办且人工意图允许时折叠 | 释放结束尝试的资源 |
| 当前尝试成功且要求投递 | 排队、发送中、不确定或失败时保持可发现 | 不因等待投递继续占用执行资源 |
| 当前必要投递为 `acked + sent` | 无其他待办且人工意图允许时折叠 | 不恢复结束尝试 |
| 执行失败／投递 dead | 显示失败与重试入口，不自动隐藏 | 释放结束尝试资源 |
| 明确忽略当前工作 | 该项不再阻止折叠；其他工作仍阻止折叠 | 本地停止跟随；远端取消单独确认 |
| 确认当前结果 | 确认的是指定结果，不等同于跳过必要投递 | 不复活执行 |
| 新 current_work／新工作单元 | 策略隐藏展开；人工隐藏保持 | 有新运行才建立执行资源 |
| 人工重新显示 | 保护当前已存在工作，不能被旧结果或重复观察重新隐藏 | 不复活执行 |

跨对话回写只影响来源工作的投递条件，不自动隐藏结果目的地。目的地按自己的消息／注意力规则处理。

### 3.3 人工命令与转换矩阵

所有命令带稳定 `command_id`、`issued_at`、精确对象 ID 和期望版本。重试同一命令返回原语义结果；同一 ID 携带不同参数报冲突。不能用“当前最新项”替代用户操作时看到的对象。

| 命令／事实 | 前置条件 | 原子业务修改 | 明确不做什么 |
| --- | --- | --- | --- |
| 接纳新 current_work | 消息修订及 disposition 有效 | 写消息／编排版本，必要时展开策略隐藏；派发仍按原规则 | 不把上下文证据都当成新工单 |
| 建立工作单元 | `(org, thread, unit_key)` 未存在 | 建 WorkItem、捕获人工意图版本 | 不复活已完成旧工单来承载新触发消息 |
| 开始／重试执行 | 无活跃或启动不确定的前次尝试；没有未闭合旧投递 | 建新 Run、更新当前运行引用、冻结本次投递决策，捕获本轮人工意图版本 | 不复用旧运行 ID；不绕过现有并发上限 |
| 执行观察 | 指定 Run 仍是本项当前尝试；状态转换合法 | 更新 Run 和 Item；成功时按快照创建投递；重算可见性和资源投影 | 重复 completed 不创建第二份投递 |
| 重试投递 | 指定 Delivery 为可重试失败，且原工作未忽略 | 重置该投递的重试资格，保留身份／目标／payload | 不重新执行任务，不生成新发送身份 |
| 确认结果 | 指定当前 Run 及结果版本一致、无活跃尝试；必要投递已成功 | 设置该结果的确认引用，移出其确切触发证据的 current_work，重算可见性 | 不把失败标成功；不放弃待投递 |
| 确认已查看失败 | 指定当前失败 Run、无活跃尝试 | 记录确认并停止该次失败的自动重试；保留失败状态；移出其确切触发证据 | 不伪造成功；未闭合投递存在时仍不得折叠 |
| 忽略工作 | 精确 WorkItem 及版本匹配 | Item 置 `skipped`；未发送投递明确放弃；已发起投递请求停止重试；需要时建立取消任务 | 不宣称远端已经取消，不删除已有回执 |
| 人工隐藏／显示 | 线程身份及人工意图版本匹配 | 更新偏好并增加人工意图版本，即使 hidden 值未变化 | 不改工单、投递或执行状态 |
| 投递结果 | 精确 Delivery 及 claim token 匹配 | 保存此投递回执／失败／不确定状态，重算来源可见性 | 不将旧回执贴到另一条投递 |

确认失败和忽略的区别：前者确认一个失败结果并保留失败语义，后者停止处理整个工作单元。失败自动重试流程必须检查确认引用，不能确认后又自动开跑；手动重试建立新 Run 并清空旧结果确认。

忽略后仍可能收到远端完成通知：可补记实际 Run 结果，但 Item 保持 `skipped`，不得安排新投递。远端取消不支持或失败时显示“本地已忽略，远端取消未确认”，不伪造 WorkRun.cancelled。前次远端运行仍活跃或启动不确定时，不能重新执行同一工作单元。

## 4. 架构与钩子边界

**解耦不等于异步化。** 第一版不实现通用事件总线、任意订阅注册、每个状态一个类或完整工作流引擎。

```text
命令／观察
  → 事务中取得对话级写锁，加载当前事实
  → 校验状态、版本、命令幂等性和关联
  → 纯转换函数 + VisibilityPolicy + 本地资源／列表投影计划
  → 原子保存业务状态、投递、偏好、投影、审计和必要取消任务
  → 提交后通知：更新页面、释放本进程订阅
  → 现有投递 worker 发回渠道；取消 worker 处理远端取消
```

| 类型 | 执行方式 | 失败处理 |
| --- | --- | --- |
| 工单／运行状态、投递入队 | 事务内 | 全部回滚 |
| 可见性、耐久列表投影、结束运行的同步工作释放 | 事务内，由领域策略产生计划、存储端口执行 | 全部回滚，不留下成功状态＋旧列表 |
| 页面刷新、preferred thread、本进程等待订阅 | 提交后幂等通知 | 记录错误；轮询／启动恢复按耐久事实重建 |
| 渠道发送 | 现有投递 worker | 独立发送账本、回执、不确定处理和重试 |
| 远端取消执行 | 有限的耐久 job | 租约、重试、可查询失败；不阻塞其他工作 |

领域层负责纯策略和转换；应用层负责授权、组装、唤醒与网络调用；Authority 负责原子提交和并发协议。不同模块通过显式端口协作，不相互调用庞大的服务类。

启动时只为仍被跟随的活跃尝试重建资源；`skipped`、已确认失败和已结束尝试不得重新抢交互优先权。运行结果补充导致行版本增加，不是拒绝必要资源清理的理由；清理应验证运行身份、结束／停止跟随事实及资源当前归属。

## 5. 已有表结构

以下来自当前公开代码，不是本机运行数据库的现场检查。SQLite 的时间／JSON 为 TEXT、布尔为 INTEGER；PostgreSQL 为 TIMESTAMPTZ／JSONB／BOOLEAN。

| 表 | 当前主键／唯一约束 | 当前字段 |
| --- | --- | --- |
| `conversation_prefs` | PK `(org_id, thread_id)` | `org_id, thread_id, title, pinned, hidden, hidden_reason, last_read_at, last_read_external_id, updated_at` |
| `work_items` | PK `id`；UNIQUE `(org_id, thread_id, unit_key)` | `id, org_id, thread_id, unit_key, head_event_id, record_class, thread_facet, status, recipe_id, current_run_id, version, created_at, updated_at` |
| `work_runs` | PK `id`；UNIQUE `(org_id, id)` | `id, org_id, work_item_id, recipe_id, executor_type, external_run_id, agent_thread_id, status, start_state, result_json, version, write_back_required, write_back_target_json, trigger_kind, created_at, updated_at` |
| `work_deliveries` | PK `id`；部分 UNIQUE `(org_id, run_id)`，run_id 非 NULL；历史 NULL run_id 部分 UNIQUE `(org_id, work_item_id)` | `id, org_id, work_item_id, recipe_id, kind, unit_key, event_id, status, write_back, attempts, last_error, next_retry_at, payload_json, lease_expires_at, lease_owner, claim_token, cancel_requested_at, idempotency_key, channel_receipt_json, run_id, target_json, created_at, updated_at` |
| `recipes` | PK `id` | `id, org_id, name, match_json, executor_type, executor_config_json, can_write_back, write_back_thread_id, include_context, enabled, trigger_kind, trigger_interval_ms, trigger_at_minute, trigger_weekdays, trigger_timezone, trigger_coalesce, max_concurrent, next_run_at, created_at, updated_at` |

现有状态值：

- WorkItem：`open / running / waiting_human / done / failed / skipped`。
- WorkRun：`running / waiting_human / completed / failed / cancelled`；`start_state` 为 NULL 或 `pending / submitted / uncertain`。
- WorkDelivery：`queued / running / write_back / acked / dead / uncertain`；write_back 为 `pending / sent / skipped / failed`。
- hidden_reason：NULL、`human`、`policy`；Hidden 仍是本地偏好，不推导远端删除。

支撑表及关系：

| 表 | 相关结构 | 用途 |
| --- | --- | --- |
| `events` | sequence PK，id 唯一；来源、修订、线程、时间、正文引用和属性 | 耐久消息证据 |
| `source_heads` | PK `(org_id, source, external_id)`；current_event_id | 来源记录的当前修订，不是整条对话头 |
| `message_dispositions` | event_id PK／FK；org_id、disposition、layer、reason_codes、score、decided_at | 当前工作编排 |
| `thread_heads` | PK `(org_id, thread_id)`；face_event_id、face_occurred_at、has_current_work | 列表派生投影 |
| `connector_sync_work` | UNIQUE `(installation_id, stream_key, lane, generation)`；状态、优先权、租约等 | 执行器同步资源；其 run_id 指同步运行，不是 WorkRun |
| `context_projection_outbox` | 消息 event_id 唯一；状态、租约、重试等 | 消息上下文投影；不复用作生命周期队列 |

当前 `work_runs.work_item_id` 和 `work_deliveries.work_item_id` 引用 WorkItem；`head_event_id` 引用消息 Event。对话通过 `(org_id, thread_id)` 逻辑关联，没有独立 Conversation 表。自 SQLite／PostgreSQL schema 56 起，Recipe 固定回写目标已覆盖保存、读取及两种数据库映射，既有导入导出继续保留该字段。Schema 57 增加 WorkItem 的 `current_run_id` 与 WorkItem／WorkRun 行版本；历史行从版本 0 起。只有活跃工单恰好只有一条同租户运行，且该运行仍活跃、规则归属一致时才恢复运行指针；其余保留 NULL，不按时间或最新运行猜测。无法恢复的活跃工单输出明确的身份核对诊断，管理面核对入口尚待实现。

Schema 58 增加运行级投递义务、安装／目标快照与触发类型，以及按 Run 保留的投递账本；Delivery 使用 `(org_id, run_id)` 复合 FK 关联同租户 Run，原子写端口同时校验所属工单与目标。新运行在调用外部执行器前持久化这些字段，历史值保持 NULL。历史投递原 ID、正文、幂等键与回执原样迁移，不猜测 Run／目标；NULL run_id 的历史记录保留每工单最多一条的限制，不能换 ID 覆盖。此阶段仍保留旧运行／投递兼容收尾，不代表历史未知授权核对及最终发送协议已启用。

Schema 59 增加 `lease_owner / claim_token / cancel_requested_at`；已有请求与回执不改写，不为旧 worker 伪造 token。投递 worker 通过 `transitionWorkDelivery()` 原子认领／续租／结算／记录回执／恢复过期租约／请求停止投递。SQLite 使用 immediate 事务与单次写 RPC；PostgreSQL 按 Item、Delivery 顺序锁行；内存同步准备并提交。新认领分配新的 token，正常结算及续租同时匹配 ID、owner、token 与有效租约；已认领记录不能通过普通 put 接口覆盖或清掉 token。

## 6. 最终表结构变更

### 6.1 现有表增补

| 表 | 新增字段 | 约束／语义 |
| --- | --- | --- |
| `conversation_prefs` | `visibility_version` | 非负整数，NOT NULL DEFAULT 0；**仅人工显示／隐藏命令递增**，策略、已读、标题、置顶不递增 |
| `work_items` | `version` | 非负整数，NOT NULL DEFAULT 0；业务行 CAS |
| `work_items` | `current_run_id` | 可空，指向当前尝试；新执行路径不再通过“最新时间”猜当前运行 |
| `work_items` | `acknowledged_run_id` | 可空，明确已确认的结果；重试时清空 |
| `work_items` | `visibility_intent_version` | 非负整数，NOT NULL DEFAULT 0；建立工作／显式重试时捕获来源人工意图版本 |
| `work_runs` | `version` | 非负整数，NOT NULL DEFAULT 0 |
| `work_runs` | `write_back_required` | 可空 BOOLEAN；新运行必填；NULL 只表示历史未知，不能解释为 false |
| `work_runs` | `write_back_target_json` | 可空 JSON；要求投递的新运行必填，保存规范化 installation／source／target 身份，无凭据 |
| `work_runs` | `trigger_kind` | 可空 TEXT，`push / pull / manual`；新运行冻结触发类型，保证 Recipe 被删除后仍能记录投递来源；历史 NULL 不猜填 |
| `work_deliveries` | `version` | 非负整数，NOT NULL DEFAULT 0；行 CAS，不作为投递身份 |
| `work_deliveries` | `run_id` | 可空，历史未知保留 NULL；新执行结果投递必填 |
| `work_deliveries` | `target_json` | 可空 JSON；新投递必填，从 Run 快照复制，不跟随 Recipe 后续编辑 |
| `work_deliveries` | `lease_owner, claim_token` | 可空 TEXT；每次认领生成新 token |
| `work_deliveries` | `cancel_requested_at` | 可空 timestamp；停止新发送／重试，不代表已经撤销在途请求 |
| `message_dispositions` | `version` | 非负整数，NOT NULL DEFAULT 0；实际编排字段变化递增，不按重复扫描递增 |
| `recipes` | `write_back_thread_id` | 可空 TEXT；沿用既有对话身份格式，已在 schema 56 实现；历史行保留 NULL，不猜填目标 |

`current_run_id / acknowledged_run_id` 必须属于同一个 org 和 WorkItem。新关联采用同租户物理 FK：相关业务表增加 UNIQUE `(org_id, id)`，配合复合 FK；WorkItem 与 Run 循环关联通过可空指针及一个事务中的插入／更新建立。所属工单一致性还必须由原子端口校验。

WorkRun 的投递快照在外部启动前冻结；试跑关闭投递时明确写 false。执行器观察不能改写这份快照。发送前仍须检查当前授权和安装可用性，快照不是永久发送许可。无权限时显式失败，不换目标或静默跳过。

进入 completed 后冻结用于确认／投递的结果；不同结果必须来自新的显式尝试。补充非结果元数据可以增加行版本，但不能更改已确认内容或产生第二次完成。

此约束同样作用于普通 `putWorkRun`，不能只保护观察入口。completed 的 summary／content／evidence 不允许改写、删除或在历史未知结果上补填；对象键顺序不视为内容变化，但内容及证据数组顺序仍属于结果。completed／failed／cancelled 不能通过普通写入转换为其他状态；重试建立新的 Run。普通写入不隐式结算 Item 或补建投递，完整业务转换仍必须使用原子观察／生命周期端口。

### 6.2 投递账本改为按运行保留

移除覆盖全部记录的 UNIQUE `(org_id, work_item_id)`；新建唯一索引 `(org_id, run_id)`，条件 `run_id IS NOT NULL`。历史 NULL run_id 记录保留部分唯一索引 `(org_id, work_item_id)`，防止没有运行证据的新 ID 替换旧请求。每次运行最多创建一条结果投递，旧运行的记录不覆盖、不借用。增加 `(org_id, work_item_id, created_at, id)` 查询索引。

- Delivery.id 就是不可变的投递身份，不再增加 delivery_generation。
- `run_id / target_json / payload_json / idempotency_key` 创建后不可修改；发送状态、租约、回执独立更新。
- 幂等键包含投递身份并在首次发送前持久化；重试不换键。不能只用内容 hash，否则不同合法运行的同样结果会被错误合并。
- 已确认运行结果不因后续重复观察改写投递正文。纠正内容通过新的显式执行产生新投递，不覆盖发送历史。
- 工单层展示根据 `current_run_id` 定位当前投递，同时单独展示任何未闭合的历史投递异常。
- 重跑执行前，旧投递必须已经成功或明确放弃；在途／不确定投递阻止重跑，防止连续产生外部重复结果。
- 原来的“按工单取一条投递”接口必须替换为精确 ID／run 查询及历史列表，批量扫描和 UI 都要同步迁移。

投递状态新增 `uncertain`，write_back 仍保留原枚举；uncertain 使用 `pending` 并提供错误原因，不能伪装成 sent。

| 场景 | 状态与处理 |
| --- | --- |
| 确定未被渠道接受的失败 | 按既有回退和次数限制重试，耗尽为 dead |
| 已有可靠 accepted receipt，本地后处理失败 | 保存回执，只重试本地后处理，不再次发送 |
| 发送超时／进程退出，是否接受未知 | 进入 uncertain；优先查回执；渠道明确支持稳定幂等时允许原键重试 |
| 渠道无回执查询且无幂等保证 | 不自动重发 uncertain，显示“需核对”；用户明确确认已发送或确认未发送后才结算／重试，并记审计 |
| 未在途且确定未发送的投递被忽略 | `acked + skipped`，记录放弃事实 |
| 在途投递被忽略 | 设置 cancel_requested_at；不再启动重试，保留回执结算路径；不能声称已撤回 |
| 忽略后收到发送成功 | 仍记录 sent，Item 保持 skipped；显示结果可能已送达，不复活工作 |

租约到期本身不能证明发送失败。过期 worker 返回的回执不得直接覆盖当前状态；通过独立回执归并端口，校验同一 Delivery、原 token 的已认领审计和不可变请求身份后接受可靠证据。不可靠或冲突的证据保留为需核对异常，不能简单丢弃，也不能嫁接到新投递。

### 6.3 新表：`conversation_lifecycle_events`

用途是审计、幂等和取消任务的来源追踪，不用于重放整套业务。事件主体允许 `work_item / work_run / work_delivery / conversation / source_event`。

| 字段 | 逻辑类型／约束 | 含义 |
| --- | --- | --- |
| `id` | TEXT PK | 事实 ID |
| `org_id, thread_id` | TEXT NOT NULL | 租户与来源线程 |
| `aggregate_type, aggregate_id` | TEXT NOT NULL | 状态主体类型与身份 |
| `aggregate_version` | 非负整数 NOT NULL | 转换后的主体版本 |
| `event_type` | TEXT NOT NULL | 封闭类型，见下文 |
| `command_id` | TEXT NULL | 人工／API 命令身份；无命令的观察可空 |
| `dedupe_key` | TEXT NOT NULL | 确定性幂等键 |
| `schema_version` | 正整数 NOT NULL | 最小快照解码版本 |
| `payload_json` | JSON NOT NULL | 前后状态、关联对象、原因、必要 claim 证据；不重复保存正文、完整结果或凭据 |
| `occurred_at, created_at` | timestamp NOT NULL | 事实与记录时间 |

事件类型：`work_item_transitioned / work_run_transitioned / work_acknowledged / delivery_created / delivery_claimed / delivery_transitioned / cancellation_requested / visibility_intent_changed / visibility_changed / current_work_changed`。具体状态放入有类型的 payload，避免为每个状态建一个处理框架。

唯一约束 `(org_id, dedupe_key)`、`(org_id, id)`；审计索引 `(org_id, thread_id, created_at, id)`、主体索引 `(org_id, aggregate_type, aggregate_id, aggregate_version)`，命令查询索引 `(org_id, command_id)`。

去重键由主体类型、ID、转换版本和事件类型组成；命令以 command_id 关联原结果，并验证参数摘要，拒绝同 ID 不同参数。消息编排使用 disposition.version，不使用轮询时间。策略事件版本由触发转换及其语义子键确定，不借用只计人工操作的 visibility_version。

业务对象引用放在有类型 payload 中，由提交端口检查同租户关系；审计对业务表不建 FK，避免阻止正常数据清理。生命周期事实本身没有 processed 字段。

### 6.4 新表：`conversation_lifecycle_jobs`

第一版唯一 job_type 是 `cancel_execution`。每个需要远端取消的尝试有一个可独立恢复的任务，不为可见性、列表刷新和本地订阅复制任务。

| 字段 | 逻辑类型／约束 | 含义 |
| --- | --- | --- |
| `id` | TEXT PK | 任务 ID |
| `org_id, event_id` | TEXT NOT NULL | 同租户复合 FK 指向 lifecycle_events |
| `job_type, run_id` | TEXT NOT NULL | 取消操作与精确运行 |
| `schema_version` | 正整数 NOT NULL | 操作参数版本，不是订阅算法版本 |
| `status` | enum NOT NULL | `pending / running / succeeded / failed / dead` |
| `attempts` | 非负整数 NOT NULL DEFAULT 0 | 认领次数 |
| `lease_owner, claim_token` | TEXT NULL | 当前认领者及本轮不可复用 token |
| `lease_expires_at, next_retry_at` | timestamp NULL | 租约与重试时间 |
| `last_error_code, last_error, outcome_code` | TEXT NULL | 脱敏失败与明确处理结果 |
| `created_at, updated_at` | timestamp NOT NULL | 入队与更新时间 |
| `completed_at` | timestamp NULL | 闭合时间 |

UNIQUE `(org_id, job_type, run_id)`；pending、failed 到期、running 过期分别建立部分索引；另建 `(org_id, status, updated_at, id)` 运营索引。job 与事件同租户通过复合 FK 约束，业务 Run 引用由端口校验。

租约 30 秒，至多每 10 秒续租；单次调用须在可续租且有超时约束的执行边界内。自动尝试上限 5 次，失败间隔为 5 秒、30 秒、2 分钟、10 分钟；上限后进入 dead 并显示可操作错误，不冒充取消成功。支持取消的适配器必须可重复取消同一运行或先查询状态；超时后先核实，不盲目重复非幂等操作。

远端已结束可记 `already_finished`；不支持取消记 `unsupported` 并展示本地忽略与远端状态的区别。人工重试 dead 任务增加审计、重置重试预算并产生新 claim token，不重放已完成任务，也不因代码升级自动重跑。

仅远端明确确认取消或查询证实取消时，才通过原子工作转换写 Run.cancelled；若查询发现实际 completed／failed，记录该实际状态。以上都不撤销 WorkItem.skipped。不确定启动没有可证明的外部运行身份时，任务必须先沿启动确认协议查证，禁止猜测目标取消。

## 7. 并发与事务协议

### 7.1 对话级串行化

只加业务行 version 无法保护并发插入的新消息。所有影响来源可见性的写路径，包括采集、编排、建单、开跑、观察、人工操作、投递结算与恢复，必须遵守同一对话写协议：

- SQLite：在同一个写 worker RPC 内使用 `BEGIN IMMEDIATE` 事务，读取与写入都在该事务内完成。禁止在外部读快照后拼多个 put RPC。
- PostgreSQL：事务中先取得基于 `(org_id, thread_id)` 的 transaction-level advisory lock，再读取并计算；默认读已提交隔离，锁在读取前取得。锁键由统一、无歧义编码和固定哈希产生；碰撞只增加串行化，不降低正确性。
- 多对话写入按统一锁键顺序取得所有锁，避免交叉回写／采集死锁。不能绕过该锁直接写影响可见性的业务表。
- 内存实现按相同对话键串行化，失败时全有或全无。

纯策略在拿锁后读取的事实中计算；事务内无网络调用。CAS 校验防止陈旧命令覆盖，独立对象版本不互相比大小。所有写入口迁移完成后才启用新策略，不能让旧 put 路径绕过协议。

### 7.2 原子提交端口

提供专用领域端口，不提供任意业务回调穿过写 RPC：

- `commitWorkTransition`：工作／运行、必要投递入队、消息工作面、可见性、资源／列表投影、事件和取消任务。
- 迁移期的 `checkpointWorkRunStart`：对已原子预留的当前 Run，提交会话绑定、启动提交确认、明确未启动失败或启动不确定；同一事务校验 Item／Run 快照并更新配套状态，不产生新 Run 或结果投递。
- 迁移期的 `recordWorkRunStartFailure`：尚未预留运行的配置校验失败，核对 Item 完整快照、规则存在性、旧活跃运行和未闭合投递，再原子写入失败尝试与 Item 版本。自动失败更新 failed 与当前 Run；手动／辅助失败保留原业务状态和当前运行指针，不把配置校验失败当作重新执行成功或远端失败。
- 迁移期的 `dismissWorkItem`：核对期望 Item 完整快照与当前 Run 归属，原子写入 skipped／行版本及本工单所有未闭合投递的停止请求；不改写任何 Run 的实际执行状态。该端口尚不包含取消任务、命令去重、审计或可见性提交。
- 迁移期的 `claimWorkRunStart`：新调用传入期望 Item 快照与明确的手动／自动重试意图；事务内校验后直接由原状态进入 running 并建立新 Run，不先在事务外把终态改为 open。显式 `rebind` 意图允许在同一预留事务内绑定所选 Recipe；手动不能抢占其他规则仍为 open 的工作，自动仅允许 open／failed。容量按所选规则核对，所有旧活跃 Run 和未闭合投递仍阻塞。无快照的旧调用仅支持同规则既有 open 启动，不能用于重试终态或规则重绑定。
- `claimDelivery / commitDeliveryTransition / reconcileDeliveryReceipt`：精确投递身份、认领及回执归并。
- `commitConversationIntent`：人工显示意图与偏好。
- 既有采集／编排提交端口：接纳消息、disposition.version、展开及相关投影。
- `claimLifecycleJob / renewLifecycleJob / settleLifecycleJob`：取消任务租约。

端口返回 `applied / already_applied / conflict` 等明确结果；冲突重新读取计算或返回用户刷新提示，不吞成成功。业务写入、审计和必要任务必须同事务；处理未知版本／非法状态失败并回滚。

### 7.3 可见性策略的精确条件

输入是同一对话锁下的耐久事实，不是事件快照。只有以下条件同时成立才自动折叠：

1. 存在有效的工作收尾触发，不能因为“扫描发现空闲”就反复折叠。
2. 没有其他活跃、未确认失败或未闭合投递；明确忽略的项不再要求执行成功，但其在途发送异常必须保留可发现的独立警示。
3. 不存在尚未被处理的 current_work 触发证据。只有准确绑定的 head_event_id／工作单元触发身份可认定已处理；上下文 evidence IDs、时间早晚和 `has_current_work` 布尔值不能替代覆盖关系。
4. 当前结束尝试确属 current_run_id，必要投递满足本次冻结的要求；不读取最新 Recipe 猜测历史义务。
5. 没有人工隐藏需要保持，且触发工作的 visibility_intent_version 等于当前人工 visibility_version。人工重新显示后当前工作不再自动隐藏；下一新单／显式重试捕获新版本。

失败重试中的工作仍视为未闭合；确认当前失败可解除这一阻塞，但不把状态写成成功。新工作到达先展开策略隐藏，不要求等待 WorkItem 建立。无法证明触发证据已覆盖时保守保持显示并提供诊断原因，不用时间推测。

人工隐藏只影响可见性，不作为取消执行、停止投递或停止后台运行的开关。执行器内部对话的产品排除继续按运行归属处理，不借用来源对话的人工偏好。

live Prompt 不属于同一数据库事务，不以“此刻远端没有 Prompt”作为折叠的强原子条件。已跟随运行进入 waiting_human 时必须耐久更新再呈现；普通非受管会话的 live attention 继续按 RFC 0008 工作。

内部系统规则沿用既有“不自动折叠普通来源对话”的边界；执行器内部对话只能按精确运行归属清理。生命周期策略不得把后台系统工作当成用户确认或折叠触发。

### 7.4 租约与资源归属

续租、任务结算和投递正常结算匹配对象 ID、owner、claim_token 及有效租约。同一 worker 再次认领也必须更换 token，旧执行不能结算新租约。业务 version 与认领 token 不可互换，续租不会改变投递身份。

释放资源验证 run_id 及 agent thread／同步 generation 当前归属；旧运行不能清除新运行的监听、preferred thread 或同步工作。重复执行已经完成的本地清理是明确的幂等 no-op；失败要记录，不用 broad catch 静默忽略。

## 8. 生命周期审计与运维

- 生命周期事实记录保留至少 90 天；成功／明确无需执行的取消任务保留至少 30 天。事件仍被任务引用，或仍为未闭合投递提供认领／回执证据时不能删除。
- pending、running、failed、dead 任务和 uncertain 投递不自动清理；dead 需要人工处理或明确放弃并留审计。
- 投递历史作为业务账本，不适用短期 job 清理；正常数据删除遵守业务保留策略及 FK 清理顺序。
- 事件命令幂等保证窗口为至少 90 天；API 根据 issued_at 拒绝超过 90 天或不合理未来时间的命令，要求重新核对，不承诺永久保留命令回执。事件内标识／版本仍用于业务状态校验。
- 管理面提供取消失败、投递失败／不确定的计数、详情和精确重试／核对入口；不把这些错误只写进日志。
- 本地任务不承诺分布式 exactly-once；外部副作用依赖稳定身份、渠道能力、查证及显式不确定状态。
- 安装卸载／授权撤销不静默丢弃任务：转为可见的不可执行状态；恢复后只重试被明确允许的原对象。

## 9. 实施与发布顺序

1. 为现有完成、失败、回写、人工操作和新工作展开补特征测试。
2. 增加表迁移、版本字段、不可变投递、运行决策快照及精确查询；覆盖 SQLite、PostgreSQL、内存和写 RPC。
3. 全面迁移对话写协议及原子端口，保持结构迁移期原有折叠触发；先消除旧调用绕过和并发竞态。
4. 拆出纯状态转换、可见性策略及事务内投影计划，接入取消任务和提交后通知；移除原服务重复副作用。
5. 完成消息编排、手动／定时／试跑、自动重试、等待通知、恢复、跨对话回写及系统规则入口。
6. 接入管理面错误与不确定处理，然后以统一策略版本启用第 3 节最终行为。不得提前启用“等回写成功才折叠”却没有对应错误入口。
7. 通过验收后结束兼容阶段；不保留长期面向用户的旧／新策略选项。

历史迁移：版本置 0，不合成旧完成事件、不重发旧投递、不改变人工偏好。Delivery.id、已有幂等键和回执原样保留。历史 run_id／目标／当前运行只在能唯一证明时补齐，否则保留未知并阻止自动发送或自动认定办结，提供核对入口；不通过“最近一条”猜测。

进行中的旧运行在启用新语义前完成决策快照核对，或继续按已知旧义务收尾；不能用当前 Recipe 静默替代历史授权。SQLite 移除原唯一约束需要重建投递表并核对索引、FK、行数与回执一致性。迁移后不回滚运行旧二进制；需要功能回退时使用理解新账本的代码，不能丢弃历史投递。

## 10. 必须通过的验收

| 场景 | 要求 |
| --- | --- |
| 原子提交中途故障 | 状态、投递、偏好、投影、审计与取消任务全提交或全回滚 |
| 重复完成／重复命令 | 无重复执行或发送；同命令 ID 不同参数明确冲突 |
| 并发接纳新消息与完成旧工作 | 任一提交顺序都不最终隐藏新待办；覆盖 PostgreSQL 插入幻读场景 |
| 新工作未建 WorkItem | 旧完成不能盖住未处理 current_work |
| 一对话多工单 | 一项完成不掩盖其他未闭合项 |
| 旧运行结果晚到 | 不更新 current_run_id 指向的新工作，不创建旧结果的新投递 |
| 人工显示／隐藏及重复同值命令 | 意图版本正确；已读、标题、置顶不影响它 |
| 修改 Recipe／临时关闭试跑投递 | 不改变已建立运行的义务和目标 |
| 同内容的不同运行 | 独立合法投递；重试同投递不换幂等键 |
| 旧发送回执晚到／租约续期 | 回执只归属原 Delivery；不把行版本变化误当新请求身份 |
| 发送超时且无幂等能力 | uncertain，无盲目重发，有核对入口 |
| 忽略时正在发送／执行 | 不伪造撤回／取消；保存实际回执，工作不复活 |
| 确认失败与自动重试竞争 | 同一原子协议下只有一个转换生效，不确认后偷偷开跑 |
| 同 worker 的旧 job 返回 | 旧 token 不结算新认领 |
| 进程提交后退出 | 状态和显示已一致；取消任务恢复，本地资源不复活结束运行 |
| 执行资源被新运行接管 | 旧清理不伤新监听／同步 generation |
| 普通聊天／系统规则／跨对话回写 | 不错误隐藏、取消或污染结果目的地 |
| 历史数据／全存储实现／全 API 与 UI 表面 | 约束、错误、查询、导入导出及并发契约一致，无静默默认成功 |

## 11. 实施核对入口

- [SQLite 迁移](../../../packages/authority-store/src/sqlite/migrations.ts) · [PostgreSQL schema／迁移](../../../packages/authority-store/src/postgres/schema.ts)
- [SQLite 工单存储](../../../packages/authority-store/src/sqlite/work.ts) · [PostgreSQL 工单存储](../../../packages/authority-store/src/postgres/work.ts)
- [SQLite 写 RPC](../../../packages/authority-store/src/sqlite/sqlite-write-rpc.ts)
- [工单模型](../../../packages/domain/src/work.ts) · [运行协议](../../../packages/connector-contract/src/executor.ts)
- [投递转换](../../../packages/domain/src/work-delivery.ts) · [可见性策略](../../../packages/domain/src/list-surface.ts)
- [采集路径](../../../packages/domain/src/ingestion-service.ts)
- [执行监督](../../../apps/api/src/personal-work-supervise.ts) · [人工操作与重试](../../../apps/api/src/personal-work.service.ts)
- [投递 worker](../../../apps/api/src/personal-work-flush.ts) · [执行派发](../../../apps/api/src/personal-work-dispatch.ts)
- [同步规划](../../../packages/domain/src/sync-work-planner.ts) · [同步 due work](../../../apps/api/src/personal-connector-due-work.ts)

当前实现与本文不同之处是明确的迁移工作，不代表已经完成。本 RFC 不包含任何连接器特定分支或私有实现要求。

## 12. 实施进度

2026-11-09：已合入上游回写目标选择与连接器表单更新，开始兼容阶段。

| 阶段 | 状态 | 已落地内容／剩余边界 |
| --- | --- | --- |
| 现有行为特征测试 | 已完成首批 | 覆盖完成、失败、等待人工、试跑回写开关、重复观察、人工隐藏、系统工作、忽略竞争及错误传播 |
| 纯状态转换 | 已接入 | `planWorkObservation()` 计算运行、工作项和投递动作，不读写存储、不分配发送身份；存储层提交其计划 |
| 共享收尾边界 | 已接入兼容实现 | 自动收尾、人工确认与忽略使用 `personal-work-lifecycle.ts`；现阶段保留旧折叠时机，不宣称已完成策略解耦 |
| 取消状态映射 | 已修正普通人工忽略 | 执行器明确返回 cancelled 时保存 cancelled；普通人工忽略不再凭取消调用返回值伪造 Run.cancelled。辅助系统取消／超时仍有旧兼容路径，耐久取消及实际退出查证未完成 |
| 原子观察提交 | 已接入兼容实现 | `commitWorkObservation()` 在一次提交中保存 Run、Item 和投递变更；SQLite 使用 immediate 事务，PostgreSQL 在同一连接锁定相关行并提交，内存无 await 地准备后提交，SQLite split 通过单个写 RPC 执行 |
| 陈旧观察与忽略保护 | 已接入兼容实现 | 比较事务内完整快照而非只比时间；冲突明确返回，已忽略项不再被观察路径伪造远端取消，终态尝试不能被观察改回活跃 |
| 完成结果观察保护 | 已接入兼容实现 | 完成后的观察不能改写 summary／content／evidence；冲突明确提示新建尝试。重复完成不再入队或放弃投递，不因规则修改或试跑开关释放而改变已完成义务；首次完成缺少结果时使用 Run 已有结果，历史未知结果不补造 |
| 普通 Run 写入终态与结果保护 | 已接入 | `assertWorkRunWrite()` 统一保护纯计划、内存和 SQL 写入；普通 put 也拒绝改变终态、改写／清空／补填 completed 结果。SQLite 在 immediate 事务内校验并写入，PostgreSQL 同事务锁行并在 upsert 冲突分支复核终态／结果，覆盖并发首次插入；返回本次语句实际写入的版本，不在事务外重读或回退成输入快照 |
| 当前运行身份与行版本 | 已接入兼容实现 | Schema 57 为 WorkItem 增加 `current_run_id`、为 WorkItem／WorkRun 增加单调行版本；内存、SQLite、PostgreSQL、SQLite 写 RPC 的启动事务写入当前 Run 并递增 Item 版本，观察以明确当前 Run 与版本快照围栏；只恢复可唯一证明的旧活跃运行关联，歧义指针保持未知；旧 Run 在新 Run 启动后不能再结算 Item |
| 启动阶段原子检查点 | 已接入已预留运行 | `checkpointWorkRunStart()` 覆盖会话绑定、提交确认、明确启动失败和未知启动结果；同事务核对同租户身份、current_run_id、Item／Run 完整快照和启动阶段，提交 Run／Item 匹配状态。已有外部身份或 submitted／uncertain 不得改作“确定未启动”；冲突返回明确 409，不重发启动／stdin；提交成功后才应用执行观察或附加等待 |
| 重试与启动预留合并 | 已接入直接手动／自动重试 | `claimWorkRunStart()` 校验 Item 完整快照与版本，再于同事务保存新 Run、更新 current_run_id 和 running；不再先写 open。自动仅允许 open／failed，手动可显式重试已结束／已忽略项，但所有旧活跃尝试及未闭合历史投递仍阻塞。竞争／容量不足不改变原状态；手动重试不再伪造取消旧活跃 Run |
| 试跑与启动时规则绑定 | 已接入复用工单及过滤规则自动启动 | 试跑直接使用选定 Item 快照与所选 Recipe，不经普通 put 重开或绑定，也不重新读取工单后猜测执行意图；`rebind` 在启动事务内更新 Recipe／current_run_id／running，旧 Run 与结果不变。过滤规则自动重绑定也只在预留成功时提交；试跑开关由调用参数冻结到本次 Run，不再借助共享覆盖表。试跑不自动放弃旧投递；未闭合历史投递、旧活跃运行和陈旧快照保持阻塞 |
| 启动前配置失败 | 已接入未知执行器入口 | `recordWorkRunStartFailure()` 在同事务保存失败 Run 与 Item 版本，自动失败更新当前指针与 failed；手动／辅助失败不改变原状态、绑定或当前指针，但递增版本以拒绝同快照的并发启动／失败。仅接受无外部身份、无启动标记且明确无需投递的新失败尝试；忽略、旧活跃运行、未闭合投递或规则缺失冲突不写入失败历史 |
| 普通人工忽略 | 已接入本地原子提交 | `dismissWorkItem()` 校验 Item 完整快照及版本，在一个事务中保存 skipped 与当前／历史未闭合投递停止请求；不改写 Run、结果、运行指针或回执。提交成功后才对原 Run 尝试远端取消；无外部身份不猜测目标，调用成功不代表已取消，异常显式记录。未闭合投递存在时不执行兼容折叠；耐久任务、客户端期望版本和去重审计仍未完成 |
| 已忽略运行的实际结果 | 已接入身份明确且启动已确认的当前 Run | 重新加载 skipped 快照后仍沿 `commitWorkObservation()` 保存原 Run 的真实 running／waiting_human／completed／failed／cancelled；Item、指针、版本和投递证据不变，不创建或放弃投递。后台轮询覆盖这些已忽略运行，但不重建等待、追踪或 reap，不因实际结束再次折叠；已结束运行不再轮询。未知启动、缺失外部身份和非当前运行仍保守拒绝 |
| 原子端口与存储迁移整体 | 未完成 | 其他人工操作及折叠／列表投影尚未纳入同一事务；所有写入口统一的版本 CAS、对话级锁、审计与取消任务尚未落地 |
| 规则回写目标持久化 | 已完成 | schema 56 补齐 SQLite／PostgreSQL 新建与升级、写入／读取映射；覆盖 writer RPC、重启、API 局部更新／清除及既有导入导出；旧版 SQLite 修复先恢复至 v55 再执行后续迁移，历史目标保留未知 |
| 运行投递快照 | 已接入新运行路径 | Schema 58 在外部启动前冻结投递开关、installation／source／target 与触发类型；试跑保留本地明确写 false；规则修改／删除及重启不改变新运行义务；发送限定原安装并检查当前可用性，不自动换连接器 |
| 按运行保留的投递账本 | 已接入兼容实现 | 新投递按 `(org_id, run_id)` 唯一，正文／目标／请求身份不可修改；不同 Run 的同内容结果有不同 Delivery.id／幂等键；回执与结算按原 Delivery.id 读写，不按当前工单找行；未闭合历史投递阻止重跑，列表不把旧投递当成当前结果 |
| 投递认领围栏 | 已接入 | Schema 59 与 `transitionWorkDelivery()` 将认领检查及状态写入放入同一事务；每个 worker 实例使用独立 owner，每次认领使用新 token，正常结算和续租要求有效租约；同 worker 的旧 token 不能操作下一轮，普通 put 不可绕过已认领记录的围栏 |
| 未知接受状态 | 已启用保守停止 | 发送超时、租约过期或无法证明未被接受的发送异常进入 uncertain，不自动或强制重发；确定发送前失败仍沿原退避重试。已有 accepted 回执只恢复本地后处理，不再次调用外部发送。桌面显示“投递需核对”、保持需关注并禁用重发，API 返回明确核对冲突 |
| 投递忽略与迟到回执 | 已接入有限协议 | 未发送的队列可明确放弃；在途／uncertain 只记录 cancel_requested_at，不伪造撤回，实际成功仍归原投递且不复活 Item。仍保留的原 token 可合并 accepted 回执；token 已更换则明确冲突，矛盾回执不覆盖已存证据。尚无历史认领审计和跨旧认领的独立证据归并 |
| 人工核对与投递审计 | 未完成 | 尚无“确认已发送／确认未发送”的去重人工命令及审计入口；没有可靠回执的 uncertain 保持阻塞，不能用普通重跑／忽略绕过。尚未接入渠道回执查询或稳定幂等能力驱动的未知状态恢复 |
| 管理面与最终可见性策略 | 未启用 | 失败折叠、完成即折叠仍为兼容行为；需在原子提交及异常入口就绪后统一切换 |

原子观察提交已覆盖内存、SQLite 直连／写 worker 和 PostgreSQL 的实现与契约用例；当前环境没有 PostgreSQL 测试连接，真实 PostgreSQL 契约用例需通过 TEST_DATABASE_URL 执行，不能将类型检查当成真实数据库验收。

当前运行身份与行版本已覆盖原子启动、观察、配置失败及普通忽略围栏；其他直接更新路径尚未全部迁移为版本 CAS，也不解决对话新消息插入与折叠的竞态。后续必须将对话级锁及全部写入口共同迁移，才能启用最终可见性策略；不得把本次 Run／Item／投递事务宣称为整个生命周期已原子化。

完成结果冻结及终态保护已覆盖纯观察计划、原子观察和普通 Run put，包括 SQLite 写 RPC。非结果元数据仍可补充并增加行版本；这不代表普通 put 已具备所有版本 CAS 或 Item／投递联动，活跃阶段的陈旧直接写入仍待统一生命周期端口迁移。运行投递快照与新投递不可变字段已由内存、SQLite、PostgreSQL 端口校验；重复完成只保留原投递，不推断历史未知义务。旧 receipt 只更新原 Delivery.id 并匹配保留的原 owner／token；跨已替换 token 的回执不盲目接受，完整证据审计与人工核对仍待实现。普通人工忽略已移除直接取消 Run 的写入，身份明确且启动已确认的当前 Run 可继续记录实际退出；耐久取消任务、未知启动查证及管理面仍未完成，不能把本地 skipped 或远端取消调用完成当作实际退出证明。

Schema 58 的 SQLite 表重建覆盖 v57 原始投递行、正文／幂等键／回执保留及 FK 核对；新增运行快照、同内容跨 Run 投递、不可变字段拒绝、重启恢复、未闭合投递禁止重跑和迟到回执隔离均有回归用例。列表使用 current_run_id 关联 Run／Delivery，并将未闭合历史投递保留为需关注；完整历史异常管理入口仍未完成。

Schema 59 覆盖双 worker／同 worker 并发认领、续租不换 token、过期正常结算拒绝、重启保留未知接受状态、原 token 的迟到 accepted 回执、本地恢复不重发、在途忽略与真实送达并存，以及普通 put 禁止绕过认领围栏。新增保守停止不等于已完成第 6.2 节全部管理协议，也不启用最终折叠策略。

Run 普通写入加固不新增表结构，不重写历史结果。契约覆盖终态转换拒绝、完整结果及空结果冻结、语义等价结果与非结果元数据更新、并发插入／更新只有一份完成结果获准、SQLite 双写 worker 竞争及重启保持；被拒绝的写入不增加版本、不改变 Item 或投递账本。

启动检查点不新增表结构。SQLite 直连／写 RPC 在 immediate 事务内加载与写入，PostgreSQL 同事务按 Item、Run 顺序锁行，内存无 await 地准备后提交。检查点更新使用同一个时间戳；Run 版本递增，Item 只在业务状态变化时递增。外部调用仍在事务外，不能宣称外部副作用和数据库原子提交或 exactly-once：网络调用成功而检查点失败时保留原耐久启动意图，沿已有未知／已提交恢复协议处理，不自动重启。

契约覆盖提交确认和冻结义务不变、明确失败／未知结果的状态配对、故障全回滚、并发检查点只有一个成功、跨写 worker 竞争、重启恢复、人工忽略／新运行／陈旧版本拒绝和返回值克隆隔离。应用路径覆盖忽略与失败／未知／最终启动确认竞争；已确认提交的启动上下文拒绝再次发送 stdin。缺少外部身份时的查证、在途启动的迟到证据审计和耐久取消任务未在此切片实现。

重试预留合并不新增表结构，不改变自动退避、重试次数和手动容量覆盖规则。直接手动执行与自动失败重试使用加载到的 Item 快照；终态保持到预留成功才原子变更为 running，版本只增加一次。覆盖同时间戳下的陈旧版本、忽略竞争、手动／自动及双写 worker 竞争、容量／历史投递／旧活跃运行阻塞、写入故障回滚与重启；旧 Run 及原结果保持不变。

试跑与启动时规则绑定不新增表结构。手动允许无规则 open 工单首次绑定，及 failed／done／skipped 工单在无旧活跃运行与未闭合投递时绑定所选规则；已绑定其他规则的 open 工单仍拒绝。过滤规则自动启动只允许 open／failed，保留原退避与容量规则。复用工单的状态、规则、指针与版本只在预留成功时一起变更；原运行的规则、结果与投递证据不变。立即完成的试跑只刷新本次 Run 对应的投递，不借当前工单误发其他尝试。

契约覆盖手动／自动绑定的状态矩阵、无规则工单、同时间戳陈旧快照、所选规则容量、缺失规则、旧活跃运行与未闭合投递阻塞、回滚、重启及双 SQLite writer 不同规则竞争。应用覆盖忽略／其他启动竞争不重开工单、不提前绑定、试跑不取消旧投递，以及调用级 keep-local 义务不受共享覆盖值或重启影响。

启动前配置失败不新增表结构，不经过 running 中间态或外部网络调用。失败尝试明确冻结 `write_back_required=false`；不能用这个端口登记已启动、在途未知或已有外部身份的运行。自动失败只适用于当前已绑定规则；过滤规则尚未绑定时失败返回冲突并记录诊断，不借配置错误绑定规则。手动试跑可显式记录所选规则的校验失败，但保留原规则／状态／当前 Run 和已完成结果。所有获准失败都递增 Item 版本一次，包括同状态的手动失败，避免与相同快照的真正启动同时获准。

内存准备后无 await 提交，SQLite immediate 事务及单写 RPC、PostgreSQL 同连接先锁规则再锁 Item，均覆盖该端口。SQL 返回事务内实际写入的 Item／Run，不用输入快照充作持久化返回值。覆盖同时间戳陈旧快照、忽略竞争、真实启动竞争、历史投递阻塞、复用运行 ID 拒绝、故障全回滚、双 SQLite writer 竞争及重启保持；真实 PostgreSQL 仍须有测试连接方可验收。冲突的人工入口返回 409，自动入口保留原事实并显式记录冲突诊断；不能将配置错误写成远端取消或新运行已成功。

普通忽略不新增表结构，不引入网络调用到数据库事务。内存先准备全部写入再一次提交，SQLite immediate／单写 RPC 与 PostgreSQL 同连接按 Item、当前 Run、按 id 排序的投递锁定后提交；失败全回滚。端口处理本工单全部未闭合投递，不仅当前 Run 的一行：确定未发送的明确放弃，在途／uncertain／已接受的保留状态、请求身份、claim token 和回执，仅增加停止请求。当前 Run 和旧 Run 全部不写入，completed 结果保持冻结；重复命令若仍携带旧快照返回冲突，新加载的重复忽略递增 Item 版本一次，不冒充 command_id 去重。

普通 API 的 `/complete` 仍只是 `/dismiss` 的弃用别名，不是“确认指定结果”；没有实现 acknowledged_run_id 或失败确认。API 当前使用服务端加载快照，只能防止本次读写间的竞争，不能证明客户端点击所指的旧版本；后续必须补齐客户端期望版本、命令身份及审计。普通忽略提交后保留已有最佳努力取消调用，仅对具有外部身份的原运行执行；无钩子、调用失败或调用返回但未确认退出时，Run 保持原状态并阻止重新执行。进程退出后尚不能恢复取消任务；已忽略 Run 的实际完成／取消可由后续身份明确的状态查询记录，未知启动与历史歧义运行仍待查证；辅助系统取消／超时不在此切片范围。

契约覆盖排队／在途投递、保留原 token 的迟到接受回执、当前及历史投递同时停止、完成结果不变、同时间戳旧版本拒绝、无运行工单、手动重试竞争、SQLite 双写 worker 竞争、回滚及重启。应用覆盖陈旧忽略不调用取消、先提交本地再调用远端、取消异常不伪造退出、未闭合投递不折叠和启动在途忽略不发送 stdin。折叠仍为提交后的兼容副作用，不解决新消息／后继运行与折叠的竞态，不宣称全生命周期已原子化。

已忽略运行的实际结果沿原观察事务保存，不新增表结构或投递。必须重新加载 skipped Item 与 Run 完整快照，且 current_run_id、外部执行身份和已确认启动事实一致；忽略发生前在途的旧 Item 观察仍返回 ignored，不把它自动重基到新状态。使用新快照的实际观察只增加 Run 版本，保持 Item／投递完全不变；completed 结果冻结及终态保护不因忽略而放松。真实终态提交后，显式手动重试才可能通过旧活跃运行检查；自动不重试 skipped，未闭合投递仍继续阻塞重跑。

监督轮询从 skipped 工单中只查询当前活跃 Run，不恢复交互优先权、等待订阅、主动追踪、过期 reap 或折叠；结果变化仅发工单更新通知，执行结束后停止轮询。有冻结触发类型和义务的运行不依赖 Recipe 仍存在；历史未知运行仍需原 Recipe，未确认启动及无外部身份的运行不猜测查询目标。此切片不是耐久取消 worker，不补写非当前历史运行，不解决未知启动确认或取消失败的管理面。契约覆盖所有执行状态、陈旧快照／身份拒绝、后继运行隔离、结果冻结、投递不变、故障回滚、重启及双 SQLite writer 互斥；应用覆盖重启轮询、规则删除、无重挂／reap／折叠、真实结束后停止查询和状态查询失败保留原事实。

此阶段仍保留无期望快照的同规则 open 启动兼容调用，以及试跑新建工作单元、采集建单／更新、非启动绑定和辅助系统取消的普通 put 路径；试跑选单与新建尚未纳入对话级锁，不能宣称所有人工命令已完成 CAS。人工命令 command_id／issued_at、去重审计、结果确认引用和对话级写协议仍需后续迁移；本切片不启用最终折叠策略。
