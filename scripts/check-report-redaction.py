#!/usr/bin/env python3
"""Check text reports for named patterns without printing matched content."""

from __future__ import annotations

import argparse
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
        patterns.append((name.strip(), re.compile(expression)))
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
            lines = path.read_text(encoding="utf-8").splitlines()
        except (OSError, UnicodeError) as error:
            print(f"redaction-check: cannot read {path}: {error}", file=sys.stderr)
            return 2
        for line_number, line in enumerate(lines, 1):
            for name, pattern in patterns:
                if pattern.search(line):
                    findings += 1
                    print(f"finding\t{name}\t{path}\tline:{line_number}")

    if findings:
        print(f"redaction-check: {findings} finding(s); matched content suppressed", file=sys.stderr)
        return 1

    print(f"redaction-check: {len(args.paths)} file(s) clear")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
