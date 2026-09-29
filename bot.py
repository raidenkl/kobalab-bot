#!/usr/bin/env python3
"""Shim that lets Akagi drive a Node.js bot.

Akagi's bot interface (``src/bot/runtime.rs``) hardcodes its entry point:

    PythonRuntime::command_for() -> <bot>/.akagi/venv/bin/python bot.py <seat>

so a bot written in another language has to arrive through ``bot.py``. This file
is that entry point, and it does one thing: run ``bridge/main.js`` under Node and
connect its stdio to Akagi's.

    Akagi  <-- stdin/stdout JSONL -->  bot.py  <-- pipes -->  node bridge/main.js

WHY THIS IS SAFE
    The bot runs as a *subprocess* either way, which is the same boundary Akagi
    already relies on for AGPL bots (see Akagi's ``src/bot/README.md``, "AGPL
    boundary"). Nothing is linked in-process, no Python API of the bot is
    touched, and Akagi's ``kill_on_drop`` still tears the whole tree down.

WHY IT NEEDS NO DEPENDENCIES
    This bot's ``pyproject.toml`` declares an empty ``dependencies`` list and
    ``[tool.uv] package = false``, so the install step Akagi runs ("Install
    environment") is a `uv sync` that builds the venv and installs nothing; the
    bot then runs under that venv's interpreter. Akagi requires the file to exist
    on every subprocess bot, so it is not optional even though it is empty — the
    real requirements of this bot are JavaScript and are vendored under
    ``node_modules`` (see README.md, "About the JavaScript dependencies"). The
    only external requirement is Node on ``PATH``, which is checked up front so a
    missing runtime produces a clear error on the first spawn instead of
    five-second reaction timeouts.

STDOUT DISCIPLINE
    Akagi reads the bot's stdout as protocol JSON — exactly one action per line.
    Nothing else may go there, so all diagnostics are written to stderr (which
    Akagi logs, and which carries ``@@AKAGI_NOTIFY@@`` toasts).

HOW IT EXITS
    Deliberately not through interpreter finalisation — see ``shutdown``. The
    short version is that the stdin pump is a daemon thread parked in a blocking
    read, and letting Python tear down around it aborts the process with
    ``Fatal Python error: _enter_buffered_busy``. That is a crash (0xC0000005 on
    Windows) on every single shutdown, including the routine one after
    ``end_game``, and Akagi logs the exit status of every bot it spawns.
"""

from __future__ import annotations

import json
import os
import shutil
import signal
import subprocess
import sys
import threading

HERE = os.path.dirname(os.path.abspath(__file__))
BRIDGE = os.path.join(HERE, "bridge", "main.js")

NOTIFY_PREFIX = "@@AKAGI_NOTIFY@@ "


def notify(level: str, title: str, body: str | None = None, **extra) -> None:
    """Send a toast to the Akagi UI. Rides on stderr, so it never desyncs."""
    payload = {"level": level, "title": title}
    if body:
        payload["body"] = body
    payload.update(extra)
    sys.stderr.write(NOTIFY_PREFIX + json.dumps(payload) + "\n")
    sys.stderr.flush()


def log(message: str) -> None:
    sys.stderr.write(f"[kobalab-shim] {message}\n")
    sys.stderr.flush()


def fail(title: str, body: str) -> None:
    """Report a fatal start-up problem and exit without answering anything."""
    log(f"{title}: {body}")
    notify("error", title, body, sticky=True, id="kobalab-shim-fatal")
    sys.exit(1)


def _node_candidates() -> list:
    """Every place worth looking for a Node executable, in priority order.

    `KOBALAB_NODE` wins outright so a user can always point at a specific build.

    The PATH lookup is done for both `node` and the platform's executable name:
    on Windows `shutil.which("node")` normally resolves `node.exe` through
    PATHEXT, but it fails for a Node installed as an *App Execution Alias*
    (`%LOCALAPPDATA%\\Microsoft\\WindowsApps\\node.exe`), which is a 0-byte
    reparse point — so the well-known install directories are checked directly
    as well rather than trusting PATH alone.
    """
    candidates = []

    override = os.environ.get("KOBALAB_NODE")
    if override:
        candidates.append(override)

    for name in ("node", "node.exe", "nodejs"):
        found = shutil.which(name)
        if found:
            candidates.append(found)

    if os.name == "nt":
        program_files = os.environ.get("ProgramFiles", r"C:\Program Files")
        program_files_x86 = os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")
        local_appdata = os.environ.get("LOCALAPPDATA", "")
        appdata = os.environ.get("APPDATA", "")
        candidates += [
            os.path.join(program_files, "nodejs", "node.exe"),
            os.path.join(program_files_x86, "nodejs", "node.exe"),
            # nvm-windows keeps one directory per installed version.
            os.path.join(appdata, "nvm", "node.exe"),
            # App Execution Alias / per-user installs.
            os.path.join(local_appdata, "Microsoft", "WindowsApps", "node.exe"),
            os.path.join(local_appdata, "Programs", "nodejs", "node.exe"),
            # Chocolatey / Scoop, which do not always land on PATH for a
            # GUI-launched process.
            r"C:\ProgramData\chocolatey\bin\node.exe",
            os.path.join(os.path.expanduser("~"), "scoop", "shims", "node.exe"),
        ]
    else:
        candidates += [
            "/usr/local/bin/node",
            "/usr/bin/node",
            "/opt/homebrew/bin/node",
            "/snap/bin/node",
            os.path.join(os.path.expanduser("~"), ".nvm", "current", "bin", "node"),
            os.path.join(os.path.expanduser("~"), ".local", "bin", "node"),
        ]

    # De-duplicate while keeping priority order, and drop anything that is not
    # actually an executable file (a 0-byte App Execution Alias counts as one,
    # so it is tried and then rejected by the version probe in `find_node`).
    seen = set()
    ordered = []
    for path in candidates:
        if not path:
            continue
        key = os.path.normcase(os.path.abspath(path))
        if key in seen:
            continue
        seen.add(key)
        ordered.append(path)
    return ordered


def _node_works(path: str):
    """Return Node's version string if `path` runs, else None.

    The version probe is what makes the App Execution Alias case fail loudly
    instead of silently: that file exists but does nothing when run without a
    console, so `shutil.which` finds it and the spawn then dies with a confusing
    error. Running it once here turns that into a clear message.
    """
    kwargs = {}
    if os.name == "nt":
        # Akagi is a GUI process and has no console. A real node.exe is
        # unaffected (we capture its stdout), but the Windows Store *App
        # Execution Alias* for node is a reparse point that can fail outright
        # without a console attached — so give the child its own console rather
        # than mistaking that failure for "Node is missing". CREATE_NO_WINDOW
        # keeps it from flashing a window on screen.
        kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)

    try:
        proc = subprocess.run(
            [path, "--version"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=20,
            **kwargs
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if proc.returncode != 0:
        return None
    version = proc.stdout.decode("utf-8", "replace").strip()
    return version or None


def find_node() -> str:
    tried = []
    for path in _node_candidates():
        version = _node_works(path)
        if version:
            log(f"using Node {version} at {path}")
            return path
        tried.append(path)

    # Build a message that says what was actually attempted, because "install
    # Node" is unhelpful advice to someone who already has.
    detail = ""
    if tried:
        # The candidate literals use "\\" while os.path.join contributes the
        # host separator, so on Windows the raw list reads as a mix of both.
        # Normalise explicitly rather than via os.path.normpath, which follows
        # the HOST separator and would do nothing when this code runs on Linux.
        display = [t.replace("/", "\\") if os.name == "nt" else t for t in tried]
        shown = "; ".join(display[:6])
        if len(display) > 6:
            shown += f"; (+{len(display) - 6} more)"
        detail = f" Looked in: {shown}."

    fail(
        "Node.js not found",
        "This bot runs @kobalab/majiang-ai on Node.js, which must be installed "
        "separately (Akagi does not bundle it). Install Node 18 or newer, then "
        "restart Akagi, or set KOBALAB_NODE to the full path of node.exe."
        + detail,
    )
    return ""  # unreachable; `fail` exits


def pump(source, sink, label: str) -> None:
    """Copy lines from one stream to the other, flushing as we go.

    Akagi's protocol is request/response per line, so nothing may be buffered
    waiting for more input.
    """
    try:
        for line in iter(source.readline, b""):
            sink.write(line)
            sink.flush()
    except (BrokenPipeError, ValueError, OSError) as exc:
        log(f"{label} pump ended: {exc}")
    finally:
        try:
            sink.close()
        except OSError:
            pass


#: Exit status to force when Akagi asks us to stop. `None` means "whatever the
#: bridge returned" — see `shutdown`.
_requested_code = None


def _on_sigterm(*_) -> None:
    """Take SIGTERM as the clean stop it is meant to be.

    Akagi's ``kill_on_drop`` SIGTERMs the bot when the game is torn down, and
    that should read as a normal exit rather than as the status of a child we
    had to kill on the way out. `os._exit(0)` here would do it, but it would
    also strand the Node child with a half-open pipe; the recorded code is
    honoured by `shutdown` instead, which stops the child first.
    """
    global _requested_code
    _requested_code = 0
    sys.exit(0)


def shutdown(proc) -> None:
    """Stop the Node child and leave the process, skipping finalisation.

    Two things here are less obvious than they look.

    The child goes first. Akagi never sends a shutdown message — it stops
    writing and drops us — so a shim that simply exited would leave ``node``
    reading a pipe whose writer is gone until Akagi killed the whole tree.

    And the exit is ``os._exit``, not a return from ``main``. The stdin pump is
    a daemon thread parked in ``sys.stdin.buffer.readline()``; interpreter
    finalisation cannot take that buffer's lock away from it and aborts the
    process — ``Fatal Python error: _enter_buffered_busy``, which on Windows is
    a hard crash (exit 0xC0000005) on *every* shutdown, the routine one after
    ``end_game`` included. Skipping finalisation is safe precisely because there
    is nothing left for it to do: every line this process emits is flushed as it
    is emitted (``notify``, ``log``, ``pump``), so no Python-level buffer holds
    unwritten bytes at this point.
    """
    if proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=2)
        except subprocess.TimeoutExpired:
            proc.kill()
    bridge_code = proc.returncode if proc.returncode is not None else 0
    log(f"bridge exited with {bridge_code}")

    code = _requested_code if _requested_code is not None else bridge_code
    try:
        sys.stdout.flush()
        sys.stderr.flush()
    except (OSError, ValueError):
        pass
    os._exit(code)


def main() -> None:
    """Run until the bridge stops, then leave via `shutdown`.

    Never returns: every path either calls `fail` (which exits) or reaches
    `shutdown` (which exits).
    """
    if not os.path.exists(BRIDGE):
        fail("Bridge not found", f"Expected {BRIDGE} to exist next to bot.py.")
    node = find_node()
    seat = sys.argv[1] if len(sys.argv) > 1 else "0"

    env = dict(os.environ)
    # Akagi sets AKAGI_PLAYER_ID; forward it as well as argv for good measure.
    env.setdefault("AKAGI_PLAYER_ID", seat)

    log(f"starting node bridge (seat {seat})")
    try:
        proc = subprocess.Popen(
            [node, BRIDGE, seat],
            cwd=HERE,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=None,          # inherit: Node's logs and toasts go straight out
            env=env,
        )
    except OSError as exc:
        fail("Could not start Node", str(exc))

    # stdin: Akagi -> Node.
    to_node = threading.Thread(
        target=pump, args=(sys.stdin.buffer, proc.stdin, "stdin"), daemon=True
    )
    to_node.start()

    # stdout: Node -> Akagi. This runs on the main thread so the process leaves
    # when the bridge does. `shutdown` never returns; it is what exits.
    try:
        pump(proc.stdout, sys.stdout.buffer, "stdout")
    finally:
        shutdown(proc)


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, _on_sigterm)
    main()
