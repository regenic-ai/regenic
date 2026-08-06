# Book ↔ Regenic schema map

- **中文:** [../../zh/rfcs/book-schema-map.md](../../zh/rfcs/book-schema-map.md)
- **Source:** `regenic-ai/regenic-book` `content/*/standards/`
- **Product model:** [RFC 0001](0001-standards-data-model.md)
- **Tracking:** [#8](https://github.com/regenic-ai/regenic/issues/8), [#1](https://github.com/regenic-ai/regenic/issues/1)

## Scope

| Path | In product schema |
| --- | --- |
| `standards/README.md` | yes — five-part body |
| `standards/product-iteration-standard.md` | yes — iteration rules + user tiers |
| `standards/book-standard.md` | no |
| `standards/prose-standard.md` | no |
| `standards/chapter-template.md` | no |

## `StandardVersion` body

| Book section | Field |
| --- | --- |
| Condition | `condition` |
| Action | `action` |
| Acceptance | `acceptance` |
| Boundary | `boundary` |
| Revision trigger | `revision_trigger` |

On import/export these five must be separate fields, not only embedded in one markdown body (RFC 0001 §7).

## Iteration → `IterationGate` / `UpgradeEvidence`

Left = book requirement; right = RFC 0001 field. Headings are not 1:1.

| Book requirement | Product |
| --- | --- |
| Which user segment this round targets (innovator … laggard) | `gate.target_user_tier` |
| Pilot validates one uncertainty only | lifecycle §5.1, `gate.single_uncertainty` |
| Write success criteria before investing | `acceptance`, `trial.success_metric` |
| Capture pass/fail evidence for promotion; record what was learned | `UpgradeEvidence`, `gate.learning_output` |
| Document rollback while not yet proven repeatable | `gate.compat_and_rollback`, `UpgradeEvidence.rollback_safe` |
| State assumed user consensus | `gate.consensus_hypothesis` |
| Expand innovation scope only after cash flow | no field (v1 non-goal) |

## Decisions (#8 — approved)

- [x] **Gates follow RFC 0001.** Product keeps five machine-checkable gates; book iteration text is commentary only (no second gate scheme). User-tier enums still come from the book.
- [x] **Keep `UpgradeEvidence` in the product model.** trial→active uses true/false evidence fields even if the book has no matching headings.
- [x] **`layer` is product-only.** `stable_core` / `adjacent` / `frontier` are not imported from book markdown.

## Identity

| Book | Product |
| --- | --- |
| `/standards/{slug}` | `Standard.slug` |
| H1 title | `Standard.title` |
| Version string | `StandardVersion.version` (default semver; RFC 0001 §9) |

## SoftGate

**Complete.** Decisions approved; #8 closed; RFC 0001 Accepted.
