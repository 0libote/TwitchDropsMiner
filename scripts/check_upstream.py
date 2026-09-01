#!/usr/bin/env python3
from __future__ import annotations

import argparse
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BASE_FILE = ROOT / ".upstream-base"
BACKEND_FILES = {
    "cache.py",
    "channel.py",
    "constants.py",
    "exceptions.py",
    "inventory.py",
    "settings.py",
    "translate.py",
    "twitch.py",
    "utils.py",
    "version.py",
    "websocket.py",
}


def git(*args: str) -> str:
    return subprocess.check_output(("git", *args), cwd=ROOT, text=True).strip()


def report(upstream_ref: str) -> tuple[bool, str]:
    base = BASE_FILE.read_text(encoding="utf8").strip()
    head = git("rev-parse", upstream_ref)
    if base == head:
        return False, f"Upstream is current at `{head[:12]}`."

    commits = git("log", "--no-merges", "--date=short", "--pretty=%h|%ad|%s", f"{base}..{head}")
    changed_output = git("diff", "--name-only", f"{base}..{head}")
    changed = [line for line in changed_output.splitlines() if line]
    backend = [path for path in changed if path in BACKEND_FILES]
    other = [path for path in changed if path not in BACKEND_FILES]

    lines = [
        "# Upstream changes available",
        "",
        f"Reviewed baseline: `{base}`",
        f"Latest upstream: `{head}`",
        "",
        "## Commits",
        "",
    ]
    for item in commits.splitlines():
        sha, date, subject = item.split("|", 2)
        lines.append(f"- `{sha}` ({date}) {subject}")
    lines.extend(("", "## Backend-sensitive files", ""))
    lines.extend(f"- `{path}`" for path in backend)
    if not backend:
        lines.append("- None")
    lines.extend(("", "## Other files", ""))
    lines.extend(f"- `{path}`" for path in other)
    if not other:
        lines.append("- None")
    lines.extend(
        (
            "",
            "## Review procedure",
            "",
            "1. Merge or cherry-pick the upstream changes into a review branch.",
            "2. Run the headless tests and verify Twitch login, inventory, claiming, and watching.",
            "3. Update `.upstream-base` to the reviewed upstream SHA only after those checks pass.",
        )
    )
    return True, "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description="Report unreviewed TwitchDropsMiner changes")
    parser.add_argument("--upstream-ref", default="upstream/master")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--check", action="store_true", help="exit 1 when updates exist")
    args = parser.parse_args()
    has_updates, text = report(args.upstream_ref)
    if args.output:
        args.output.write_text(text, encoding="utf8")
    print(text, end="")
    return int(args.check and has_updates)


if __name__ == "__main__":
    raise SystemExit(main())
