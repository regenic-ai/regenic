# 执行器

执行器是进程内插件。它接下内核开出的工单，在本机连接器或外部 HTTP
上跑一轮，再把 `WaitStatus` 交回内核。

本文说明执行器 API 与安装协议。类型定义在 `@regenic/domain`。分层见
[消息编排](MESSAGE_ORCHESTRATION.md) 与 [RFC 0009](rfcs/0009-work-orchestration.md)。

本页给实现或安装执行器的人看。

- **English:** [../en/EXECUTOR.md](../en/EXECUTOR.md)
- **相关：** [连接器](CONNECTOR.md) · [消息编排](MESSAGE_ORCHESTRATION.md) ·
  [桌面端](DESKTOP.md) · [RFC 0009](rfcs/0009-work-orchestration.md)
- **状态：** Phase 1

## 执行器是什么

内核只认 `TaskExecutor` 端口。它不读 `Recipe.executor_config` 的 key，
不按连接器名分支，默认开源树不 import 私有 HTTP。

连接器 ≠ 执行器。连接器停在 L0：翻译一条渠道的 wire，并可申明
`unit_kind` 词表。执行器是 L6：跑工单。不同类型的工单用不同 Recipe
（或同一执行器、不同的不透明 `executor_config`）分流，不在连接器里选
执行器。同一插件包可以同时挂 `ChannelDriver` 和 `TaskExecutor`
（DSH 已如此）。换执行器 = 换安装（或换插件）+ Recipe 选择。

能力写在安装和 `catalog()` 上。内核不按驱动名推断。

## 接口

| 接口 | 职责 |
| --- | --- |
| `TaskExecutor` | `start` / `resume` / `status`，并声明调用目录 |
| `ExecutorContext` | 碰渠道只走这里：`spawnSysout` / `writeStdin` / `listPrompts` / `readTranscript` |
| `ExecutorInstallation` | 引擎页上的一等安装，和连接器并列 |

```ts
interface TaskExecutor {
  readonly executor_type: string;
  capabilities(): { start: boolean; resume: boolean; status: boolean; prompts?: boolean; wait?: boolean };
  catalog(): ExecutorCatalogEntry;
  start(input, ctx): Promise<ExecutorRunHandle>;
  resume(input, ctx): Promise<ExecutorRunHandle>;
  status(run, ctx): Promise<ExecutorRunHandle>;
  cancel?(run: WorkRun, ctx: ExecutorContext): Promise<void>;
}
```

`cancel` 为可选方法，本机连接器绑定会原样转发运行记录和上下文。
dismiss 尽力调用它，取消失败不会撤销账本中的移除操作。
执行器取消没有 `AbortSignal`；插件必须按运行身份精确取消，并保证重复或并发清理安全。

`@regenic/connector-contract` 的 `0.3.0` 候选版新增
`ExecutorContext.readonly installation_id?: string`。host 在固定安装的本机执行器
start/resume/status/cancel 上一致填写该绑定；未固定安装及 HTTP 执行器省略。
它不是 recipe 配置：`executor_config` 仍不透明、原样传递。直接执行 Agent 的插件必须
要求此绑定，用它选择 `ctx.org_id` 内启用的安装；resume/status/cancel 前须校验持久化
运行所属的 org 与安装，不能按 recipe 安装 key 路由或从执行器名称推断归属。
上下文不增加配置、凭证或 activation generation；现有 DSH 式执行器仍可只使用
`spawnSysout`，无需读取新字段。候选版本及本地包不代表已经发布到 npm。
静态插件的 `catalog().source` 只选择插件，不选择安装；须在引擎页安装一个
固定连接器安装的 `local_connector` 执行器，才能获得 host 绑定。
默认未固定安装的执行器即使 source 匹配也不提供绑定。

固定安装且驱动实现 `stopInstallation` 的本机执行器共用该安装的准入和排空门禁。
`start`、`resume` 按 activation 启动一次；`status` 受门禁保护但不主动启动资源。
被阻断后仍可通过 `cancel` 清理，且不会启动资源；旧 activation 的句柄不能调用或取消
新 activation。删除固定连接器后，重挂载会将其执行器移出目录。

`start` 必须尽快返回运行句柄，不能等待整个 Agent 任务结束；后续由 `status` 观察运行。
安装停止先排空已准入调用，再调用 `stopInstallation`（上下文含 `reason`、`signal`）。
不合作的启动调用可能耗尽有界排空时间；此时仍尝试清理，但停止操作会明确失败并保持门禁。
只有安装停止 hook 接收清理 signal，执行器契约不能中断正在执行的调用。

## 要求

每个执行器必须：

- 用 `catalog()` 声明执行器专属的调用参数。公共任务说明始终单独配置，
  不属于调用参数字段。
- 经 `ExecutorContext` 碰渠道。本机绑定不得自带私有 HTTP 客户端。
- 完成协议是 `WaitStatus`（wait / notify）。气泡里的字不是退出。
- 从环境变量读凭证，或从一个指向环境变量的名字读。安装表单不收 token。
- 故障彼此隔离。一个安装不得拖住另一个。

不允许：

- 把私有运行时 import 进 `@regenic/domain` 或默认桌面。
- 内核或桌面写 `if (executor_type === "dsh")` 或按连接器名分类。
- 把 token 存进 `config`，或从 `/v1/me` 返回。
- 把 dismiss 当成 `exited`，或在未真退出时写回原渠道。
- 在规则页按执行器名特判调用参数。

## 安装种类

引擎页的执行器和连接器分开管。`GET /v1/me/engine` 的 `executor_catalog`
声明种类、字段和本文档。桌面只渲染目录，不按种类写死表单。

| `kind` | 含义 | 运行时 |
| --- | --- | --- |
| `local_connector` | 固定能 `create` 或明确声明 `execute` 的已装连接器 | 会话执行器用 `spawnSysout`；直接执行器用 host context 绑定。未固定安装时按 `catalog.source` 找第一个能建会话的连接器，但不能绑定直接执行运行时 |
| `http` | 通用 HTTP 适配器 | `POST {base}/v1/runs`、`GET /v1/runs/:id`、`POST /v1/runs/:id/resume` |

凭证只存环境变量名 `auth_env`。表单不收 token。

升级后若还没有执行器记录，内核写入一条 id 为 `dsh` 的本机绑定，旧
Recipe 的 `executor_type: "dsh"` 不用改。`GET /v1/me/executors` 只列出
**已启用**安装的调用目录。

填了 `session_id` 的 DSH 安装 `create: false`，不能当本机执行器。

### 创建固定的本机绑定

先在引擎页安装并启用连接器，再进入「执行器 → 本机连接器 → 安装」，
在「连接器」下拉中选择该安装，可选填写名称后安装。下拉选项来自
`GET /v1/me/engine` 的 `executor_catalog` 中 `local_connector` 项的
`fields[key=installation_id].options`。

等价 API 为 `POST /v1/me/executors`：

```json
{
  "kind": "local_connector",
  "name": "My agent",
  "config": { "installation_id": "<connector installation id>" }
}
```

将返回的执行器 `id` 设为规则的 `executor_type`，不是静态插件 source。
`GET /v1/me/executors` 列出已挂载调用目录，其中固定执行器的 `installation_id`
就是上述连接器安装 ID。host 从此目录填写 context 绑定，不从 recipe 配置读取；
直接执行插件必须拒绝缺少 host pin 的调用，不能自动选第一个安装。

安装 API、下拉与重挂载使用同一准入检查；能 `create` 的会话连接器保留原路径。
直接执行驱动则对启用且允许执行的安装声明 `ChannelCapabilities.execute: true`。
host 还要求已注册执行器的 `catalog().source` 与安装驱动的 `source` 一致，
且执行器 `capabilities().start` 为 true。安装缺失或禁用、驱动或执行器缺失、
source 不匹配、关闭直接执行时均拒绝安装或从重挂载目录移除，不回落到其他插件。
这些元数据检查不会启动 Agent；直接执行运行时不需要 `createThread` 或渠道发送能力，
也不能为出现在下拉中虚报 `create`。

## 持久化启动与恢复

内核在调用 `TaskExecutor.start` 前，原子创建 `start_state: pending` 的
WorkRun，同时把开放的 WorkItem 标记为运行中并占用自动执行名额。
多个进程不能同时认领同一个工单。`input.run_id` 是提前落盘的运行 ID。

本机会话执行器通过 `spawnSysout` 创建会话后，先保存会话 ID，再允许
`writeStdin` 发送任务。stdin 确认成功后保存 `start_state: submitted`；
若最终收尾中断，监督器通过 `status` 恢复已有会话，不重新创建会话或发送任务。
执行器返回的句柄也会在应用结果之前落盘。正常收尾后清除 `start_state`。

启动中断留下的 `pending`，或调用异常留下的 `uncertain`，都不能当作确定失败。
异常尝试转为等待人工核对，不会被自动重试、恢复输入或判定完成；
手动运行、恢复接口返回 `execution_start_uncertain`（409）。
请先核对外部会话或远端运行记录，再移除本次尝试并明确开始新一次。
已记录提交但启动收尾中断时返回 `execution_recovery_pending`（503），
刷新即可恢复已有执行；并发手动启动返回 `execution_start_conflict`（409）。
创建会话后、首次会话 ID 落盘前宕机，仍可能留下空闲孤立会话，
但持久化认领会阻止重复提交任务。数据库与执行器之间不承诺端到端 exactly-once。

## HTTP 协议

远端执行器实现这三条。内核把 `executor_config` 原样转交，不读 key。

| 方法 | 路径 | 请求 | 成功响应 |
| --- | --- | --- | --- |
| POST | `/v1/runs` | `run_id`、`work_item_id`、`thread_id`、`recipe_id`、`task_instruction`、`evidence_text`、`executor_config` | `external_run_id`、`status`，可选 `agent_thread_id` / `prompts` / `result` |
| GET | `/v1/runs/:id` | — | 同上 |
| POST | `/v1/runs/:id/resume` | `work_item_id`、`recipe_id`、`answer` | 同上 |

以下旧版降级说明保留用于升级对照；当前版本的错误处理规则见后文：

`status` 只能是 `running` / `waiting_human` / `completed` / `failed` /
`cancelled`。缺省或未知值按 `failed`，避免工单一直挂着。Bearer token
来自安装声明的环境变量名（`[A-Za-z_][A-Za-z0-9_]*`）。云 metadata
地址不能当 `base_url`。

当前版本不再把协议错误伪造成失败运行：缺省或未知状态、无效 JSON、
非 2xx 响应及网络异常均明确抛错。启动时保留不确定尝试，
状态轮询时保留已有运行，不转成可自动重试的失败。
监督器按运行记录轮询错误，并继续处理其他运行；异常运行保留已落盘状态，
下一轮再次轮询。内核关闭仍会中止本轮监督。
启动请求在正文传递 `run_id`，并用相同值设置 `Idempotency-Key` 请求头。
远端可以据此去重或查询；内核不假定远端具备去重能力，也不重试不确定启动。

## 调用目录

规则页的「调用参数」不是内核字段。每个已启用安装的
`TaskExecutor.catalog()` 声明自己的表。桌面只渲染
`GET /v1/me/executors`。

```ts
interface ExecutorCatalogEntry {
  executor_type: string;
  label: string;
  description?: string;
  params_label?: string;
  source?: string;
  attach?: AttachMode;
  installation_id?: string;
  kind?: "local_connector" | "http";
  fields: ExecutorCatalogField[];
}
```

规则页始终提供公共任务说明，保存在现有 `executor_config.prompt` 中，
并作为 `task_instruction` 传给 `TaskExecutor.start`。为兼容旧配置，
`prompt` 缺失时会读取 `executor_config.instruction`；不会自动改写已保存的规则。
新建规则必须有非空说明；没有说明的历史规则仍可编辑和执行。执行器专属参数仍由
`catalog().fields` 声明；DSH 在此提供可选 `skill`。本机执行器应使用
`input.task_instruction`；HTTP 适配器会将同名值放在请求顶层，同时原样转发
原有 `executor_config`。

## 目录

`GET /v1/me/engine` 返回 `executor_catalog`。引擎页在 Install 时用弹窗
渲染这些字段。新种类在那里加一条。

| 字段 | 说明 |
| --- | --- |
| `fields` | `key`、`label`、是否必填、占位、`hint`、可选 `options` |
| `docs` | 研发规范。引擎页在「执行器」标题旁统一渲染一次，点开跳到 GitHub 网页 |

token 是前置条件，不是表单字段。

## 完成与写回

公开 DSH 的 absentee notify 是 mux `session/event` 里的 `turn/end`（未闭合的
`turn/start` 或 `working` 仍是 running），或 session 已不在。声明
`capabilities().wait` 的执行器在 `start()` 后由内核订阅
`ChannelDriver.waitThread`；同一回调 follow 该 sysout 入库再 reap。
`session.history` poll 只做漏帧、冷启动和 CLI。内核在
`exited` 上 reap Job。写回只发生在这次真退出，且 Recipe
`can_write_back` 为真。内核把结果第一行与活的待办选项做精确匹配。
别名来自 `ChannelDriver.writeBackLabels`，不写在宿主名单里。

人不想跟的 Job 走 `POST /v1/me/work-items/:id/dismiss`。Dismiss 不是
`exited`，也不写回。被拿掉的 Inferior 记 `cancelled`。之后的 status
tick 不得把这次 run 救活。

人只回答 Prompt，走 `POST /v1/me/conversations/prompts`，禁止再走 egress。

## 范围外

- 在本系统实现 DAG / Skill 图 / 模型路由
- 把私有 Agent OS 写进默认开源树
- 团队项目集、冲刺、多人指派
