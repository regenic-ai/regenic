# 桌面端

- **相关：** [产品](PRODUCT.md) · [消息编排](MESSAGE_ORCHESTRATION.md) · [连接器](CONNECTOR.md) · [执行器](EXECUTOR.md) · [技术栈](TECH_STACK.md) · RFC 0004、0008、[0009](rfcs/0009-work-orchestration.md)、[0010](rfcs/0010-cross-channel-forward.md)
- **状态：** Phase 1 v0（控制台 + 本机引擎）

Regenic 个人阶段的主界面是本机 Electron 应用。它不是第二个飞书，也不是容器面板。

## 从哪里借、不借什么

| 参考 | 采用 | 不采用 |
| --- | --- | --- |
| 飞书桌面端 | 三栏工作面、图标栏、线程、关窗进托盘 | 频道瀑布流、聊天身份、紫/蓝品牌铬 |
| Docker Desktop | 托盘引擎层、内核 Running/Syncing/Stopped、本机 sidecar | 容器/镜像列表、引擎设置向导 |

默认只显示**未折叠**的会话；过滤栏可切到「不显示」。不显示是列表表面状态，不是删除，也不是工单完结或源侧 tombstone。人可以主动折叠；机器在工单结束或身份被撤回后按策略折叠。人折叠后新消息不会自动回来；策略折叠后若再有桌上的活会自动回到显示列表。渠道仍在原处；回复发回原渠道。线程能不能发由内核 `can_send` 决定（连接器 `ChannelDriver` 声明），桌面不按「是不是 DSH」开关输入框。能发的线程用 Composer 回写（所见即所得格式、图片、文件）；Slack 驱动目前 `canReply: false`，回写 501。发送走 `installation + thread → egress.send(ContentPart[])`。发送后内核按该线程 follow/pull，等到新的 inbound、`working` 或 `awaiting_user`，不必只等一条有正文的 Agent 回复。连接器通过 `surface.activity` 声明对端状态（`working` / `awaiting_user`），通过 `capabilities.await_reply` 声明发送后要不要等对端，通过 `capabilities.list_title` 声明列表标题用会话名、第一条用户消息还是可见消息，通过 `create_with_task` 声明新建是立刻建空会话还是等第一条任务，通过 `hold_while_working` 声明跟发是已送达还是由连接器暂存。桌面只读这些声明，用状态条表示「已发送 / 对端还在处理 / 原渠道在等你」，不按渠道名写死。飞书不声明 `await_reply`，发出去就不挂等待条。`working` 不画成聊天气泡。不必再去引擎页点 Sync。引擎 Sync 只负责追平其他会话或首次拉齐。同一句本地出站与渠道 history 回声只保留一条 Event。

## 视觉

桌面端只用 **BIOBY Color System · Dark Mode**，不用纸色浅底或飞书紫。

- 中性：INK `#0A0A0A`、SURFACE `#171C18`、TEXT `#F7F8F7`、MUTED `#AEB5AF`
- 品牌绿：G500 `#6BED4A`（运行中 / 主按钮）、G900 `#153B12`（选中底）
- 语义：AI/PROCESS `#36D6E7`（同步中）、DATA `#B69CFF`（出处）、RISK `#FFB347`（已停止）
- 标识按 Electron / macOS 常见三套用法：
  - Dock / 任务栏：**两套图**。macOS 与微信 / Cursor / 系统备忘录一样，1024 画板里预切 824 squircle（约 10% 透明边，Dock 不会再切一刀）；Windows / Linux 用铺满的不透明方标（多尺寸 `.ico`），任务栏由系统圆角，带透明通道的 ico 在 Shell 里经常是空白。开发态不要设自定义 AppUserModelId（没有开始菜单快捷方式时任务栏会丢图标）。生成脚本：`apps/desktop/scripts/build-app-icon.py`
  - 菜单栏托盘：16×16 / 32×32 template，只有斜切圆
  - 窗口内：22px / 28px 圆角方块，中间放标，旁边是 **Regenic** 字标
- 顶栏左留 82px 给 macOS 红黄绿灯，侧栏从标题栏下方开始，避免窗口按钮和标识挤在一起

## 双层表面

- **主窗口：** 左图标栏（工作 / 规则 / 引擎 / 设置），中列表，右线程。顶栏是引擎芯片与进行中计数。关窗不退出。设置页可切界面语言（英文 / 中文，默认英文），记在本机 `desktop-settings.json`。设置页可选本机数据目录（库和附件，默认 `~/.regenic`）；改目录会停本机 sidecar、按选择拷贝或接管，再按新路径拉起。迁移或覆盖成功后，设置页会记住原来的目录，让人选择保留拷贝或只删掉源上的库和附件来腾空间（`regenic.relocated.json` 和文件夹里其它文件不动；开发仓库根不提供删除）。指针留在 `desktop-settings.json`，不搬 Electron `userData`。`REGENIC_DATABASE` / `REGENIC_BLOB_ROOT` 仍优先。设置页也可清理当前内核的本机数据：清空会话、工单和导入，保留连接器与 Recipes。
- **当前工作按会话列，不按单条消息列。** 一条会话在列表里是一行；右侧线程窗按时间展开该会话里进入当前工作的消息。底层 `/v1/me/inbox` 仍是 Event 列表（含 `can_send`、`await_reply`、`list_title`、自定义 `title`、`pinned`、连接器写入的 `conversation_label` / `conversation_kind` / `unit_kind` / `unit_kind_label` / `actor_label`，以及 Thread Surface 的 `prompts` / `unread` / `unread_count`，打开的线程另带 `can_receipt` / `receipt`），聚合只发生在桌面表面。列表未读点只读内核算好的 `unread`（我还没看对方）。出站气泡上的 Sent/Read 只在 `can_receipt` / `receipt` 出现时画，表示对方是否已读我发出的那条，不复用 `unread`。有未决 `prompts` 时，线程里的通用 Prompt 面板接管 Composer（choice / approval / plan_review），`plan_review` 只点出带 `emphasized` 的选项，答题走 `POST /v1/me/conversations/prompts`，不再走 `session.prompt` / egress。打开会话会 `POST /v1/me/conversations/attention` 写本地游标；驱动声明了 `attention` 再 ack 来源。桌面不按渠道名分支。标题可双击或用铅笔手改，置顶用图钉；二者写入内核 `conversation_prefs`，轮询不会用首条消息把自定义标题冲掉。清空标题则按 `list_title` 回退：聊天渠道用会话名（群名或单聊对方），没有会话名才用会话 id；会话 Agent 渠道用第一条用户消息。引擎页的安装和改同步范围用同一套 catalog 弹窗，不按连接器写死表单。列表按来源渠道过滤，置顶用图钉开关；置顶会话排在前面。列表和标题醒目标出**来源渠道**；有 `unit_kind` 时用 catalog 文案画类型芯片，不按渠道名分支。角色与发送格式由内核 `message-contract` 规定，连接器负责翻译。对话窗按发言人展开：每条消息保留自己的名字和时间。悬停或右键可复制正文（markdown 与附件名）；划选文字后右键走系统 Copy。能回的线程另有回复。消息或会话头可转发到另一条 `can_send` 会话，也可勾选多条再转发（编译 + 发送，见 [RFC 0010](rfcs/0010-cross-channel-forward.md)）。目标气泡带出处 chip；源侧气泡带「已转发到 {channel_label}」。同一人连续发言只收起头像和名字，不把不同人的正文拼成一块。线程窗只挂可视区域附近的消息，长会话可以滚动，不会一次性把几千上万条都画进 DOM。同步时按 React 的 keyed list 对账：先对前缀、再对后缀，剩下的才建 key map；key 相同且 props 未变就复用原对象。拉取追加时只脏对应会话，其它会话不重建。打开的对话不会因为别的会话在拉而整段重建；本会话只是追加时也只更新尾部。新建的空会话按打开时间排到未置顶最前，不用 locale 相关的 `~` 哨兵。发送写入的 outbound 和渠道拉回来的同一句只显示一次。桌面列表只拉 `heads=1&split=1` 的最近一页（默认约 40 条 `live` 会话脸；置顶和进行中工单走旁路，不占翻页游标）。滚到底用 `next_before` 要更早的一页；轮询只刷新 live 窗口，已翻过的 history 按 `thread_id` 留在身份目录里。每个会话最后一条可见消息的短脸，不含附件，也不叠全文。列表在会话名下可出一条预览；点开会话才拉 `thread_id` 全文，之后只跟该会话的 `since` 增量。内核 `listInbox` 按会话/时间/heads 收窄，引擎摘要只算 `inbox_digest` 不再水合全部 Event。`inbox_count` 是进行中会话数；改标题或置顶也会推进 digest。打开会话先出最近一页文字（约 20 条），不挡在飞书全量附件或已读回执上；图片预览只带最近几张，其余文件名先占位。本地没有消息时立刻返回，后台种最近一批，桌面短轮询直到出现。打开过的会话正文只缓存最近几条，关掉后会丢掉。空闲后轮询放到 8 秒。列表轮询走 `engine?detail=0`，已打开的会话才跟增量。托盘只拉最近几条会话脸，计数走 `inbox_count`，不再为角标拉全量列表。开会话时停在最新一条；往上翻历史时新消息不把滚动位置拽回去。没有 `actor_label` 时才回退 You / Agent / Runtime。引用条、runtime 居中折叠。底部是 Cursor 式 Composer：多行编辑、图片缩略图、拖入/粘贴附件，以及飞书常用的加粗/斜体/删除线/行内代码/列表（⌘B / ⌘I / ⌘⇧X）。Enter 发送，Shift+Enter 换行。能发时回复写回原渠道线程。安装声明了 `can_create` 时，列表里有「新建」，按钮带上该安装的 `channel_label`。多条都能建时，先跟当前渠道过滤，否则弹出选择。桌面仍不写死渠道名。Slack / 飞书不能新建。列表顶栏按功能分行：上一行是显示/不显示（列表表面）和新建；下一行才是排序、渠道过滤和置顶针。两个来源渠道用芯片；多于两个改成下拉，渠道很多时可搜索。行上和线程头可「不显示」或「显示」。不写「当前工作」标题。不随列表滚动。列表行先扫会话名，再看来源渠道和预览。
- **托盘：** 点击打开小窗，显示内核状态、计数、最近 3 个会话；可「打开控制台」。退出只在托盘菜单。

## 工单与分层

桌面读 [消息编排](MESSAGE_ORCHESTRATION.md) 的 L2–L6，不按连接器名判断人聊 / Agent / 工单。

- 列表行带 `thread_facet`、`attention`、`work`。默认的 `chat` / `direct` 不打标；进行中的工单标 `Running` / `Waiting` / `Failed`。
- 会话名下可出最后一条预览；标题和正文相同时不重复。
- 排序：`normal` 为置顶 + 最近活动；`attention` 为等人 / 运行中 / 未读优先，并在档位不同时分组（只排已经加载进列表的这一窗，与 Slack 侧栏相同）。选择写入 `ui_prefs.inbox_sort`。过滤栏「显示 / 不显示」写入 `ui_prefs.inbox_list`。折叠写入 `conversation_prefs.hidden`（`human` 或 `policy`），与 `current_work`、tombstone、WorkItem 状态解耦。
- 显示/不显示与新建钉在列表顶第一行；排序、渠道滤、置顶针在第二行。只有会话列表滚动。
- Recipes 单独一页：用白话说明「这类工作出现时用哪个执行器」。调用参数只渲染 `GET /v1/me/executors` 的 `catalog().fields`，不按执行器名特判。DSH 用 `skill` / `prompt` 拼进新会话，再带上工单原文；Cursor / bioby-agent 后接同一协议。默认看所有 task，或某一来源的 task，或一条会话。`include_context` 打开则把该会话最近一页可见历史交给执行器（长会话截断），默认只带最近这条工单。匹配到的会话在 Current work 里 **Start run**；DSH 日志出现 `turn/end` 后内核 reap。聊天回复不是退出。人不想跟的 Job 从当前工作 **拿掉**，不冒充执行器结束。没有 `can_write_back` 不得 egress；写回只发生在真 `exited`。

## 进程

Electron 主进程默认拉起或复用本机 sidecar（`apps/api`，`127.0.0.1`，默认端口 `4370`）。同一份 `userData` 只跑一个桌面实例，后开的窗口会聚焦已有窗口。设置页可以改成自定义内核 URL；Apply 会先探 `/health`，确认 `mode=personal` 才停本机 sidecar。探失败则保住本机内核。渲染进程只打 HTTP，不直连 SQLite。人与 Agent 共用 `/v1`。地址记在应用 `userData/desktop-settings.json`（原子写入）。自定义内核可以是 `https://`（例如 Sealos）；页面 CSP 的 `connect-src` 允许本机和 HTTPS。

sidecar **就绪**只表示进程在、端口已听、`/health` 的 `mode=personal`。第一次连接器拉新、压缩旧信封都是后台 Job，在 `listen()` 之后才开始，不得挡住健康检查，也不得被桌面当成「内核没起来」杀掉。人在用 PC 时，后台只扫少量会话的最近/新消息；历史在人空闲时一页页补，或打开会话后往上翻再要。个人模式 `/health` 只看本机 SQLite 是否打开，不探 DSH；DSH 是否在线属于引擎目录，不是就绪条件。桌面探测带短超时；sidecar 进程已经退出则立刻失败，不必空等到超时。安装 / 改配置 / 启用连接器会立刻种最近一批，但 HTTP 不等待历史拉完；要一次多拉走 Sync。

`/v1/me` 默认只在回环监听时开放（`LISTEN_HOST` 为 `127.0.0.1` / `localhost` / `::1`）。Sealos 等 `0.0.0.0` 部署默认没有这条个人面；要让桌面连远程内核，远程进程设 `REGENIC_PERSONAL_API=1`。`REGENIC_PERSONAL_API=0` 可在本机也关掉。桌面 sidecar 会丢掉父进程里的 `REGENIC_PERSONAL_API`，以免外壳 `=0` 把内核个人面关掉。个人模式 CORS 只回显 `file://`、`null` 和本机 Origin，不回显任意网站。安装 DSH 时不接收 `command` / `workdir`。本机表单里的 `base_url` 必须是回环 URL。托管 API（Sealos 等）用环境变量 `REGENIC_DSH_BASE_URL` 指向集群内网 dsh web（例如 `http://regenic-dsh:3080`），目录不再要公网地址；已存的 CLI 安装也会按 web 认会话、允许回复。

默认数据：若设置里有 `dataRoot`，则用 `dataRoot/regenic.db` 与 `dataRoot/blobs`；未打包的开发检出若仓库里已有 `regenic.db` 则内核用它，设置页会单独标出，产品默认仍是 `~/.regenic`；打包后的应用不会把仓库根当数据目录。再否则 `~/.regenic/regenic.db` 与 `~/.regenic/blobs`。环境变量 `REGENIC_DATABASE` / `REGENIC_BLOB_ROOT` 覆盖以上全部；两者不在同一目录时设置页分开显示，不能在这里一起搬走。Windows 选盘符根（`D:\`）时实际写入 `D:\Regenic`。选普通文件夹时同样落到其中的 `Regenic`；文件夹名已是 `Regenic` / `.regenic`，或里面已有 `regenic.db`，则不再套一层。接管已有目录会检查 `regenic.db` 的 SQLite 头。迁走或覆盖成功后，源目录写 `regenic.relocated.json`（指向新位置和 `storeId`），新目录写 `regenic.store.json`；未保存 `dataRoot` 时会跟着指针走，目标不在或 `storeId` 对不上则仍用旧目录。设置里同时记下 `previousDataRoot`：只有源上的 relocated 指向当前目录且 `storeId` 对得上，才允许删源上的库、WAL/SHM、附件和锁；删完后指针清掉，下次打开设置不再追问。点「保留拷贝」也只清这个指针。在已迁走的旧目录上再拉起内核会清掉指针并换新 `storeId`，避免两份库假装是同一份。桌面单实例；数据目录旁写 `regenic.store.lock`（本进程 pid），改目录前要拿到这份锁。引擎 Kernel 卡片的 Disk 跟正在连的内核走：本机 sidecar 显示库/附件和盘剩余；只有真正连上自定义内核时才不统计本机目录（显示 —，不显示 0 B）。`regenic.store.lock` / `regenic.store.json` / `regenic.relocated.json` 与 `*.db` 一样不进 git。Memory 由桌面主进程用 pid / `ps` 采样内核和自身，不经过 sidecar 的 HTTP；内核涨得太高或进程没了，顶栏也会标出来。

## `/v1/me`

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/v1/me/inbox` | 默认显示列表（桌上的活且未 hidden）；`list=hidden` 为不显示的会话。可选 `body_text`。`heads=1` 每个会话最后一条可见消息的短脸，不含附件；可加 `limit` / `before` / `before_id` 按会话脸分页（不传 `limit` 仍一次返回全部，兼容旧客户端）。`split=1` 时 heads 回 `{ pinned, live, active_work, next_before, has_older }`：置顶和进行中工单不进 `live`，翻页游标只从 `live` 出。`thread_id` 只返回该会话全文；`since` / `since_id` 做增量。每项带 `prompts`、`unread`、`unread_count`、`record_class`、`thread_facet`、`attention`、`work`、`hidden`；打开的线程另带 `can_receipt` / `receipt` |
| GET | `/v1/me/inbox/:event_id` | 单条 + 出处 + 正文 |
| GET | `/v1/me/engine` | 内核、库路径、live pull 间隔/上次 tick、已安装连接器、未安装目录、已安装执行器与执行器种类目录。目录项带 `docs`（`href` / `href_zh` 指向 GitHub 规范页）。`inbox_count` 是显示列表里的会话数。`detail=0` 跳过 catalog 探测和 attempt 列表，仍带 `inbox_digest`（含最新 Event、conversation prefs；有 live surface 时追加 `&s=`）以及执行器安装 |
| GET | `/v1/me/store` | 当前内核本机数据盘点：会话 / 消息 / 工单 / 附件 / 规则 / 连接器 / 执行器数量 |
| POST | `/v1/me/store/clear` | 清空当前工作、导入历史、附件和工单，重置连接器游标。保留已安装连接器、执行器和 Recipes。已启用的连接器会从头再拉。设置页二次确认后调用 |
| POST | `/v1/me/connectors` | 从目录安装（Slack / DSH / 飞书），不接收 token；安装后立刻种最近一批，响应不等待历史拉完 |
| POST | `/v1/me/connectors/:id/config` | 改已安装连接器的非密钥配置（同一套 catalog 字段），不丢游标；enabled 时立刻再开始 pull，响应不等待追平 |
| DELETE | `/v1/me/connectors/:id` | 卸载安装记录和游标，保留已入库消息 |
| POST | `/v1/me/connectors/:id/sync` | 手动追平。Slack 一页频道；DSH web 默认同步全部会话（每路最多 5 页）。日常不用点 |
| POST | `/v1/me/connectors/:id/enable` | 启用连接器，并立刻再开始 pull；响应不等待追平 |
| POST | `/v1/me/connectors/:id/disable` | 停用连接器，停止 pull |
| POST | `/v1/me/conversations` | 让连接器开一条新会话。省略 `installation_id` 时取第一条 `can_create` 的安装。驱动 `create: false` 时 501 |
| POST | `/v1/me/conversations/prefs` | 维护会话标题、置顶和不显示。`thread_id` 必填；`title` 空字符串清除自定义标题，回到自动标题；`pinned` / `hidden` 可单独改。人点「不显示」写 `hidden=true`（reason=`human`）。inbox 项带回 `thread_id` / `title` / `pinned` / `hidden` / `pref_updated_at` |
| POST | `/v1/me/conversations/attention` | 写本地已读游标；驱动声明了 `attention` 再 ack 来源 |
| POST | `/v1/me/conversations/prompts` | 回答未决 Prompt。禁止再走 egress。`not-pending` 视为已解决 |
| GET/POST | `/v1/me/recipes` | 列出 / 创建 Recipe |
| POST | `/v1/me/recipes/:id` | 更新 Recipe |
| DELETE | `/v1/me/recipes/:id` | 删除 Recipe |
| GET | `/v1/me/executors` | 已启用执行器的调用目录（规则页用） |
| POST | `/v1/me/executors` | 安装执行器：`local_connector`（选能新建会话的本机连接器）或 `http`（`base_url` + 可选 `auth_env`） |
| POST | `/v1/me/executors/:id/config` | 改名称或绑定（钉死连接器 / 改 URL）。不收 token |
| DELETE | `/v1/me/executors/:id` | 卸载执行器安装；规则仍在，指向它会失败 |
| POST | `/v1/me/executors/:id/enable` | 启用并挂上目录 |
| POST | `/v1/me/executors/:id/disable` | 停用并从规则目录拿掉 |
| POST | `/v1/me/work-items/:id/run` | 手动启动一条工单（桌面 Start run） |
| POST | `/v1/me/work-items/:id/dismiss` | 从当前工作拿掉并按策略折叠到不显示；不写回 |
| POST | `/v1/me/work-items/:id/complete` | dismiss 的别名；不冒充 DSH 退出 |
| GET/POST | `/v1/me/prefs` | `inbox_sort`：`attention` 或 `normal`；`inbox_list`：`shown` 或 `hidden` |
| POST | `/v1/me/replies` | 把回复发回原渠道。API 按 installation + thread 找 `ChannelDriver`，再 `egress.send`。入库后 follow 该线程直到出现新的 inbound / `working` / `awaiting_user` 或短暂超时；驱动 `canReply: false` 时 501 |
| POST | `/v1/me/forwards` | 把源线程的 utterance 编译后发到**另一条** `can_send` 线程，或 `create: true` 在 `can_create` 安装上新建（DSH 先 `createThread` 再 send；Cursor `create_with_task` 把第一包当任务，只 ingest 出站）。可多选 `event_ids`。编译正文按句带 `[Attached: 文件名]`，bytes 仍走附件。目标气泡用 `forwarded_from.channel_label` 画出处 chip。不改 `thread_id`，不扩展 replies。不能建会话的安装仍 501。见 [RFC 0010](rfcs/0010-cross-channel-forward.md) |
| POST | `/v1/me/imports` | 按 catalog `import_files` 导入用户自选文件。`{ connector_type, content, file_name }`。驱动 `parseImport` 译成 ingest batch，内核写 Event。不必先安装该连接器。 |
| POST | `/v1/me/imports/whatsapp` | 上一路由的别名，固定 `connector_type=whatsapp-web-live`。 |
| GET | `/v1/me/engine` | 含 `plugin_dir`（默认 `~/.regenic/plugins`）和 `plugins` 库存。 |
| GET | `/v1/me/plugins` | 插件库存：已加载 / 跳过 / 失败。第一方 `trust=core`，额外包 `trust=unsigned`。引擎页也会带上这份列表。 |
| POST | `/v1/me/plugins/reload` | 扫描 extra 插件目录，只注册尚未存在的 `connector_type` / executor source。不替换已加载驱动。 |
| GET | `/health` | 个人模式查 SQLite 是否已打开；不探 Postgres，也不探 DSH。`mode=personal` 即 sidecar 就绪 |

不返回连接器 token 或 quarantine 正文。内核在跑且连接器 enabled 时按约 3 秒 pull 一次（`REGENIC_CONNECTOR_PULL_MS` 可改）。人在操作时同 tick 串行、只跟少量会话的新消息；空闲时再补一页历史。流上的 `pace` 由连接器声明：飞书追上后约 15 秒再扫，DSH 不写 `pace`，仍每 tick 跟。对话窗发送后会更快跟当前 DSH session。引擎 Sync 只是漏了再追平。凭证只读环境变量。

## 连接器：同步范围与前置步骤

安装和前置检查都由 `/v1/me/engine` 的 **catalog** 驱动：每个驱动用 `installCatalog()` 声明标题、`fields`（含默认值、是否必填、`visible_when`）、`prerequisites` 和可选的 `import_files`。Slack、DSH、飞书和额外插件同一套。`ready` / `hint` 由该驱动的 `probeCatalog()` 探测，已装行的文案由 `presentInstall` 提供，API 只合并，引擎页只渲染，不按连接器类型写死 UI。规范链接（`docs`）挂在分区标题旁，点开用系统浏览器打开 GitHub 页。额外包由 `REGENIC_PLUGIN_DIR` 或 `REGENIC_CHANNEL_PLUGIN` 加载；新类型可热发现，已加载的驱动不会被替换。

| 连接器 | 安装要填 | 前置 | 同步范围 |
| --- | --- | --- | --- |
| Slack | `channel_id`（频道名可选） | 启动前设好 `REGENIC_SLACK_TOKEN`（Slack 应用的 bot token）。表单不收 | 只拉该频道。安装后立刻拉，之后内核轮询 |
| DSH web（本机） | `base_url` 默认 `http://127.0.0.1:3080`；`session_id` **可选** | 目录会探测 `dsh web`，但探测失败不挡安装。装完后要本机 `dsh web --port 3080` 在跑，内核才能拉。`REGENIC_DSH_TOKEN` 仅在 DSH 要求 Bearer 时需要 | 未填 session 时用 DSH `session.list` 拉齐全部会话，每个 session 走自己的 `session:${id}` 游标。安装后立刻拉，之后内核轮询。填了则只跟那一条 |
| DSH web（托管） | 只填可选 `session_id`；不填 `base_url` | 内核环境变量 `REGENIC_DSH_BASE_URL`（集群 DNS） | 同上；核心只走内网，不要填 Sealos 公网 URL |
| DSH CLI | mailbox 可选 | 本机 `dsh` 命令 | 该 mailbox 一条流 |
| 飞书 | 弹窗里默认勾选全部群和全部单聊；也可勾选具体会话。安装后随时 Edit sync | 没装则 `npx @larksuite/cli@latest install`；装了未登录则 `lark-cli config init` 和 `lark-cli auth login --recommend`。内核不代装 | 按选择拉群和单聊，记录群名/对方名和发送者名。安装后立刻拉，之后内核轮询。入站同步文本、图片和文件；回写同样支持。图片走 `im images create`（`image_type=message`）再发 `msg_type=image`，和正文同一用户身份；不把图塞进富文本 post |

DSH 安装不接收 token / `command` / `workdir`。本机 `base_url` 必须是回环；托管内核忽略表单里的公网 URL，一律用 `REGENIC_DSH_BASE_URL`。

## 执行器：本机连接器与 HTTP

引擎页的执行器和连接器分开管。规则页只列出**已启用**的安装。执行器目录同样声明 `docs`，在「执行器」标题旁打开执行器规范与 RFC 0009。

| 种类 | 安装要填 | 运行时 |
| --- | --- | --- |
| 本机连接器 | 选一个 `create: true` 的已装连接器（现在是 DSH） | 在该安装上 `createThread`，再经 `ExecutorContext` 写 stdin / 读 transcript。空绑定（默认 `dsh`）仍自动找第一个能建会话的 DSH |
| HTTP API | `base_url`；可选 `auth_env`（Bearer 所在环境变量名，表单不收 token） | `POST {base}/v1/runs`、`GET {base}/v1/runs/:id`、`POST {base}/v1/runs/:id/resume`。内核把 `executor_config` 当不透明袋转交，不读 key |

升级后若还没有执行器安装，内核会写入一条 id 为 `dsh` 的本机绑定，旧规则不用改。私有 Agent 仍不得 import 进内核；外部运行时走这条 HTTP 协议或以后的插件包。

## 启动

```bash
pnpm dev:desktop
```

需已能 `pnpm --filter @regenic/api... build`。无 Inbox 数据时，在引擎页安装连接器，内核会自己拉。

## 本版不做

Slack 回写、OAuth 授权流、标准编辑、渠道 webhook/push、Windows/Linux 打包。渠道目前是 pull 轮询，不是事件推送。
