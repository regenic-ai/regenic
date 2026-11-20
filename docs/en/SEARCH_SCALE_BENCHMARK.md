# Million-message search benchmark

This benchmark reproduces the authorized candidate path with a real,
million-scale conversation corpus. It is separate from retrieval-quality
fixtures and does not run in CI.

## Dataset

Use the sanitized `allenai/WildChat-1M` release pinned to revision
`7d6490e462285cf85d91eabea0f9a954fbddcd1f` (ODC-BY 1.0). That revision has
837,989 conversation rows in 14 Parquet shards. The original release paper
reports 2,639,415 user-assistant rounds; calculate the exact message count of
the pinned sanitized revision during preparation.

WildChat contains real user text. Redaction does not guarantee that all
sensitive content is gone. Keep the derived JSONL local. Do not commit or
redistribute it.

## Prepare privacy-minimized JSONL

Install optional tools outside the workspace dependency graph:

```powershell
python -m pip install datasets huggingface_hub pyarrow
```

Stream the pinned revision without materializing it in memory:

```powershell
python scripts\benchmarks\prepare_wildchat.py `
  --output D:\regenic-bench\wildchat-1m.messages.jsonl
```

For a quick smoke corpus:

```powershell
python scripts\benchmarks\prepare_wildchat.py `
  --output D:\regenic-bench\wildchat-100k.messages.jsonl `
  --max-messages 100000
```

The converter writes an adjacent manifest with the revision, dependency
versions, exact counts, byte size and SHA-256. It excludes IP hashes, request
headers, geography, timestamps, moderation vectors and source-linkable IDs.

For an offline pinned copy:

```powershell
hf download allenai/WildChat-1M `
  --repo-type dataset `
  --revision 7d6490e462285cf85d91eabea0f9a954fbddcd1f `
  --include "README.md" `
  --include "LICENSE.md" `
  --include "data/*.parquet" `
  --local-dir D:\regenic-bench\WildChat-1M-7d6490e

python scripts\benchmarks\prepare_wildchat.py `
  --local-parquet D:\regenic-bench\WildChat-1M-7d6490e `
  --output D:\regenic-bench\wildchat-1m.messages.jsonl
```

## Run the scale curve

Use a persistent database so repeated runs can skip index construction.
Pass `--rebuild` after changing the selected prefix.

```powershell
pnpm --filter @regenic/local-cli bench:conversation-scale -- `
  --input D:\regenic-bench\wildchat-1m.messages.jsonl `
  --manifest D:\regenic-bench\wildchat-1m.messages.jsonl.manifest.json `
  --database D:\regenic-bench\wildchat-100k.lexical.db `
  --messages 100000 `
  --samples 10 `
  --warmup 2 `
  --query python `
  --query error `
  --output D:\regenic-bench\wildchat-100k.report.json `
  --rebuild

pnpm --filter @regenic/local-cli bench:conversation-scale -- `
  --input D:\regenic-bench\wildchat-1m.messages.jsonl `
  --manifest D:\regenic-bench\wildchat-1m.messages.jsonl.manifest.json `
  --database D:\regenic-bench\wildchat-1m.lexical.db `
  --messages 1000000 `
  --output D:\regenic-bench\wildchat-1m.report.json `
  --rebuild
```

Run at 100,000, 1,000,000 and the full prepared message count. Record the same
queries and hardware for every point.

Include a deliberately absent query such as `zzzz_no_match_7f3a` to isolate
authorization and coverage overhead from result materialization.

The report contains:

- exact messages, conversations, role/language counts and consumed-prefix hash;
- index construction time and SQLite file sizes;
- warm authorized-search P50, P95, P99, mean and maximum latency;
- coverage and match counts;
- observed process peak RSS and hardware information.

The report never contains message text or full local paths.

## Interpretation

This benchmark exercises the production SQLite FTS authorization staging and
candidate matching path with real text. It does not measure embedding
inference, vector recall, answer generation or end-to-end desktop rendering.
Use `bench:semantic` for retrieval quality and the embedding latency benchmark
for inference contention.

If latency grows linearly with the authorized message count while match counts
stay small, optimize authorization staging/candidate lookup before changing
the embedding model.
