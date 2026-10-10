# @regenic/connector-test-utils

In-memory registries and conformance checks for a Regenic connector test suite.

```ts
import {
  MemoryConnectorRegistry,
  MemoryEgressRegistry,
  verifyChannelDriverConformance,
  verifyPollConnectorConformance,
} from "@regenic/connector-test-utils";
```

Use it as a dev dependency next to `@regenic/connector-contract` and `@regenic/plugin-host`.

Requires Node.js 20 or newer.
