# Automated testing

The repository keeps Node's built-in `node:test` runner. The supported local/CI test runtime is Node 22.12+ (22.x) or Node 24+; the desktop tests use Node's type stripping and the Electron smoke also requires the built desktop and API. Install the pinned workspace dependencies first:

```sh
pnpm install --frozen-lockfile
pnpm test:ci
```

`test:ci` is the pull-request gate: package-boundary checks, workspace build and typecheck, the existing package test suites, and a production-only packed SDK consumer check. The API keeps its existing serial `personal-api*.test.cjs` group and runs the remaining test files separately. The build, typecheck, test and boundary failures block the job. Dependency inventory and audit findings are emitted as sanitized evidence under ignored `coverage/test-evidence/`; known dependency advisories are reported, not silently waived or used as a pre-existing, permanently-red gate. Audit transport/schema failures still fail reporting.

The workflow runs stable `Core / Node 22.12.0` and `Core / Node 24.12.0` checks and a `Desktop / <OS>` check on Linux and macOS. Nightly runs the same full PR regressions, ten deterministic host lifecycle repetitions, and external connector source compatibility. Manual workflow dispatch adds the SDK candidate matrix and packed consumer verification. A published GitHub release runs the packed core consumer lane against the released source SHA. All jobs use read-only repository permissions and upload short-lived JSON evidence containing source SHAs, lock/tarball SHA-512 hashes, package versions, and sanitized lane results.

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

`scripts/testing/connectors.json` records exact default-branch source SHAs and the actual contract range for Slack, WhatsApp, DingTalk, WeCom, Telegram, Discord, Claude Code, and GitHub Copilot. `stable` runs against published contract 0.2.0 where supported; `candidate` uses the current 0.3.0 core SDK only for packages whose declared range supports it. Every run builds/tests the selected pinned source and records the source-resolved `@regenic/connector-contract` identity (path + realpath + version) before and after validation.

Consumer compatibility mode is explicit per connector:

- `packed-npm`: pack the connector, install into an isolated production consumer, then assert host/plugin resolve the same contract instance and load declared contributions.
- `clone-root-absolute` (GitHub Copilot): validate from the connector source root with frozen install/build/typecheck/test + root audit evidence, then load the plugin by absolute source path and assert host/plugin share the same contract instance.

For Copilot specifically, the Zod 4.6.7 override is validated in the **Copilot connector source repository root** for `clone-root-absolute`; this does not claim arbitrary downstream tarball consumers inherit that override. No connector is tested by silently overriding its declared contract range.

The desktop lane runs existing isolated unit tests, the Electron production build, and the real Electron semantic smoke with a synthetic local embedding HTTP server and a disposable database/profile. It does not log in to any account, call an external model, send messages, or start a real agent. Linux runs under Xvfb; the CI macOS lane provides the native macOS run.

Live/account validation is intentionally manual and opt-in. Before doing it, a maintainer must select a dedicated test account/tenant and confirm ownership, obtain scoped credentials through the normal secret store, understand whether a test can create or send real content, and explicitly approve the operation. Never put credentials in workflow variables, fixtures, logs, or artifacts. CI does not contain a live-test switch and does not perform those actions.
