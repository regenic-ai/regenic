# 客服场景评测门禁

Regenic 提供一组冻结、无隐私数据的客服回归集和确定性合并门禁，用来验证授权检索、对话展开、证据绑定、成员集合闭合、业务结果边界、上下文失效和发送前事实复查能否持续协同工作。

## 运行门禁

```powershell
pnpm --filter @regenic/context-engine eval:customer-service
```

命令会构建所需 workspace 包、执行全部 60 条用例、输出确定性 JSON 报告，并在任一阈值失败时以非零状态退出。同一门禁也包含在 Context Engine 测试套件中：

```powershell
pnpm --filter @regenic/context-engine test
```

## 用例集

`customer-service-synthetic-regression-v1` 共 60 条：12 个类别，每类 5 个变体。

| 类别 | 必须保证的行为 |
|---|---|
| `reference_resolution` | 找回“上次选中的人”等指代背后的范围。 |
| `set_closure` | 保留预期数量和精确成员集合。 |
| `reply_chain` | 把原生回复目标纳入证据。 |
| `continuation_gap` | 在有界续读过程中不丢失必要消息。 |
| `identity_ambiguity` | 身份有歧义时澄清，不能直接确认。 |
| `cross_conversation_scope` | 客户/项目范围未核验前禁止跨会话检索。 |
| `business_not_found` | 绝不能把 `not_found` 翻译成“尚未回复”。 |
| `business_denied` | `permission_denied` 不能支持客户回复。 |
| `business_unavailable` | 业务源不可用时不能编造状态。 |
| `internal_visibility` | 内部字段不能支持客户可见结论。 |
| `stale_context` | Authority read epoch 变化后必须拒绝旧 continuation。 |
| `business_changed` | 发送前业务事实变化必须使批准失效。 |

每条用例都经过真实的确定性 Context Engine retriever 和 `CustomerServiceCoordinator`。执行器使用 oracle 解释提供实体抽取结果，使该门禁不依赖具体模型并保持可重复。

## 合并阈值

| 指标 | 门槛 |
|---|---:|
| 用例数量 | 至少 60 |
| 必要证据召回率 | 至少 95% |
| 精确成员集合闭合 | 100% |
| Citation/Event/content hash 有效率 | 100% |
| 预期动作正确率 | 100% |
| 必须检测的 stale context | 100% |
| 禁止的客户可见结论 | 0 |

报告包含每条用例缺失的证据、集合闭合状态、无效引用、动作错误、禁止结论，以及确定性的 `content_hash`。耗时不会进入质量哈希。

## 用例治理

- 只能使用合成数据或不可逆脱敏内容。
- 已有标签保持冻结；改变用例含义、标签或类别组成时必须升级 dataset ID。
- 修复新发现的问题前，先加入能够复现它的回归用例。
- 不允许通过降低阈值让代码通过。
- 开发回归集必须与未来真实保留确认集分开。
- 条件允许时，用例集变更和检索实现变更应独立审核。

## 范围与限制

该门禁验证确定性本地检索和工作流安全边界，但**不代表**已经验证：

- 模型推理或提示词质量；
- 生产连接器同步完整性；
- 真实租户授权配置；
- 远端业务服务正确性；
- 生产延迟、并发或容量。

该门禁通过后，还应使用真实 Cursor/MCP 客户端、生产近似连接器、受控业务测试服务和单独治理的真实保留确认集复验同类场景。
