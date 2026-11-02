#!/usr/bin/env python3
"""Aggregate Claude Code transcript usage into a per-day, per-model ledger.

Reads ~/.claude/projects/**/*.jsonl and writes one JSON object to stdout:

    {"days": {"YYYY-MM-DD": {"model": [input, output, cache_read,
                                       cache_creation, requests]}},
     "stats": {...}}

Assistant rows are written to the transcript more than once for the same API
response, so rows are de-duplicated by requestRef (requestId / message.id /
uuid are fallbacks).  Rows whose model is "<synthetic>" are ignored.

The plugin collects live usage itself.  --before <epoch-ms> imports only rows
written before that instant, so the two halves do not overlap.
"""

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path


USAGE_KEYS = (
    "input_tokens",
    "output_tokens",
    "cache_read_input_tokens",
    "cache_creation_input_tokens",
)


def parse_day(value):
    """Return the local calendar day for a transcript timestamp, or None."""
    if value is None:
        return None

    stamp = None
    if isinstance(value, (int, float)):
        number = float(value)
        if number > 1e11:
            stamp = number / 1000.0
        else:
            stamp = number
        try:
            return datetime.fromtimestamp(stamp).date().isoformat()
        except (OverflowError, OSError, ValueError):
            return None

    if not isinstance(value, str) or not value:
        return None

    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None

    if parsed.tzinfo is None:
        parsed = parsed.astimezone()
    return parsed.astimezone().date().isoformat()


def to_millis(value):
    """Epoch milliseconds for a transcript timestamp, or None."""
    if value is None:
        return None
    if isinstance(value, (int, float)):
        number = float(value)
        return int(number if number > 1e11 else number * 1000)
    if not isinstance(value, str) or not value:
        return None

    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.astimezone()
    return int(parsed.timestamp() * 1000)


def add_counts(days, day, model, counts):
    by_model = days.setdefault(day, {})
    current = by_model.get(model)
    if current is None:
        by_model[model] = [counts[0], counts[1], counts[2], counts[3], 1]
        return
    for index in range(4):
        current[index] += counts[index]
    current[4] += 1


def remove_counts(days, day, model, counts):
    by_model = days.get(day)
    if not by_model:
        return
    current = by_model.get(model)
    if not current:
        return
    for index in range(4):
        current[index] -= counts[index]
    current[4] -= 1
    if current[4] <= 0 or sum(current[:4]) <= 0:
        by_model.pop(model, None)
    if not by_model:
        days.pop(day, None)


def usage_counts(usage):
    """Normalise a usage object to four non-negative integers, or None."""
    if not isinstance(usage, dict):
        return None
    values = []
    for key in USAGE_KEYS:
        raw = usage.get(key)
        if isinstance(raw, bool):
            raw = 0
        if not isinstance(raw, (int, float)):
            raw = 0
        values.append(max(0, int(round(raw))))
    if sum(values) == 0:
        return None
    return values


def record_key(record, message):
    for holder in (record, message):
        if not isinstance(holder, dict):
            continue
        for name in ("requestRef", "requestId", "request_ref", "request_id"):
            value = holder.get(name)
            if isinstance(value, str) and value:
                return value
    if isinstance(message, dict):
        value = message.get("id")
        if isinstance(value, str) and value:
            return value
    value = record.get("uuid")
    if isinstance(value, str) and value:
        return value
    return None


def cutoff_ms(value):
    if value is None:
        return None
    number = int(value)
    if number > 0 and number < 100_000_000_000:
        # Seconds, not milliseconds.
        number *= 1000
    return number


def iter_files(root):
    try:
        for entry in sorted(root.rglob("*.jsonl")):
            if entry.is_file():
                yield entry
    except (OSError, PermissionError):
        return


def backfill(root, before):
    days = {}
    best = {}
    stats = {
        "files": 0,
        "lines": 0,
        "assistant": 0,
        "unique": 0,
        "skipped": 0,
        "errors": 0,
        "missingTimestamp": 0,
        "cutoff": before,
    }
    min_stamp = None
    max_stamp = None

    for path in iter_files(root):
        stats["files"] += 1
        try:
            handle = path.open("r", encoding="utf-8", errors="replace")
        except (OSError, PermissionError):
            stats["errors"] += 1
            continue

        with handle:
            for line in handle:
                stats["lines"] += 1
                if '"usage"' not in line:
                    continue
                try:
                    record = json.loads(line)
                except (json.JSONDecodeError, ValueError):
                    stats["errors"] += 1
                    continue
                if not isinstance(record, dict) or record.get("type") != "assistant":
                    continue

                message = record.get("message")
                if not isinstance(message, dict):
                    continue
                stats["assistant"] += 1

                model = message.get("model")
                if not isinstance(model, str) or not model:
                    model = "unknown"
                if model == "<synthetic>":
                    stats["skipped"] += 1
                    continue

                stamp = record.get("timestamp")
                if stamp is None:
                    stamp = message.get("timestamp")
                day = parse_day(stamp)
                if day is None:
                    stats["missingTimestamp"] += 1
                    continue

                if before is not None:
                    ms = to_millis(stamp)
                    if ms is None:
                        continue
                    if ms >= before:
                        stats["skipped"] += 1
                        continue
                    min_stamp = ms if min_stamp is None else min(min_stamp, ms)
                    max_stamp = ms if max_stamp is None else max(max_stamp, ms)

                counts = usage_counts(message.get("usage"))
                if counts is None:
                    stats["skipped"] += 1
                    continue

                key = record_key(record, message)
                if key is None:
                    stats["unique"] += 1
                else:
                    previous = best.get(key)
                    if previous is not None:
                        if sum(counts) <= sum(previous[2]):
                            stats["skipped"] += 1
                            continue
                        remove_counts(days, previous[0], previous[1], previous[2])
                    else:
                        stats["unique"] += 1
                    best[key] = (day, model, counts)

                add_counts(days, day, model, counts)

    if min_stamp is not None:
        stats["first"] = min_stamp
    if max_stamp is not None:
        stats["last"] = max_stamp
    return {"days": days, "stats": stats}


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Aggregate Claude Code token usage by day and model.",
    )
    parser.add_argument(
        "--projects",
        default=str(Path.home() / ".claude" / "projects"),
        help="transcript root (default: ~/.claude/projects)",
    )
    parser.add_argument(
        "--before",
        default=None,
        help="only rows written before this epoch time (ms, or seconds)",
    )
    args = parser.parse_args(argv)

    root = Path(os.path.expanduser(args.projects))
    if not root.is_dir():
        json.dump({"days": {}, "stats": {"error": "projects directory not found"}}, sys.stdout)
        sys.stdout.write("\n")
        return 0

    payload = backfill(root, cutoff_ms(args.before))
    json.dump(payload, sys.stdout, ensure_ascii=False, separators=(",", ":"))
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())