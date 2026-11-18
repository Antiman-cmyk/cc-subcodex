"""Messages between Codex and the agent that delegated the task, while Codex works: each way, and each way the call can be made."""
import json
import random

from ..harness import COMMAND_ROW, Case, case, claude, codex_task, only_synthetic_at_no_cost, until_running
from ..mocks import LINES, agent_id, answer, call, latest, outputs, results, run, say, use

SEND = [[use('message_parent', message='halfway there')], [run(LINES)], answer('notes.txt has 3 lines.')]


def _heard(body: dict) -> dict:
    """The main session's last words: whether the message reached it, and the agent's report."""
    heard = 'halfway there' in json.dumps(body.get('messages', []))
    return say(f"Message: {'halfway there' if heard else 'none'}. Report: {(results(body) or [''])[-1][-300:]}")


def _main() -> list:
    # The message may come with the agent's result, or after it: wait once for it.
    return [codex_task('Tell me when you are halfway, then count the lines of notes.txt.'),
            lambda body: _heard(body) if 'halfway there' in json.dumps(body.get('messages', [])) else say('Waiting.'),
            _heard]


@case
def message_default(c: Case):
    c.plain()
    s = claude(c, _main(), SEND)
    sends = s.calls('SendMessage')
    c.check(len(sends) == 1 and sends[0]['by'] == '<synthetic>' and not sends[0]['error'], 'the mod itself wrote the call that sent the message, and it went')
    c.check('halfway there' in str(sends[0]['input'].get('message') if sends else ''), "the message is Codex's own words")
    c.check(not [r for r in s.rows if str(r.get('by', '')).startswith('claude-')], 'no Claude request was made inside the agent')
    c.check('Message: halfway there' in s.result, 'the main session received the message')
    only_synthetic_at_no_cost(c, s)
    c.check(any(LINES in str(call['input'].get('command')) for call in s.calls(COMMAND_ROW)), 'Codex went on working after sending it')


@case
def message_auto(c: Case):
    c.plain()
    s = claude(c, _main(), SEND, mode='auto')
    sends = s.calls('SendMessage')
    c.check(any(call['by'] == '<synthetic>' and not call['error'] and 'halfway there' in str(call['input'].get('message')) for call in sends),
            'the local protocol sent the message, word for word')
    c.check('Message: halfway there' in s.result, 'the main session received the message')
    only_synthetic_at_no_cost(c, s)


@case
def message_auto_allowed(c: Case):
    c.plain()
    s = claude(c, _main(), SEND, mode='auto', extra=('--allowedTools', 'SendMessage'))
    sends = s.calls('SendMessage')
    c.check(len(sends) == 1 and sends[0]['by'] == '<synthetic>' and not sends[0]['error'], 'with the tool allowed by rule, the message goes as in auto mode')
    c.check('Message: halfway there' in s.result, 'the main session received the message')
    only_synthetic_at_no_cost(c, s)


@case
def steer_auto(c: Case):
    c.plain()
    seconds = f'{random.randrange(6, 9)}.{random.randrange(10, 99)}'
    fruit = lambda body: 'BANANA' if 'BANANA' in json.dumps(body.get('input', [])) else 'APPLE'
    # The engine hands the message over at the agent's next tool round, the end of the first sleep: the second
    # keeps Codex's turn going meanwhile, so the message joins that turn.
    codex = [[run(f'sleep {seconds}')], [run('sleep 3')], lambda body: [run(f'echo {fruit(body)}')], lambda body: answer(f'I echoed {fruit(body)}.')]
    main = [codex_task('Sleep, then echo the fruit word, APPLE unless a message says otherwise, and report it.', background=True),
            call('Bash', command=until_running(f'sleep {seconds}'), timeout=60000),
            lambda body: call('SendMessage', to=agent_id(body), message='Change of plan: the fruit word is BANANA.', summary='A change'),
            say('Waiting for the agent.'),
            lambda body: say(f'Its report: {latest(body)}')]
    s = claude(c, main, codex, mode='auto')
    c.check(s.traced('passed on to Codex'), 'the message reached Codex while it was at work, in the turn it was in')
    echoes = [str(call['input'].get('command')) for call in s.calls(COMMAND_ROW) if 'echo' in str(call['input'].get('command'))]
    c.check(any('BANANA' in e for e in echoes) and not any('APPLE' in e for e in echoes), f'Codex acted on it: it echoed BANANA, not APPLE ({echoes})')
    c.check(not s.traced('Codex turn 2'), 'the message did not also start a second Codex turn that does the task again')
    c.check('BANANA' in s.report(), "Codex's own report says BANANA")


@case
def message_auto_denied(c: Case):
    c.plain()
    codex = [[use('message_parent', message='MUST-NOT-DELIVER')],
             lambda body: answer('DELIVERY-DENIED' if any('Not sent' in one for one in outputs(body)) else 'DELIVERED')]
    s = claude(c, [codex_task('Send a message, and say whether it was delivered.')], codex, mode='auto', extra=('--disallowedTools', 'SendMessage'))
    c.check('DELIVERY-DENIED' in s.report(), 'the native deny is returned to Codex, which can finish normally')
    c.check(not [call for call in s.calls('SendMessage') if call['error'] is False], 'no denied message was delivered')
    only_synthetic_at_no_cost(c, s)
