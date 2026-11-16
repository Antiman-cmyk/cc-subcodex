#!/usr/bin/env python3
"""End-to-end tests of the subcodex mod, on real headless Claude Code sessions and real Codex, offline.

    python3 tests/e2e/run.py                every case
    python3 tests/e2e/run.py leave message  cases whose name contains one of the words
    python3 tests/e2e/run.py --live         the live cases instead, never run otherwise

Options: --jobs N (default 5), --keep (show every check and leave the run folder), --out DIR.

Each case runs in a home of its own under the run folder, and both model APIs are scripted stand-ins on
local ports (tests/e2e/mocks.py): no request leaves the machine, no usage is spent, and the person's own
Claude Code and Codex are neither read nor written. A run that passes, unkept, removes its folder.
The live cases (tests/e2e/cases/live.py) run real Codex instead, on the person's own ChatGPT login and its
usage limits; the main session stays scripted. Each prints what Codex used.
The cases are in tests/e2e/cases, one file per concern; what they are built from is tests/e2e/harness.py.
The mod's pure logic has its own, faster tests: tests/unit, run by `claude plugin test`.
"""
import argparse
import concurrent.futures
import glob
import os
import shutil
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from tests.e2e import cases  # noqa: E402,F401  (registers the cases)
from tests.e2e.harness import CASES, LIVE, RUN, Case  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('words', nargs='*', help='run the cases whose name contains one of these')
    parser.add_argument('--jobs', type=int, default=5)
    parser.add_argument('--keep', action='store_true')
    parser.add_argument('--out')
    parser.add_argument('--live', action='store_true', help="run the live cases, on the person's Codex login")
    args = parser.parse_args()
    table = LIVE if args.live else CASES
    names = [n for n in table if not args.words or any(w in n for w in args.words)]
    root = args.out or tempfile.mkdtemp(prefix=f'subcodex-tests-{RUN}-')
    os.makedirs(root, exist_ok=True)
    print(f'{len(names)} cases, run {RUN}, in {root}', flush=True)

    def one(name: str) -> Case:
        c = Case(name, root)
        started = time.time()
        try:
            table[name](c)
        except Exception as error:  # a case that cannot even look is a failure, and says why
            c.check(False, f'the case itself failed: {type(error).__name__}: {error}')
        state = 'SKIP' if c.skipped else 'ok  ' if c.checks and all(ok for ok, _ in c.checks) else 'FAIL'
        print(f'{state} {name} ({time.time() - started:.0f}s){" - " + c.skipped if c.skipped else ""}', flush=True)
        for note in c.notes:
            print(f'       {note}', flush=True)
        for ok, what in c.checks:
            if not ok or args.keep:
                print(f'       {"ok" if ok else "NO"}  {what}', flush=True)
        return c

    with concurrent.futures.ThreadPoolExecutor(max_workers=args.jobs) as pool:
        done = list(pool.map(one, names))
    # After every session has ended: no process of the run is left, and no pipe.
    def left() -> list[str]:
        # A process of the run names a case's home on its command line (the mod's servers name their pipe there).
        listed = subprocess.run(['pgrep', '-fl', f'{os.path.realpath(root)}/[^ ]*\\.home/'], capture_output=True, text=True).stdout.split('\n')
        return [line for line in listed if line.strip()]

    for _ in range(10):  # a server told to stop takes a moment to go
        if not left():
            break
        time.sleep(2)
    pipes = glob.glob(f'{root}/*.home/.claude/subcodex/run/*.fifo') + glob.glob(f'{root}/*.home/.claude/subcodex/run/*.pid')
    after = Case('after_every_case', root)
    after.check(not pipes, f"no pipe or pid file of a Codex server is left behind ({len(pipes)} found)")
    after.check(not left(), f'no process of the run is still running ({left()[:2]})')
    print(f'{"ok  " if all(ok for ok, _ in after.checks) else "FAIL"} after_every_case', flush=True)
    for ok, what in after.checks:
        if not ok or args.keep:
            print(f'       {"ok" if ok else "NO"}  {what}', flush=True)
    done.append(after)
    failed = [c.name for c in done if not c.skipped and not (c.checks and all(ok for ok, _ in c.checks))]
    skipped = [c.name for c in done if c.skipped]
    checks = sum(len(c.checks) for c in done)
    print(f'\n{len(done) - len(failed) - len(skipped)} passed, {len(failed)} failed, {len(skipped)} skipped; {checks} checks')
    if failed:
        print('failed:', ', '.join(failed))
    if not args.keep and not failed:
        shutil.rmtree(root, ignore_errors=True)
    else:
        print('run folder kept:', root)
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
