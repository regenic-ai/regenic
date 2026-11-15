# 自动化测试

仓库继续使用 Node 内置的 `node:test`，不整体替换为 Jest/Vitest。支持的本地和 CI 测试运行时为 Node 22.14+（22.x）或 Node 24+，且 Node-API 至少为 10。`better-sqlite3` 13 的预编译插件要求 Node-API 10；Node 22.12 只提供版本 9，打开数据库可能崩溃。测试 lane 会在加载原生插件前拒绝不兼容运行时。桌面测试依赖 Node 类型剥离，Electron 冒烟测试还需要先构建桌面端和 API。先安装锁定的工作区依赖：

```sh
pnpm install --frozen-lockfile
pnpm test:ci
```

`test:ci` 是 Pull Request 门禁：依赖边界检查、工作区 build/typecheck、现有包测试，以及生产依赖模式下的打包 SDK 消费者检查。API 原有 `personal-api*.test.cjs` 测试仍单独串行，其余测试按既有命令执行。构建、类型检查、测试和依赖边界失败都会阻断任务。依赖清单及审计发现以脱敏证据形式输出到已忽略的 `coverage/test-evidence/`；已存在的依赖公告只报告，不静默豁免，也不作为已知长期失败的门禁。审计传输或结果结构错误仍会失败。

工作流提供稳定的 `Core / Node 22.14.0`、`Core / Node 24.12.0` 检查，并在 Linux 和 macOS 运行 `Desktop / <OS>`。Nightly 执行完整 PR 回归、十轮确定性的宿主生命周期重复测试，以及外置连接器源码兼容性测试。手动 workflow dispatch 另外运行候选 SDK 矩阵和打包消费者验证；GitHub Release 发布后会针对该发布源码 SHA 运行打包消费者测试。所有任务仅有只读仓库权限，并上传短期 JSON 证据，包含源码 SHA、锁文件/打包文件 SHA-512、包版本和脱敏结果。

常用聚焦命令：

```sh
pnpm test:host
REGENIC_SOAK_ITERATIONS=25 pnpm test:soak
pnpm test:consumer
pnpm test:desktop
pnpm test:report
pnpm test:compatibility -- --connector dingtalk --sdk stable
pnpm test:compatibility -- --connector dingtalk --sdk candidate
```

真实宿主执行器测试使用实际 API、Nest host、SQLite authority store、driver/executor registry 和 installation lifecycle；只有外部执行器边界由临时子进程 JSON-RPC 服务代替。测试用显式 barrier 确定并发顺序，不依靠 sleep。每个测试使用隔离的临时 HOME/config/data/database/blob 目录和系统分配的本地端口，并关闭自有服务及子进程、确认端口已关闭后删除夹具。覆盖仅读取元数据不激活、多个组织/安装绑定、阻止 recipe 覆盖 pin、启用/禁用/重配置/删除、持久化重启后不复活旧代、跨安装/跨组织拒绝、排空已准入任务以及子进程清理。现有持久回复恢复测试覆盖结果未知时不自动重放。

`scripts/testing/connectors.json` 记录 Slack、WhatsApp、DingTalk、WeCom、Telegram、Discord、Claude Code、GitHub Copilot 的默认分支精确 SHA、冻结源码 SDK 预期版本与真实契约范围。两种模式都按源码锁文件冻结安装、构建、类型检查和测试；必需的 link 脚本使用指向同一批冻结安装包的 SDK 目录布局，不指向候选 core。因此 DingTalk/WeCom 即使在 candidate 模式，源码阶段仍使用 contract 0.2.0；Claude/Copilot 源码阶段使用 registry contract 0.3.0。candidate lane 随后将当前 core SDK 打成 `.tgz`，安装到拥有独立 manifest 且路径已规范化的消费者，校验 npm lock 精确顶层条目中的本地 tarball 解析路径和 SHA-512 完整性，并断言插件加载实际解析到候选 contract 的真实路径和版本；同版本 registry 包无法通过身份断言。不宣称验证了候选 SDK 下的源码编译。

每个连接器显式声明消费者兼容模式：

- `packed-npm`：连接器打包后与 stable SDK 包或 candidate SDK `.tgz` 一起安装到隔离消费者；由实际编译后的 API 插件 loader 加载连接器，并按 core protocol 边界校验贡献项。core 和插件不要求共享物理 contract 实例。
- `clone-root-core-loader`（GitHub Copilot）：保留源码根 frozen install/build/typecheck/test 和 audit；从 Copilot SDK 入口实际解析并验证 Zod 4.6.7；再由编译后的 API loader 加载构建产物但不激活。candidate 模式通过隔离的模块解析 overlay 提供已打包的 candidate SDK。core 与克隆连接器刻意使用独立依赖根。

对 Copilot 而言，Zod 4.6.7 override 不仅检查源码根配置，还会验证 **Copilot SDK 入口实际解析到的 Zod 包版本**。这不代表任意下游 tarball 消费者会自动继承该 override。不会通过覆盖不兼容声明范围来“强行通过”测试。

桌面测试 lane 运行现有隔离单元测试、Electron 生产构建和真实 Electron semantic smoke，使用合成的本地 embedding HTTP 服务及临时数据库/配置目录。它不登录账号、不调用外部模型、不发送消息，也不启动真实 Agent。Linux 在 Xvfb 中运行；临时 CI runner 在启动前将 Electron 的 `chrome-sandbox` helper 配置为 root 所有、权限 4755，不禁用 Chromium sandbox。本地 Linux 运行也需要对应的 Electron sandbox 配置。CI macOS lane 提供原生 macOS 验证。

`pnpm test:tooling` 还运行离线 npm pack/install/lock 回归，以及信号杀死、已经退出、失败退出三种独立子进程测试。冒烟测试在异步清理前设置非零退出码；清理复用最初注册的退出 promise，并限制 kill 等待时间。

真实账号/线上验证必须人工选择并确认专用测试账号或租户的所有权，使用正常秘密存储取得最小权限凭据，明确测试是否会创建或发送真实内容，并显式批准操作。凭据不得放入 workflow 变量、夹具、日志或测试产物。CI 不提供线上测试开关，也不会执行这些行为。
