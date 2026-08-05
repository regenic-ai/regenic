# Documentation locales

This document defines how Regenic manages multilingual docs. It follows
patterns used by Kubernetes (`content/<lang>/`), VitePress / Mintlify
(locale directories + mirrored paths), Hugo Docsy, and this org’s
[regenic-book](https://github.com/regenic-ai/regenic-book) (`content/en`,
`content/zh`).

## Principles

1. **English is canonical** for product semantics (RFCs, APIs, enums, schemas).
2. **Locale folders mirror paths and filenames** so missing translations are
   obvious and automation stays simple.
3. **One locale per PR** when changing translated prose (Kubernetes rule);
   English semantic changes may land first, translations follow.
4. **Identifiers stay English** everywhere: field names, HTTP paths, status
   enums, SQL, code samples.
5. **Fix upstream (English) first** when the issue is factual; then sync locales.

## Locale codes

| Folder code | BCP 47 / HTML `lang` | hreflang | Notes |
| --- | --- | --- | --- |
| `en` | `en` | `en` | Default / canonical |
| `zh` | `zh-CN` | `zh-CN` | Simplified Chinese; folder code matches `regenic-book` |

Do **not** mix `zh`, `zh-CN`, and `zh-Hans` as *folder* names. Use `zh` on
disk; use `zh-CN` only where HTML/SEO needs a region tag.

## Layout

```text
README.md                 # English GitHub entry (required by GitHub)
README.zh-CN.md           # Chinese GitHub entry (GitHub README locale suffix)

docs/
  LOCALES.md              # this file (English)
  en/                     # canonical docs tree
    ROADMAP.md
    rfcs/
      README.md
      0001-….md
      sketch/             # non-translated helpers (SQL, diagrams source)
  zh/                     # Simplified Chinese — same relative paths
    ROADMAP.md
    rfcs/
      README.md
      0001-….md
```

### Why root README uses a suffix

GitHub only auto-surfaces locale READMEs at the **repository root** via the
`README.<locale>.md` convention (e.g. `README.zh-CN.md`). All other docs use
**folder locales** (`docs/en/…`, `docs/zh/…`), not filename suffixes.

### Shared / non-translated artifacts

Put language-neutral sketches (SQL, machine schemas) under `docs/en/rfcs/sketch/`
(or a future `docs/shared/`). Locale copies **link** to them; do not diverge
the bytes per language.

## Sync rules

| Change type | Order |
| --- | --- |
| New RFC / roadmap item | Write `docs/en/…` → translate to `docs/zh/…` in a follow-up (or same PR if ready) |
| Semantic edit | Edit English first; mark ZH stale or update in the same change |
| Translation-only polish | PR touches only `docs/zh/` (and root `README.zh-CN.md` if needed) |
| Conflict EN vs ZH | English wins |

Do **not** put locale policy or “English wins” narration into reader-facing
pages. A single quiet alternate link is enough, e.g. `[简体中文](…)` /
`[English](…)`. Keep process rules in this file only.

## Completeness checklist

For each English path under `docs/en/`, a file with the **same relative path**
should exist under `docs/zh/` (except `sketch/` and other shared assets).

Optional front matter later (when a docs site is added):

```yaml
---
locale: zh
canonical_path: /docs/en/rfcs/0001-standards-data-model.md
translation_status: current   # current | stale | wip
---
```

## References

- [Kubernetes — Localizing documentation](https://kubernetes.io/docs/contribute/localization/)
- [VitePress — Internationalization](https://vitepress.dev/guide/i18n)
- [Mintlify — Internationalization](https://www.mintlify.com/docs/guides/internationalization)
- [Hugo — Multilingual mode](https://gohugo.io/content-management/multilingual/)
- [MkDocs static i18n — folder vs suffix](https://ultrabug.github.io/mkdocs-static-i18n/setup/choosing-the-structure/)
