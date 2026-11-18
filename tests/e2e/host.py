"""What the tests ask of the host system, on Windows or elsewhere: the processes running, waiting for one, and
stopping sessions. The one place of the tests that tells the systems apart; the cases use only its data."""
from __future__ import annotations

import json
import os
import re
import shutil
import signal
import subprocess
import sys
import time

WINDOWS = os.name == 'nt'
PYTHON = sys.executable
# The shells Codex runs a command in on Windows.
SHELLS = ('pwsh.exe', 'powershell.exe')
# Every process on Windows, as JSON written in UTF-8: id, parent's id, name, command line, start (Unix seconds).
LISTING = ("$list = @(Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ pid = $_.ProcessId; ppid = $_.ParentProcessId; "
           "name = $_.Name; cmd = [string]$_.CommandLine; started = ([DateTimeOffset]$_.CreationDate).ToUnixTimeSeconds() } }); "
           "$bytes = [Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject $list -Compress)); "
           "$out = [Console]::OpenStandardOutput(); $out.Write($bytes, 0, $bytes.Length); $out.Flush()")


def processes() -> list[dict]:
    """Every process on Windows: its id, its parent's, its name, its command line and when it started."""
    out = subprocess.run(['pwsh.exe', '-NoProfile', '-NonInteractive', '-Command', LISTING], capture_output=True, check=True).stdout
    return json.loads(out.decode('utf-8'))


def descendants(roots: set[int], listed: list[dict]) -> list[dict]:
    """The processes started by the given ones, at any depth, still running (their parents may have ended)."""
    children: dict[int, list[dict]] = {}
    for one in listed:
        children.setdefault(int(one['ppid'] or 0), []).append(one)
    found, todo, seen = [], list(roots), set(roots)
    while todo:
        for child in children.get(todo.pop(), []):
            if child['pid'] not in seen:
                seen.add(child['pid'])
                found.append(child)
                todo.append(child['pid'])
    return found


def _shell_runs(command: str, listed: list[dict]) -> bool:
    """Whether a PowerShell of Codex's runs `command` (Windows): `<shell> -Command <command>`, the command alone or as
    the last line of the script Codex gives the shell."""
    shape = re.compile(r'(?:\s-Command\s+["\']?|\n)' + re.escape(command) + r'["\']?\s*$')
    return any(str(one['name']).lower() in SHELLS and ' -Command ' in str(one['cmd'] or '') and shape.search(str(one['cmd']))
               for one in listed)


def running(command: str) -> bool:
    """Whether a process runs `command`: its command line starts with it, or on Windows Codex's PowerShell runs it."""
    if WINDOWS:
        return _shell_runs(command, processes())
    return bool(subprocess.run(['pgrep', '-f', f'^{command}'], capture_output=True).stdout.strip())


def until_running(command: str) -> str:
    """A Bash command for the driver that waits until a process runs `command`."""
    if WINDOWS:
        python, script = (path.replace('\\', '/') for path in (PYTHON, os.path.abspath(__file__)))
        return f"'{python}' -X utf8 '{script}' '{command}' >/dev/null"
    return f"until pgrep -f '^{command}' >/dev/null; do sleep 2; done"


def leftovers(sessions: set[int], since: float, root: str) -> list[str]:
    """The processes of the run still running once its sessions have ended: on Windows those the sessions started,
    and servers of Codex's whose helper is gone; elsewhere those that name a case's home."""
    if not WINDOWS:
        # A process of the run names a case's home on its command line (the mod's servers name their pipe there).
        listed = subprocess.run(['pgrep', '-fl', f'{os.path.realpath(root)}/[^ ]*\\.home/'], capture_output=True, text=True).stdout.split('\n')
        return [line for line in listed if line.strip()]
    everything = processes()
    alive = {one['pid'] for one in everything}
    listed = [one for one in everything if one['started'] >= int(since)]
    servers = [one for one in listed if 'app-server' in str(one['cmd']) and one['ppid'] not in alive]
    left = {one['pid']: one for one in descendants(sessions, listed) + servers}
    return [f'{one["pid"]} {one["cmd"] or one["name"]}' for one in left.values()]


def remove_caches(root: str) -> None:
    """Removes the cache Claude Code keeps on Windows in LOCALAPPDATA for each case folder of a run."""
    caches = os.path.join(os.environ.get('LOCALAPPDATA', ''), 'claude-cli-nodejs', 'Cache')
    if not WINDOWS or not os.path.isdir(caches):
        return
    prefix = re.sub(r'[^A-Za-z0-9]', '-', os.path.realpath(root))
    for name in os.listdir(caches):
        if name.startswith(prefix):
            shutil.rmtree(os.path.join(caches, name), ignore_errors=True)


def popen_options() -> dict:
    """How a session is started: in a process group of its own."""
    return {'creationflags': subprocess.CREATE_NEW_PROCESS_GROUP} if WINDOWS else {'start_new_session': True}


def stop_tree(pid: int) -> None:
    """Stops a session and every process it started."""
    if WINDOWS:
        subprocess.run(['taskkill', '/PID', str(pid), '/T', '/F'], capture_output=True)
    else:
        os.killpg(pid, signal.SIGTERM)


if __name__ == '__main__':
    # `host.py <command> [seconds]`: waits, polling, until a PowerShell of Codex's runs the command (the driver's
    # wait, on Windows); exits 1 if none does within the seconds (110 by default).
    deadline = time.time() + float(sys.argv[2] if len(sys.argv) > 2 else 110)
    while not running(sys.argv[1]):
        if time.time() > deadline:
            sys.exit(1)
        time.sleep(0.5)
