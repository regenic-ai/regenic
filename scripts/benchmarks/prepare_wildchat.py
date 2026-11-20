#!/usr/bin/env python3
"""Stream a pinned WildChat-1M revision into privacy-minimized benchmark JSONL."""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import os
import sys
from pathlib import Path
from typing import Any, Iterable

WILDCHAT_REPOSITORY = "allenai/WildChat-1M"
WILDCHAT_REVISION = "7d6490e462285cf85d91eabea0f9a954fbddcd1f"
EXCLUDED_FIELDS = [
    "conversation_hash",
    "country",
    "detoxify_moderation",
    "hashed_ip",
    "header",
    "openai_moderation",
    "state",
    "timestamp",
    "turn_identifier",
]


def positive_integer(value: str) -> int:
    parsed = int(value)
    if parsed < 1:
        raise argparse.ArgumentTypeError("value must be a positive integer")
    return parsed


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Stream the pinned, sanitized WildChat-1M release into compact JSONL. "
            "Install optional dependencies with: "
            "python -m pip install datasets huggingface_hub pyarrow"
        )
    )
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument(
        "--local-parquet",
        type=Path,
        help="Directory containing data/train-*.parquet from the pinned revision",
    )
    parser.add_argument("--max-conversations", type=positive_integer)
    parser.add_argument("--max-messages", type=positive_integer)
    parser.add_argument(
        "--progress-every",
        type=positive_integer,
        default=10_000,
        help="Report progress after this many conversations",
    )
    return parser.parse_args()


def load_rows(local_parquet: Path | None) -> Iterable[dict[str, Any]]:
    try:
        from datasets import load_dataset
    except ImportError as error:
        raise RuntimeError(
            "Missing optional dependency. Run: "
            "python -m pip install datasets huggingface_hub pyarrow"
        ) from error

    if local_parquet is None:
        return load_dataset(
            WILDCHAT_REPOSITORY,
            split="train",
            revision=WILDCHAT_REVISION,
            streaming=True,
        )

    files = sorted((local_parquet / "data").glob("train-*.parquet"))
    if len(files) != 14:
        raise RuntimeError(
            f"Expected 14 pinned WildChat parquet shards under "
            f"{local_parquet / 'data'}, found {len(files)}"
        )
    return load_dataset(
        "parquet",
        data_files={"train": [str(path) for path in files]},
        split="train",
        streaming=True,
    )


def package_version(name: str) -> str:
    try:
        return importlib.metadata.version(name)
    except importlib.metadata.PackageNotFoundError:
        return "unknown"


def normalized_message(
    conversation_index: int,
    message_index: int,
    row: dict[str, Any],
    message: dict[str, Any],
) -> dict[str, Any]:
    content = message.get("content")
    role = message.get("role")
    if not isinstance(content, str) or not isinstance(role, str) or not role:
        raise RuntimeError(
            f"Invalid conversation payload at row {conversation_index}, "
            f"message {message_index}"
        )
    language = message.get("language")
    model = row.get("model")
    turns = row.get("turn")
    return {
        "id": f"wildchat1m:{conversation_index:09d}:{message_index:03d}",
        "conversation_index": conversation_index,
        "message_index": message_index,
        "role": role,
        "text": content,
        **({"language": language} if isinstance(language, str) else {}),
        **({"model": model} if isinstance(model, str) else {}),
        **({"conversation_turns": turns} if isinstance(turns, int) else {}),
    }


def main() -> None:
    args = arguments()
    output = args.output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    partial = output.with_name(f"{output.name}.partial")
    manifest_path = output.with_name(f"{output.name}.manifest.json")
    rows = load_rows(args.local_parquet.resolve() if args.local_parquet else None)
    digest = hashlib.sha256()
    conversation_count = 0
    message_count = 0
    role_counts: dict[str, int] = {}
    language_counts: dict[str, int] = {}
    stopped = False

    try:
        with partial.open("wb") as sink:
            for conversation_index, row in enumerate(rows):
                if (
                    args.max_conversations is not None
                    and conversation_count >= args.max_conversations
                ):
                    break
                messages = row.get("conversation")
                if not isinstance(messages, list):
                    raise RuntimeError(
                        f"Invalid conversation list at row {conversation_index}"
                    )
                for message_index, message in enumerate(messages):
                    if (
                        args.max_messages is not None
                        and message_count >= args.max_messages
                    ):
                        stopped = True
                        break
                    if not isinstance(message, dict):
                        raise RuntimeError(
                            f"Invalid message at row {conversation_index}, "
                            f"message {message_index}"
                        )
                    normalized = normalized_message(
                        conversation_index, message_index, row, message
                    )
                    encoded = (
                        json.dumps(
                            normalized,
                            ensure_ascii=False,
                            separators=(",", ":"),
                        )
                        + "\n"
                    ).encode("utf-8")
                    sink.write(encoded)
                    digest.update(encoded)
                    message_count += 1
                    role = normalized["role"]
                    role_counts[role] = role_counts.get(role, 0) + 1
                    language = normalized.get("language", "unknown")
                    language_counts[language] = language_counts.get(language, 0) + 1
                conversation_count += 1
                if conversation_count % args.progress_every == 0:
                    print(
                        f"conversations={conversation_count:,} "
                        f"messages={message_count:,}",
                        file=sys.stderr,
                        flush=True,
                    )
                if stopped:
                    break
        os.replace(partial, output)
    except BaseException:
        partial.unlink(missing_ok=True)
        raise

    manifest = {
        "schema_version": "1.0",
        "dataset": WILDCHAT_REPOSITORY,
        "revision": WILDCHAT_REVISION,
        "license": "ODC-BY-1.0",
        "source": "local_parquet" if args.local_parquet else "huggingface_streaming",
        "conversations": conversation_count,
        "messages": message_count,
        "role_counts": dict(sorted(role_counts.items())),
        "language_counts": dict(
            sorted(language_counts.items(), key=lambda entry: (-entry[1], entry[0]))
        ),
        "output_bytes": output.stat().st_size,
        "output_sha256": digest.hexdigest(),
        "privacy": {
            "excluded_fields": EXCLUDED_FIELDS,
            "warning": (
                "Free text may still contain residual sensitive data. "
                "Keep the derived corpus local and do not redistribute it."
            ),
        },
        "dependencies": {
            "python": sys.version.split()[0],
            "datasets": package_version("datasets"),
            "huggingface_hub": package_version("huggingface_hub"),
            "pyarrow": package_version("pyarrow"),
        },
    }
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    print(json.dumps(manifest, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
