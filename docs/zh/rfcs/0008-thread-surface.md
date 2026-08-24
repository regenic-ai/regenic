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

1. 在连接器端口上增加渠道无关的 **Thread Surface**：`prompts`（人工干预）、`attention`（我是否看过对方）、`receipts`（对方是否看过我）。
2. 内核与桌面只读声明，不按 `dsh` / `feishu` 分支。
3. Prompt **不入库为 Event**。Attention 的本地游标进 `conversation_prefs`；Receipts 不进 store，由驱动按出站消息现查。
4. PC 端能回答对端的提问/审批，而不必打开原渠道 UI。

## 3. 非目标

- 权限预设、slash 命令、渠道设置页。
- 把 prompt 写成 `IngestRecord` 或新 Event 类型。
- 假装每个聊天 OpenAPI 都有会话未读计数，或都有对端已读回执。
- 用 inbox `unread` 表示「对方看没看我发的」。
- CLI 运输上的远程 DSH 答题（没有 mux）。

## 4. 不变量

| 面 | 权威 | 寿命 |
| --- | --- | --- |
| Event / Blob | 采集服务 | 耐久 |
| `conversation_prefs.title` / `pinned` | 内核本地 | 耐久 |
| `conversation_prefs.last_read_*` | 内核本地游标 | 耐久 |
| Prompt | 连接器控制面（驱动内存 / 对端 mux） | 活的；对端 resolved 即消失 |
| 来源 attention | 连接器只读覆盖 | 活的；失败则退回本地游标 |
| Receipt | 连接器按出站 `external_id` 现查 | 活的；失败则显示 Sent |

内核不得按渠道名推断「这是审批」或「这是飞书未读」。两条已读面不得共用一个字段。

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

Inbox `unread` 由内核计算。本机游标是 PC 已读权威；来源覆盖只能补未读，不能把「本机没开过」消掉：

1. 未决 `prompts` 或 `activity === awaiting_user` → 未读。
2. 有最新 inbound 时，只比本地 `last_read_*`。没开过或游标落后 → 未读；本机已追上 → 已读（即使飞书官方仍显示未读）。
3. 没有 inbound 时，若驱动报来源未读 → 未读。来源报已读不单独作数。

列表绿点只读这条面。所有渠道都走同一套本地游标；`attention` 能力只表示「有来源 hint」，不是「才有未读」。

## 7. Receipts

对端是否已读**我发出的那条**。粒度是出站消息，不是会话。权威在连接器现查，不进 Event，也不写 `last_read_*`。

```ts
type ReceiptState = "sent" | "read";

interface MessageReceipt {
  state: ReceiptState;
  read_at?: string;
  read_count?: number;
}
```

`ChannelCapabilities.receipts` 只在真实 API 存在时声明。飞书用用户态 `GET /im/v1/messages/:id/read_users`（我发出且 7 天内的 `om_`）。空 `items` 仍是 `sent`，不是会话未读。官方 bot 的 `read_users` 不得拿来当 conversation unread。

内核 `readReceipts(ThreadReceiptQuery[])` 返回 `Map<external_id, MessageReceipt>`。`external_id` 对内核不透明；连接器自己认出 `:out:om_…`。打开的线程才查；列表 `heads` 不查。桌面只在 `can_receipt` / `receipt` 出现时，画出站气泡 Sent / Read。

DSH、Slack 不声明 `receipts`。没有 API 就没有回执 UI，但 attention 游标仍然在。

## 8. 驱动

`ChannelCapabilities` 增加可选 `prompts`、`attention`、`receipts`。

可选方法：`listPrompts`、`answerPrompt`、`readAttention`、`ackAttention`、`readReceipts`、`surfaceGeneration`。

经 `installation + thread` 解析。卸载插件必须丢掉该安装的 live prompt。

## 9. 个人 API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/v1/me/inbox` | 装饰 `prompts`、`unread`、`unread_count`；打开的线程另带 `can_receipt` / `receipt` |
| POST | `/v1/me/conversations/prompts` | 回答；`not-pending` 视为已解决 |
| POST | `/v1/me/conversations/attention` | 写本地游标；若声明 `attention` 再 ack 来源 |

`inbox_digest` 在有 live surface 世代时追加 `&s=`，以便审批弹出时桌面轮询能看见。Receipt 变化不进 digest。

## 10. 验收

1. 桌面或 API 不出现 `if (source === "dsh")` 的答题/已读分支。
2. DSH web 的 question/approval 可在 PC 答完，agent 继续，且不额外 `session.prompt` 一条重复消息。
3. 飞书未读在没有来源覆盖时仍能靠本地游标工作。
4. Prompt 不出现在 Event 表。
5. inbox `unread` 从不表示「对方看没看我发的」。
6. Slack / DSH 不声明 `receipts`；没有回执也不假装已读。
