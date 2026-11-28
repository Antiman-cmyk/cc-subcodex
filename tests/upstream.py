#!/usr/bin/env python3
"""Writes what the installed Claude Code and Codex give the mod to build on into DIR: the Mod API skill of
`claude` (its `plugin-authoring` skill, the Mod API types among it) into DIR/claude-code, and the app-server
protocol of `codex`, as TypeScript, into DIR/codex.

    python3 tests/upstream.py DIR

`claude` puts the skill's files on disk once a session reads the skill. A headless session without the mod,
its model requests answered by the scripted stand-in of tests/e2e/mocks.py, does that offline.
"""
import argparse
import glob
import os
import shutil
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

if os.name == 'nt' and not sys.flags.utf8_mode and __name__ == '__main__':
    # Files and pipes are read and written as UTF-8 (Python's UTF-8 mode).
    sys.exit(subprocess.call([sys.executable, '-X', 'utf8', *sys.argv]))

from tests.e2e import host  # noqa: E402
from tests.e2e.harness import WINDOWS_ENV  # noqa: E402
from tests.e2e.mocks import Mocks, call, say  # noqa: E402


def skill(dest: str) -> None:
    """Copies the `plugin-authoring` skill of the `claude` on PATH into `dest`."""
    claude = shutil.which('claude') or 'claude'
    version = subprocess.run([claude, '--version'], capture_output=True, text=True).stdout.split(' ')[0].strip()
    root = tempfile.mkdtemp(prefix='subcodex-skill-')
    try:
        home, work, temp = (os.path.join(root, name) for name in ('home', 'work', 'temp'))
        for folder in (os.path.join(home, '.claude'), work, temp):
            os.makedirs(folder)
        with Mocks([call('Skill', skill='plugin-authoring'), say('done')]) as mocks:
            env = {'PATH': os.environ.get('PATH', ''), 'TERM': 'dumb', 'HOME': home, 'CLAUDE_CONFIG_DIR': os.path.join(home, '.claude'),
                   'CLAUDE_CODE_TMPDIR': temp, 'ANTHROPIC_BASE_URL': mocks.anthropic, 'ANTHROPIC_API_KEY': 'sk-ant-offline-test',
                   'DISABLE_TELEMETRY': '1', 'DISABLE_AUTOUPDATER': '1', 'DISABLE_ERROR_REPORTING': '1'}
            if host.WINDOWS:
                env.update({name: os.environ[name] for name in (*WINDOWS_ENV, 'LOCALAPPDATA') if name in os.environ})
                env.update({'USERPROFILE': home, 'APPDATA': os.path.join(home, 'AppData', 'Roaming')})
            run = subprocess.run([claude, '-p', 'Go.', '--model', 'claude-haiku-5-5'], cwd=work, env=env,
                                 stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=300)
        # Under CLAUDE_CODE_TMPDIR; failing that, this version's folder in the system's temporary folder.
        found = glob.glob(os.path.join(temp, '**', 'plugin-authoring', 'types', 'claude-code.d.ts'), recursive=True) or sorted(
            (path for folder in {tempfile.gettempdir(), '/tmp'}
             for path in glob.glob(os.path.join(folder, 'claude*', 'bundled-skills', version, '*', 'plugin-authoring', 'types', 'claude-code.d.ts'))),
            key=os.path.getmtime)[-1:]
        if not found:
            sys.exit(f'claude {version} left no plugin-authoring skill (exit {run.returncode}):\n{run.stdout[-2000:]}\n{run.stderr[-2000:]}')
        shutil.copytree(os.path.dirname(os.path.dirname(found[-1])), dest)
    finally:
        shutil.rmtree(root, ignore_errors=True)


def protocol(dest: str) -> None:
    """Writes the app-server protocol of the `codex` on PATH into `dest`, as TypeScript."""
    subprocess.run([shutil.which('codex') or 'codex', 'app-server', 'generate-ts', '--experimental', '--out', dest],
                   check=True, stdout=subprocess.DEVNULL)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('dir', help='the folder to write into')
    args = parser.parse_args()
    skill(os.path.join(args.dir, 'claude-code'))
    protocol(os.path.join(args.dir, 'codex'))


if __name__ == '__main__':
    main()
