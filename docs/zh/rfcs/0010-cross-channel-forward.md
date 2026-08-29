# RFC 0010 — 跨渠道转发

- **状态：** Draft
- **English:** [../../en/rfcs/0010-cross-channel-forward.md](../../en/rfcs/0010-cross-channel-forward.md)
- **依赖：** RFC 0004、RFC 0008、RFC 0009、连接器合同
- **相关：** [消息编排](../MESSAGE_ORCHESTRATION.md) · [连接器](../CONNECTOR.md) · [桌面端](../DESKTOP.md)

## 1. 问题

控制台已经把飞书、Slack、DSH、Cursor 收成同一种消息。人要把一段对话交给另一个能写的地方（尤其是新建一条 Agent 会话）时，今天只有两条路：

- `POST /v1/me/replies`：只能写回**本** `thread_id` 的原渠道。
- Recipe / Handle now：在**同一条**线程上开 WorkItem，结果仍写回原渠道。

两者都不是转发。若把 `replies` 加上 `target_thread_id`，会把「回复发回原渠道」写脏。若让连接器互译（飞书 wire → DSH wire），桌面和内核会重新按渠道名分支。

复制正文是桌面表面问题，不在本 RFC。

## 2. 目标

1. 转发 = **编译 + 发送**。源线程不搬家、不改 `thread_id`、不与目标结成一对。
2. 内核把源 Event 收成渠道无关的 `PortableForwardPacket`，目标只吃已有的 `ContentPart[]`。
3. 新资源 `POST /v1/me/forwards`。不扩展 replies。
4. 桌面只问 `can_send` / `can_create`，按 `channel_label` 渲染，不写 `if (source === …)`。
5. 出处可查：目标出站带 `forwarded_from`；源侧一条不进 `current_work` 的 `status` 挂 `forwarded_to`。第一期不自动开 WorkItem，也不把 Agent 结果写回源渠道。

## 3. 非目标

- 跨渠道镜像或双向同步。
- 合并两条 `thread_id`，或给线程做跨渠道别名。
- 用 RFC 0003 的组织 Handoff 对象实现聊天转发。
- Slack / WhatsApp 作为发送目标（它们没有 live egress）。
- 消息复制到剪贴板。

## 4. 不变量

| 规则 | 说明 |
| --- | --- |
| 一线程一 `source` | `thread_id = source:target` 不变。转发在**目标**线程长出一条新 outbound。 |
| 回复仍回原渠道 | 目标线程上的后续 Reply 仍走该线程自己的 egress。 |
| 发送权不因看见而升高 | 目标没有 `can_send`（已有线程）或 `can_create`（新建）则不得出现在选择器里。 |
| 连接器只翻译 | 驱动不实现「转发给别的渠道」。 |
| 写回仍要显式授权 | 转发不得抬高 `can_write_back`。 |

## 5. 语义

两档，共用一个 API：

| `mode` | 入口 | 编什么 | 目标 |
| --- | --- | --- | --- |
| `messages` | 消息上的 Forward | 指定 `event_ids` 的 `utterance` | 已有 `can_send` 线程 |
| `transcript` | 线程头 Forward conversation | 当前可见 `utterance`（丢掉 status / prompt / ticket 头） | 已有可写线程，或 `can_create` 安装上新建 |

默认带出处一行：`渠道标签 · 发言人 · 时间`。预览可改。Cursor 的 `create_with_task` 把第一包 transcript 当作任务文本；未声明则先 `createThread` 再 `send`。桌面仍只读能力位。

## 6. API

```http
POST /v1/me/forwards
```

```ts
type ForwardInput = {
  source_thread_id: string;
  event_ids?: string[];
  target:
    | { thread_id: string }
    | { installation_id: string; create: true };
  mode: "messages" | "transcript";
  attribution?: boolean; // 默认 true
};

type ForwardView = {
  accepted: true;
  source_thread_id: string;
  target_thread_id: string;
  created: boolean;
  item: InboxViewItem;
  truncated?: boolean;
};
```

幂等：`hash(org, source_thread, event_ids, target, mode)`。找不到可写目标 → 404 `no_sender`；驱动不能发 → 选择器里就不出现，不要靠 501 当正常路径。

实现落在 `PersonalForwardService`，不改 `PersonalReplyService` 的合同。

## 7. 编译

`compileForwardPacket()` 在 `@regenic/domain`，不 import 渠道名。

- 只编 `record_class === "utterance"`。
- 正文取已 flatten 的 markdown / plain。
- 附件从 BlobStore 取出再交给目标 egress（要 bytes，不能只丢 hash）。
- 超现有 `MAX_TEXT`（32_000）截断，包头写「已截断」。
- 目标 Event 的 surface attrs 写 `forwarded_from: { thread_id, event_ids, source }`。
- 不必新表。源侧 ingest 一条 `thread_status`（`outside_current_work`），surface 写 `forwarded_to: { thread_id, event_ids, source }`；inbox 按 `event_ids` 挂到源 utterance。多次转发同一条取最新。源侧 ingest 失败不让整个转发变 502。

## 8. 桌面

- 消息 hover：Copy（桌面本地）· Forward（本 RFC）· Reply（已有）。右键无选区时同一套；有选区则走系统 Copy。
- 勾选多条 utterance（Shift 扩选）后可转发或复制所选。
- 目标气泡出处 chip：`转发自 {channel_label}`。
- 源侧气泡：`已转发到 {channel_label}`。status 痕迹不画成系统气泡。
- 线程头：Forward conversation。
- 选择器上半：inbox 里 `can_send` 的会话；下半：现有 `createTargets` 的 `New {channel}`。
- 发送前预览编译结果。新建 Agent 会话后跳到目标；发进已有会话则留在源线程。

## 9. 分波

| 波次 | 交付 |
| --- | --- |
| P1 | `messages` → 已有 `can_send` 线程（已落地） |
| P2 | `transcript` → `can_create` 新建 Agent 线程（已落地） |
| P3 | 多选、附件保真、目标气泡出处 chip（已落地） |
| P4 | 源侧「已转发到」chip（已落地） |

P0 复制不阻塞本 RFC。
