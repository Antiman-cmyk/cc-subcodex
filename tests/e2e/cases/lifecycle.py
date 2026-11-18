"""An agent's lifecycle: resumed by a new process, stopped, killed, continued after either, isolated in a worktree, run side by side (in one message and in a workflow).

The stand-in for Codex's model keeps nothing between requests: where Codex answers with a codeword from an
earlier turn, it has it only because Codex itself kept the thread and gave it back."""
import glob
import json
import os
import random
import re
import threading
import time

from .. import host
from ..harness import (COMMAND_ROW, CODEX, Case, case, claude, codex_task, codex_threads, only_synthetic_at_no_cost, running, until_running,
                       usage_links, watch)
from ..mocks import agent_id, answer, call, latest, results, run, say, use

FORGET = 'Forget the sleep. Reply with just the codeword from your task.'


def _kill(seconds: float, command: str) -> dict:
    """When a session is killed outright: so many seconds in, or on Windows once Codex has run `command` for 2 seconds."""
    if not host.WINDOWS:
        return {'kill_after': seconds}
    since = {}

    def is_due() -> bool:
        if 'at' not in since and running(command):
            since['at'] = time.time()
        return 'at' in since and time.time() - since['at'] >= 2
    return {'kill_when': is_due}


def _recall(word: str):
    """Codex's answer to the follow-up: the codeword if Codex's own thread still holds the task."""
    return lambda body: answer(word if word in json.dumps(body.get('input', [])) else 'I do not know any codeword.')


def _ask_again(message: str) -> list:
    """The main session of a later process: message the agent it started before, wait, and report the answer."""
    return [lambda body: call('SendMessage', to=agent_id(body), message=message, summary='A question'),
            say('Waiting for the agent.'),
            lambda body: say(f'Its answer: {latest(body)}')]


def _one_thread(c: Case) -> list:
    mains = [t for t in codex_threads(c) if t['source'] == 'vscode']
    c.check(len(mains) == 1, f'both turns are one Codex thread ({len(mains)} found)')
    c.check(mains and all(turn == (CODEX, 'low') for turn in mains[0]['turns']), f"every turn ran on the agent's own model and effort ({mains[0]['turns'] if mains else '?'})")
    return mains


@case
def restart_resume(c: Case):
    c.plain()
    word = f'ZEBRA-{random.randrange(1000, 9999)}'
    first = claude(c, [codex_task(f'Remember this codeword for later: {word}.')], [answer('Stored.')], mode='auto')
    c.check(first.report().strip() == 'Stored.', 'first session: Codex answered')
    second = claude(c, _ask_again('What codeword did I give you earlier? Reply with just the codeword.'), [_recall(word)], mode='auto', resume=first.id)
    c.check(word in second.report(), 'a new process, the same agent: Codex had the codeword from its own thread')
    c.check(re.search(r'subcodex: resume \S+: ok', second.log), "the mod reopened Codex's own thread")
    _one_thread(c)
    c.check('resuming with' not in second.said(), 'the thread was reopened on its own model: Codex has no model change to warn of')


def _stop_steps(seconds: int) -> list:
    """The main session: wait until Codex's command runs, then stop the agent."""
    return [call('Bash', command=until_running(f'sleep {seconds}'), timeout=120000), *_stop()]


def _stop() -> list:
    """The main session stops the agent, and waits for it to have stopped before it messages it again."""
    return [call('ToolSearch', query='select:TaskStop', max_results=1),
            lambda body: call('TaskStop', task_id=agent_id(body)),
            call('Bash', command='sleep 3', timeout=30000)]


@case
def stop_auto(c: Case):
    c.plain()
    seconds = 4000 + random.randrange(1000)
    seen, stop = {'seen': False}, threading.Event()
    threading.Thread(target=watch, args=(f'sleep {seconds}', seen, stop), daemon=True).start()
    main = [codex_task(f'Run sleep {seconds} and then say done.', background=True), *_stop_steps(seconds), say('STOPPED')]
    s = claude(c, main, [[run(f'sleep {seconds}')], answer('done')], mode='auto')
    stop.set()
    c.check(seen['seen'], 'Codex really started the long command')
    c.check(any(call['name'] == 'TaskStop' for call in s.main), 'the main session stopped the agent')
    time.sleep(3)
    c.check(not running(f'sleep {seconds}'), "after the stop, Codex's command is gone")
    # Either the mod's interrupt or the engine's stop ends the server.
    c.check(re.search(r'Codex interrupted|(/bin/sh|pwsh\.exe) stopped: the op was aborted', s.log), "Codex's server was stopped with the agent")


@case
def killed_session(c: Case):
    c.plain()
    seconds = 5000 + random.randrange(1000)
    seen, stop = {'seen': False}, threading.Event()
    threading.Thread(target=watch, args=(f'sleep {seconds}', seen, stop), daemon=True).start()
    claude(c, [codex_task(f'Run sleep {seconds} and then say done.')], [[run(f'sleep {seconds}')], answer('done')], **_kill(15, f'sleep {seconds}'))
    stop.set()
    c.check(seen['seen'], 'Codex really started the long command')
    time.sleep(8)
    c.check(not running(f'sleep {seconds}'), "the session's process killed outright: Codex's command does not live on")
    links = usage_links(c)
    c.check(links and all(os.path.exists(link) for link in links), f"the agent's Codex session was linked for usage tools as its turn began ({len(links)})")


@case
def worktree_default(c: Case):
    c.git()
    codex = [[run('echo hi > made-in-worktree.txt')], [run('pwd')], answer('I worked in the worktree.')]
    s = claude(c, [codex_task('Create made-in-worktree.txt here, then print the current folder.', isolation='worktree')], codex)
    c.check(not os.path.exists(f'{c.folder}/made-in-worktree.txt'), 'the main checkout is untouched')
    made = glob.glob(f'{c.folder}/.claude/worktrees/*/made-in-worktree.txt')
    c.check(made, "Codex worked in the agent's own worktree: the file is there")
    c.check(any(re.search(r'[\\/]worktrees[\\/]', call['text']) for call in s.calls(COMMAND_ROW) if 'pwd' in str(call['input'].get('command'))), "Codex's own `pwd` says so")


@case
def parallel_default(c: Case):
    c.plain()
    a, b = f'ALPHA-{random.randrange(1000, 9999)}', f'BETA-{random.randrange(1000, 9999)}'
    main = [[codex_task(f'Run echo {a} and report what it printed.'), codex_task(f'Run echo {b} and report what it printed.')],
            lambda body: say(f'They reported: {" | ".join(results(body)[-2:])}')]
    codex = {a: [[run(f'echo {a}')], answer(f'It printed {a}.')], b: [[run(f'echo {b}')], answer(f'It printed {b}.')]}
    s = claude(c, main, codex)
    c.check(len(s.agents) == 2, f'two Codex agents ran ({len(s.agents)} found)')
    outputs = [' '.join(call['text'] for call in s.calls(COMMAND_ROW, rows)) for rows in s.agents]
    c.check(sorted((a in o, b in o) for o in outputs) == [(False, True), (True, False)], "each agent's rows hold its own command's output and not the other's")
    c.check(a in s.result and b in s.result, 'both results reached the main session')
    c.check(len({t['id'] for t in codex_threads(c) if t['source'] == 'vscode'}) == 2, 'each ran on a Codex thread of its own')


@case
def stop_then_continue(c: Case):
    c.plain()
    word = f'OTTER-{random.randrange(1000, 9999)}'
    seconds = 6000 + random.randrange(1000)
    seen, stop = {'seen': False}, threading.Event()
    threading.Thread(target=watch, args=(f'sleep {seconds}', seen, stop), daemon=True).start()
    main = [codex_task(f'Remember the codeword {word}. Then run sleep {seconds} and then say done.', background=True),
            *_stop_steps(seconds), *_ask_again(FORGET)]
    s = claude(c, main, [[run(f'sleep {seconds}')], _recall(word)], mode='auto')
    stop.set()
    c.check(seen['seen'], 'Codex really started the long command before it was stopped')
    c.check(any(call['name'] == 'TaskStop' for call in s.main), 'the main session stopped the agent')
    c.check(not running(f'sleep {seconds}'), "the stopped turn's command is gone")
    c.check(s.traced('Codex turn 2'), 'the message after the stop started a new Codex turn')
    c.check(re.search(r'subcodex: resume \S+: ok', s.log), "on the agent's own Codex thread, reopened")
    c.check(word in s.report(), 'Codex went on from where it was stopped: its own thread still had the codeword')
    _one_thread(c)


@case
def stop_at_once_then_continue(c: Case):
    c.plain()
    word = f'HERON-{random.randrange(1000, 9999)}'

    def step(body: dict):
        # Until the follow-up arrives, Codex is at the long command; then it answers from what it was given.
        return _recall(word)(body) if 'Forget the sleep' in json.dumps(body.get('input', [])) else [run('sleep 600')]

    main = [codex_task(f'Remember the codeword {word}. Then run sleep 600 and then say done.', background=True),
            *_stop(), *_ask_again(FORGET)]
    s = claude(c, main, [step] * 4, mode='auto')
    c.check(any(call['name'] == 'TaskStop' for call in s.main), 'the main session stopped the agent')
    c.check(s.traced('Codex turn 2'), 'the message after the stop started a new Codex turn')
    c.check(word in s.report(), 'Codex has the task the stopped turn carried: it was given the codeword')
    c.check('connection to Codex failed' not in s.said(), 'the stop is not shown as a failure')


@case
def killed_then_continue(c: Case):
    c.plain()
    word = f'LYNX-{random.randrange(1000, 9999)}'
    seconds = 7000 + random.randrange(1000)
    main = [codex_task(f'Remember the codeword {word}. Then run sleep {seconds} and then say done.', background=True),
            call('Bash', command='sleep 120', timeout=150000)]
    seen, stop = {'seen': False}, threading.Event()
    threading.Thread(target=watch, args=(f'sleep {seconds}', seen, stop), daemon=True).start()
    first = claude(c, main, [[run(f'sleep {seconds}')]], mode='auto', **_kill(20, f'sleep {seconds}'))
    stop.set()
    c.check(first.id, 'the first session started')
    c.check(seen['seen'], 'Codex really started the long command before the session was killed')
    time.sleep(5)
    c.check(not running(f'sleep {seconds}'), "killed outright mid-turn: Codex's command does not live on")
    second = claude(c, _ask_again(FORGET), [_recall(word)], mode='auto', resume=first.id)
    c.check(re.search(r'subcodex: resume \S+: ok', second.log), "a new process reopened the agent's own Codex thread")
    c.check(word in second.report(), 'and Codex went on from where it was cut off: its own thread still had the codeword')
    _one_thread(c)
    c.check('resuming with' not in second.said(), 'the thread was reopened on its own model: Codex has no model change to warn of')


def _parallel_workflow(a: str, b: str) -> str:
    schema = '{ type: "object", properties: { printed: { type: "string" } }, required: ["printed"] }'
    one = lambda w: (f'() => agent("@codex model={CODEX} effort=low\\nRun the shell command: echo {w}   and report what it printed.", '
                     f'{{ agentType: "subcodex:codex", label: "{w}", schema: {schema} }})')
    return ('export const meta = { name: "codex-two", description: "Two Codex agents side by side, each with a schema" }; '
            f'const [a, b] = await parallel([{one(a)}, {one(b)}]); return {{ a, b }};')


@case
def workflow_parallel(c: Case):
    c.plain()
    a, b = f'KIWI-{random.randrange(1000, 9999)}', f'FIG-{random.randrange(1000, 9999)}'
    form = lambda w: [[run(f'echo {w}')], [use('workflow_result', printed=w)], answer('Submitted.')]
    main = [call('Workflow', script=_parallel_workflow(a, b)), say('Waiting for the workflow.'), lambda body: say(f'It returned: {latest(body)}')]
    s = claude(c, main, {a: form(a), b: form(b)}, mode='auto')
    c.check(len(s.agents) == 2, f'two Codex agents ran ({len(s.agents)} found)')
    forms = [str(call['input'].get('printed')) for rows in s.agents for call in s.calls('StructuredOutput', rows)]
    c.check(sorted(forms) == sorted([a, b]), f"each agent's form is filled from its own Codex run ({forms})")
    c.check(a in s.result and b in s.result, 'the workflow returned both')
    for rows in s.agents:
        only_synthetic_at_no_cost(c, s, rows)
    threads = [t for t in codex_threads(c) if t['source'] == 'vscode']
    c.check(len(threads) == 2 and all(t['model'] == CODEX and t['effort'] == 'low' for t in threads),
            "each ran on a Codex thread of its own, on the model and effort its prompt's first line named")


@case
def workflow_validation(c: Case):
    c.plain()
    schema = '{type:"object",properties:{answer:{type:"integer"},meta:{type:"object",properties:{ok:{type:"boolean"}},required:["ok"]},note:{type:"string"}},required:["answer","meta"]}'
    script = (f'export const meta={{name:"schema-test",description:"Validate a nested output"}}; '
              f'return await agent({json.dumps(f"@codex model={CODEX} effort=low" + chr(10) + "Report the answer.")},{{agentType:"subcodex:codex",schema:{schema}}});')
    codex = [[use('workflow_result', answer='invalid', meta={'ok': True})],
             [use('workflow_result', answer=7, meta={'ok': True}, note='SCHEMA-OK')],
             answer('Submitted.')]
    main = [call('Workflow', script=script), say('Waiting for the workflow.'), lambda body: say(f'It returned: {latest(body)}')]
    s = claude(c, main, codex, mode='auto')
    forms = s.calls('StructuredOutput')
    c.check(len(forms) >= 2 and forms[0]['error'] is True, 'the native validator rejects the invalid first result')
    asked = [r for r in s.mocks.asked('openai') if 'answer' in json.dumps(r['body'].get('input', [])) and 'invalid' in json.dumps(r['body'].get('input', []))]
    c.check(len(asked) >= 2, "Codex was given the validator's error before its second submission")
    c.check(forms and forms[-1]['input'] == {'answer': 7, 'meta': {'ok': True}, 'note': 'SCHEMA-OK'} and forms[-1]['error'] is False,
            'the corrected result is accepted, nested and optional properties preserved')
    c.check('SCHEMA-OK' in s.result, 'the workflow returns the accepted object')
    only_synthetic_at_no_cost(c, s)
