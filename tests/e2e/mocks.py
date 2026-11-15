"""Scripted stand-ins for the two model APIs the tests would otherwise reach: Anthropic's Messages API (the
main Claude session) and OpenAI's Responses API (Codex, through a provider of the test home's own). They run
on local ports, answer from a case's script, and record every request.

A script is a list of steps, one per model request, taken in order. A step is a block (or a list of blocks)
from the helpers below, or a function of the request that returns one. Codex's script may be a dict of
scripts instead, chosen by the first key that appears in a request's input (one per agent's task).
"""
from __future__ import annotations

import json
import re
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable

# --- what the main Claude session says ---------------------------------------------------------------

def call(name: str, **args: Any) -> dict:
    """A tool call of the main session's."""
    return {'type': 'tool_use', 'name': name, 'input': args}


def say(text: str) -> dict:
    """Text of the main session's; a step of text alone ends its turn."""
    return {'type': 'text', 'text': text}


def results(body: dict) -> list[str]:
    """The text of every tool result the main session has been given, oldest first."""
    found = []
    for message in body.get('messages', []):
        for block in message.get('content', []) if isinstance(message.get('content'), list) else []:
            if isinstance(block, dict) and block.get('type') == 'tool_result':
                content = block.get('content')
                found.append(content if isinstance(content, str) else ' '.join(
                    part.get('text', '') for part in content or [] if isinstance(part, dict)))
    return found


def latest(body: dict) -> str:
    """The text of the main session's latest user message: a task's notification, say."""
    for message in reversed(body.get('messages', [])):
        if message.get('role') != 'user':
            continue
        content = message.get('content')
        if isinstance(content, str):
            return content
        texts = [block.get('text', '') for block in content or [] if isinstance(block, dict) and block.get('type') == 'text']
        if texts:
            return '\n'.join(texts)
    return ''


def agent_id(body: dict) -> str:
    """The id of the agent the main session started last, from its Agent call's result."""
    for text in reversed(results(body)):
        found = re.search(r'agentId: (\w+)', text)
        if found:
            return found.group(1)
    return ''


# --- what Codex's model says ---------------------------------------------------------------------------

def run(command: str, escalate: str = '') -> dict:
    """Codex runs a shell command; with `escalate` (the reason), it asks to run it outside its sandbox."""
    args = {'cmd': command, **({'sandbox_permissions': 'require_escalated', 'justification': escalate} if escalate else {})}
    return {'type': 'function_call', 'name': 'exec_command', 'arguments': json.dumps(args)}


def patch(text: str) -> dict:
    """Codex edits files with its apply_patch tool (a patch in its own format)."""
    return {'type': 'custom_tool_call', 'name': 'apply_patch', 'input': text}


def use(name: str, namespace: str | None = None, **args: Any) -> dict:
    """Codex calls a tool the mod gave it: a session tool (in its namespace), or message_parent, workflow_result."""
    return {'type': 'function_call', 'name': name, 'arguments': json.dumps(args), **({'namespace': namespace} if namespace else {})}


def note(text: str) -> dict:
    """Codex says something along the way."""
    return {'type': 'message', 'role': 'assistant', 'phase': 'commentary', 'content': [{'type': 'output_text', 'text': text}]}


def answer(text: str) -> dict:
    """Codex's final answer, which ends its turn."""
    return {'type': 'message', 'role': 'assistant', 'phase': 'final_answer', 'content': [{'type': 'output_text', 'text': text}]}


def think(text: str) -> dict:
    """A summary of Codex's reasoning."""
    return {'type': 'reasoning', 'summary': [{'type': 'summary_text', 'text': text}], 'encrypted_content': ''}


def search(query: str) -> dict:
    """A web search of Codex's own."""
    return {'type': 'web_search_call', 'status': 'completed', 'action': {'type': 'search', 'query': query}}


def outputs(body: dict) -> list[str]:
    """The output of every tool Codex has called in this thread, oldest first."""
    found = []
    for item in body.get('input', []):
        if isinstance(item, dict) and item.get('type') in ('function_call_output', 'custom_tool_call_output'):
            output = item.get('output')
            found.append(output if isinstance(output, str) else json.dumps(output))
    return found


def said_to_codex(body: dict) -> list[str]:
    """The user messages in Codex's input, oldest first."""
    found = []
    for item in body.get('input', []):
        if isinstance(item, dict) and item.get('type') == 'message' and item.get('role') == 'user':
            found.append(' '.join(part.get('text', '') for part in item.get('content', []) if isinstance(part, dict)))
    return found


Step = Any  # a block, a list of blocks, or a function of the request returning one


class _Server(ThreadingHTTPServer):
    """A stand-in's server. A client that hangs up mid-answer, a stopped or killed session, is no error."""
    daemon_threads = True

    def handle_error(self, request, client_address) -> None:
        if not isinstance(sys.exc_info()[1], (BrokenPipeError, ConnectionResetError)):
            super().handle_error(request, client_address)


class Mocks:
    """Both APIs, from a case's two scripts. Use as a context manager; `requests` keeps what each was asked."""

    def __init__(self, main: list[Step] | None = None, codex: list[Step] | dict[str, list[Step]] | None = None,
                 reviewer: str = 'allow'):
        self.main = list(main or [])
        self.codex = codex or []
        # Codex's own reviewer of requests to act outside the sandbox: its outcome, `allow` or `deny`.
        self.reviewer = reviewer
        self.requests: list[dict] = []
        self.lock = threading.Lock()
        self.serial = 0
        self.taken: dict[str, int] = {}

    def __enter__(self) -> 'Mocks':
        self.servers = [_Server(('127.0.0.1', 0), self._handler(kind)) for kind in ('anthropic', 'openai')]
        for server in self.servers:
            threading.Thread(target=server.serve_forever, daemon=True).start()
        self.anthropic, self.openai = (f'http://127.0.0.1:{server.server_address[1]}' for server in self.servers)
        return self

    def __exit__(self, *exc) -> None:
        for server in self.servers:
            server.shutdown()
            server.server_close()

    def _next_id(self, prefix: str) -> str:
        with self.lock:
            self.serial += 1
            return f'{prefix}_{self.serial}'

    # Steps ------------------------------------------------------------------------------------------

    @staticmethod
    def _blocks(step: Step, body: dict) -> list[dict]:
        while callable(step):
            step = step(body)
        return [dict(one) for one in (step if isinstance(step, list) else [step])]

    def _main_step(self, body: dict) -> list[dict]:
        with self.lock:
            step = self.main.pop(0) if self.main else say('Done.')
        return self._blocks(step, body)

    def _codex_step(self, body: dict) -> list[dict]:
        script = self.codex
        key = ''
        if isinstance(script, dict):
            text = json.dumps(body.get('input', []))
            key = next((one for one in script if one in text), '')
            script = script.get(key, [])
        with self.lock:
            at = self.taken.get(key, 0)
            self.taken[key] = at + 1
        step = script[at] if at < len(script) else answer('Done.')
        return self._blocks(step, body)

    # Wire formats -------------------------------------------------------------------------------------

    def _handler(self, kind: str):
        mocks = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def _read(self) -> dict:
                raw = self.rfile.read(int(self.headers.get('content-length', 0)) or 0)
                try:
                    return json.loads(raw or b'{}')
                except ValueError:
                    return {}

            def _json(self, value: dict, status: int = 200) -> None:
                data = json.dumps(value).encode()
                self.send_response(status)
                self.send_header('content-type', 'application/json')
                self.send_header('content-length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def _stream(self, events: list[dict]) -> None:
                self.send_response(200)
                self.send_header('content-type', 'text/event-stream')
                self.end_headers()
                self.wfile.write(''.join(f'event: {e["type"]}\ndata: {json.dumps(e)}\n\n' for e in events).encode())

            def do_GET(self):
                with mocks.lock:
                    mocks.requests.append({'api': kind, 'method': 'GET', 'path': self.path})
                if kind == 'openai' and self.path.startswith('/v1/models'):
                    return self._json({'object': 'list', 'data': [{'id': 'mock-model', 'object': 'model'}]})
                self._json({'error': 'not found'}, 404)

            def do_POST(self):
                body = self._read()
                record = {'api': kind, 'method': 'POST', 'path': self.path, 'headers': dict(self.headers), 'body': body}
                with mocks.lock:
                    mocks.requests.append(record)
                if kind == 'anthropic':
                    return self._anthropic(body)
                return self._openai(body)

            def _anthropic(self, body: dict) -> None:
                if self.path.startswith('/v1/messages/count_tokens'):
                    return self._json({'input_tokens': 10})
                tools = [tool.get('name') for tool in body.get('tools', []) if isinstance(tool, dict)]
                is_main = 'Agent' in tools and not self.headers.get('x-claude-code-agent-id')
                # Auto mode's review of an action asks for a severity: the test's reviewer lets it through.
                is_review = '<severity>' in json.dumps(body.get('system', ''))
                blocks = mocks._main_step(body) if is_main else [say('<severity>3</severity>' if is_review else 'ok')]
                for block in blocks:
                    if block['type'] == 'tool_use':
                        block['id'] = mocks._next_id('toolu_mock')
                usage = {'input_tokens': 1, 'output_tokens': 1, 'cache_creation_input_tokens': 0, 'cache_read_input_tokens': 0}
                calls = [block['id'] for block in blocks if block['type'] == 'tool_use']
                stop = 'tool_use' if calls else 'end_turn'
                # A request in auto mode asks for the server's review of each call; the test's server passes it.
                verdict = ([{'type': 'dangerous_tool_use', 'status': {'type': 'available', 'tool_uses': {
                    one: {'type': 'evaluated', 'outcome': 'not_flagged'} for one in calls}}}] if body.get('safeguards') and calls else None)
                message = {'id': mocks._next_id('msg_mock'), 'type': 'message', 'role': 'assistant', 'model': body.get('model', 'mock'),
                           'content': blocks, 'stop_reason': stop, 'stop_sequence': None, 'usage': usage,
                           **({'safeguard_results': verdict} if verdict else {})}
                if not body.get('stream'):
                    return self._json(message)
                events = [{'type': 'message_start', 'message': {**message, 'content': [], 'stop_reason': None}}]
                for index, block in enumerate(blocks):
                    if block['type'] == 'tool_use':
                        events += [{'type': 'content_block_start', 'index': index, 'content_block': {**block, 'input': {}}},
                                   {'type': 'content_block_delta', 'index': index, 'delta': {'type': 'input_json_delta', 'partial_json': json.dumps(block['input'])}}]
                    else:
                        events += [{'type': 'content_block_start', 'index': index, 'content_block': {'type': 'text', 'text': ''}},
                                   {'type': 'content_block_delta', 'index': index, 'delta': {'type': 'text_delta', 'text': block['text']}}]
                    events.append({'type': 'content_block_stop', 'index': index})
                events += [{'type': 'message_delta', 'delta': {'stop_reason': stop, 'stop_sequence': None, **({'safeguard_results': verdict} if verdict else {})}, 'usage': usage},
                           {'type': 'message_stop'}]
                self._stream(events)

            def _openai(self, body: dict) -> None:
                is_reviewer = self.headers.get('x-openai-subagent') == 'guardian'
                verdict = {'risk_level': 'low', 'user_authorization': 'high', 'outcome': mocks.reviewer,
                           'rationale': 'The task asks for it.' if mocks.reviewer == 'allow' else 'Not something the task needs.'}
                items = [answer(json.dumps(verdict))] if is_reviewer else mocks._codex_step(body)
                for item in items:
                    item.setdefault('id', mocks._next_id('item'))
                    if item['type'] in ('function_call', 'custom_tool_call'):
                        item.setdefault('call_id', mocks._next_id('call'))
                        item.setdefault('status', 'completed')
                response = mocks._next_id('resp')
                events = [{'type': 'response.created', 'response': {'id': response}}]
                for item in items:
                    events.append({'type': 'response.output_item.added', 'item': item})
                    if item['type'] == 'message':
                        for part in item['content']:
                            events.append({'type': 'response.output_text.delta', 'item_id': item['id'], 'delta': part['text']})
                    events.append({'type': 'response.output_item.done', 'item': item})
                events.append({'type': 'response.completed', 'response': {'id': response, 'usage': {
                    'input_tokens': 100, 'input_tokens_details': {'cached_tokens': 0}, 'output_tokens': 10,
                    'output_tokens_details': {'reasoning_tokens': 0}, 'total_tokens': 110}}})
                self._stream(events)

        return Handler

    # What was asked --------------------------------------------------------------------------------------

    def asked(self, api: str) -> list[dict]:
        """The POST requests one API received, in order."""
        return [one for one in self.requests if one['api'] == api and one['method'] == 'POST']
