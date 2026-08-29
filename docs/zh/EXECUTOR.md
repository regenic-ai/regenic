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
  capabilities(): { start: boolean; resume: boolean; status: boolean; prompts?: boolean };
  catalog(): ExecutorCatalogEntry;
  start(input, ctx): Promise<ExecutorRunHandle>;
  resume(input, ctx): Promise<ExecutorRunHandle>;
  status(run, ctx): Promise<ExecutorRunHandle>;
}
```

## 要求

每个执行器必须：

- 实现 `catalog()`。规则页只渲染这些字段。内核把 `executor_config` 当不透明袋。
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
| `local_connector` | 钉在一条能 `create` 的已装连接器上 | `spawnSysout` 走该安装。未钉时按 `catalog.source` 找第一个能建会话的连接器 |
| `http` | 通用 HTTP 适配器 | `POST {base}/v1/runs`、`GET /v1/runs/:id`、`POST /v1/runs/:id/resume` |

凭证只存环境变量名 `auth_env`。表单不收 token。

升级后若还没有执行器记录，内核写入一条 id 为 `dsh` 的本机绑定，旧
Recipe 的 `executor_type: "dsh"` 不用改。`GET /v1/me/executors` 只列出
**已启用**安装的调用目录。

填了 `session_id` 的 DSH 安装 `create: false`，不能当本机执行器。

## HTTP 协议

远端执行器实现这三条。内核把 `executor_config` 原样转交，不读 key。

| 方法 | 路径 | 请求 | 成功响应 |
| --- | --- | --- | --- |
| POST | `/v1/runs` | `work_item_id`、`thread_id`、`recipe_id`、`evidence_text`、`executor_config` | `external_run_id`、`status`，可选 `agent_thread_id` / `prompts` / `result` |
| GET | `/v1/runs/:id` | — | 同上 |
| POST | `/v1/runs/:id/resume` | `work_item_id`、`recipe_id`、`answer` | 同上 |

`status` 只能是 `running` / `waiting_human` / `completed` / `failed` /
`cancelled`。缺省或未知值按 `failed`，避免工单一直挂着。Bearer token
来自安装声明的环境变量名（`[A-Za-z_][A-Za-z0-9_]*`）。云 metadata
地址不能当 `base_url`。

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

拼 stdin / HTTP / Agent 目标是插件自己的事。DSH 用 `skill` / `prompt`。
Cursor 与私有 Agent OS 各自声明字段。旧 DSH 配方里的 `instruction`
只在 DSH 插件内映射为 `prompt`。

## 目录

`GET /v1/me/engine` 返回 `executor_catalog`。引擎页在 Install 时用弹窗
渲染这些字段。新种类在那里加一条。

| 字段 | 说明 |
| --- | --- |
| `fields` | `key`、`label`、是否必填、占位、`hint`、可选 `options` |
| `docs` | 研发规范。引擎页在「执行器」标题旁统一渲染一次，点开跳到 GitHub 网页 |

token 是前置条件，不是表单字段。

## 完成与写回

公开 DSH 的 absentee notify 是日志里的 `turn/end`（未闭合的
`turn/start` 或 `working` 仍是 running），或 session 已不在。内核在
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
