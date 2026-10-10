# @regenic/plugin-host

Host runtime for a Regenic connector. Connectors mount through `definePlugin` and `createHost`. They read services with `host.get("connectors")` and `host.get("egress")`.

```ts
import { createHost, definePlugin } from "@regenic/plugin-host";
```

Requires Node.js 20 or newer.
