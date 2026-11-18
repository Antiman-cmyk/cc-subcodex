"""The mod's own housekeeping: `/subcodex` and its cleaning, the pipes of servers no longer running, the
usage links, the agent records."""
import glob
import json
import os
import subprocess
import sys
import time

from .. import host
from ..harness import Case, case, claude, codex_task, usage_links
from ..mocks import LINES, answer, run


def _pipe(c: Case, name: str, pid: int) -> str:
    """A server's pipe and pid file in the case's home, as the mod lays them out; returns their path without suffix.
    On Windows the pipe is not a file: the pid file alone is laid out."""
    folder = f'{c.home}/.claude/subcodex/run'
    os.makedirs(folder, exist_ok=True)
    if not host.WINDOWS:
        os.mkfifo(f'{folder}/{name}.fifo', 0o600)
    open(f'{folder}/{name}.pid', 'w').write(f'{pid}\n')
    return f'{folder}/{name}'


def _gone(c: Case, day: str) -> str:
    """A link of the mod's whose session file is gone, in the case's own Codex home, in the day folder `day`
    (`<year>/<month>/<day>`)."""
    name = f'rollout-{day.replace("/", "-")}T00-00-00-gone'
    os.makedirs(f'{c.home}/.codex/sessions/{day}', exist_ok=True)
    link = f'{c.home}/.codex/sessions/{day}/{name}.subcodex.jsonl'
    os.symlink(f'{c.home}/.claude/subcodex/codex-home/sessions/{day}/{name}.jsonl', link)
    return link


def _ended() -> int:
    """The pid of a process that has ended."""
    done = subprocess.Popen([sys.executable, '-c', 'pass'])
    done.wait()
    return done.pid


@case
def upkeep_without_pwsh(c: Case):
    """On Windows the mod's own work runs in PowerShell 7: without it, `/subcodex` and an agent say so."""
    if not host.WINDOWS:
        return c.skip('PowerShell 7 is a need on Windows alone')
    c.plain()
    # No PowerShell 7: no folder on the PATH holds `pwsh.exe`, and the Microsoft Store's is not found through a
    # LOCALAPPDATA of the case's own.
    path = os.pathsep.join(d for d in os.environ.get('PATH', '').split(os.pathsep) if d and not os.path.exists(os.path.join(d, 'pwsh.exe')))
    hidden = {'PATH': path, 'LOCALAPPDATA': f'{c.folder}.local'}
    os.makedirs(hidden['LOCALAPPDATA'], exist_ok=True)
    shown = claude(c, [], prompt='/subcodex', env=hidden).result
    c.check('PowerShell 7 (`pwsh`), which was not found' in shown and 'Nothing on disk was looked at or removed' in shown,
            f'`/subcodex` says PowerShell 7 is missing, and touches nothing ({shown[:200]!r})')
    s = claude(c, [codex_task('Count the lines of notes.txt.')], env=hidden)
    c.check('Codex did not start. On Windows the subcodex mod runs its own work in PowerShell 7' in s.report(),
            f"the agent's result says PowerShell 7 is missing ({s.report()[:200]!r})")


@case
def upkeep_default(c: Case):
    c.plain()
    # Left over: a pipe whose server is gone; in the day folder the agent's session goes in (Codex's local date), a
    # link of the mod's whose session file is gone and a link of the person's own.
    stale = _pipe(c, 'stale', _ended())
    now = time.localtime()
    to_midnight = 86400 - (now.tm_hour * 3600 + now.tm_min * 60 + now.tm_sec)
    if to_midnight < 180:  # the dispatch ends on the same local date
        time.sleep(to_midnight + 2)
    today = time.strftime('%Y/%m/%d')
    gone_today = _gone(c, today)
    theirs = f'{c.home}/.codex/sessions/{today}/rollout-{today.replace("/", "-")}T00-00-00-theirs.jsonl'
    os.symlink(f'{c.home}/elsewhere/rollout-theirs.jsonl', theirs)
    claude(c, [codex_task('Count the lines of notes.txt.')], [[run(LINES)], answer('notes.txt has 3 lines.')])
    c.check(not os.path.exists(f'{stale}.fifo') and not os.path.exists(f'{stale}.pid'),
            "a server's start removed the pipe and pid file of a server no longer running")
    c.check(not os.path.lexists(gone_today), "in the day folder of the agent's session, the mod's link whose session file is gone was removed")
    c.check(os.path.lexists(theirs), "a link of the person's own was left alone")
    links = usage_links(c)
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
    # And a link of the mod's whose session file is gone, in a day folder the mod has no session in: `clean <days>`
    # removes it too.
    gone = _gone(c, '2026/01/01')
    pruned = claude(c, [], prompt='/subcodex clean 3650').result
    c.check('Removed 0 session files' in pruned and '1 agent records that pointed at no session' in pruned, f'`clean <days>` removed the stray record ({pruned[:160]!r})')
    c.check(not os.path.exists(stray) and all(os.path.exists(path) for path in records), "the stray record is gone, the agent's own stays")
    c.check(not os.path.lexists(gone), "`clean <days>` removed the mod's link whose session file is gone")
    c.check(os.path.lexists(theirs), "and left the person's own link alone")
    record = f'{c.home}/.claude/subcodex/usage-links.json'
    c.check(os.path.exists(record) and 'began' not in json.load(open(record)),
            '`clean <days>` has the next usage-link pass look at every day folder')

    # A pipe whose pid file names a running app-server: a server at work (on Windows, a pid file held open). Then
    # one whose server is gone.
    busy = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)', 'app-server'])
    try:
        with open(f'{_pipe(c, "busy", busy.pid)}.pid'):
            refused = claude(c, [], prompt='/subcodex clean all').result
        c.check('is at work' in refused and os.path.isdir(f'{c.home}/.claude/subcodex'), f'a running server stops `clean all` ({refused[:80]!r})')
    finally:
        busy.kill()
        busy.wait()
    cleaned = claude(c, [], prompt='/subcodex clean all').result
    c.check('Removed 1 session files' in cleaned and '1 agent records' in cleaned, f'a pipe whose server is gone does not stop `clean all` ({cleaned[:160]!r})')
    c.check(not os.path.exists(f'{c.home}/.claude/subcodex'), "the mod's folder is gone")
    c.check(not usage_links(c) and os.path.lexists(theirs),
            "every link of the mod's is gone, and only those")
    after = claude(c, [], prompt='/subcodex').result
    c.check('Nothing is kept on disk yet' in after, 'with nothing left, the status says so')
