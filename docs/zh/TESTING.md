# 自动化测试

仓库继续使用 Node 内置的 `node:test`，不整体替换为 Jest/Vitest。支持的本地和 CI 测试运行时为 Node 22.12+（22.x）或 Node 24+；桌面测试依赖 Node 类型剥离，Electron 冒烟测试还需要先构建桌面端和 API。先安装锁定的工作区依赖：

```sh
pnpm install --frozen-lockfile
pnpm test:ci
```

`test:ci` 是 Pull Request 门禁：依赖边界检查、工作区 build/typecheck、现有包测试，以及生产依赖模式下的打包 SDK 消费者检查。API 原有 `personal-api*.test.cjs` 测试仍单独串行，其余测试按既有命令执行。构建、类型检查、测试和依赖边界失败都会阻断任务。依赖清单及审计发现以脱敏证据形式输出到已忽略的 `coverage/test-evidence/`；已存在的依赖公告只报告，不静默豁免，也不作为已知长期失败的门禁。审计传输或结果结构错误仍会失败。

工作流提供稳定的 `Core / Node 22.12.0`、`Core / Node 24.12.0` 检查，并在 Linux 和 macOS 运行 `Desktop / <OS>`。Nightly 执行完整 PR 回归、十轮确定性的宿主生命周期重复测试，以及外置连接器源码兼容性测试。手动 workflow dispatch 另外运行候选 SDK 矩阵和打包消费者验证；GitHub Release 发布后会针对该发布源码 SHA 运行打包消费者测试。所有任务仅有只读仓库权限，并上传短期 JSON 证据，包含源码 SHA、锁文件/打包文件 SHA-512、包版本和脱敏结果。

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

`scripts/testing/connectors.json` 记录 Slack、WhatsApp、DingTalk、WeCom、Telegram、Discord、Claude Code、GitHub Copilot 的默认分支精确 SHA 与真实契约范围。支持的 `stable` 模式使用已发布 contract 0.2.0；仅对声明范围支持的包，`candidate` 模式才使用当前 0.3.0 core SDK。每轮测试会在验证前后记录源码侧解析到的 `@regenic/connector-contract` 身份（路径 + realpath + 版本），避免只看最终消费者版本。

每个连接器显式声明消费者兼容模式：

- `packed-npm`：连接器打包后安装到隔离生产消费者，断言 host/plugin 解析到同一 contract 实例并加载声明贡献项。
- `clone-root-absolute`（GitHub Copilot）：在连接器源码根执行 frozen install/build/typecheck/test，并记录 root audit 证据；随后用源码绝对路径加载插件，断言 host/plugin 解析同一 contract 实例。

对 Copilot 而言，Zod 4.6.7 override 的验证点是 **Copilot 连接器源仓库根目录**（`clone-root-absolute` 模式），并不声称任意下游 tarball 消费者会自动继承该 override。不会通过覆盖不兼容声明范围来“强行通过”测试。

桌面测试 lane 运行现有隔离单元测试、Electron 生产构建和真实 Electron semantic smoke，使用合成的本地 embedding HTTP 服务及临时数据库/配置目录。它不登录账号、不调用外部模型、不发送消息，也不启动真实 Agent。Linux 在 Xvfb 中运行；CI macOS lane 提供原生 macOS 验证。

真实账号/线上验证必须人工选择并确认专用测试账号或租户的所有权，使用正常秘密存储取得最小权限凭据，明确测试是否会创建或发送真实内容，并显式批准操作。凭据不得放入 workflow 变量、夹具、日志或测试产物。CI 不提供线上测试开关，也不会执行这些行为。
