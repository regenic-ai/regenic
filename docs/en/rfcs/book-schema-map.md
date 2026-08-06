# Book ↔ Regenic schema map (draft)

- **中文:** [../../zh/rfcs/book-schema-map.md](../../zh/rfcs/book-schema-map.md)
- **Source:** `regenic-ai/regenic-book` `content/*/standards/`
- **Product model:** [RFC 0001](0001-standards-data-model.md)
- **Status:** Draft mapping for SoftGate; update when book or RFC 0001 changes

## 1. Scope of alignment

| Book path | Role for Regenic |
| --- | --- |
| `content/*/standards/README.md` | Five-part publishable standard shape |
| `content/*/standards/product-iteration-standard.md` | Iteration discipline + adoption segments → gates |
| `content/*/standards/book-standard.md` | Editorial book standard — **out of product runtime** |
| `content/*/standards/prose-standard.md` | Prose fluency — **out of product runtime** |
| `content/*/standards/chapter-template.md` | Chapter one-pager — **out of product runtime** |

Only README + `product-iteration-standard` must map into machine-readable org
standards. Book/prose/chapter files stay methodology, not API resources.

## 2. Five-part standard body

From book standards README → RFC 0001 `StandardVersion`:

| Book concept | Regenic field | Notes |
| --- | --- | --- |
| Condition | `condition` | markdown/string |
| Action | `action` | |
| Acceptance | `acceptance` | observable evidence |
| Boundary | `boundary` | stop / escalate |
| Revision trigger | `revision_trigger` | forced change evidence |

Import/export must preserve these five as first-class fields (RFC 0001 §7).

## 3. Product iteration → `IterationGate`

Book `product-iteration-standard` does not use the same five numbered product
gates as RFC 0001 §4.4. Mapping is interpretive — resolve before 0001 Accept.

| Book rule / concept | Regenic field(s) | Match |
| --- | --- | --- |
| Rogers segments (Innovators … Laggards) | `gate.target_user_tier` | Direct enum map |
| Single-variable changes in pilots | lifecycle rule §5.1 + `gate.single_uncertainty` | Aligned |
| Frozen acceptance criteria before investment | `acceptance` + trial `success_metric` | Aligned in spirit |
| Two-sided evidence (success and failure) | `UpgradeEvidence` + `learning_output` | Partial — book is narrative; product needs booleans |
| Explicit rollback until proven | `gate.compat_and_rollback` + `UpgradeEvidence.rollback_safe` | Aligned |
| Earn survival from existing consensus first | `gate.consensus_hypothesis` | Soft map |
| Core principle / cash-flow expansion | — | Not a field; product non-goal for v1 |

### Open mismatches — proposed resolutions (Wave A review)

Pending maintainer confirm on Issues [#1](https://github.com/regenic-ai/regenic/issues/1) /
[#8](https://github.com/regenic-ai/regenic/issues/8):

1. **Gate numbering:** **Keep** RFC 0001 five machine-checkable gates.
   Book `product-iteration-standard` four rules + Rogers segments are normative
   commentary and segment enum source — not a competing gate numbering scheme.
2. **`UpgradeEvidence` booleans:** **Keep** as Regenic productization of
   “two-sided evidence / frozen acceptance / rollback” — no 1:1 book headings
   required. Document in import docs as product fields.
3. **`layer`:** **Product-only** enum; not imported from public book markdown.
   Book editorial standards (`book-standard`, `prose-standard`) stay out of runtime.

## 4. Identity & citation

| Book | Regenic |
| --- | --- |
| Markdown file slug under `/standards/{slug}` | `Standard.slug` |
| Human title (H1) | `Standard.title` |
| Semver / revision history (book versions page) | `StandardVersion.version` — confirm policy in 0001 §9 |

## 5. SoftGate checklist

- [x] Five-part body map accepted (README ↔ `StandardVersion` five fields)
- [ ] Iteration / gate mismatches confirmed (see proposed resolutions above)
- [x] EN + ZH copies of this file stay in sync
- [ ] Maintainer sign-off on Issues #1 / #8 — then close #8 and Accept 0001
