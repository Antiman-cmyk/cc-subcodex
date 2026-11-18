"""The engine side of the mod: results and hand-backs, edits, questions and answers, Codex's own sub-agents,
long runs, workflows, background agents."""
import os
import re

from .. import host
from ..harness import COMMAND_ROW, Case, case, claude, codex_task, only_synthetic_at_no_cost, usage_links
from ..mocks import LINES, agent_id, answer, call, latest, note, patch, run, say, sh, use

# Codex's command: it adds a line to ran.txt each time it runs.
ONCE = sh('echo ran >> ran.txt; echo hello-from-worker', "Add-Content ran.txt ran; 'hello-from-worker'")
PLAIN = [[note('I will run one command first.'), run(ONCE)], answer('The command printed hello-from-worker.')]


def _runs(c: Case) -> int:
    """How many times Codex's command has run in the case's folder."""
    path = os.path.join(c.folder, 'ran.txt')
    return len(open(path).read().split()) if os.path.exists(path) else 0


@case
def plain_default(c: Case):
    c.plain()
    s = claude(c, [codex_task('Run one command and report what it printed.')], PLAIN)
    c.check(s.report() == 'The command printed hello-from-worker.', f'the result is the closing message alone, word for word (got {s.report()!r})')
    bash = s.calls(COMMAND_ROW)
    c.check(len(bash) == 1 and 'hello-from-worker' in bash[0]['text'], f"one {COMMAND_ROW} row, answered with the output Codex's command produced")
    c.check(_runs(c) == 1, f'the command ran once, in Codex: its {COMMAND_ROW} row did not run it again ({_runs(c)} runs)')
    c.check(re.search(r'sandbox "?workspaceWrite', s.log), "Codex's sandbox is the one its config names, workspace-write")
    only_synthetic_at_no_cost(c, s)
    if host.WINDOWS:
        bare = claude(c, [codex_task('Run one command and report what it printed.')], PLAIN, env={'CLAUDE_CODE_USE_POWERSHELL_TOOL': '0'})
        rows = bare.calls('Bash')
        c.check(len(rows) == 1 and 'hello-from-worker' in rows[0]['text'] and not bare.calls('PowerShell'),
                'in a session without the PowerShell tool, the command is a Bash row')
        c.check(_runs(c) == 2, f'... which did not run it again either ({_runs(c) - 1} runs)')


@case
def plain_auto(c: Case):
    c.plain()
    s = claude(c, [codex_task('Run one command and report what it printed.')], PLAIN, mode='auto')
    backs = s.calls('SubagentHandback')
    c.check(len(backs) == 1 and backs[0]['by'] == '<synthetic>', 'the result is handed back once, by the local protocol')
    c.check(s.report() == 'The command printed hello-from-worker.', 'the hand-back is the closing message, word for word, without notes')
    rows = s.calls(COMMAND_ROW)
    c.check(len(rows) == 1 and 'hello-from-worker' in rows[0]['text'] and not rows[0]['error'], f"one {COMMAND_ROW} row, answered with the output Codex's command produced")
    c.check(_runs(c) == 1, f'the command ran once, in Codex: in auto mode too its {COMMAND_ROW} row did not run it again ({_runs(c)} runs)')
    only_synthetic_at_no_cost(c, s)


CART = 'function total(items) {\n    const sum = items.reduce(add, 0)\n    item.price = applyDiscount(item.price, this.coupon)\n    return applyDiscount(sum, this.coupon)\n}\n'
UNDOUBLE = ('*** Begin Patch\n*** Update File: src/cart.js\n@@\n     const sum = items.reduce(add, 0)\n'
            '-    item.price = applyDiscount(item.price, this.coupon)\n     return applyDiscount(sum, this.coupon)\n*** End Patch\n')
CLAIM = 'Fixed: the coupon was applied twice in src/cart.js and is now applied once. All tests pass and lint is clean.'


def _cart(c: Case) -> None:
    c.plain()
    os.makedirs(f'{c.folder}/src', exist_ok=True)
    open(f'{c.folder}/src/cart.js', 'w').write(CART)


@case
def claim_auto(c: Case):
    _cart(c)
    failing = sh("sh -c 'echo Tests: 1 failed, 6 passed, 7 total; exit 1'", "Write-Output 'Tests: 1 failed, 6 passed, 7 total'; exit 1")
    s = claude(c, [codex_task('Fix the double discount in src/cart.js and make sure tests and lint pass.')],
               [[note('Removing the second discount.'), patch(UNDOUBLE)], [run(failing)], answer(CLAIM)], mode='auto')
    c.check(s.report() == CLAIM, 'even an inaccurate closing message is handed back word for word; no review of it is claimed')
    edits = s.calls('Edit')
    c.check(len(edits) == 1 and str(edits[0]['input'].get('file_path')).replace('\\', '/').endswith('src/cart.js')
            and 'applyDiscount(item.price' in str(edits[0]['input'].get('old_string')), "Codex's edit is a native Edit row")
    c.check(edits and not edits[0].get('error') and open(f'{c.folder}/src/cart.js').read() == CART.replace('    item.price = applyDiscount(item.price, this.coupon)\n', ''),
            'the row was answered from the diff: the file has the change once')
    c.check(any('1 failed' in call['text'] for call in s.calls(COMMAND_ROW)), 'the failing test run is a row with its output')
    only_synthetic_at_no_cost(c, s)


QUESTION = ('I have not changed anything yet, because I need a decision first. src/cart.js applies the coupon twice. '
            'Which is intended: should VIP customers keep the double discount, or should I remove it for everyone?')
ASK = [[run(sh('grep -n applyDiscount src/cart.js', 'Select-String -Path src/cart.js -Pattern applyDiscount'))], answer(QUESTION),
       [note('Thanks, that settles it. Applying the decision now.'), patch(UNDOUBLE)], answer('Done as decided: the coupon is applied once for everyone.')]
ANSWER = 'Remove it for everyone and change the test'


def _ask(c: Case, mode: str):
    _cart(c)
    main = [codex_task('Fix the discount bug in src/cart.js.'),
            lambda body: call('SendMessage', to=agent_id(body), message=ANSWER, summary='The answer'),
            say('Waiting for the agent.'),
            lambda body: say(f'Its final report: {latest(body)}')]
    return claude(c, main, ASK, mode=mode)


@case
def ask_default(c: Case):
    s = _ask(c, 'default')
    first = next((call for call in s.main if call['name'] == 'Agent'), {'text': ''})
    c.check('Which is intended' in first['text'], 'the first turn ends on the question, as the result')
    c.check(any(call['name'] == 'SendMessage' for call in s.main), 'the caller answered with a message to the agent')
    c.check(s.traced('Codex turn 2'), 'the message started a second Codex turn')
    asked = [r for r in s.mocks.asked('openai') if ANSWER in str(r['body'].get('input'))]
    c.check(asked, 'the second turn was given the answer')
    c.check('Done as decided' in s.result, 'the final report reached the main session')


@case
def ask_auto(c: Case):
    s = _ask(c, 'auto')
    backs = s.calls('SubagentHandback')
    c.check(len(s.agents) == 1 and len(backs) == 2, 'the same native agent hands back twice')
    c.check('Which is intended' in str(backs[0]['input']) if backs else False, 'the first hand-back carries the question')
    c.check('Done as decided' in s.result, 'the resumed result reaches the main session')
    only_synthetic_at_no_cost(c, s)


YEAR = sh('date +%Y', 'Get-Date -Format yyyy')
SYSTEM = sh('uname', '[Environment]::OSVersion.Platform')


@case
def team_default(c: Case):
    c.plain()
    parent = [
        [note('I will have a sub-agent count the lines of the notes file while I check the date.'),
         use('spawn_agent', namespace='collaboration', message='Count the lines of notes.txt.', task_name='line_counter', fork_turns='none'),
         run(YEAR), run(SYSTEM)],
        [use('wait_agent', namespace='collaboration', timeout_ms=30000)],
        answer('The year is known, and my sub-agent counted 3 lines in notes.txt.'),
    ]
    sub = [[note('Counting the lines of notes.txt.'), run(LINES)], answer('notes.txt has 3 lines.')]
    s = claude(c, [codex_task('Count the lines of notes.txt with a sub-agent and tell me the year.')],
               {'tell me the year': parent, 'Count the lines of notes.txt.': sub})
    c.check(s.report() == 'The year is known, and my sub-agent counted 3 lines in notes.txt.', f"the result is Codex's own closing message, without the sub-agent's words (got {s.report()!r})")
    by_command = {str(call['input'].get('command')): call for call in s.calls(COMMAND_ROW)}
    date = next((call for command, call in by_command.items() if YEAR in command), {})
    uname = next((call for command, call in by_command.items() if SYSTEM in command), {})
    c.check(re.search(r'20\d\d', date.get('text', '')), 'two commands side by side: `date` got its own output')
    c.check(any(name in uname.get('text', '') for name in ('Darwin', 'Linux', 'Win32NT')), '... and `uname` its own')
    wc = next((call for command, call in by_command.items() if LINES in command), {})
    c.check('3' in wc.get('text', '') and 'sub-agent' in str(wc.get('input', {}).get('description')), "the sub-agent's command is a row marked as its")
    c.check('] Counting the lines' in s.said() and '[Codex sub-agent' in s.said(), "the sub-agent's words are shown under its name")


@case
def long_auto(c: Case):
    c.plain()
    # With a compaction window of 50,000 tokens the engine cuts its copy of the context about every 24 of these rows.
    shards = 60
    page = sh("seq 1 400 | sed 's/^/row checked against baseline, drift within tolerance, status nominal, line /'",
              '1..400 | ForEach-Object { "row checked against baseline, drift within tolerance, status nominal, line $_" }')
    steps = [[run(f'echo shard {n}; {page}')] for n in range(shards)] + [answer(f'All {shards} shards scanned. Nothing drifted; the codeword for this run is HERON-42.')]
    main = [codex_task('Scan every shard and report.'), lambda body: say(f'Its codeword: {latest(body) or body}'[:2000])]
    s = claude(c, main, steps, mode='auto', timeout=600, env={'CLAUDE_CODE_AUTO_COMPACT_WINDOW': '50000'})
    c.check('HERON-42' in s.report(), 'a run far longer than its context window still ends with its result')
    c.check(len(s.calls(COMMAND_ROW)) >= shards, f'all {shards} commands are rows of the transcript')
    cuts = sum(r['kind'] == 'compacted' for r in s.rows)
    c.check(cuts >= 2, f"the engine's copy of the context was cut on the way, and cut again ({cuts} times)")
    c.check('Prompt is too long' not in s.log and 'terminated early' not in s.log, 'no step was refused as too long, and the agent was not ended')
    c.check(all(len(call['text']) <= 2000 + 6000 + 200 for call in s.calls(COMMAND_ROW)), "each command's mirrored output is held to its start and end")
    back = s.calls('SubagentHandback')
    c.check(back and back[0]['tokens'] == 0, f'the local hand-back costs no tokens ({back[0]["tokens"] if back else "?"} tokens)')
    only_synthetic_at_no_cost(c, s)


WORKFLOW = ('export const meta = { name: "codex-one", description: "One Codex agent with a schema" }; '
            'const r = await agent("Run one command and tell me what it printed.", { agentType: "subcodex:codex", '
            'schema: { type: "object", properties: { printed: { type: "string" } }, required: ["printed"] } }); return r;')
SUBMIT = [[run('echo hello-from-worker')], [use('workflow_result', printed='hello-from-worker')], answer('Submitted.')]


def _workflow(c: Case, mode: str):
    c.plain()
    main = [call('Workflow', script=WORKFLOW), say('Waiting for the workflow.'), lambda body: say(f'It returned: {latest(body)}')]
    # Outside auto mode the Workflow tool needs approval: allowed by rule here.
    s = claude(c, main, SUBMIT, mode=mode, extra=() if mode == 'auto' else ('--allowedTools', 'Workflow'))
    forms = s.calls('StructuredOutput')
    printed = str(forms[0]['input'].get('printed')) if forms else ''
    c.check(len(forms) == 1 and printed == 'hello-from-worker', f"the workflow's form is filled once, by Codex's workflow_result ({printed!r})")
    c.check('hello-from-worker' in s.result, 'the workflow returned the filled form')
    only_synthetic_at_no_cost(c, s)
    c.check(COMMAND_ROW in [call['name'] for call in s.rows if call['kind'] == 'call'], "the workflow's agent mirrored Codex's command")
    links = usage_links(c)
    c.check(links and all(os.path.exists(link) for link in links), f"the workflow's Codex session is linked for usage tools ({len(links)})")


@case
def workflow_default(c: Case):
    _workflow(c, 'default')


@case
def workflow_auto(c: Case):
    _workflow(c, 'auto')


@case
def workflow_plain_auto(c: Case):
    c.plain()
    script = 'export const meta = {name:"plain",description:"Plain Codex result"}; return await agent("Report the greeting.",{agentType:"subcodex:codex"});'
    main = [call('Workflow', script=script), say('Waiting for the workflow.'), lambda body: say(f'It returned: {latest(body)}')]
    s = claude(c, main, PLAIN, mode='auto')
    c.check('hello-from-worker' in s.result, 'a workflow without a schema returns the plain report')
    c.check(not s.calls('StructuredOutput'), 'no structured result is invented')
    only_synthetic_at_no_cost(c, s)


@case
def background_auto(c: Case):
    c.plain()
    main = [codex_task('Run one command and report what it printed.', background=True), say('Waiting for the agent.'),
            lambda body: say(f'Its report: {latest(body)}')]
    s = claude(c, main, PLAIN, mode='auto')
    c.check(any(call['name'] == 'Agent' and call['input'].get('run_in_background') is True for call in s.main), 'the native agent ran in the background')
    c.check('hello-from-worker' in s.result, 'the completed report reached the main session')
    only_synthetic_at_no_cost(c, s)
