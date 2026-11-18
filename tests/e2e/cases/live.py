"""Live cases: real Codex, on the person's own ChatGPT login, with the main session scripted. Run only with
`--live`. The model is not scripted, so each checks outcomes: what is on disk, what ran, what was decided."""
import os
import random
import subprocess
import sys

from ..harness import LIVE_MODEL, STAMP, Case, claude, codex_task, codex_threads, live_case
from ..mocks import touch


def _live(c: Case, prompt: str, **more):
    return claude(c, [codex_task(prompt, model=LIVE_MODEL)], live=True, **more)


@live_case
def live_fix(c: Case):
    c.git(bug=True)
    s = _live(c, 'The uncommitted change in cart.py applies the coupon twice. Fix it, then say in one sentence what you changed.')
    ran = subprocess.run([sys.executable, '-c', 'from cart import total; assert abs(total([100], 0.1) - 90) < 1e-9'], cwd=c.folder, capture_output=True)
    c.check(ran.returncode == 0, 'the fix is really in the workspace (checked here, not taken from the report)')
    edits = [call for call in s.calls('Edit') + s.calls('Write') if str(call['input'].get('file_path', '')).endswith('cart.py')]
    c.check(edits and not any(call.get('error') for call in edits), "the change is a native Edit or Write row, answered from Codex's diff")
    c.check(s.report().strip() != '', "the result is Codex's closing message")
    threads = codex_threads(c)
    c.check(threads and all(t['model'] == LIVE_MODEL and t['effort'] == 'low' for t in threads), 'Codex ran on the model and effort the call named')


@live_case
def live_tool_search(c: Case):
    c.plain()
    word = f'W{random.randrange(10000, 99999)}'
    s = _live(c, 'Use your tool search to find the stamp tool of the Claude session (in the namespace claude_subcodex-fixture), '
                 f'call it with the arguments {{"word": "{word}"}}, and report exactly what the call returned.')
    stamp = f'STAMP-{word}-OK'
    c.check(any(stamp in call['text'] for call in s.calls('claude_tool') if call['input'].get('name') == STAMP),
            'Codex found the deferred tool and called it: it ran, with the word it was given')
    c.check(stamp in s.report(), 'Codex used what the tool returned')


@live_case
def live_reviewer(c: Case):
    c.plain()
    target = c.home_file('mark')
    s = _live(c, f'Run `{touch(target)}`. That path is outside your workspace, so request escalated permissions for the command, '
                 'with a one-line justification. Then say whether the file exists.')
    said = s.said()
    allowed, refused = "Codex's own reviewer allowed" in said, "Codex's own reviewer refused" in said
    c.check(allowed or refused, "the request for leave went to Codex's own reviewer, whose decision is a line")
    c.check(os.path.exists(target) == allowed, f"the file exists only if the reviewer allowed it ({'allowed' if allowed else 'refused'})")
