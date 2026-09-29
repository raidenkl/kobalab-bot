#!/usr/bin/env python3
"""Build the installable Akagi archive for the kobalab bot.

    python pack_kobalab.py

Output: `kobalab.zip` at the repo root.

Three things about the archive are load-bearing, and each is enforced below
rather than left to the calling shell:

1.  **The name.** Akagi names the installed bot after the *zip stem*, and it
    identifies a bot by the directory holding `bot.py`. The manifest says
    `name = "kobalab"` and `doctor.js` fails loudly on a mismatch, so the archive
    must be `kobalab.zip` — a copy saved as `kobalab-bot.zip` installs to
    `mjai_bot/kobalab-bot/` and Akagi then keys the settings panel and the UI row
    off a name nothing else agrees with.

2.  **The single top-level folder.** Akagi strips one leading directory when it
    extracts, so `kobalab/…` lands as `mjai_bot/kobalab/…`. Everything therefore
    goes under exactly one `kobalab/` prefix, and nothing is placed at the root.

3.  **What is left out.** `node_modules` ships (there is no npm step at install
    time), but `.akagi/` — the venv and sync stamps Akagi writes into an
    installed bot — must not, along with anything else that is per-machine state.

The build is byte-reproducible: entries are sorted and stamped with a fixed
timestamp, so two builds of the same tree produce the same archive and a
downloaded zip can be checked against a fresh one.
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
BOT_DIR = HERE  # the bot's files live at the repo root; this script sits beside them

OUT = os.path.join(HERE, "kobalab.zip")

#: The one top-level directory in the archive, which is also the bot's name.
ROOT = "kobalab"

#: Never shipped. `.akagi` holds the venv Akagi builds on the target machine;
#: `settings.toml` and `resolved_settings.json` are per-machine too. `.git` and
#: `.github` are repository/CI plumbing, not bot code.
EXCLUDE_DIRS = {".akagi", ".git", ".github", "__pycache__", ".cache", ".downloads"}
EXCLUDE_FILES = {
    "settings.toml", ".DS_Store", "Thumbs.db", ".gitignore", ".gitattributes",
    "pack_kobalab.py",  # the build tool itself is not part of the installed bot
}
EXCLUDE_SUFFIX = (".pyc", ".pyo", ".log", ".swp", ".zip")  # no shipping a stale build

#: Fixed stamp for reproducibility. 1980-01-01 is the earliest a zip can express.
STAMP = (1980, 1, 1, 0, 0, 0)


def wanted(rel: str) -> bool:
    """Whether the archive should carry the entry at `rel` (a '/' path)."""
    parts = rel.split("/")
    if any(p in EXCLUDE_DIRS for p in parts[:-1]):
        return False
    name = parts[-1]
    if name in EXCLUDE_DIRS:  # a directory entry itself
        return False
    if name in EXCLUDE_FILES or name.endswith(EXCLUDE_SUFFIX):
        return False
    return True


def collect() -> list[tuple[str, bytes | None]]:
    """Every (archive path, bytes) to ship, sorted. `None` bytes = a directory."""
    entries: dict[str, bytes | None] = {}

    for dirpath, dirnames, filenames in os.walk(BOT_DIR):
        dirnames[:] = sorted(d for d in dirnames if d not in EXCLUDE_DIRS)
        for fname in sorted(filenames):
            full = os.path.join(dirpath, fname)
            rel = os.path.relpath(full, BOT_DIR).replace(os.sep, "/")
            if not wanted(rel):
                continue
            with open(full, "rb") as fh:
                entries[f"{ROOT}/{rel}"] = fh.read()

    if f"{ROOT}/probe/harness.js" not in entries:
        print("warning: probe/harness.js not found — shipping without the harness",
              file=sys.stderr)

    # Directory entries, so an extractor that needs them has them.
    for path in list(entries):
        parts = path.split("/")[:-1]
        for i in range(1, len(parts) + 1):
            entries.setdefault("/".join(parts[:i]) + "/", None)

    return sorted(entries.items())


def main() -> int:
    if not os.path.isfile(os.path.join(BOT_DIR, "bot.py")):
        print(f"error: {BOT_DIR}/bot.py not found", file=sys.stderr)
        return 1

    entries = collect()

    # Akagi rejects an archive with an absolute path or a `..` segment, so the
    # build fails here rather than at install time on the user's machine.
    for path, _ in entries:
        norm = path.rstrip("/")
        if norm.startswith("/") or ".." in norm.split("/") or "\\" in norm:
            print(f"error: unsafe archive path {path!r}", file=sys.stderr)
            return 1

    tops = {p.split("/")[0] for p in (e for e, _ in entries)}
    if tops != {ROOT}:
        print(f"error: expected a single top-level {ROOT}/, found {sorted(tops)}",
              file=sys.stderr)
        return 1

    tmp = OUT + ".part"
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for path, data in entries:
            if data is None:
                info = zipfile.ZipInfo(path, STAMP)
                info.external_attr = (0o755 << 16) | 0x10  # dir
                info.compress_type = zipfile.ZIP_STORED
                zf.writestr(info, b"")
            else:
                info = zipfile.ZipInfo(path, STAMP)
                info.external_attr = 0o644 << 16
                info.compress_type = zipfile.ZIP_DEFLATED
                zf.writestr(info, data)

    shutil.move(tmp, OUT)

    files = sum(1 for _, d in entries if d is not None)
    raw = sum(len(d) for _, d in entries if d is not None)
    print(f"{OUT}")
    print(f"  {files} files, {raw:,} bytes raw -> {os.path.getsize(OUT):,} bytes")

    # The two files Akagi's installer checks for, and the entry point.
    for required in ("bot.py", "pyproject.toml", "manifest.toml"):
        if f"{ROOT}/{required}" not in dict(entries):
            print(f"  warning: {required} is missing", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
