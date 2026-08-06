# Book ↔ Regenic schema 对照（草稿）

- **English:** [../../en/rfcs/book-schema-map.md](../../en/rfcs/book-schema-map.md)
- **来源：** `regenic-ai/regenic-book` `content/*/standards/`
- **产品模型：** [RFC 0001](0001-standards-data-model.md)
- **状态：** SoftGate 用草稿映射；book 或 RFC 0001 变更时同步更新

## 1. 对齐范围

| Book 路径 | 对 Regenic 的角色 |
| --- | --- |
| `content/*/standards/README.md` | 可发布标准的五段形状 |
| `content/*/standards/product-iteration-standard.md` | 迭代纪律 + 采纳分段 → 闸门 |
| `content/*/standards/book-standard.md` | 书稿编辑标准 — **不进产品运行时** |
| `content/*/standards/prose-standard.md` | 行文流畅标准 — **不进产品运行时** |
| `content/*/standards/chapter-template.md` | 章节一页纸 — **不进产品运行时** |

仅 README + `product-iteration-standard` 必须映射为机读组织标准。
书稿/行文/章节模板保持方法论，不作 API 资源。

## 2. 标准正文五段

Book standards README → RFC 0001 `StandardVersion`：

| Book 概念 | Regenic 字段 | 说明 |
| --- | --- | --- |
| Condition（适用条件） | `condition` | markdown/string |
| Action（行动） | `action` | |
| Acceptance（验收） | `acceptance` | 可观察证据 |
| Boundary（边界） | `boundary` | 停止 / 升级 |
| Revision trigger（修订触发） | `revision_trigger` | 强制变更证据 |

导入/导出须将这五节作为一等字段保留（RFC 0001 §7）。

## 3. 产品迭代 → `IterationGate`

Book `product-iteration-standard` 与 RFC 0001 §4.4 的五闸门编号并不一一对应。
映射为解释性对照 — 须在 0001 Accept 前裁定。

| Book 规则 / 概念 | Regenic 字段 | 匹配度 |
| --- | --- | --- |
| Rogers 五段（Innovators … Laggards） | `gate.target_user_tier` | 直接枚举映射 |
| 试点单变量变更 | 生命周期 §5.1 + `gate.single_uncertainty` | 对齐 |
| 投资前冻结验收标准 | `acceptance` + trial `success_metric` | 精神对齐 |
| 正反两侧证据 | `UpgradeEvidence` + `learning_output` | 部分 — book 叙事，产品需布尔 |
| 证明可重复前显式回滚 | `gate.compat_and_rollback` + `UpgradeEvidence.rollback_safe` | 对齐 |
| 先从既有共识挣生存 | `gate.consensus_hypothesis` | 软映射 |
| 现金流扩展创新半径 | — | 非字段；v1 产品非目标 |

### 开放不一致 — 拟议裁定（Wave A 评审）

待维护者在 Issues [#1](https://github.com/regenic-ai/regenic/issues/1) /
[#8](https://github.com/regenic-ai/regenic/issues/8) 确认：

1. **闸门编号：保留** RFC 0001 五道可机检闸门。Book
   `product-iteration-standard` 的四条规则 + Rogers 分段是规范解说与分段枚举来源，
   不是另一套闸门编号。
2. **`UpgradeEvidence` 布尔项：保留**为 Regenic 对「双侧证据 / 冻结验收 / 回滚」的产品化 —
   不要求与 book 标题 1:1。导入文档中标明为产品字段。
3. **`layer`：仅产品侧**枚举；不从公开 book markdown 导入。
   书稿编辑标准（`book-standard`、`prose-standard`）不进运行时。

## 4. 身份与引用

| Book | Regenic |
| --- | --- |
| `/standards/{slug}` 下 markdown slug | `Standard.slug` |
| 人类标题（H1） | `Standard.title` |
| 版本页 semver / 修订史 | `StandardVersion.version` — 与 0001 §9 策略一并确认 |

## 5. SoftGate 清单

- [x] 五段正文映射已接受（README ↔ `StandardVersion` 五字段）
- [ ] 迭代 / 闸门不一致已确认（见上方拟议裁定）
- [x] 本文中英副本保持同步
- [ ] 维护者在 Issues #1 / #8 签字 — 然后关闭 #8 并 Accept 0001
