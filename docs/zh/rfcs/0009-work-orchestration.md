# RFC 0009 — 记录类、线程面与托管执行

- **状态：** Accepted
- **English:** [../../en/rfcs/0009-work-orchestration.md](../../en/rfcs/0009-work-orchestration.md)
- **依赖：** RFC 0004、RFC 0005、RFC 0008、连接器合同
- **相关：** [消息编排](../MESSAGE_ORCHESTRATION.md) · [连接器](../CONNECTOR.md) · [执行器](../EXECUTOR.md) · [桌面端](../DESKTOP.md)

## 1. 问题

个人控制台要接入 N 个渠道，并在「普通消息 / Agent 消息 / 工单」上做托管处理。若把人聊或 Agent 标在**连接器安装**上，一个飞书安装里的群聊、机器人和审批会互相踩踏，最终退化成按渠道名分支。

执行引擎（DSH、Cursor、内部 Agent OS）也不能焊进内核：公开构建不得依赖私有项目。

## 2. 目标

1. 分类落在**记录**和**内核投影**上，不落在连接器安装。
2. 连接器只翻译到封闭 `record_class`；未知原生类型隔离，不得默默当成 `message`。
3. `WorkItem` 由策略从记录/线程投影，不是第三种消息。
4. 执行走 `TaskExecutor` 插件。内核只认端口，不 import 私有 HTTP。
5. 列表成员仍是当前工作；排序可在 `attention` 与置顶 + 最近活动之间切换。

## 3. 非目标

- 在本系统实现 DAG / Skill 图 / 模型路由。
- 把私有 Agent OS 写进默认开源树。
- 团队 Jira：项目集、冲刺、多人指派。
- 改 `IngestBatch` schema_version。

## 4. 分层

含义从 wire 上按固定步骤剥下来。L0 只懂一种协议。L2 是 N 个渠道的共同点。L5 可有可无。L6 是插件。

```text
L0 协议插件     ChannelConnector / ChannelDriver / Egress
                只懂飞书 / Slack / CRM / DSH 的 wire
L1 信封         IngestRecord
                身份、时间、作者、正文、幂等
L2 记录类       utterance | task | status | prompt
                N 渠道的共同点
L3 发言者       仅 utterance：kind + direction
                user | assistant | system
L4 线程面       chat | agent | ticket
                内核投影；记录可提示，安装不可当 lane
L5 处理         策略才开 WorkItem（可有可无）
L6 执行         TaskExecutor 插件
                DSH / Cursor / 内部；内核只认端口
```

三层测试互不 import 渠道名：连接器锁 L1/L2，内核锁 L4/L5，执行器锁 L6。

| 层 | 负责 | 禁止 |
| --- | --- | --- |
| L0 | 原生 API、凭证、流游标、wire 类型 | 写 Event / Blob；把**安装**标成人聊或 Agent |
| L1 | `source` + `external_id`、`occurred_at`、作者、正文、内容哈希 | 把渠道原生 id（`om_`、`rpcId`）送进内核 |
| L2 | 由 `IngestRecord.type` 映射的封闭 `record_class` | 未知原生类型默默当成 `message` |
| L3 | 仅 `utterance` 上的 `kind` / `direction` | 把 `task` / `status` / `prompt` 当成发言者 |
| L4 | 由 task 头、`await_reply` / prompts 或 hint 投影 `thread_facet` | 内核或桌面写 `if (source === "dsh")` |
| L5 | `task` 或 Recipe 命中时开/更新 WorkItem | 第三种消息；绑定的执行会话再占一行 |
| L6 | 经 `ExecutorContext` 做 `start` / `resume` / `status` | 把私有运行时 import 进 `@regenic/domain` 或默认桌面 |

同一飞书安装上的三条原生事实：

| 原生事实 | L2 | L3 | L4 | L5 | L6 |
| --- | --- | --- | --- | --- | --- |
| 单聊里的人 | `utterance` | `user` | `chat` | 无，除非 Recipe 命中 | — |
| 群里的机器人 | `utterance` | `assistant` | `chat` | 无 | — |
| 审批 / 工作单元 | `task` | — | `ticket` | WorkItem | Recipe 允许则走执行器 |

Agent 与状态：

| 原生事实 | L2 | L3 | L4 | L5 | L6 |
| --- | --- | --- | --- | --- | --- |
| DSH 用户回合 | `utterance` | `user` | `agent` | 可选 Recipe | Recipe 指定则 `dsh` |
| DSH `working` | `status` | — | 不进列表脸 | 更新已绑定 Run | — |
| mux / 活问题 | `prompt`（不入库为 Event） | — | `agent` | `waiting_human` | 答完 `POST /v1/me/conversations/prompts` 再 resume |

`assistant` 发言和 `thread_status` **不得一律** `current_work`。列表成员仍是当前工作。WorkItem 是这条线程上的额外处理，不是另一行 inbox。

## 5. 记录类

```ts
type RecordClass = "utterance" | "task" | "status" | "prompt";
```

| 值 | 含义 | 入库 |
| --- | --- | --- |
| `utterance` | 有人说了一句（人话或助手话） | Event |
| `task` | 带生命周期的工作单元 | Event |
| `status` | 对端不可见劳动 / `working` | Event（不进列表脸） |
| `prompt` | 活的待决决策 | 不入库（RFC 0008） |

从现有 `IngestRecord.type` 映射：`task` → `task`；`thread_status` → `status`；`prompt` → `prompt`；`message` / `thread_reply` / 缺省 → `utterance`。未知原生类型不映射成 utterance，也不开 WorkItem。连接器可在 surface 上提示 `thread_facet`，不得把安装标成一种 lane。

`match` 全空的 Recipe 不命中任何主体。至少要有 `thread_id`、`source`、`record_class`、`thread_facet` 之一。

## 6. 发言者

发言者是 `kind` 加 `direction`，**只作用于 `utterance`**：

| `kind` | 含义 |
| --- | --- |
| `user` | 人（包括 Agent 会话里的用户） |
| `assistant` | 机器人或模型回合 |
| `system` | 运行时注入，不是聊天气泡 |

人群里的机器人是 `chat` 线程上的 `utterance + assistant`。Agent 会话里的人是 `agent` 线程上的 `utterance + user`。这两件事不得收成「这个连接器是 Agent」。

## 7. 线程面

```ts
type ThreadFacet = "chat" | "agent" | "ticket";
```

内核按记录投影（连接器可提示，不可当安装属性）：

1. `record_class = task` → `ticket`
2. 否则记录带 hint → 用 hint
3. 否则该头上有**活的** prompts → `agent`
4. 否则 → `chat`

`await_reply` / `list_title` / `hydrate_on_open` / `attention` / `receipts` 仍是协议能力（RFC 0008），不是 facet。能力不是类型。

## 8. WorkItem / Recipe / Run

```ts
type WorkItemStatus =
  | "open" | "running" | "waiting_human" | "done" | "failed" | "skipped";

interface Recipe {
  id: string;
  org_id: string;
  name: string;
  match: {
    record_class?: RecordClass;
    thread_facet?: ThreadFacet;
    source?: string;
    thread_id?: string;
  };
  trigger: {
    kind: "push" | "pull" | "manual";
    interval_ms?: number;
    coalesce?: boolean;
  };
  executor_type: string;
  executor_config: Record<string, unknown>;
  can_write_back: boolean;
  include_context: boolean;
  enabled: boolean;
}

interface ResultEnvelope {
  summary: string;
  content?: ContentPart[];
  evidence_event_ids?: string[];
}
```

身份拆成三个对象（POSIX session / job / inferior）：

| 对象 | 是什么 | 不是什么 |
| --- | --- | --- |
| Session | 来源对话，列表脸 | 工单主键 |
| Job (`WorkItem`) | 一个工作单元，`unit_key` | 一条线程一辈子一张单 |
| Inferior (`WorkRun`) | 一次执行；sysout 默认不进列表 | 用户自己开的 Agent 闲聊 |

`match` 必须具体（`thread_id`，或 `record_class=task`，或 `source` + 非 utterance 的 class）。空 match、只写 source、只写 utterance、只写 facet 不能保存。

`trigger` 是一等字段，和 match 分开：

| `kind` | 何时开跑 | `unit_key` | 证据 |
|---|---|---|---|
| `push` | 已入库的入站 user 消息/工单 | `event_id` | 触发消息；`include_context` 可选 |
| `pull` | 时钟到期；必须有 `thread_id` + `interval_ms` | `pull:{recipe_id}:{next_run_at}` | 会话上下文是主输入；默认回写 |
| `manual` | 只在当前工作点「开始执行」 | 与 push 相同 | 同 push |

Push 合同：outbound / assistant / 本规则写回不触发；`(recipe, event)` 幂等；`coalesce` 默认真：running 时不改 `head_event_id`，结束后用最新头再开一轮。`coalesce=false` 时，活跃 Job 遇到新头立刻开新 Job。执行失败留在 `WorkItem.failed`，按 30s / 2min / 8min 最多重试 3 次（计次是 `WorkRun`）。连接器丢消息是 L0 的事。Manual 规则可以绑到对得上的 Job，但不 `start`。

Pull 合同：独立于连接器 pull。`next_run_at` 持久化，休眠醒来仍认账。上一 occurrence 还在跑则跳过。到期只补跑一轮，然后把 `next_run_at` 跳到未来。内核仍不读 `executor_config` 的 key。

投递账本只负责 egress，不负责开跑。Job 完成且需要回写时入队，快照写进 `payload`，并记下稳定 `idempotency_key`。Tick 认 `queued` 和到期的 `failed`；`write_back` 带 60s 租约，超时回 `queued`。渠道发送限 45s，超时不标失败，留下租约。发送成功立刻记下 `channel_receipt`，崩溃后跳过重发、只补 ingest。`applyHandle` 只入队，不在同一趟 `await` 发送。开跑、盯执行、刷投递三路 tick 各持一把锁，egress 卡住不得停采集或 Pull。`acked` / `dead` 只表示有没有发回渠道。Dismiss 把未闭合的账本标 `acked/skipped`。空正文不得当成成功跳过。桌面 `attention` 以内核脸为准：`waiting_you` / `needs_ack` / `running` 压过本地 unread。

同一 Session 上已完成的 Job 遇到新 `head_event_id` 开**新 Job**，不复活旧单。列表脸取当前前台 Job。

没有 `can_write_back` 不得 egress（Pull 默认开）。蒸馏或看过 Digest ≠ 发送权。

`include_context` 为真或 `trigger.kind=pull` 时，开跑只取来源会话最近一页可见历史写入 evidence（条数和字数封顶，多出来的标 omitted），禁止把几千上万条整段拉进内核或执行器。Push 默认只带触发/头消息。这是内核证据策略，不是 `executor_config` 的 key。

## 9. TaskExecutor

```ts
interface TaskExecutor {
  readonly executor_type: string;
  capabilities(): { start: boolean; resume: boolean; status: boolean; prompts?: boolean };
  catalog(): ExecutorCatalogEntry;
  start(input, ctx): Promise<ExecutorRunHandle>;
  resume(input, ctx): Promise<ExecutorRunHandle>;
  status(run, ctx): Promise<ExecutorRunHandle>;
}
```

内核查 `ctx.executors`。执行器碰渠道只走 `ExecutorContext`（`spawnSysout` / `writeStdin` / `listPrompts` / `readTranscript`），不自带私有 HTTP 客户端。

完成契约是 `WaitStatus`（wait / notify）。气泡里的字不是退出。公开 DSH 的 absentee notify 是日志里的 `turn/end`（未闭合的 `turn/start` 或 `working` 仍是 running），或 session 已不在。内核在 `exited` 上 reap Job。写回只发生在这次真退出。内核把结果第一行与活的待办选项做精确匹配。别名来自 `ChannelDriver.writeBackLabels`，不写在宿主名单里。人只回答 Prompt；不想跟的 Job 走 `POST /v1/me/work-items/:id/dismiss` 从当前工作拿掉。Dismiss 不是 `exited`，也不写回。被拿掉的 Inferior 记 `cancelled`，不是 `failed`。之后的 status tick 不得把这次 run 救活，也不得写回。

公开默认：可管理的 `dsh` 本机绑定（种子 id 仍是 `dsh`，旧 Recipe 不用改）。本机 L6 插件按 `catalog.source` 注册，不在挂载路径写 `if (source === "dsh")`。Cursor 与私有 Agent OS（如 bioby-agent）后接，同一目录合同。私有运行时只作内部插件包，或经通用 HTTP 执行器调用；默认开源构建不 import 私有 HTTP。

执行器是一等安装，和连接器并列：

| `kind` | 含义 |
| --- | --- |
| `local_connector` | 钉在一条能 `create` 的连接器安装上；`spawnSysout` 走该安装。未钉时仍按 `catalog.source` 找第一个能建会话的连接器 |
| `http` | 通用 HTTP 适配器。`POST {base}/v1/runs`、`GET /v1/runs/:id`、`POST /v1/runs/:id/resume`。凭证只读环境变量名 |

换执行器 = 换安装（或换插件）+ Recipe 选择。`GET /v1/me/executors` 只列出已启用安装的 `catalog()`。内核仍不读 `executor_config` 的 key，也不按连接器名分类。

### 调用目录

规则页的「调用参数」不是内核字段，也不是固定 Prompt 框。每个 `TaskExecutor.catalog()` 声明自己的表；桌面只渲染 `GET /v1/me/executors`，内核把 `Recipe.executor_config` 当不透明袋，**不读 key**。换执行器 = 换插件 + 换字段表，禁止 `if (executor_type === "dsh")`。

```ts
interface ExecutorCatalogField {
  key: string;
  label: string;
  required?: boolean;
  placeholder?: string;
  default?: string;
  hint?: string;
  kind?: "text" | "textarea" | "select";
  options?: Array<{ value: string; label: string }>;
}

interface ExecutorCatalogEntry {
  executor_type: string;
  label: string;
  description?: string;
  params_label?: string;
  source?: string;
  attach?: AttachMode;
  fields: ExecutorCatalogField[];
}
```

拼 stdin / HTTP / Agent 目标是插件自己的事。DSH 用 `skill` / `prompt`；Cursor、bioby-agent 各自声明 repo、模型、目标或约束。旧 DSH 配方里的 `instruction` 只在 DSH 插件内映射为 `prompt`。

连接器 ≠ 执行器。同一插件包可以同时挂 L0 `ChannelDriver` 和 L6 `TaskExecutor`（DSH 已如此：Engine 装渠道，执行器安装再绑这条渠道或走 HTTP）。额外包走 `REGENIC_PLUGIN_DIR` / `REGENIC_CHANNEL_PLUGIN` 进程内加载，内核不 import 包名。出进程只走通用 HTTP 执行器，不另起 extension host。bioby-agent 按同样方式接入，不把私有 HTTP 写进内核或规则页。

挂起映射为渠道无关 Prompt，走 `POST /v1/me/conversations/prompts`，禁止再走 egress。绑定 inferior 上的 Prompt 装饰到来源 Session 那一行。

## 10. 列表

默认成员仍是当前工作，外加状态为 `open` / `running` / `waiting_human` 的工单线程。

排序可切换，选择写入 `ui_prefs.inbox_sort`：

- `normal`：置顶 → 最近活动
- `attention`：`waiting_you` → `needs_ack` → `running` → `unread` → `quiet`；同档再按时间。`running` 不因 status tick 重排，不点未读。

桌面读 `record_class`、`thread_facet`、`attention`、`work`（含 `work.delivery`）。规则页先问何时跑（有新消息 / 定时 / 仅手动），再选范围与执行器。Push 与 Pull 自动开跑；「开始执行」留给手动、失败重试、立刻跑一轮；回写失败或死信时同一按钮表示重试投递。人不想跟的 Job 可以 dismiss，不要 Mark done。不按连接器名判断人聊 / Agent / 工单。

## 11. 个人 API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/v1/me/inbox` | 另带 `record_class`、`thread_facet`、`attention`、`work` |
| GET/POST | `/v1/me/recipes` | 列出 / 创建 |
| POST | `/v1/me/recipes/:id` | 更新 |
| DELETE | `/v1/me/recipes/:id` | 删除 |
| GET | `/v1/me/executors` | 已启用执行器目录 |
| POST | `/v1/me/executors` | 安装 `local_connector` 或 `http` |
| POST | `/v1/me/executors/:id/config` | 改名称或绑定 |
| DELETE | `/v1/me/executors/:id` | 卸载 |
| POST | `/v1/me/executors/:id/enable` | 启用 |
| POST | `/v1/me/executors/:id/disable` | 停用 |
| POST | `/v1/me/work-items/:id/run` | 手动启动 |
| POST | `/v1/me/work-items/:id/dismiss` | 从当前工作拿掉；不写回 |
| POST | `/v1/me/work-items/:id/complete` | dismiss 的别名；不冒充 `exited` |
| GET/POST | `/v1/me/prefs` | `inbox_sort` |

## 12. 验收

1. 内核与桌面不按连接器名判断人聊 / Agent / 工单。
2. 默认开源构建没有私有 Agent 依赖。
3. 换执行器 = 换插件 + Recipe 选择，不改内核。规则页调用参数只来自 `catalog().fields`，不按 key 特判。
4. 列表能在 Attention 与正常排序之间切换，刷新后保持。
5. 一条来源任务在列表里是一行；机器进度画在这行上。
6. 连接器测试可以点名飞书或 DSH；内核的 L4/L5/L6 测试不可以。
7. 需要回写的 Job 入队时带 payload 快照；发出或明确跳过才 `acked`；租约超时会回到队列；三次发送失败进死信并在列表可见。执行失败不计进投递账本。
