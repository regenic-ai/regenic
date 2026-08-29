# Documentation locales

Rules for English and Chinese docs in this repository.

## Rules

1. English under `docs/en/` is the source for product semantics.
2. `docs/zh/` mirrors the same relative paths and filenames.
3. Prefer one locale per translation PR.
4. Field names, HTTP paths, enums, SQL, and code samples stay English.
5. Fix factual errors in English first, then sync Chinese.

## Voice and style

Match public docs from Go, Vite, and Redis — not a manifesto, pitch deck, or diary.

### Page kinds

| Kind | Pages | Voice | Lead with |
| --- | --- | --- | --- |
| Map | Root README | Third person, then imperative | `Regenic is a …` then how to run it |
| Product | `PRODUCT.md` | Third person present | What the software is |
| Explanation | architecture, stack, integration | Third person present | The mechanism |
| How-to | Getting started, CLI, intake worksheets | Imperative | The command or the form |
| Reference | RFCs, ports, schemas | Third person; RFC headings as usual | The contract |
| Plan | `ROADMAP.md` | Third person; checklists as facts | What ships in each phase |

Tutorials may address the reader as `you` only when the reader performs the step. Elsewhere the subject is the product or a component: `Regenic ingests…` / `The kernel validates…`.

Do not narrate as `we` / `our` / `us` (or `我们`). First-person plural is only for contributing thanks (`Go is the work of thousands of contributors. We appreciate your help!`).

### Headings

Use nouns or established phrases:

- English: Overview, Getting started, Architecture, Configuration, Status, Out of scope
- Chinese: 概述、开始使用、架构、配置、状态、范围外

Do not use team or pitch headings: What we are, What we use, Why we built this, Our philosophy, Product positioning, Dual capability, 仓库长什么样, 当前不做, 决策 as a slogan.

RFC pages keep RFC convention (`Non-goals` is fine there). Reader pages use **Out of scope** / **范围外**.

### Lead

1. Name the thing: `Regenic is a message orchestration layer.`
2. One short paragraph of behavior (what it does).
3. Then scope, architecture, or how to run.
4. Put exclusions under Out of scope. Do not open a page with `X is not Y`.
5. Do not explain the product by naming another project, paper, or protocol metaphor.
6. Name a vendor only as a connector, driver, credential, or a named integration target.
7. Capability copy and architecture copy use different words. Plugin assembly is an implementation fact. It is not how features are named.

| Capability pages (README, PRODUCT, ROADMAP prose, CLI titles) | Architecture pages (MESSAGE_ORCHESTRATION implementation, TECH_STACK, INGESTION, RFCs) |
| --- | --- |
| connect, import, sync / 接入、导入、同步 | ingest, `IngestBatch` |
| connector / 连接器 | inbound plugin, `ChannelConnector` |
| message / 消息 | ingest record / 入站记录 |
| reply, send back / 回复、发回原渠道 | outbound plugin, delivery intent, `EgressAdapter` |

Do not describe a feature as a plugin. Say what the user can connect, read, rank, or send. Type names stay on architecture pages.

README answers: what it is, how to run it, where the rest of the docs are. Architecture lives under `docs/<locale>/`. One canonical page per topic; link instead of repeating the pitch.

Root README section order: title, one-line description, overview, getting started, extra sections, contributing, license last.

### Tone

- Facts, not persuasion. No stacked one-line slogans.
- Active voice, short paragraphs, no hype (`powerful`, `seamless`, `next-generation`).
- Describe behavior: `Messages that need handling reach the console; the rest stay outside the current work.` Not belief: `We believe ordinary mail should disappear.`
- Status is a table or a checklist, not a narrative of intent.

### Chinese

Mirror English semantics and heading structure.

- Product pages: third person; the subject is `Regenic` or the user-visible part (`连接器`, `控制台`).
- Architecture pages: third person; the subject may be `内核` / plugin / port.
- How-to: imperative (`运行 pnpm install`). Use `你` only when the reader acts.
- Headings and table labels are dictionary nouns (`仓库结构`, `运行方式`, `组件`), not speech (`长什么样`, `怎么跑`, `用什么`).
- Prefer 范围外 to 不做 / 当前不做.
- English `contract` (connector, API, message, HTTP, install) is 协议, never 合同 or 契约. Identifiers stay English (`message-contract`, `contracts.ts`).
- Out-of-tree connectors and executors are 私有插件 / private plugin. Do not name CRM, 内部系统, or an internal ticket system. Example `unit_kind` ids use `{source}.{native}` with a generic source (`private.order_review`), not a vendor prefix. Do not document private env aliases by vendor name.

## Codes

| Folder | HTML `lang` / hreflang |
| --- | --- |
| `en` | `en` |
| `zh` | `zh-CN` |

Folder name is `zh` (same as `regenic-book`). Use `zh-CN` only for HTML/SEO tags.

Reader pages: language switch link only (`[简体中文](…)` / `[English](…)`). Keep process text in this file.

## Layout

```text
README.md
README.zh-CN.md           # GitHub root locale README only

docs/
  LOCALES.md
  en/
    PRODUCT.md
    MESSAGE_ORCHESTRATION.md
    CONNECTOR.md
    TECH_STACK.md
    ROADMAP.md
    rfcs/
  zh/
    PRODUCT.md
    MESSAGE_ORCHESTRATION.md
    CONNECTOR.md
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
