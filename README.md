# Regenic

**Default organizational management software for AI-native organizations.**

Regenic implements the [dual-capability model](https://regenic.ai/en/method) from
*Rewrite the DNA* / 《重写基因》:

1. **Unified judgment standards** — encode, apply, and revise standards that humans and agents share
2. **Unified context** — one organizational context layer instead of per-team chat silos

Not bolt-on AI on legacy ERP.

中文：Regenic 是 AI 原生组织的默认管理软件，实现「统一判断标准 × 统一上下文」。

## Methodology source

The book, [regenic.ai](https://regenic.ai), and public standards live in
[**regenic-ai/regenic-book**](https://github.com/regenic-ai/regenic-book).

## Status

**Early stage.** Architecture and RFCs first; implementation follows the public
methodology in `regenic-book`.

| Capability | Description | Status |
| --- | --- | --- |
| Judgment standards | Define, version, apply, and revise org-wide standards | Planned |
| Shared context | Single context layer for people, teams, and agents | Planned |
| Org management | AI-native operations — not legacy ERP with a chat box | Planned |

## Repository layout

```
regenic-ai/regenic       ← this repo (product)
regenic-ai/regenic-book  ← book + website + public methodology
regenic.ai               ← canonical website (deployed from regenic-book)
```

## Roadmap

See [ROADMAP.md](ROADMAP.md).

## Contributing

Regenic is not accepting feature PRs until the initial architecture RFC lands.
Discussion welcome via [Issues](https://github.com/regenic-ai/regenic/issues).

Follow the org [Code of Conduct](https://github.com/regenic-ai/regenic-book/blob/main/CODE_OF_CONDUCT.md).
Security reports: [private advisory](https://github.com/regenic-ai/regenic/security/advisories/new).

## License

MIT — see [LICENSE](LICENSE).

Methodology content in `regenic-ai/regenic-book` remains under CC BY-NC 4.0 where applicable.
