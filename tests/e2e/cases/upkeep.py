"""The mod's own housekeeping: `/subcodex` and its cleaning, the pipes of servers no longer running, the
usage links, the agent records."""
import glob
import json
import os
import subprocess
import sys

from ..harness import Case, case, claude, codex_task
from ..mocks import answer, run


def _pipe(c: Case, name: str, pid: int) -> str:
    """A server's pipe and pid file in the case's home, as the mod lays them out; returns their path without suffix."""
    folder = f'{c.home}/.claude/subcodex/run'
    os.makedirs(folder, exist_ok=True)
    os.mkfifo(f'{folder}/{name}.fifo', 0o600)
    open(f'{folder}/{name}.pid', 'w').write(f'{pid}\n')
    return f'{folder}/{name}'


def _ended() -> int:
    """The pid of a process that has ended."""
    done = subprocess.Popen(['/usr/bin/true'])
    done.wait()
    return done.pid


@case
def upkeep_default(c: Case):
    c.plain()
    # Left over: a pipe whose server is gone, a link of the mod's whose session file is gone, and one of the person's own.
    stale = _pipe(c, 'stale', _ended())
    day = f'{c.home}/.codex/sessions/2026/01/01'
    os.makedirs(day, exist_ok=True)
    gone = f'{day}/rollout-2026-01-01T00-00-00-gone.subcodex.jsonl'
    os.symlink(f'{c.home}/.claude/subcodex/codex-home/sessions/2026/01/01/rollout-2026-01-01T00-00-00-gone.jsonl', gone)
    theirs = f'{day}/rollout-2026-01-01T00-00-00-theirs.jsonl'
    os.symlink(f'{c.home}/elsewhere/rollout-2026-01-01T00-00-00-theirs.jsonl', theirs)
    claude(c, [codex_task('Count the lines of notes.txt.')], [[run('wc -l notes.txt')], answer('notes.txt has 3 lines.')])
    c.check(not os.path.exists(f'{stale}.fifo') and not os.path.exists(f'{stale}.pid'),
            "a server's start removed the pipe and pid file of a server no longer running")
    c.check(not os.path.lexists(gone), "the mod's link whose session file is gone was removed")
    c.check(os.path.lexists(theirs), "a link of the person's own was left alone")
    links = glob.glob(f'{c.home}/.codex/sessions/*/*/*/rollout-*.subcodex.jsonl')
    c.check(len(links) == 1 and os.path.exists(links[0]), f"the agent's session file was linked for usage tools ({len(links)})")
    records = glob.glob(f'{c.home}/.claude/subcodex/agents/*.json')
    c.check(len(records) == 1 and json.load(open(records[0])).get('threadId'), f"the agent's record is a file of its own, naming its thread ({len(records)})")
    stores = glob.glob(f'{c.home}/.claude/plugins/store/*subcodex*.json')
    c.check(not any(key.startswith('agent:') for path in stores for key in json.load(open(path))), 'the plugin store holds no agent records')

    # A record whose thread has no session file: `clean <days>` removes it, and only it.
    stray = f'{c.home}/.claude/subcodex/agents/stray.json'
    open(stray, 'w').write(json.dumps({'threadId': '00000000-0000-0000-0000-000000000000'}))
    shown = claude(c, [], prompt='/subcodex').result
    c.check('1 Codex session files' in shown and '1 links' in shown, f'the status counts the session file and its link ({shown[-400:]!r})')
    c.check('2 agent records' in shown, 'the status counts the record files')
    c.check("Codex's own databases (" in shown, "the status names Codex's own databases, with their size")
    pruned = claude(c, [], prompt='/subcodex clean 3650').result
    c.check('Removed 0 session files' in pruned and '1 agent records that pointed at no session' in pruned, f'`clean <days>` removed the stray record ({pruned[:160]!r})')
    c.check(not os.path.exists(stray) and all(os.path.exists(path) for path in records), "the stray record is gone, the agent's own stays")

    # A pipe whose pid file names a running app-server: a server at work. Then one whose server is gone.
    busy = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)', 'app-server'])
    try:
        _pipe(c, 'busy', busy.pid)
        refused = claude(c, [], prompt='/subcodex clean all').result
        c.check('is at work' in refused and os.path.isdir(f'{c.home}/.claude/subcodex'), f'a running server stops `clean all` ({refused[:80]!r})')
    finally:
        busy.kill()
        busy.wait()
    cleaned = claude(c, [], prompt='/subcodex clean all').result
    c.check('Removed 1 session files' in cleaned and '1 agent records' in cleaned, f'a pipe whose server is gone does not stop `clean all` ({cleaned[:160]!r})')
    c.check(not os.path.exists(f'{c.home}/.claude/subcodex'), "the mod's folder is gone")
    c.check(not glob.glob(f'{c.home}/.codex/sessions/*/*/*/rollout-*.subcodex.jsonl') and os.path.lexists(theirs),
            "every link of the mod's is gone, and only those")
    after = claude(c, [], prompt='/subcodex').result
    c.check('Nothing is kept on disk yet' in after, 'with nothing left, the status says so')
