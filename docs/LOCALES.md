# Documentation locales

Rules for English and Chinese docs in this repository.

## Rules

1. English under `docs/en/` is the source for product semantics.
2. `docs/zh/` mirrors the same relative paths and filenames.
3. Prefer one locale per translation PR.
4. Field names, HTTP paths, enums, SQL, and code samples stay English.
5. Fix factual errors in English first, then sync Chinese.

## Codes

| Folder | HTML `lang` / hreflang |
| --- | --- |
| `en` | `en` |
| `zh` | `zh-CN` |

Folder name is `zh` (same as `regenic-book`). Use `zh-CN` only for HTML/SEO tags.

## Layout

```text
README.md
README.zh-CN.md           # GitHub root locale README only

docs/
  LOCALES.md
  en/
    TECH_STACK.md
    ROADMAP.md
    rfcs/
  zh/
    TECH_STACK.md
    ROADMAP.md
    rfcs/
```

Root uses `README.<locale>.md` because GitHub only detects that pattern at repo root. All other docs use `docs/<locale>/`.

Language-neutral files (e.g. SQL sketches) live under `docs/en/rfcs/sketch/`; other locales link to them.

## Sync

| Change | Order |
| --- | --- |
| New or semantic edit | `docs/en/` then `docs/zh/` |
| Translation only | `docs/zh/` (and `README.zh-CN.md` if needed) |

Reader pages: language switch link only (`[简体中文](…)` / `[English](…)`). Keep process text in this file.
