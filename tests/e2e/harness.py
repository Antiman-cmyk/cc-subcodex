"""Building blocks of the end-to-end cases. Each case runs in a home of its own, a throwaway folder: a
headless Claude Code session with the mod loaded from this checkout, and real Codex, both answered by the
scripted stand-ins for the model APIs in mocks.py. Nothing leaves the machine, no usage is spent, and nothing
of the person's own Claude Code or Codex is read or written.
"""
from __future__ import annotations

import glob
import json
import os
import random
import re
import shutil
import subprocess
import threading
import time

from . import host
from .mocks import Mocks, call

MOD = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
# The tests' own plugin, loaded beside the mod: harmless tools for the bridge cases.
FIXTURE = os.path.join(MOD, 'tests', 'e2e', 'fixture')
STAMP = 'mcp__subcodex-fixture__stamp'
CLAUDE = shutil.which('claude') or 'claude'
CODEX = 'gpt-6.1-terra'  # the Codex model the cases name; its requests go to the stand-in
# Live cases: real Codex on the person's own ChatGPT login, on a small model.
LIVE_MODEL = 'gpt-6-luna'
PERSON_CODEX = os.environ.get('CODEX_HOME') or os.path.expanduser('~/.codex')
LIVE_HOSTS = ('chatgpt.com', 'openai.com')
TOKENS = ('input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens')
RUN = f'{random.randrange(16**6):06x}'
# The sessions this run started, by process id: every process of the run descends from one of them.
SESSIONS: set[int] = set()
# The tool of the rows that mirror Codex's commands: on Windows sessions have the PowerShell tool turned on.
COMMAND_ROW = 'PowerShell' if host.WINDOWS else 'Bash'
# What a Windows process needs of the environment, passed to each session as it is.
WINDOWS_ENV = ('SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'PATHEXT', 'OS', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS',
               'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'CommonProgramFiles', 'CommonProgramW6432',
               'PSModulePath', 'USERNAME', 'COMPUTERNAME', 'TEMP', 'TMP')


# ---------------------------------------------------------------- one session

class Session:
    """A finished `claude -p` run and everything it left to look at."""

    def __init__(self, folder: str, home: str, code: int | None):
        self.folder = folder
        self.home = home
        self.code = code
        self.id = None
        self.result = ''
        self.main: list[dict] = []  # the main loop's tool calls and their results
        calls = {}
        for line in open(os.path.join(folder, 'out.jsonl'), errors='ignore'):
            try:
                m = json.loads(line)
            except Exception:
                continue
            self.id = self.id or m.get('session_id')
            if m.get('type') == 'result' and m.get('result'):
                self.result = str(m['result'])
            if m.get('parent_tool_use_id'):
                continue
            message = m.get('message')
            content = message.get('content') if isinstance(message, dict) else None
            for block in content if isinstance(content, list) else []:
                if block.get('type') == 'tool_use':
                    calls[block['id']] = {'name': block['name'], 'input': block['input'], 'text': '', 'error': None}
                    self.main.append(calls[block['id']])
                elif block.get('type') == 'tool_result' and block.get('tool_use_id') in calls:
                    calls[block['tool_use_id']].update(text=_text(block.get('content')), error=bool(block.get('is_error')))
        self.log = open(os.path.join(folder, 'debug.log'), errors='ignore').read() if os.path.exists(os.path.join(folder, 'debug.log')) else ''
        self.agents = self._agents()

    def _agents(self) -> list[list[dict]]:
        """Each Codex agent's saved transcript, as rows in order."""
        found = []
        for path in sorted(glob.glob(f'{self.home}/.claude/projects/*/{self.id}/subagents/**/*.jsonl', recursive=True)):
            rows, calls = [], {}
            for line in open(path, errors='ignore'):
                try:
                    r = json.loads(line)
                except Exception:
                    continue
                if r.get('type') == 'system' and r.get('subtype') == 'compact_boundary':
                    rows.append({'kind': 'compacted'})
                if r.get('type') not in ('assistant', 'user'):
                    continue
                m = r.get('message')
                if not isinstance(m, dict):
                    continue
                usage = m.get('usage') or {}
                for block in m.get('content') if isinstance(m.get('content'), list) else []:
                    if block.get('type') == 'text' and r['type'] == 'assistant':
                        rows.append({'kind': 'text', 'by': m.get('model'), 'text': block['text'], 'tokens': sum(usage.get(k) or 0 for k in TOKENS)})
                    elif block.get('type') == 'tool_use':
                        calls[block['id']] = {'kind': 'call', 'by': m.get('model'), 'name': block['name'], 'input': block['input'],
                                              'text': '', 'error': None, 'tokens': sum(usage.get(k) or 0 for k in TOKENS)}
                        rows.append(calls[block['id']])
                    elif block.get('type') == 'tool_result' and block.get('tool_use_id') in calls:
                        calls[block['tool_use_id']].update(text=_text(block.get('content')), error=bool(block.get('is_error')))
            if any(row.get('by') == '<synthetic>' for row in rows):
                found.append(rows)
        return found

    # what the cases ask of a session
    @property
    def rows(self) -> list[dict]:
        return self.agents[0] if self.agents else []

    def calls(self, name: str, rows=None) -> list[dict]:
        return [r for r in (self.rows if rows is None else rows) if r['kind'] == 'call' and r['name'].endswith(name)]

    def said(self, rows=None) -> str:
        return '\n'.join(r['text'] for r in (self.rows if rows is None else rows) if r['kind'] == 'text')

    def report(self) -> str:
        """The agent's result: its hand-back's message, else the Agent call's report, else its last words."""
        backs = self.calls('SubagentHandback')
        if backs:
            return str(backs[-1]['input'].get('message', ''))
        for call in self.main:
            found = re.search(r'The report follows:\n(.*?)\nagentId:', call['text'], re.S)
            if call['name'] == 'Agent' and found:
                return '\n'.join(line[2:] if line.startswith('  ') else line for line in found.group(1).split('\n')).strip()
        said = [r['text'] for r in self.rows if r['kind'] == 'text' and r.get('by') == '<synthetic>']
        return said[-1].strip() if said else ''

    def traced(self, text: str) -> bool:
        return f'subcodex: {text}' in self.log or text in self.log


def _text(content) -> str:
    if isinstance(content, list):
        return ' '.join(part.get('text', '') for part in content if isinstance(part, dict))
    return '' if content is None else str(content)


def claude(c: 'Case', main: list, codex=None, mode: str = 'default', extra: tuple = (), resume: str | None = None,
           timeout: int = 300, kill_after: float | None = None, kill_when=None, config: str = '', reviewer: str = 'allow',
           live: bool = False, prompt: str = 'Go.', env: dict | None = None) -> Session:
    """One headless session in the case's folder and home, its model requests answered by `main`, Codex's by
    `codex` (mocks.py), and Codex's reviewer's with `reviewer`. `config` is more of the home's Codex config.
    `live`: Codex's requests go to OpenAI instead, on the person's own Codex login (live cases only).
    `prompt` is what the session is given, such as a slash command. The session's process is killed alone
    `kill_after` seconds in, or once `kill_when()` is true. `env` is set over the session's environment."""
    os.makedirs(c.folder, exist_ok=True)
    os.makedirs(f'{c.home}/.codex', exist_ok=True)
    os.makedirs(f'{c.home}/.claude', exist_ok=True)
    with Mocks(main, codex, reviewer) as mocks:
        # Only the workspace is writable: the case's home, under the temporary folder, is not.
        sandbox = '[sandbox_workspace_write]\nexclude_tmpdir_env_var = true\nexclude_slash_tmp = true\n\n'
        if live:
            # The login file alone, linked: never copied, and nothing else of the person's Codex.
            if not os.path.islink(f'{c.home}/.codex/auth.json'):
                os.symlink(f'{PERSON_CODEX}/auth.json', f'{c.home}/.codex/auth.json')
            open(f'{c.home}/.codex/config.toml', 'w').write(f'sandbox_mode = "workspace-write"\n{config}\n\n{sandbox}')
        else:
            open(f'{c.home}/.codex/config.toml', 'w').write(
                f'model = "{CODEX}"\nmodel_provider = "mock"\nsandbox_mode = "workspace-write"\n{config}\n\n{sandbox}'
                f'[model_providers.mock]\nname = "Mock"\nbase_url = "{mocks.openai}/v1"\nwire_api = "responses"\nenv_key = "MOCK_OPENAI_KEY"\n')
        more_env = env or {}
        env = {'PATH': os.environ.get('PATH', ''), 'TERM': 'dumb', 'LANG': os.environ.get('LANG', 'en_US.UTF-8'),
               'HOME': c.home, 'CLAUDE_CONFIG_DIR': f'{c.home}/.claude',
               'ANTHROPIC_BASE_URL': mocks.anthropic, 'ANTHROPIC_API_KEY': 'sk-ant-offline-test', 'MOCK_OPENAI_KEY': 'offline-test',
               'DISABLE_TELEMETRY': '1', 'DISABLE_AUTOUPDATER': '1', 'DISABLE_ERROR_REPORTING': '1'}
        if host.WINDOWS:
            env.update({name: os.environ[name] for name in WINDOWS_ENV if name in os.environ})
            # LOCALAPPDATA stays the person's: there PowerShell 7 from the Microsoft Store is found by name.
            env.update({name: os.environ[name] for name in ('LOCALAPPDATA',) if name in os.environ})
            env.update({'USERPROFILE': c.home, 'APPDATA': f'{c.home}/AppData/Roaming', 'CLAUDE_CODE_USE_POWERSHELL_TOOL': '1'})
        else:
            env.update({'SHELL': os.environ.get('SHELL', '/bin/zsh'), 'TMPDIR': os.environ.get('TMPDIR', '/tmp')})
        env.update(more_env)
        cmd = [CLAUDE, '-p', prompt, '--plugin-dir', MOD, '--plugin-dir', FIXTURE, '--model', 'claude-haiku-5-5', '--permission-mode', mode,
               '--output-format', 'stream-json', '--verbose', '--debug-file', os.path.join(c.folder, 'debug.log'),
               *(['--resume', resume] if resume else []), *extra]
        with open(os.path.join(c.folder, 'out.jsonl'), 'w') as out, open(os.path.join(c.folder, 'err.txt'), 'w') as err:
            proc = subprocess.Popen(cmd, cwd=c.folder, env=env, stdin=subprocess.DEVNULL, stdout=out, stderr=err, **host.popen_options())
            SESSIONS.add(proc.pid)
            if kill_when:
                deadline = time.time() + timeout
                while proc.poll() is None and time.time() < deadline and not kill_when():
                    time.sleep(0.5)
                if proc.poll() is None:
                    # Killed alone, as a crash would: its children are not signalled; at the deadline, stopped whole.
                    proc.kill() if time.time() < deadline else host.stop_tree(proc.pid)
            try:
                proc.wait(timeout=kill_after if kill_after else timeout)
            except subprocess.TimeoutExpired:
                if kill_after:
                    proc.kill()
                else:
                    host.stop_tree(proc.pid)
                proc.wait()
        s = Session(c.folder, c.home, proc.returncode)
        s.mocks = mocks
    hosts = sorted({name for name in re.findall(r'https?://([A-Za-z0-9.-]+)', s.log) if name not in ('127.0.0.1', 'localhost')
                    and not (live and any(name == one or name.endswith(f'.{one}') for one in LIVE_HOSTS))})
    c.check(not hosts, f'no request left the machine{", but to OpenAI" if live else ""} ({hosts[:3]})')
    return s


def live_unavailable() -> str | None:
    """Why the live cases cannot run, if they cannot: no ChatGPT login of the person's, or no such model for it."""
    try:
        tokens = json.load(open(f'{PERSON_CODEX}/auth.json')).get('tokens') or {}
    except (OSError, ValueError):
        tokens = {}
    if not (tokens.get('access_token') and tokens.get('account_id')):
        return f'no ChatGPT login in {PERSON_CODEX}/auth.json (log in with `codex login`)'
    try:
        models = [m.get('slug') for m in json.load(open(f'{PERSON_CODEX}/models_cache.json')).get('models', [])]
    except (OSError, ValueError, AttributeError):
        models = []
    if models and LIVE_MODEL not in models:
        return f'the login offers no model {LIVE_MODEL}'
    return None


def codex_usage(c: 'Case') -> str:
    """What the case's Codex threads used, from their session files, and where the login's usage windows stand."""
    used = {'input_tokens': 0, 'cached_input_tokens': 0, 'output_tokens': 0}
    windows = {}
    for path in glob.glob(f'{c.home}/.claude/subcodex/codex-home/sessions/*/*/*/rollout-*.jsonl'):
        last = None
        for line in open(path, errors='ignore'):
            if '"token_count"' not in line:
                continue
            try:
                payload = json.loads(line)['payload']
            except (ValueError, KeyError):
                continue
            if payload.get('type') == 'token_count':
                last = payload
                for name in ('primary', 'secondary'):
                    window = (payload.get('rate_limits') or {}).get(name)
                    if isinstance(window, dict) and window.get('used_percent') is not None:
                        windows[window.get('window_minutes')] = max(windows.get(window.get('window_minutes'), 0), window['used_percent'])
        total = ((last or {}).get('info') or {}).get('total_token_usage') or {}
        for key in used:
            used[key] += total.get(key) or 0
    shown = ', '.join(f'{"5-hour" if minutes == 300 else "weekly" if minutes == 10080 else f"{minutes}-minute"} window at {percent:.0f}%'
                      for minutes, percent in sorted(windows.items(), key=lambda kv: kv[0] or 0))
    return (f'Codex used {used["input_tokens"]} input tokens ({used["cached_input_tokens"]} cached), {used["output_tokens"]} output'
            + (f'; {shown}' if shown else ''))


def codex_task(prompt: str, model: str = CODEX, effort: str = 'low', background: bool = False, head: str = '', **more) -> dict:
    """The main session's Agent call for a Codex agent, as a model would make it; `head` is the `@codex` line."""
    first = head or f'@codex model={model}'
    return call('Agent', description='A test task', prompt=f'{first}\n{prompt}' if prompt else first, subagent_type='subcodex:codex',
                effort=effort, run_in_background=background, **more)


# ---------------------------------------------------------------- a case

class Case:
    def __init__(self, name: str, root: str):
        self.name = name
        self.folder = os.path.join(root, name)
        self.home = os.path.join(root, f'{name}.home')
        self.checks: list[tuple[bool, str]] = []
        self.skipped: str | None = None
        self.notes: list[str] = []  # shown with the case's result, pass or fail

    def check(self, ok, what: str) -> bool:
        self.checks.append((bool(ok), what))
        return bool(ok)

    def skip(self, why: str) -> None:
        self.skipped = why

    def home_file(self, tag: str) -> str:
        """A path outside the workspace, in the case's home, that Codex's sandbox does not let it write to."""
        os.makedirs(self.home, exist_ok=True)
        return f'{self.home}/.subcodex-test-{self.name}-{tag}'

    def git(self, bug: bool = False) -> None:
        os.makedirs(self.folder, exist_ok=True)
        run = lambda *a: subprocess.run(a, cwd=self.folder, check=True, capture_output=True)
        run('git', 'init', '-q')
        open(f'{self.folder}/cart.py', 'w').write('def total(prices, coupon):\n    return sum(prices) * (1 - coupon)\n')
        open(f'{self.folder}/notes.txt', 'w').write('a\nb\nc\n')
        run('git', 'add', '.')
        run('git', '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'init')
        if bug:
            open(f'{self.folder}/cart.py', 'w').write(
                'def total(prices, coupon):\n    prices = [p * (1 - coupon) for p in prices]\n    return sum(prices) * (1 - coupon)\n')

    def plain(self) -> None:
        os.makedirs(self.folder, exist_ok=True)
        open(f'{self.folder}/notes.txt', 'w').write('a\nb\nc\n')


CASES = {}
LIVE = {}


def case(fn):
    """Registers a case under its function's name."""
    CASES[fn.__name__] = fn
    return fn


def live_case(fn):
    """Registers a live case: run only with `--live`, skipped without the person's Codex login, its usage noted."""
    def run(c: Case) -> None:
        why = live_unavailable()
        if why is not None:
            return c.skip(why)
        try:
            fn(c)
        finally:
            c.notes.append(codex_usage(c))
    LIVE[fn.__name__] = run
    return fn


def only_synthetic_at_no_cost(c: Case, s: Session, rows=None) -> None:
    rows = s.rows if rows is None else rows
    mine = [r for r in rows if r.get('by') == '<synthetic>']
    c.check(mine, 'the agent has rows the mod wrote')
    c.check(all(r['tokens'] == 0 for r in mine), 'every row the mod wrote records zero tokens')
    c.check(all(not r.get('by') or r['by'] == '<synthetic>' for r in rows), 'no row was produced by a Claude model')
    attempted = sum('[API REQUEST]' in line and 'source=agent:custom:subcodex:codex' in line for line in s.log.splitlines())
    local = sum('local protocol:' in line and 'no Claude request' in line for line in s.log.splitlines())
    c.check(attempted == local, f'every native protocol request was answered locally ({local}/{attempted})')
    records = [os.path.join(s.folder, 'out.jsonl'), *glob.glob(f'{s.home}/.claude/projects/*/{s.id}.jsonl')]
    warning = "when reviewing this subagent's work"
    c.check(all(warning not in open(path, errors='ignore').read() for path in records), 'neither UI notifications nor internal delivery carry the unavailable-review warning')



def codex_threads(c: 'Case') -> list[dict]:
    """The Codex sessions recorded for the case: their first line, the tools the mod gave them, and their turn settings."""
    found = []
    same = lambda path: os.path.normcase(os.path.realpath(path))
    real = same(c.folder)
    for path in glob.glob(f'{c.home}/.claude/subcodex/codex-home/sessions/*/*/*/rollout-*.jsonl'):
        lines = open(path, errors='ignore').read().split('\n')
        try:
            meta = json.loads(lines[0])['payload']
        except Exception:
            continue
        if same(str(meta.get('cwd'))) != real:
            continue
        turns = []
        for line in lines[1:]:
            if '"turn_context"' in line:
                try:
                    turns.append(json.loads(line)['payload'])
                except Exception:
                    pass
        first = turns[0] if turns else {}
        found.append({'path': path, 'id': meta.get('id'), 'source': meta.get('source'), 'tools': meta.get('dynamic_tools') or [],
                      'model': first.get('model'), 'effort': first.get('effort'),
                      'turns': [(turn.get('model'), turn.get('effort')) for turn in turns]})
    return found


def usage_links(c: 'Case') -> list[str]:
    """The links of the mod's in the case's own Codex home, by which usage tools count its sessions."""
    return glob.glob(f'{c.home}/.codex/sessions/*/*/*/rollout-*.subcodex.jsonl')


running = host.running
until_running = host.until_running


def watch(command: str, seen: dict, stop: threading.Event):
    while not stop.is_set():
        if running(command):
            seen['seen'] = True
        time.sleep(0.5)
