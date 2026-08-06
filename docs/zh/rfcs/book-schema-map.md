# Book ↔ Regenic schema 对照

- **English:** [../../en/rfcs/book-schema-map.md](../../en/rfcs/book-schema-map.md)
- **来源：** `regenic-ai/regenic-book` `content/*/standards/`
- **产品模型：** [RFC 0001](0001-standards-data-model.md)
- **跟踪：** [#8](https://github.com/regenic-ai/regenic/issues/8)、[#1](https://github.com/regenic-ai/regenic/issues/1)

## 范围

| 路径 | 是否进入产品 schema |
| --- | --- |
| `standards/README.md` | 是 — 正文五段 |
| `standards/product-iteration-standard.md` | 是 — 迭代规则 + 用户分段 |
| `standards/book-standard.md` | 否 |
| `standards/prose-standard.md` | 否 |
| `standards/chapter-template.md` | 否 |

## `StandardVersion` 正文

| Book 节 | 字段 |
| --- | --- |
| Condition | `condition` |
| Action | `action` |
| Acceptance | `acceptance` |
| Boundary | `boundary` |
| Revision trigger | `revision_trigger` |

导入/导出时这五个必须是独立字段，不能只落在一段 markdown 正文里（RFC 0001 §7）。

## 迭代 → `IterationGate` / `UpgradeEvidence`

左栏 = book 要求；右栏 = RFC 0001 落点。book 标题与产品字段不是一一对应。

| Book 要求 | 产品落点 |
| --- | --- |
| 标出这轮面向哪类用户（innovator … laggard） | `gate.target_user_tier` |
| 试点一次只验证一个不确定点 | 生命周期 §5.1、`gate.single_uncertainty` |
| 开干前写死「怎样算成功」 | `acceptance`、`trial.success_metric` |
| 成功/失败都要留下可勾选的晋升证据，并记下本轮学到什么 | `UpgradeEvidence`、`gate.learning_output` |
| 未证明可重复前，写清如何回滚 | `gate.compat_and_rollback`、`UpgradeEvidence.rollback_safe` |
| 写清假定的用户共识是什么 | `gate.consensus_hypothesis` |
| 有了现金流再扩大创新范围 | 无字段（v1 不做） |

## 已裁定（#8 — 已批准）

- [x] **闸门以 RFC 0001 为准。** 产品用五道可机检闸门；book 里的迭代条文只作说明，不另建一套闸门编号。用户分段枚举仍从 book 来。
- [x] **`UpgradeEvidence` 留在产品模型。** trial→active 用一组 true/false 证据字段；book 没有同名标题也没关系。
- [x] **`layer` 只在产品里有。** `stable_core` / `adjacent` / `frontier` 不从 book markdown 导入。

## 身份

| Book | 产品 |
| --- | --- |
| `/standards/{slug}` | `Standard.slug` |
| H1 标题 | `Standard.title` |
| 版本字符串 | `StandardVersion.version`（默认 semver；RFC 0001 §9） |

## SoftGate

**已完成。** 三项已批准；#8 已关闭；RFC 0001 已 Accepted。
