"""Codex asking leave to act outside its sandbox: its own reviewer answers, and under plan mode the mod refuses."""
import os
import re

from ..harness import Case, case, claude, codex_task
from ..mocks import answer, run

WHY = 'The task asks to create this file outside the workspace.'


@case
def plan_readonly(c: Case):
    c.plain()
    target = c.home_file('plan')
    s = claude(c, [codex_task('Find out what your sandbox lets you do.')],
               [[run('touch made-by-codex.txt')], [run(f'touch {target}', escalate=WHY)], answer('Neither was allowed.')], mode='plan')
    c.check(not os.path.exists(f'{c.folder}/made-by-codex.txt'), 'plan mode: nothing was written in the workspace')
    c.check(not os.path.exists(target), 'plan mode: nothing was written outside it either')
    c.check(re.search(r'sandbox "?readOnly', s.log), "Codex's sandbox was read-only")
    c.check(re.search(r'approvals \S+/user,', s.log), "a request for leave comes to the mod, not to Codex's own reviewer")
    c.check('refused, as plan mode lets nothing be changed' in s.said(), 'the request for leave was refused outright, and says so')


def _leave(c: Case, mode: str, reviewer: str = 'allow'):
    c.plain()
    target = c.home_file('mark')
    s = claude(c, [codex_task('Create the mark file outside the workspace.')],
               [[run(f'touch {target}', escalate=WHY)], answer('Done.')], mode=mode, reviewer=reviewer)
    c.check(re.search(r'approvals \S+/auto_review,', s.log), "the thread's requests for leave go to Codex's own reviewer")
    return s, target


@case
def leave_reviewer(c: Case):
    s, target = _leave(c, 'default')
    c.check("Codex's own reviewer allowed" in s.said(), "the reviewer's decision is a line")
    c.check(os.path.exists(target), 'the file was created')


@case
def leave_reviewer_auto(c: Case):
    s, target = _leave(c, 'auto')
    c.check("Codex's own reviewer allowed" in s.said() and os.path.exists(target), 'the reviewer allowed it, and the file was created')
    claude_rows = [r for r in s.rows if str(r.get('by', '')).startswith('claude-')]
    c.check(not claude_rows, f"no Claude request in the agent ({[r.get('name') for r in claude_rows]})")


@case
def leave_reviewer_refused(c: Case):
    s, target = _leave(c, 'default', reviewer='deny')
    c.check("Codex's own reviewer refused" in s.said(), "the reviewer's refusal is a line")
    c.check(not os.path.exists(target), 'the file was not created')
