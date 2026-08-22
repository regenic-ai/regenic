# 消息编排

- **English:** [../en/MESSAGE_ORCHESTRATION.md](../en/MESSAGE_ORCHESTRATION.md)
- **相关：** [产品](PRODUCT.md) · [采集架构](INGESTION_ARCHITECTURE.md) · [技术栈](TECH_STACK.md) · RFC 0004、0005、0006
- **状态：** Phase 1 起的公开架构

Regenic 编排的是**消息**。它不托管这些消息当初被写下的那些应用。

## 消息怎么走

人或 Agent 不必知道一条线程来自邮件、工作区聊天、内部工单还是文件。进来的流量被整理成同一种消息，再存成 Event 与 Blob。回复发回原渠道。

```text
渠道
        |  连接器（读）
        v
   统一消息 → Event + Blob
        |
        v
   内核
   过滤 → 分层 → 排序 → 调度
        |
        +-- 其余 → 不进入当前工作
        +-- 需要处理 → 消息控制台（人与 Agent，同一套 API）
                |
                v
           回复
                |  连接器（写）
                v
           原渠道
```

收和发不是同一档权限：

- **收**是加工。蒸馏不得抬权（RFC 0006）。
- **发**是授权。看见 Digest 不等于获得 `can_send`。

## 消息控制台

控制台是编排的人机表面：

- 默认是当前需要处理的
- 其余不会出现
- 围绕 Event 的线程窗，不是孤立摘要
- 出处可查
- 人与 Agent 使用同一套 `/v1` 资源（RFC 0004）

对话并不住在控制台里。回复发回原渠道。

## 插件

连接器、模型、存储以**插件**挂上（端口加驱动）。运行时由 `@regenic/plugin-host` 装成一棵插件树。新渠道或新模型通过挂载插件加入，而不是给特权内核打补丁。卸载插件等于 dispose 对应 fiber：注册表、监听器和打开的库一并收回，不能留下额外写入或额外授权。

一次运行里的能力按 `ctx` 键查找，不 import 具体驱动：

| `ctx` 键 | 端口 |
| --- | --- |
| `authority` | `AuthorityStore` + 连接器运行时 |
| `blobs` | `BlobStore` |
| `ingest` | 采集服务（唯一写 Event / Blob 的入口） |
| `connectors` | 已挂载的 `ChannelConnector` 注册表 |
| `egress` | 已挂载的 `EgressAdapter` 注册表 |

**内核**

- 消息格式与幂等
- AuthorityStore / BlobStore 写入
- ACL `visible()` 与权威边界
- D0 过滤与分层：`current_work` / `outside_current_work` / `pending`；Event 仍留下；从不自动 defer
- 标准的应用与修订钩子
- 调度：不进入当前工作 vs pending
- 读与发的审计

**插件种类**

| 种类 | 职责 | 禁止 |
| --- | --- | --- |
| 连接器（`ChannelConnector`） | 把来源读成 `IngestBatch` | 直写 Event、Blob、ACL、身份 |
| 渠道驱动（`ChannelDriver`） | 安装、解析 pull 流、按线程绑定 egress、声明能否回写 | 在 API / UI 里按渠道名打补丁 |
| 发送（`EgressAdapter`） | 把回复写回原渠道 | 自授权限或跳过审批 |
| 排序 / 分层 | D0 之后的打分（耐久、敏感、「该知道」）。D0 过滤 / 分层在内核 | 用个人标签冒充组织事实 |
| 调度策略 | 排序 + 标准 + 习惯 → 不进入当前工作 \| pending \| defer | 没有发送授权就发送 |
| 模型 | 只提案 | 染指打分、配额、ACL |
| 身份 / 密钥 / 检索 / 通知 | 填一条能力缝 | 改消息格式 |

每条缝都有定义、提供方和消费者。换一个连接器，不得分叉内核。以后加来源是插件，不是重写产品。

连接器遵守[采集架构](INGESTION_ARCHITECTURE.md)：它们翻译；采集服务负责校验、鉴权、去重、存储与审计。

## 消息契约（内核定，连接器实现）

收发形状由 `@regenic/domain` 的 `message-contract` 定死。连接器只把渠道协议译进/译出这份契约，不在桌面或某个连接器里各写一套判断。

| 由内核规定 | 由连接器实现 |
| --- | --- |
| 渠道 id / 展示名（`dsh` → DSH，`slack` → Slack） | 把自己的来源写成该 id |
| 展示角色 `user` / `assistant` / `system` | 把原生事件映射到角色。DSH：`user/message` 且 `source.kind=user` → user（You）；`assistant/message` 的 `text` 块 → assistant（DSH Agent）；插件注入的 `user/message` → system。Slack 真人 → user |
| 方向 `inbound` / `outbound` | 读进来是 inbound；人从控制台发出是 outbound |
| 发送信封：`ContentPart[]`（`body` + `attachment`） | `EgressAdapter.send` 译回渠道（DSH `session.prompt`，Slack 以后 `chat.postMessage`） |

连接器入库必须走 `channelRecord()`，这样正文旁边会带上 surface 元数据。控制台按这份 surface 显示渠道标签和头像，不再猜正文。旧事件没有 surface 时，只用内核的 `inferLegacySurface()` 兜底：`:out:` 视为本地出站，其余视为入站 assistant，不再按正文或 `source === "dsh"` 猜格式。同一会话里，控制台发出的本地出站与渠道 history 回声的同一句话只保留一条 Event。

回复、follow 与 pull 走 `ChannelDriverRegistry`：API 只做 `installation + thread → driver.resolveStreams / bindEgress → egress.send(ContentPart[])`。桌面只问入箱里的 `can_send`，不问「是不是 DSH」。新渠道挂上 driver，不要改内核或控制台的渠道分支。

## 扩展点

| 目标 | 机制 |
| --- | --- |
| 加来源 | 连接器；一致性测试 |
| 加发送 | 同一渠道打开发送 |
| 改「什么算重要」 | 排序器 + 版本化标准 |
| 普通邮件自动处理 | 绑在标准上的调度策略；这些消息不进入当前工作，每次跳过都记审计 |
| 没把握就停下 | defer；defer 不能当答案 |
| Agent 读 | Evidence Bundle / 控制台 API；不给凭据 |
| Agent 发 | 显式发送授权 |
| SQLite 换成 Postgres | `AuthorityStore` 提供方；消息格式不变 |
| 加模型 | `ModelProvider` 插件；只提案 |

若改动需要新的 `IngestBatch` 字段或新的内核不变量，那就不是插件。应写成 RFC。

## 组合

一次运行是开机时按层叠起来的**插件树**（先个人默认，再组织默认）。个人与组织共用同一种消息格式和插件种类。组织再补身份映射、权威 Event 合并与按 scope 的 ACL。见[从个人到组织](rfcs/personal-to-org.md)。

## 范围外

- 取代已经在写消息的那些应用
- 还没有一致性测试就做插件市场
- 没有标准与上下文约束的无界 Agent 循环
- 插件输出不经内核就当成权威
