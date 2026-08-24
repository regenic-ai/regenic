# RFC 0008 — Thread Surface

- **状态：** Accepted
- **English:** [../../en/rfcs/0008-thread-surface.md](../../en/rfcs/0008-thread-surface.md)
- **依赖：** RFC 0004（人机对称 API）、连接器合同
- **相关：** [连接器](../CONNECTOR.md) · [消息编排](../MESSAGE_ORCHESTRATION.md) · [桌面端](../DESKTOP.md)

## 1. 问题

渠道会在消息 Event 之外卡住人或标记注意力：

- 会话 Agent（如 DSH）用控制面提问或审批。待决项**不进 history**，`session.prompt` 解不开已暂停的 tool call。
- 聊天渠道（如飞书）有已读未读。这不是一条消息，也不该入库为 Event。

若把这些写进内核或桌面的渠道分支，加来源就要改产品。若把待决决策当成 Event，会在对端已经答完后留下过期卡片。

## 2. 目标

1. 在连接器端口上增加渠道无关的 **Thread Surface**：`prompts`（人工干预）与 `attention`（已读未读）。
2. 内核与桌面只读声明，不按 `dsh` / `feishu` 分支。
3. Prompt **不入库为 Event**。Attention 的本地游标进 `conversation_prefs`；来源覆盖由驱动可选提供。
4. PC 端能回答对端的提问/审批，而不必打开原渠道 UI。

## 3. 非目标

- 权限预设、slash 命令、渠道设置页。
- 把 prompt 写成 `IngestRecord` 或新 Event 类型。
- 假装每个聊天 OpenAPI 都有会话未读计数。
- CLI 运输上的远程 DSH 答题（没有 mux）。

## 4. 不变量

| 面 | 权威 | 寿命 |
| --- | --- | --- |
| Event / Blob | 采集服务 | 耐久 |
| `conversation_prefs.title` / `pinned` | 内核本地 | 耐久 |
| `conversation_prefs.last_read_*` | 内核本地游标 | 耐久 |
| Prompt | 连接器控制面（驱动内存 / 对端 mux） | 活的；对端 resolved 即消失 |
| 来源 attention | 连接器只读覆盖 | 活的；失败则退回本地游标 |

内核不得按渠道名推断「这是审批」或「这是飞书未读」。

## 5. Prompt

```ts
type PromptPresentation = "choice" | "approval" | "plan_review";

interface ThreadPrompt {
  prompt_id: string;
  presentation: PromptPresentation;
  title?: string;
  detail?: string;
  questions: Array<{
    id: string;
    prompt: string;
    options?: Array<{ label: string; description?: string; emphasized?: boolean }>;
    multi_select?: boolean;
    allow_custom?: boolean;
  }>;
}

interface PromptAnswer {
  prompt_id: string;
  answers: Array<{ id: string; selected: string[]; custom?: string }>;
}
```

`prompt_id` 对内核不透明。呈现只改 UI：`plan_review` 用选项上的 `emphasized` 点出肯定项，答案编码与 `choice` 相同。单选时 `custom` 覆盖 `selected`（清空已选项），这是呈现合同，不是某个渠道的规则。`approval` 由连接器译成渠道自己的允许/拒绝。

未读是**会话**属性。内核用 store 里该线程最新 inbound（不是列表脸上那条）对比 `last_read_*`。来源覆盖仍由驱动可选提供；驱动可以把 store 给出的 inbound id 当不透明 hint，不得让内核认识 `om_` / mux `rpcId`。

回答 prompt **不得**再走 `egress.send`。那是新的用户消息，不是控制面回填。

## 6. Attention

本地游标：`last_read_at`、`last_read_external_id`。开会话或 `POST /v1/me/conversations/attention` 时写入。

Inbox `unread` 由内核计算：

1. 未决 `prompts` 或 `activity === awaiting_user` → 未读。
2. 否则若驱动返回来源覆盖 → 用该覆盖。
3. 否则用最新 inbound 是否新过本地游标。

## 7. 驱动

`ChannelCapabilities` 增加可选 `prompts`、`attention`。

可选方法：`listPrompts`、`answerPrompt`、`readAttention`、`ackAttention`、`surfaceGeneration`。

经 `installation + thread` 解析。卸载插件必须丢掉该安装的 live prompt。

## 8. 个人 API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/v1/me/inbox` | 装饰 `prompts`、`unread`、`unread_count` |
| POST | `/v1/me/conversations/prompts` | 回答；`not-pending` 视为已解决 |
| POST | `/v1/me/conversations/attention` | 写本地游标；若声明 `attention` 再 ack 来源 |

`inbox_digest` 在有 live surface 世代时追加 `&s=`，以便审批弹出时桌面轮询能看见。

## 9. 验收

1. 桌面或 API 不出现 `if (source === "dsh")` 的答题/已读分支。
2. DSH web 的 question/approval 可在 PC 答完，agent 继续，且不额外 `session.prompt` 一条重复消息。
3. 飞书未读在没有来源覆盖时仍能靠本地游标工作。
4. Prompt 不出现在 Event 表。
