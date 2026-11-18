"""Codex at work: a fix, a review, what it shows of its own doings, what context it is given."""
import glob
import json
import os
import re
import struct
import subprocess
import sys
import zlib

from ..harness import COMMAND_ROW, CODEX, MOD, Case, case, claude, codex_task, codex_threads, only_synthetic_at_no_cost, usage_links
from ..mocks import LINES, answer, note, patch, run, search, use

FIX = ('*** Begin Patch\n*** Update File: cart.py\n@@\n def total(prices, coupon):\n'
       '-    prices = [p * (1 - coupon) for p in prices]\n     return sum(prices) * (1 - coupon)\n*** End Patch\n')


@case
def fix_auto(c: Case):
    c.git(bug=True)
    s = claude(c, [codex_task('The uncommitted change in cart.py applies the coupon twice. Fix it.')],
               [[note('Fixing the double discount.'), patch(FIX)], [run('cat cart.py')],
                answer('Fixed cart.py: the coupon is applied once, so total([100], 0.1) is 90.')], mode='auto')
    ran = subprocess.run([sys.executable, '-c', 'from cart import total; assert abs(total([100], 0.1) - 90) < 1e-9'], cwd=c.folder, capture_output=True)
    c.check(ran.returncode == 0, 'the fix is really in the workspace (checked here, not taken from the report)')
    c.check('cart.py' in s.report(), 'the result is the closing message')
    edits = [call for call in s.calls('Edit') if str(call['input'].get('file_path', '')).endswith('cart.py')]
    c.check(edits and 'coupon' in str(edits[0]['input'].get('old_string')) and not edits[0].get('error'),
            "the edit is a native Edit row of the change, answered from Codex's diff")
    threads = codex_threads(c)
    c.check(threads and all(t['model'] == CODEX and t['effort'] == 'low' for t in threads), 'Codex ran on the model and effort the call named')
    version = json.load(open(f'{MOD}/.claude-plugin/plugin.json'))['version']
    agents = {r['headers'].get('user-agent', '') for r in s.mocks.asked('openai')}
    c.check(agents and all(agent.endswith(f'(subcodex; {version})') for agent in agents),
            f"Codex was told the mod's version from plugin.json ({sorted(agents)[:1]})")
    link = [p for t in threads for p in usage_links(c) if p.endswith(f'{t["id"]}.subcodex.jsonl')]
    c.check(link and all(os.path.islink(p) for p in link), "the session file is linked into the person's Codex home for usage tools")
    only_synthetic_at_no_cost(c, s)


@case
def review_default(c: Case):
    c.git(bug=True)
    where = os.path.realpath(f'{c.folder}/cart.py')
    findings = {'findings': [{'title': '[P1] The coupon is applied twice', 'body': 'Each price is discounted, then the sum again.',
                              'confidence_score': 0.9, 'priority': 1,
                              'code_location': {'absolute_file_path': where, 'line_range': {'start': 2, 'end': 2}}}],
                'overall_correctness': 'patch is incorrect', 'overall_explanation': 'The discount is applied twice.', 'overall_confidence_score': 0.9}
    s = claude(c, [codex_task('', head=f'@codex review model={CODEX}')], [answer(json.dumps(findings))])
    c.check(re.search(r'\[P[0-3]\]', s.report()) and 'cart.py' in s.report(), 'the result is a review: a finding with a priority tag, on the changed file')
    c.check("Codex's review mode" in s.said(), 'the transcript says review mode was entered')
    reviews = [t for t in codex_threads(c) if t['source'] == {'subagent': 'review'}]
    c.check(reviews and all(t['effort'] == 'low' and t['model'] == CODEX for t in reviews), "the review's own thread ran on the call's model and effort")


@case
def context_default(c: Case):
    c.plain()
    # Claude instruction files: one imported, and a rule; a skill of the person's.
    os.makedirs(f'{c.folder}/.claude/rules', exist_ok=True)
    open(f'{c.folder}/CLAUDE.md', 'w').write('The project codeword is KESTREL-7.\n\n@notes.md\n')
    open(f'{c.folder}/notes.md', 'w').write('The imported codeword is PLOVER-3.\n')
    open(f'{c.folder}/.claude/rules/words.md', 'w').write('The rules codeword is WREN-5.\n')
    os.makedirs(f'{c.home}/.claude/skills/heron-ledger', exist_ok=True)
    open(f'{c.home}/.claude/skills/heron-ledger/SKILL.md', 'w').write('---\nname: heron-ledger\ndescription: Keeps the heron ledger. A test skill.\n---\nWrite HERON.\n')
    # Context of the person's own Codex that Codex inside the mod must not get.
    own = '[mcp_servers.heron_server]\ncommand = "node"\n\n[plugins."heron-docs@openai"]\nenabled = true\n'
    s = claude(c, [codex_task('Say what you were given.')], [answer('Noted.')], config=own)
    first = json.dumps(s.mocks.asked('openai')[0]['body']) if s.mocks.asked('openai') else ''
    for word in ('KESTREL-7', 'PLOVER-3', 'WREN-5'):
        c.check(word in first, f"Claude's instruction files reach Codex, with imports and rules: `{word}`")
    c.check('heron-ledger' in first, "Claude's skills reach Codex")
    for name in ('heron_server', 'heron-docs', 'imagegen', 'skill-installer'):
        c.check(name not in first, f"none of Codex's own global context: no `{name}`")
    copy = f'{c.home}/.claude/subcodex/codex-home/config.toml'
    c.check(os.path.isfile(copy) and not os.path.islink(copy), "the mod's Codex config is a copy, not a link")
    c.check(not re.search(r'^\[+\s*"?(mcp_servers|plugins|marketplaces|memories|skills|apps|agents)\b', open(copy).read(), re.M), 'and holds no table that is context')
    links = [path for path in glob.glob(f'{c.home}/.claude/subcodex/codex-home/*') if os.path.islink(path) and os.path.realpath(path) == os.path.realpath(f'{c.home}/.codex/config.toml')]
    c.check(not links, "nothing in the mod's Codex home links to the person's config")


def _red_png(path: str) -> None:
    raw = b''.join(b'\x00' + bytes((255, 0, 0)) * 64 for _ in range(64))
    chunk = lambda kind, data: struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)
    open(path, 'wb').write(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 64, 64, 8, 2, 0, 0, 0))
                           + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b''))


@case
def outputs_default(c: Case):
    c.plain()
    _red_png(f'{c.folder}/red.png')
    image = os.path.realpath(f'{c.folder}/red.png')
    parent = [[note('I am about to look at the image, wait a second, and have a sub-agent count the lines.'), use('view_image', path=image)],
              [use('sleep', namespace='clock', duration_ms=1000)],
              [use('spawn_agent', namespace='collaboration', message='Run wc -l notes.txt.', task_name='counter', fork_turns='none')],
              [use('wait_agent', namespace='collaboration', timeout_ms=30000)],
              answer('red, 3')]
    sub = [[run(LINES)], answer('notes.txt has 3 lines.')]
    s = claude(c, [codex_task('Look at red.png, wait, count the lines of notes.txt with a sub-agent.')],
               {'Look at red.png': parent, 'Run wc -l notes.txt.': sub})
    said = s.said()
    c.check('[Codex looked at the image' in said and 'red.png' in said, 'looking at an image is a line')
    c.check('[Codex waited' in said, 'waiting is a line')
    c.check('[Codex started sub-agent' in said, "a sub-agent's start is a line")
    c.check(any('sub-agent' in str(call['input'].get('description')) and '3' in call['text'] for call in s.calls(COMMAND_ROW)), "the sub-agent's command is a row marked as its, with its output")
    c.check(s.report() == 'red, 3', f"the result is the final answer alone, not what Codex said along the way, nor the mod's lines ({s.report()!r})")


@case
def search_default(c: Case):
    c.plain()
    s = claude(c, [codex_task('Search the web for the latest stable release of Python.')],
               # A web search runs on the server, within one response: the answer comes with it.
               [[search('latest stable Python release'), answer('The latest stable release is Python 3.14.')]])
    lines = [line for line in s.said().split('[Codex ') if line.startswith('searched the web')]
    c.check(lines and 'latest stable Python release' in lines[0], 'a web search is a line that names what was searched for')
    c.check(re.search(r'3\.\d+', s.report()), 'and Codex answered')
