# Regenic Genome

**The default organizational management substrate for AI-native organizations.**

Genome implements the [Regenic dual-capability model](https://regenic.ai/en/method):

1. **Unified judgment standards** — encode, apply, and revise standards that humans and agents share
2. **Unified context** — one organizational context layer instead of per-team chat silos

The methodology lives in [**regenic-ai/regenic**](https://github.com/regenic-ai/regenic)
(book, website, public standards). Genome is the **product layer** that turns that
method into software — not bolt-on AI on legacy ERP.

中文：Genome 是 AI 原生组织的默认管理底座，实现「统一判断标准 × 统一上下文」。

## Why "Genome"

The book [*Rewrite the DNA*](https://regenic.ai/en/book) / 《重写基因》 describes
organizational evolution as a **genome rewrite**: replacing legacy defaults
(cognitive inertia, private information, execution worship) with encoded
**standards** and shared **context**.

Genome is that rewrite in software form.

## Status

**Early stage.** Architecture and RFCs first; implementation follows the public
methodology in `regenic-ai/regenic`.

| Capability | Description | Status |
| --- | --- | --- |
| Judgment standards | Define, version, apply, and revise org-wide standards | Planned |
| Shared context | Single context layer for people, teams, and agents | Planned |
| Org management | AI-native operations — not legacy ERP with a chat box | Planned |

## Relationship to other repos

```
regenic-ai/regenic     Methodology + book + regenic.ai website
        │
        ▼  (public standards & schemas)
regenic-ai/genome      Product implementation
        │
        ▼  (maintainers only, never imported publicly)
regenic-internal       Private operating standards & case library
```

## Roadmap

See [ROADMAP.md](ROADMAP.md).

## Contributing

Genome is not accepting feature PRs until the initial architecture RFC lands.
Discussion welcome via [Issues](https://github.com/regenic-ai/genome/issues).

Follow the org [Code of Conduct](https://github.com/regenic-ai/regenic/blob/main/CODE_OF_CONDUCT.md).
Security reports: [private advisory](https://github.com/regenic-ai/genome/security/advisories/new).

## License

MIT — see [LICENSE](LICENSE).

Methodology content in `regenic-ai/regenic` remains under CC BY-NC 4.0 where applicable.
