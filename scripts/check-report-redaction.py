#!/usr/bin/env python3
"""Check text reports for named patterns without printing matched content."""

from __future__ import annotations

import argparse
from bisect import bisect_left
import json
import re
import sys
from pathlib import Path


def load_patterns(path: Path) -> list[tuple[str, re.Pattern[str]]]:
    patterns = []
    for number, raw_line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not raw_line.strip() or raw_line.lstrip().startswith("#"):
            continue
        try:
            name, expression = raw_line.split("\t", 1)
        except ValueError as error:
            raise ValueError(f"invalid pattern row {number}") from error
        if not name.strip() or not expression:
            raise ValueError(f"invalid pattern row {number}")
        patterns.append((name.strip(), re.compile(expression, re.MULTILINE)))
    if not patterns:
        raise ValueError("pattern file contains no rules")
    return patterns


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--patterns", type=Path, required=True)
    parser.add_argument("paths", nargs="+", type=Path)
    args = parser.parse_args()

    try:
        patterns = load_patterns(args.patterns)
    except (OSError, ValueError, re.error) as error:
        print(f"redaction-check: {error}", file=sys.stderr)
        return 2

    findings = 0
    for path in args.paths:
        try:
            with path.open("r", encoding="utf-8", newline="") as stream:
                report = stream.read()
        except (OSError, UnicodeError) as error:
            print(f"redaction-check: cannot read {path}: {error}", file=sys.stderr)
            return 2
        newline_offsets = []
        index = 0
        while index < len(report):
            if report[index] == "\r" and index + 1 < len(report) and report[index + 1] == "\n":
                newline_offsets.append(index + 1)
                index += 2
            elif report[index] in {"\r", "\n"}:
                newline_offsets.append(index)
                index += 1
            else:
                index += 1
        for name, pattern in patterns:
            for match in pattern.finditer(report):
                findings += 1
                line_number = bisect_left(newline_offsets, match.start()) + 1
                print(
                    "finding\t"
                    f"{json.dumps(name, ensure_ascii=True)}\t"
                    f"{json.dumps(str(path), ensure_ascii=True)}\t"
                    f"line:{line_number}"
                )

    if findings:
        print(f"redaction-check: {findings} finding(s); matched content suppressed", file=sys.stderr)
        return 1

    print(f"redaction-check: {len(args.paths)} file(s) clear")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
