# Extra connector starters

Drop this folder on `REGENIC_PLUGIN_DIR`, or copy one child into `~/.regenic/plugins`.

A package is a plugin when `package.json` has `regenic.plugin`, `engines.regenic`, and `contributes`. The kernel loads only the named exports.

| Folder | Shape | Use when |
| --- | --- | --- |
| `catalog-only` | vocabulary + install card | Internal ticket types, no live sync yet |
| `import-only` | `parseImport` + `import_files` | User-picked exports |
| `webhook` | `bindWebhook` | Browser extension or SaaS push |
| `poll` | `resolveStreams` + `poll` | Localhost or LAN HTTP |

Drivers receive `ConnectorHost`: `connectors`, `egress`, `plugin`, `now`, `secrets`. They do not get `authority` or `ingest`. Secret catalog fields are stored in the keychain; `config` keeps no token.

Peer the in-repo `@regenic/domain` for types, `channelRecord`, `verifyChannelDriverConformance`, `probeLocalHttp`, `probeLocalCommand`, and `createMemoryEgressQueue`.
