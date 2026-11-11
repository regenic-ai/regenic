# Automated testing

The repository keeps Node's built-in `node:test` runner. The supported local/CI test runtime is Node 22.14+ (22.x) or Node 24+, with Node-API 10 or newer. The `better-sqlite3` 13 prebuild requires Node-API 10; Node 22.12 exposes version 9 and can crash when opening a database. Testing lanes reject incompatible runtimes before loading the native addon. The desktop tests use Node's type stripping and the Electron smoke also requires the built desktop and API. Install the pinned workspace dependencies first:

```sh
pnpm install --frozen-lockfile
pnpm test:ci
```

`test:ci` is the pull-request gate: package-boundary checks, workspace build and typecheck, the existing package test suites, and a production-only packed SDK consumer check. The API keeps its existing serial `personal-api*.test.cjs` group and runs the remaining test files separately. The build, typecheck, test and boundary failures block the job. Dependency inventory and audit findings are emitted as sanitized evidence under ignored `coverage/test-evidence/`; known dependency advisories are reported, not silently waived or used as a pre-existing, permanently-red gate. Audit transport/schema failures still fail reporting.

The workflow runs stable `Core / Node 22.14.0` and `Core / Node 24.12.0` checks and a `Desktop / <OS>` check on Linux and macOS. Nightly runs the same full PR regressions, ten deterministic host lifecycle repetitions, and external connector source compatibility. Manual workflow dispatch adds the SDK candidate matrix and packed consumer verification. A published GitHub release runs the packed core consumer lane against the released source SHA. All jobs use read-only repository permissions and upload short-lived JSON evidence containing source SHAs, lock/tarball SHA-512 hashes, package versions, and sanitized lane results.

Useful focused commands:

```sh
pnpm test:host
REGENIC_SOAK_ITERATIONS=25 pnpm test:soak
pnpm test:consumer
pnpm test:desktop
pnpm test:report
pnpm test:compatibility -- --connector dingtalk --sdk stable
pnpm test:compatibility -- --connector dingtalk --sdk candidate
```

The real-host executor tests use the actual API, Nest host, SQLite authority store, driver/executor registries, and installation lifecycle. A temporary child-process JSON-RPC endpoint stands in only for the external executor. Barriers establish ordering; no sleeps determine lifecycle assertions. Each test uses temporary HOME/config/data/database/blob directories and an OS-assigned local port, closes the owned server and process, checks the port is closed, and removes its fixture. Cases cover metadata-only reads without activation, multiple org/install bindings, recipe pin override resistance, enable/disable/reconfigure/delete, persisted restart without old-generation resurrection, cross-install/cross-org rejection, admitted work drain, and process cleanup. Existing durable reply recovery tests cover unknown delivery outcomes and refusal to replay.

`scripts/testing/connectors.json` records exact default-branch source SHAs, the frozen-source SDK expectation, and the actual contract range for Slack, WhatsApp, DingTalk, WeCom, Telegram, Discord, Claude Code, and GitHub Copilot. Both modes frozen-install, build, typecheck, and test the source against its lockfile dependencies. Required link scripts receive a checkout-shaped SDK layout pointing to those same frozen-installed packages, not to the candidate core. DingTalk/WeCom source stages therefore use contract 0.2.0 even in candidate mode; Claude/Copilot source stages use registry contract 0.3.0. Candidate lanes then pack the current core SDK as `.tgz`, install into a canonical-path consumer with its own manifest, validate the exact top-level npm lock entry's local-tarball resolution and SHA-512 integrity, and prove the plugin load resolves the candidate contract by real path and version. A same-version registry package cannot satisfy this identity check. Candidate source compilation is not claimed.

Consumer compatibility mode is explicit per connector:

- `packed-npm`: pack the connector and install it together with the stable SDK packages or candidate SDK `.tgz` files into an isolated consumer. The actual compiled API plugin loader loads the package and validates its declared contributions against the core protocol boundary; core and plugin contract modules are not required to share a physical instance.
- `clone-root-core-loader` (GitHub Copilot): preserve its source-root frozen install/build/typecheck/test and audit, verify Zod 4.6.7 from the actual Copilot SDK entry's resolution, then load the built plugin through the compiled API loader without activation. Candidate mode supplies packed candidate SDK packages via an isolated module-resolution overlay. The core and cloned connector intentionally have separate dependency roots.

For Copilot specifically, the Zod 4.6.7 override is validated both as source-root configuration and by the **actual Zod package resolved from the Copilot SDK entry point**. This does not claim arbitrary downstream tarball consumers inherit that override. No connector is tested by silently overriding its declared contract range.

The desktop lane runs existing isolated unit tests, the Electron production build, and the real Electron semantic smoke with a synthetic local embedding HTTP server and a disposable database/profile. It does not log in to any account, call an external model, send messages, or start a real agent. Linux runs under Xvfb; its ephemeral CI runner configures Electron's `chrome-sandbox` helper as root-owned mode 4755 before launching, rather than disabling the Chromium sandbox. Local Linux runs require the corresponding Electron sandbox setup. The CI macOS lane provides the native macOS run.

`pnpm test:tooling` also runs offline npm pack/install/lock regressions and independent subprocess tests for signal-killed, already-exited and failed-exit smoke children. Smoke failure is marked nonzero before asynchronous cleanup; shutdown reuses the originally registered exit promise with a bounded kill wait.

Live/account validation is intentionally manual and opt-in. Before doing it, a maintainer must select a dedicated test account/tenant and confirm ownership, obtain scoped credentials through the normal secret store, understand whether a test can create or send real content, and explicitly approve the operation. Never put credentials in workflow variables, fixtures, logs, or artifacts. CI does not contain a live-test switch and does not perform those actions.
