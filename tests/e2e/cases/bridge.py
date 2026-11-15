"""Codex calling a tool the Claude session has connected (the tests' fixture tools): run directly,
refused by a deny rule, not run in plan mode, and a picture passed on."""
import random

from ..harness import STAMP, Case, case, claude, codex_task, codex_threads
from ..mocks import answer, outputs, use

# The namespace Codex is given the fixture's tools in, and its picture tool.
STAMP_NAMESPACE = 'claude_subcodex-fixture'
PICTURE = 'mcp__subcodex-fixture__picture'
# The fixture's picture, as its tool returns it.
RED = 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGO4IyKCFTEMLQkAmD9BAZzFjLYAAAAASUVORK5CYII='


def _bridge(c: Case, extra: tuple = (), mode: str = 'default') -> tuple:
    c.plain()
    word = f'W{random.randrange(10000, 99999)}'
    codex = [[use('stamp', namespace=STAMP_NAMESPACE, word=word)],
             lambda body: answer(f'The stamp tool returned: {(outputs(body) or ["nothing"])[-1]}')]
    s = claude(c, [codex_task('Call the Claude session\'s stamp tool and report what it returned.')], codex, mode=mode, extra=extra)
    return s, f'STAMP-{word}-OK'


def _ran(s, stamp: str) -> bool:
    return any(stamp in call['text'] for call in s.calls('claude_tool') if call['input'].get('name') == STAMP)


def _offered(c: Case) -> bool:
    """Whether the thread was given the fixture's tools in their namespace, to be loaded when Codex looks for them."""
    spaces = [tool for thread in codex_threads(c) for tool in thread['tools'] if tool.get('name') == STAMP_NAMESPACE]
    return bool(spaces) and all(tool.get('deferLoading') for space in spaces for tool in space.get('tools', []))


@case
def bridge_runs(c: Case):
    s, stamp = _bridge(c)
    c.check(_offered(c), "Codex was given the session's tools, deferred, in a namespace of their connection")
    c.check(_ran(s, stamp), 'no rule speaks of the tool, and it ran at once: its result is on the row')
    c.check(any(stamp in out for out in outputs(s.mocks.asked('openai')[-1]['body'])), 'and its result went back to Codex')
    c.check(not s.calls('approve'), 'no one was asked first')
    c.check(stamp in s.report(), 'Codex used what the tool returned')


@case
def bridge_auto(c: Case):
    s, stamp = _bridge(c, mode='auto')
    c.check(_ran(s, stamp), 'in auto mode too the tool ran at once')
    claude_rows = [r.get('name') for r in s.rows if str(r.get('by', '')).startswith('claude-')]
    c.check(claude_rows == [], f'no Claude request in the agent ({claude_rows})')
    c.check(stamp in s.report(), 'Codex used what the tool returned')


@case
def bridge_denied_by_rule(c: Case):
    s, stamp = _bridge(c, extra=('--disallowedTools', STAMP))
    c.check(not _ran(s, stamp), "a deny rule of the person's still refuses the tool: it did not run")
    c.check(stamp not in s.report(), 'and Codex has no result of it')


@case
def bridge_plan(c: Case):
    s, stamp = _bridge(c, mode='plan')
    c.check(not _ran(s, stamp), 'plan mode: the tool did not run')
    c.check(any('plan mode' in call['text'] for call in s.calls('claude_tool')), 'and Codex was told why')


@case
def bridge_picture(c: Case):
    c.plain()
    codex = [[use('picture', namespace=STAMP_NAMESPACE)],
             lambda body: answer('red' if RED in ''.join(outputs(body)) else 'no picture came')]
    s = claude(c, [codex_task("Call the Claude session's picture tool and say what color the picture is.")], codex)
    rows = [call for call in s.calls('claude_tool') if call['input'].get('name') == PICTURE]
    c.check(rows and 'went to Codex' in rows[0]['text'], 'the tool ran, and its row says its picture went to Codex')
    c.check(s.report() == 'red', f'the picture itself reached Codex, as an image with the result ({s.report()[:80]!r})')
