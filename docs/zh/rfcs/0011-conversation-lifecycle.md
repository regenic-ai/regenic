# RFC 0011 — 对话生命周期与策略钩子

- **状态：** Accepted（设计定稿，尚未实现）。
- **日期：** 2026-11-09
- **依赖：** [RFC 0008](0008-thread-surface.md)、[RFC 0009](0009-work-orchestration.md)
- **定位：** 后续实现的产品与架构规格；本次只更新文档，不运行迁移、不修改业务代码。
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
| `work_items` | PK `id`；UNIQUE `(org_id, thread_id, unit_key)` | `id, org_id, thread_id, unit_key, head_event_id, record_class, thread_facet, status, recipe_id, created_at, updated_at` |
| `work_runs` | PK `id` | `id, org_id, work_item_id, recipe_id, executor_type, external_run_id, agent_thread_id, status, start_state, result_json, created_at, updated_at` |
| `work_deliveries` | PK `id`；UNIQUE `(org_id, work_item_id)` | `id, org_id, work_item_id, recipe_id, kind, unit_key, event_id, status, write_back, attempts, last_error, next_retry_at, payload_json, lease_expires_at, idempotency_key, channel_receipt_json, created_at, updated_at` |
| `recipes` | PK `id` | `id, org_id, name, match_json, executor_type, executor_config_json, can_write_back, include_context, enabled, trigger_kind, trigger_interval_ms, trigger_at_minute, trigger_weekdays, trigger_timezone, trigger_coalesce, max_concurrent, next_run_at, created_at, updated_at` |

现有状态值：

- WorkItem：`open / running / waiting_human / done / failed / skipped`。
- WorkRun：`running / waiting_human / completed / failed / cancelled`；`start_state` 为 NULL 或 `pending / submitted / uncertain`。
- WorkDelivery：`queued / running / write_back / acked / dead`；write_back 为 `pending / sent / skipped / failed`。
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

当前 `work_runs.work_item_id` 和 `work_deliveries.work_item_id` 引用 WorkItem；`head_event_id` 引用消息 Event。对话通过 `(org_id, thread_id)` 逻辑关联，没有独立 Conversation 表。当前 Recipe 域类型中的固定回写目标不能假定已持久化：实施必须补齐规则保存、读取、导入导出及两种数据库映射。

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
| `work_deliveries` | `version` | 非负整数，NOT NULL DEFAULT 0；行 CAS，不作为投递身份 |
| `work_deliveries` | `run_id` | 可空，历史未知保留 NULL；新执行结果投递必填 |
| `work_deliveries` | `target_json` | 可空 JSON；新投递必填，从 Run 快照复制，不跟随 Recipe 后续编辑 |
| `work_deliveries` | `lease_owner, claim_token` | 可空 TEXT；每次认领生成新 token |
| `work_deliveries` | `cancel_requested_at` | 可空 timestamp；停止新发送／重试，不代表已经撤销在途请求 |
| `message_dispositions` | `version` | 非负整数，NOT NULL DEFAULT 0；实际编排字段变化递增，不按重复扫描递增 |
| `recipes` | `write_back_thread_id` | 可空 TEXT；补齐现有域字段的持久化，沿用既有对话身份格式 |

`current_run_id / acknowledged_run_id` 必须属于同一个 org 和 WorkItem。新关联采用同租户物理 FK：相关业务表增加 UNIQUE `(org_id, id)`，配合复合 FK；WorkItem 与 Run 循环关联通过可空指针及一个事务中的插入／更新建立。所属工单一致性还必须由原子端口校验。

WorkRun 的投递快照在外部启动前冻结；试跑关闭投递时明确写 false。执行器观察不能改写这份快照。发送前仍须检查当前授权和安装可用性，快照不是永久发送许可。无权限时显式失败，不换目标或静默跳过。

进入 completed 后冻结用于确认／投递的结果；不同结果必须来自新的显式尝试。补充非结果元数据可以增加行版本，但不能更改已确认内容或产生第二次完成。

### 6.2 投递账本改为按运行保留

移除 UNIQUE `(org_id, work_item_id)`；新建唯一索引 `(org_id, run_id)`，条件 `run_id IS NOT NULL`。每次运行最多创建一条结果投递，旧运行的记录不覆盖、不借用。增加 `(org_id, work_item_id, created_at, id)` 查询索引。

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
