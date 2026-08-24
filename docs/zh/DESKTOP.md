# 桌面端

- **相关：** [产品](PRODUCT.md) · [消息编排](MESSAGE_ORCHESTRATION.md) · [连接器](CONNECTOR.md) · [技术栈](TECH_STACK.md) · RFC 0004
- **状态：** Phase 1 v0（控制台 + 本机引擎）

Regenic 个人阶段的主界面是本机 Electron 应用。它不是第二个飞书，也不是容器面板。

## 从哪里借、不借什么

| 参考 | 采用 | 不采用 |
| --- | --- | --- |
| 飞书桌面端 | 三栏工作面、图标栏、线程、关窗进托盘 | 频道瀑布流、聊天身份、紫/蓝品牌铬 |
| Docker Desktop | 托盘引擎层、内核 Running/Syncing/Stopped、本机 sidecar | 容器/镜像列表、引擎设置向导 |

默认只显示**当前工作**。渠道仍在原处；回复发回原渠道。线程能不能发由内核 `can_send` 决定（连接器 `ChannelDriver` 声明），桌面不按「是不是 DSH」开关输入框。能发的线程用 Composer 回写（所见即所得格式、图片、文件）；Slack 驱动目前 `canReply: false`，回写 501。发送走 `installation + thread → egress.send(ContentPart[])`。发送后内核按该线程 follow/pull，等到新的 inbound、`working` 或 `awaiting_user`，不必只等一条有正文的 Agent 回复。连接器通过 `surface.activity` 声明对端状态（`working` / `awaiting_user`），通过 `capabilities.await_reply` 声明发送后要不要等对端，通过 `capabilities.list_title` 声明列表标题用会话名、第一条用户消息还是可见消息。桌面只读这些声明，用状态条表示「已发送 / 对端还在处理 / 原渠道在等你」，不按渠道名写死。飞书不声明 `await_reply`，发出去就不挂等待条。`working` 不画成聊天气泡。不必再去引擎页点 Sync。引擎 Sync 只负责追平其他会话或首次拉齐。同一句本地出站与渠道 history 回声只保留一条 Event。

## 视觉

桌面端只用 **BIOBY Color System · Dark Mode**，不用纸色浅底或飞书紫。

- 中性：INK `#0A0A0A`、SURFACE `#171C18`、TEXT `#F7F8F7`、MUTED `#AEB5AF`
- 品牌绿：G500 `#6BED4A`（运行中 / 主按钮）、G900 `#153B12`（选中底）
- 语义：AI/PROCESS `#36D6E7`（同步中）、DATA `#B69CFF`（出处）、RISK `#FFB347`（已停止）
- 标识按 Electron / macOS 常见三套用法：
  - Dock / 任务栏：1024 圆角方标（画板约 80% 圆角矩形 + 中间斜切圆），对齐 Apple 图标模板
  - 菜单栏托盘：16×16 / 32×32 template，只有斜切圆
  - 窗口内：22px / 28px 圆角方块，中间放标，旁边是 **Regenic** 字标
- 顶栏左留 82px 给 macOS 红黄绿灯，侧栏从标题栏下方开始，避免窗口按钮和标识挤在一起

## 双层表面

- **主窗口：** 左图标栏（Inbox / Engine / Settings），中列表，右线程。顶栏是引擎芯片与 Inbox 计数。关窗不退出。
- **当前工作按会话列，不按单条消息列。** 一条会话在列表里是一行；右侧线程窗按时间展开该会话里进入当前工作的消息。底层 `/v1/me/inbox` 仍是 Event 列表（含 `can_send`、`await_reply`、`list_title`、自定义 `title`、`pinned`、连接器写入的 `conversation_label` / `conversation_kind` / `actor_label`），聚合只发生在桌面表面。标题可双击或用铅笔手改，置顶用图钉；二者写入内核 `conversation_prefs`，轮询不会用首条消息把自定义标题冲掉。清空标题则按 `list_title` 回退：聊天渠道用会话名（群名或单聊对方），没有会话名才用会话 id；会话 Agent 渠道用第一条用户消息。引擎页的安装和改同步范围用同一套 catalog 弹窗，不按连接器写死表单。列表按来源渠道过滤，置顶用图钉开关；置顶会话排在前面。列表和标题醒目标出**来源渠道**。角色与发送格式由内核 `message-contract` 规定，连接器负责翻译。对话窗按发言人展开：每条消息保留自己的名字和时间。同一人连续发言只收起头像和名字，不把不同人的正文拼成一块。线程窗只挂可视区域附近的消息，长会话可以滚动，不会一次性把几千上万条都画进 DOM。同步时按 React 的 keyed list 对账：先对前缀、再对后缀，剩下的才建 key map；key 相同且 props 未变就复用原对象。拉取追加时只脏对应会话，其它会话不重建。打开的对话不会因为别的会话在拉而整段重建；本会话只是追加时也只更新尾部。新建的空会话按打开时间排到未置顶最前，不用 locale 相关的 `~` 哨兵。发送写入的 outbound 和渠道拉回来的同一句只显示一次。桌面列表只拉 `heads=1`（每个会话最后一条可见消息的短脸，不含附件、不带回复预览，也不叠全文）。列表不画第三行预览；点开会话才拉 `thread_id` 全文，之后只跟该会话的 `since` 增量。内核 `listInbox` 按会话/时间/heads 收窄，引擎摘要只算 `inbox_digest` 不再水合全部 Event。`inbox_count` 是会话数，和列表一致；改标题或置顶也会推进 digest。打开过的会话正文只缓存最近几条，关掉后会丢掉。空闲后轮询放到 8 秒。列表轮询走 `engine?detail=0`，已打开的会话才跟增量。托盘同样只拉头。开会话时停在最新一条；往上翻历史时新消息不把滚动位置拽回去。没有 `actor_label` 时才回退 You / Agent / Runtime。引用条、runtime 居中折叠。底部是 Cursor 式 Composer：多行编辑、图片缩略图、拖入/粘贴附件，以及飞书常用的加粗/斜体/删除线/行内代码/列表（⌘B / ⌘I / ⌘⇧X）。Enter 发送，Shift+Enter 换行。能发时回复写回原渠道线程。安装声明了 `can_create` 时，列表里有「新对话」，按钮带上该安装的 `channel_label`（现在是 New DSH）。多条都能建时，先跟当前渠道过滤，否则弹出选择。桌面仍不写死渠道名。Slack / 飞书不能新建。列表顶栏收成一行：渠道过滤 + 置顶开关 + New。
- **托盘：** 点击打开小窗，显示内核状态、计数、最近 3 个会话；可「打开控制台」。退出只在托盘菜单。

## 进程

Electron 主进程默认拉起或复用本机 sidecar（`apps/api`，`127.0.0.1`，默认端口 `4370`）。设置页可以改成自定义内核 URL；Apply 会先探 `/health`，确认 `mode=personal` 才停本机 sidecar。探失败则保住本机内核。渲染进程只打 HTTP，不直连 SQLite。人与 Agent 共用 `/v1`。地址记在应用 `userData/desktop-settings.json`。自定义内核可以是 `https://`（例如 Sealos）；页面 CSP 的 `connect-src` 允许本机和 HTTPS。

`/v1/me` 默认只在回环监听时开放（`LISTEN_HOST` 为 `127.0.0.1` / `localhost` / `::1`）。Sealos 等 `0.0.0.0` 部署默认没有这条个人面；要让桌面连远程内核，远程进程设 `REGENIC_PERSONAL_API=1`。`REGENIC_PERSONAL_API=0` 可在本机也关掉。桌面 sidecar 会丢掉父进程里的 `REGENIC_PERSONAL_API`，以免外壳 `=0` 把内核个人面关掉。个人模式 CORS 只回显 `file://`、`null` 和本机 Origin，不回显任意网站。安装 DSH 时不接收 `command` / `workdir`。本机表单里的 `base_url` 必须是回环 URL。托管 API（Sealos 等）用环境变量 `REGENIC_DSH_BASE_URL` 指向集群内网 dsh web（例如 `http://regenic-dsh:3080`），目录不再要公网地址；已存的 CLI 安装也会按 web 认会话、允许回复。

默认数据：若仓库里已有 `regenic.db` 则开发时用它；否则 `~/.regenic/regenic.db` 与 `~/.regenic/blobs`。引擎 Kernel 卡片的 Disk 同时显示我们自己的库/附件大小，以及这块盘还剩多少。Memory 由桌面主进程用 pid / `ps` 采样内核和自身，不经过 sidecar 的 HTTP；内核涨得太高或进程没了，顶栏也会标出来。

## `/v1/me`

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/v1/me/inbox` | 当前工作 + 可选 `body_text`。`heads=1` 每个会话最后一条可见消息的短脸，不含附件和回复预览；`thread_id` 只返回该会话全文；`since` / `since_id` 做增量 |
| GET | `/v1/me/inbox/:event_id` | 单条 + 出处 + 正文 |
| GET | `/v1/me/engine` | 内核、库路径、live pull 间隔/上次 tick、已安装连接器、未安装目录。`inbox_count` 是当前工作会话数。`detail=0` 跳过 catalog 探测和 attempt 列表，仍带 `inbox_digest`（含最新 Event 和 conversation prefs） |
| POST | `/v1/me/connectors` | 从目录安装（Slack / DSH / 飞书），不接收 token；安装后内核立刻 pull 一次 |
| POST | `/v1/me/connectors/:id/config` | 改已安装连接器的非密钥配置（同一套 catalog 字段），不丢游标；enabled 时立刻再 pull 一次 |
| DELETE | `/v1/me/connectors/:id` | 卸载安装记录和游标，保留已入库消息 |
| POST | `/v1/me/connectors/:id/sync` | 手动追平。Slack 一页频道；DSH web 默认同步全部会话（每路最多 5 页）。日常不用点 |
| POST | `/v1/me/connectors/:id/enable` | 启用连接器，并立刻再 pull 一次 |
| POST | `/v1/me/connectors/:id/disable` | 停用连接器，停止 pull |
| POST | `/v1/me/conversations` | 让连接器开一条新会话。省略 `installation_id` 时取第一条 `can_create` 的安装。驱动 `create: false` 时 501 |
| POST | `/v1/me/conversations/prefs` | 维护会话标题和置顶。`thread_id` 必填；`title` 空字符串清除自定义标题，回到自动标题；`pinned` 可单独改。inbox 项带回 `thread_id` / `title` / `pinned` / `pref_updated_at` |
| POST | `/v1/me/replies` | 把回复发回原渠道。API 按 installation + thread 找 `ChannelDriver`，再 `egress.send`。入库后 follow 该线程直到出现新的 inbound / `working` / `awaiting_user` 或短暂超时；驱动 `canReply: false` 时 501 |
| GET | `/health` | 个人模式查 SQLite，不探 Postgres |

不返回连接器 token 或 quarantine 正文。内核在跑且连接器 enabled 时按约 3 秒 pull 一次（`REGENIC_CONNECTOR_PULL_MS` 可改）。同 tick 有限并行。流上的 `pace` 由连接器声明：飞书追上后约 15 秒再扫，DSH 不写 `pace`，仍每 tick 跟。对话窗发送后会更快跟当前 DSH session。引擎 Sync 只是漏了再追平。凭证只读环境变量。

## 连接器：同步范围与前置步骤

安装和前置检查都由 `/v1/me/engine` 的 **catalog** 驱动：每种连接器声明 `fields`（含默认值、是否必填、`visible_when`）和 `prerequisites`（环境变量或本机服务）。`ready` / `hint` 由该连接器的 `probeCatalog()` 探测，API 只合并，引擎页只渲染，不按连接器类型写死 UI。

| 连接器 | 安装要填 | 前置 | 同步范围 |
| --- | --- | --- | --- |
| Slack | `channel_id`（频道名可选） | 启动前设好 `REGENIC_SLACK_TOKEN`（Slack 应用的 bot token）。表单不收 | 只拉该频道。安装后立刻拉，之后内核轮询 |
| DSH web（本机） | `base_url` 默认 `http://127.0.0.1:3080`；`session_id` **可选** | 目录会探测 `dsh web`，但探测失败不挡安装。装完后要本机 `dsh web --port 3080` 在跑，内核才能拉。`REGENIC_DSH_TOKEN` 仅在 DSH 要求 Bearer 时需要 | 未填 session 时用 DSH `session.list` 拉齐全部会话，每个 session 走自己的 `session:${id}` 游标。安装后立刻拉，之后内核轮询。填了则只跟那一条 |
| DSH web（托管） | 只填可选 `session_id`；不填 `base_url` | 内核环境变量 `REGENIC_DSH_BASE_URL`（集群 DNS） | 同上；核心只走内网，不要填 Sealos 公网 URL |
| DSH CLI | mailbox 可选 | 本机 `dsh` 命令 | 该 mailbox 一条流 |
| 飞书 | 弹窗里默认勾选全部群和全部单聊；也可勾选具体会话。安装后随时 Edit sync | 没装则 `npx @larksuite/cli@latest install`；装了未登录则 `lark-cli config init` 和 `lark-cli auth login --recommend`。内核不代装 | 按选择拉群和单聊，记录群名/对方名和发送者名。安装后立刻拉，之后内核轮询。能回写文本、图片和文件。图片与发送必须走同一用户身份，不能只把正文发出去 |

DSH 安装不接收 token / `command` / `workdir`。本机 `base_url` 必须是回环；托管内核忽略表单里的公网 URL，一律用 `REGENIC_DSH_BASE_URL`。

## 启动

```bash
pnpm dev:desktop
```

需已能 `pnpm --filter @regenic/api... build`。无 Inbox 数据时，在引擎页安装连接器，内核会自己拉。

## 本版不做

Slack 回写、OAuth 授权流、标准编辑、渠道 webhook/push、Windows/Linux 打包。渠道目前是 pull 轮询，不是事件推送。
