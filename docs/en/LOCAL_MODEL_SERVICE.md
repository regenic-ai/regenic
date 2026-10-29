# Local model service setup

[简体中文](../zh/LOCAL_MODEL_SERVICE.md) · [Desktop runbook](../zh/DESKTOP.md) · [Retrieval architecture](../zh/EMBEDDING_RETRIEVAL_ARCHITECTURE.md)

This guide configures the **Embedding model service** for personal semantic search,
not an answer-generation model. Without it, lexical search still works. Enabling it
gradually indexes authorized current text and enables semantic + lexical hybrid
retrieval. Historical search, organization ACLs and image retrieval are out of scope.

Use desktop-managed installation unless you need to manage Python processes, caches
or an independent kernel yourself. Choose one approach; never open the same personal
database from two kernels simultaneously.

## 1. Prerequisites and pinned model

- For source development, use **Node.js 22**, pnpm 9.15.0 and a cloned repository.
- Install **Python 3.12**. On Windows the desktop installer tries `py -3.12`, then
  `python`; on macOS/Linux it tries `python3.12`, then `python3`. The actual version
  must be 3.12.
- First installation requires PyPI/Hugging Face access for dependencies and pinned
  weights. Allow several GB of disk space and additional RAM for CPU inference.
  Installation time and memory depend on the machine; there is no certified
  production hardware baseline.
- After installing Python or changing PATH on Windows, **quit from the tray and
  restart the desktop app**. Closing its window only hides it; the old process
  does not inherit an updated PATH.

The current service has a fixed identity. Changing only the model name or mixing
tokenizers is not supported:

| Field | Value |
| --- | --- |
| Model | `google/embeddinggemma-2` |
| Model / tokenizer revision | `914f7f89142e33e77833254d9c9b90c3cef7303b` |
| Dimensions / input window | 768 / 8192 tokens |
| Query prefix | `task: search result \| query: ` |
| Document prefix | `title: none \| text: ` |
| Output | float32, L2 normalized, cosine similarity |

[requirements.txt](../../packages/embedding-provider/python/requirements.txt) is
authoritative: `sentence-transformers[image]==6.1.0`, `transformers==5.19.0`,
`torch==2.14.1`, `torchvision==0.29.1`, `pillow==12.3.0`. Do not independently upgrade
one package to work around an error.

## 2. Recommended: desktop-managed service

Start from the repository root. These are Windows PowerShell commands:

```powershell
node --version
pnpm --version
python --version
pnpm install
pnpm dev:desktop
```

If you use the Windows Python launcher, check with `py -3.12 --version` instead.
Both `py` and `python` are not required.

1. Confirm the desktop's local kernel is running. If using a custom kernel, select
   **Local** under **Settings > Kernel address** and apply. Desktop does not install
   models on remote kernels.
2. Open **Settings > Local semantic search**, read and check the dependency/model
   download consent, then click **Download and install**. Wait for completion;
   only installation needs to download weights.
3. Click **Enable and start**. Desktop validates the pinned identity, starts the
   model offline and restarts its owned local kernel. **Do not send messages
   during start/stop operations.**
4. Wait for healthy status. Existing text is indexed one job at a time while idle;
   **Process next indexing job** advances at most one job. A healthy model does
   not mean all content has already been indexed.
5. Open **Search** and enter a question. Look for semantic + lexical hybrid
   retrieval and vector coverage. **View original message** revalidates current
   content; when an inbox mapping exists, **Open conversation** locates it.

The venv, cache and installation marker live under `semantic-runtime` in Electron
userData, separate from the personal database. The actual userData location depends
on how the app is launched; do not copy a developer's absolute path into your setup.
Moving the personal database does not redownload the model. Changes to dependency
or service assets invalidate the installation fingerprint and require reinstallation.

**Disable and stop** switches back to a lexical kernel and stops the owned model
while keeping downloads. Quitting also stops owned services. The next launch restores
an enabled preference, but still needs time to load the model. Desktop does not
start or stop a custom kernel's model.

## 3. Manual: independent Python service and custom kernel

These examples use **Windows PowerShell 7**, starting in the repository root.
The desktop manager also supports other systems. Managed CPU installation/inference
was exercised on Windows; the manual approach uses the same requirements and service
script. This is not cross-platform or GPU/NPU certification.

### 3.1 Terminal A: install and start the Embedding service

Use a separate directory outside the repository. Do not reuse the desktop-managed
venv, marker or an active personal database. Check that `python --version` is 3.12.
If only the launcher is installed, replace `python` with `py -3.12` in the venv
creation command.

```powershell
$repo = (Get-Location).Path
$runtime = Join-Path $env:LOCALAPPDATA 'Regenic\local-model-service'
New-Item -ItemType Directory -Force -Path $runtime | Out-Null
python -m venv (Join-Path $runtime 'venv')
if ($LASTEXITCODE -ne 0) { throw 'venv creation failed' }
$python = Join-Path $runtime 'venv\Scripts\python.exe'
$env:HF_HOME = Join-Path $runtime 'cache'
Remove-Item Env:HF_HUB_OFFLINE -ErrorAction SilentlyContinue

& $python -m pip install --disable-pip-version-check -r (Join-Path $repo 'packages\embedding-provider\python\requirements.txt')
if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed' }
& $python -B (Join-Path $repo 'packages\embedding-provider\python\serve.py') --download-only --device cpu
if ($LASTEXITCODE -ne 0) { throw 'Model download/load verification failed' }

$env:HF_HUB_OFFLINE = '1'
& $python -B (Join-Path $repo 'packages\embedding-provider\python\serve.py') --port 8765 --device cpu
```

The download step actually loads the model; it does not merely create a pipeline.
Wait for `embedding_ready` and keep terminal A running. On later starts, set
`$repo`, `$runtime`, `$python`, `HF_HOME` and `HF_HUB_OFFLINE=1` again and run the
last service command. Installation does not need to be repeated.

The service binds only to `127.0.0.1:8765`. It has no public deployment, TLS or
user-authentication support. Do not expose it through a public bind or reverse
proxy. It is not an OpenAI `/v1/embeddings` endpoint: it uses the repository's
descriptor protocol at `/tokens` and `/embed`. Requests with an `Origin` header
are rejected, including `/health`; test from a terminal, not browser JavaScript.

### 3.2 Terminal B: start an independent test kernel

This example creates a separate test database and uses 4380 rather than the
desktop's usual 4370. Choose and securely save a strong random Personal API key,
then paste it at the prompt. Never put it in documentation, Git or logs.

```powershell
$repo = (Get-Location).Path
$runtime = Join-Path $env:LOCALAPPDATA 'Regenic\local-model-service'
$data = Join-Path $runtime 'test-data'
New-Item -ItemType Directory -Force -Path $data | Out-Null
$env:LISTEN_HOST = '127.0.0.1'
$env:PORT = '4380'
$env:REGENIC_AUTHORITY_DRIVER = 'sqlite'
$env:REGENIC_DATABASE = Join-Path $data 'authority.db'
$env:REGENIC_BLOB_ROOT = Join-Path $data 'blobs'
$env:REGENIC_ORG = 'local-model-test'
$env:REGENIC_EMBEDDING_DRIVER = 'local_http'
$env:REGENIC_EMBEDDING_BASE_URL = 'http://127.0.0.1:8765'
$env:REGENIC_EMBEDDING_TIMEOUT_MS = '30000'
$env:REGENIC_MODEL_DRIVER = 'none'
$env:REGENIC_PERSONAL_PAIRING = '0'
$env:REGENIC_PERSONAL_API_KEY = Read-Host 'Personal API key (keep private)' -MaskInput
if ([string]::IsNullOrWhiteSpace($env:REGENIC_PERSONAL_API_KEY)) { throw 'API key is required' }

pnpm --filter @regenic/api... build
if ($LASTEXITCODE -ne 0) { throw 'API build failed' }
node (Join-Path $repo 'apps\api\dist\main.js')
```

Keep terminal B running. In desktop **Settings > Kernel address**, choose
**Custom**, enter `http://127.0.0.1:4380` and the same Personal API key, then apply.
Desktop model install/start/stop controls are unavailable for this kernel by design;
manage it in terminals A/B. The test database starts empty: import test messages
before expecting search results.

Environment variables must be set in the process that starts the kernel. Setting
them in another terminal does not update an existing kernel. The API entry reads
process environment; it does not automatically load the repository's `.env.example`.
Do not enable non-loopback access with `REGENIC_PERSONAL_API=1` or disable Personal
API authentication for this setup. Direct `/v1/me/*` calls require a valid
`x-regenic-personal-key`; a connected desktop supplies it automatically.

### 3.3 Environment and lifecycle

| Variable | Default / purpose |
| --- | --- |
| `REGENIC_EMBEDDING_DRIVER` | `none`; use `local_http` for manual enablement |
| `REGENIC_EMBEDDING_BASE_URL` | Required when enabled; example `http://127.0.0.1:8765` |
| `REGENIC_EMBEDDING_TIMEOUT_MS` | 30000; integer 1-300000 ms |
| `REGENIC_EMBEDDING_CHUNK_TOKENS` | 256; integer 32-8192 |
| `REGENIC_EMBEDDING_MAX_CHUNKS` | 128; per-Event limit, integer 1-1024 |
| `HF_HOME` | Python model cache; keep the same path on restart |
| `HF_HUB_OFFLINE` | Set to `1` after downloading to load from cache offline |
| `REGENIC_MODEL_DRIVER` | Answer-generation model; search can keep `none` |

The Embedding URL must be numeric loopback HTTP without credentials, a path prefix,
query parameters or a fragment. Do not use `localhost`, an external hostname or a
`/v1` suffix. The client also accepts `[::1]`, but the reference Python service
binds IPv4 only, so use `127.0.0.1` as shown. Chunk settings are part of an immutable
generation; changing them is not a fix for a model identity mismatch.

If starting desktop directly with environment variables instead of a separate API,
external configuration is preserved only while no desktop semantic preference has
been saved. Explicit disablement overrides the environment's driver; enablement
uses the desktop-owned model endpoint. Prefer the custom-kernel approach above
when you need an explicitly external service lifecycle.

Manual services do not stop when desktop quits. Press Ctrl+C in terminal B and
then A to stop the kernel and model. Avoid active sends/indexing while stopping,
and never delete an in-use database or cache.

## 4. Verify service, real inference and retrieval

Use terminal C to test the manual service. Desktop-managed services use a dynamic
port; do not assume they listen on 8765.

```powershell
$health = Invoke-RestMethod 'http://127.0.0.1:8765/health' -TimeoutSec 10
if ($health.status -ne 'ready' -or
    $health.descriptor.model_id -ne 'google/embeddinggemma-2' -or
    $health.descriptor.model_revision -ne '914f7f89142e33e77833254d9c9b90c3cef7303b') {
  throw 'Unexpected model identity'
}
$body = @{
  descriptor = $health.descriptor
  mode = 'query'
  texts = @('How many days can I work from home?')
} | ConvertTo-Json -Depth 6
$result = Invoke-RestMethod 'http://127.0.0.1:8765/embed' -Method Post `
  -ContentType 'application/json' -Body ([System.Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 60
$vector = @($result.vectors[0])
$squares = ($vector | ForEach-Object { $_ * $_ } | Measure-Object -Sum).Sum
$norm = [Math]::Sqrt($squares)
if ($vector.Count -ne 768 -or [Math]::Abs($norm - 1) -gt 0.001) {
  throw 'Unexpected vector dimensions or normalization'
}
[pscustomobject]@{ Dimensions = $vector.Count; L2Norm = $norm }
```

This performs real inference, not a mock. It proves vector generation, **not
end-to-end retrieval acceptance**:

1. Import a known test message, such as "Employees can work from home two days
   per week."
2. Wait for healthy provider/vector status and successful jobs, then search
   "How many days can I work from home?"
3. Check hybrid mode, the expected message and coverage. `3/3` refers only to that
   request's authorized candidate set, not database size or recall.
4. Test original text, conversation navigation, unrelated queries and stale hits
   after revision/deletion. UI elapsed time includes network waiting; small-fixture
   speed is not a production performance baseline.

Developers can also build the API and desktop, then run
`pnpm --filter @regenic/desktop test:semantic:electron`. It starts real Electron/API
with an isolated synthetic database and protocol stub, does not download weights,
and does not replace the real inference test above. Build commands are in the
[desktop runbook](../zh/DESKTOP.md).

## 5. Troubleshooting

| Symptom | Check / action |
| --- | --- |
| Cannot reach kernel | Check running kernel, origin/port and Personal API key. 4380/4370 are API ports, not model or web UI ports; a development web port is not the kernel. |
| Python 3.12 required | Check actual version and PATH; fully quit/restart desktop. Missing `py` is fine if `python` is 3.12. |
| Install/download fails | Check disk space, PyPI/Hugging Face connectivity and model access. Do not bypass license/access checks. Read manual terminal errors, or fix the cause before desktop reinstallation. |
| Offline startup fails | Verify the initial download/load completed and `HF_HOME` points to the original cache. Changed managed asset fingerprints require reinstallation. |
| `provider_unavailable` / `timeout` | Wait for model readiness; check port, CPU/RAM and service logs. A listening port does not prove indexing is complete. |
| `model_mismatch` / HTTP 409 | Use matching repository code, pinned model/tokenizer and descriptor. Do not reuse old vectors after swapping model names or dimensions. |
| `input_invalid` / `input_too_large` | Repair source content/size. Repeating retries does not repair invalid input. |
| Failed/quarantined indexing jobs | Fix the cause, wait for healthy provider/vector status, then confirm batches of at most 10 for requeue or process one job manually. Successful indexing and running leases are preserved; workers still recheck current lifecycle. |
| Lexical mode or partial coverage | Check enablement, provider/vector status and job progress. Unhealthy/unavailable vector services allow lexical degradation; enablement does not guarantee vector candidates for every query. |
| `model_absent` | Optional answer generation is unconfigured; this does not mean Embedding is missing. |
| `graph_absent` / `rerank_absent` | Optional graph retrieval/reranking is absent, not a core semantic-search failure. |

## 6. Answer generation is configured separately

Search returns matching records without needing a generated answer.
`REGENIC_EMBEDDING_*` and `REGENIC_MODEL_*` are independent; the desktop downloader
installs only the Embedding model, not an LLM. Optional cited `/ask` answers use
`REGENIC_MODEL_DRIVER=openai_compatible`, `REGENIC_MODEL_BASE_URL`,
`REGENIC_MODEL_NAME` and related settings; see [Technology stack](TECH_STACK.md).
Do not point a chat service setting at the Embedding URL to remove `model_absent`.
