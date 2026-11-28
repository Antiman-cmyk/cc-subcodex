import type { EngineInterface } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'

import { recordPath } from '../../hooks/agents'
import { findCodex, keysOf, sandboxChoice, skillRoots } from '../../hooks/codex-home'
import { hostCommand, hostRun, isAbsolute, isWindows, learnSystem } from '../../hooks/host'
import { encoded, literal, pwsh } from '../../hooks/windows'

// The mod on each system: how it knows which, the commands it runs there,
// and the paths and variables it reads there.

/** The script a `pwsh -EncodedCommand` argument holds. */
const decoded = (text: string): string => {
  const binary = atob(text)
  let script = ''
  for (let at = 0; at + 1 < binary.length; at += 2) script += String.fromCharCode(binary.charCodeAt(at) | (binary.charCodeAt(at + 1) << 8))
  return script
}

/** A session on Windows, home `C:\Users\p`, Codex found at `C:\c\codex.exe`; `there` the folders that exist. */
const windowsOf = (there: Set<string> = new Set()) =>
  ({
    plugin: { root: 'C:\\Users\\p\\.claude\\plugins\\subcodex' },
    env: {
      get: async (name: string) =>
        ({ USERPROFILE: 'C:\\Users\\p', HOME: '/c/Users/p', CLAUDE_CODE_PLUGIN_DIRS: 'C:\\dev\\x;D:\\dev\\y\\' })[name],
    },
    process: { run: async () => ({ stdout: 'C:\\c\\codex.exe', stderr: '', exitCode: 0 }) },
    session: { root: async () => 'C:\\w' },
    fs: { exists: async (path: string) => there.has(path), read: async () => Promise.reject(new Error('ENOENT')) },
  }) as unknown as EngineInterface

const POSIX_SESSION = { plugin: { root: '/Users/p/mods/subcodex' } } as unknown as EngineInterface

describe('the system', () => {
  test('is Windows where the mod runs from a Windows folder', () => {
    expect(isWindows(windowsOf())).toBe(true)
    expect(isWindows({ plugin: { root: '\\\\host\\share\\subcodex' } } as unknown as EngineInterface)).toBe(true)
    expect(isWindows(POSIX_SESSION)).toBe(false)
  })

  test('is the system the engine says it runs on, where it says one', async () => {
    const said = (platform: unknown) =>
      ({ ...POSIX_SESSION, session: { info: async () => ({ platform }) } }) as unknown as EngineInterface
    await learnSystem(said('windows'))
    expect(isWindows(POSIX_SESSION)).toBe(true)
    await learnSystem(said('wsl'))
    expect(isWindows(windowsOf())).toBe(false)
    await learnSystem(said('unknown'))
    expect(isWindows(windowsOf())).toBe(true)
    // Claude Code before 2.1.326 has no `$.session.info`.
    await learnSystem(POSIX_SESSION)
    expect(isWindows(windowsOf())).toBe(true)
    expect(isWindows(POSIX_SESSION)).toBe(false)
  })

  test('absolute paths are those of either system', () => {
    for (const path of ['/w/a.py', 'C:\\w\\a.py', 'c:/w/a.py', '\\\\host\\share\\a.py']) expect(isAbsolute(path)).toBe(true)
    for (const path of ['a.py', 'codex', 'C:a.py', '.\\a.py']) expect(isAbsolute(path)).toBe(false)
  })
})

describe('the host commands', () => {
  test('elsewhere they are /bin/sh scripts and plain commands', () => {
    expect(hostCommand(POSIX_SESSION, 'send', ['/h/run/x.fifo']).argv.slice(0, 2)).toEqual(['/bin/sh', '-c'])
    expect(hostCommand(POSIX_SESSION, 'send', ['/h/run/x.fifo']).argv.at(-1)).toBe('/h/run/x.fifo')
    const serve = ['/h/run/x.fifo', '/h/mod', '/h/own', '/h/mod/config.toml.x', 'auth.json', '-skills', '--', '/bin/codex', 'app-server']
    expect(hostCommand(POSIX_SESSION, 'serve', serve).argv.slice(-serve.length)).toEqual(serve)
    expect(hostCommand(POSIX_SESSION, 'sleep', ['2'])).toEqual({ argv: ['/bin/sleep', '2'] })
    expect(hostCommand(POSIX_SESSION, 'noop')).toEqual({ argv: ['/usr/bin/true'] })
    expect(hostCommand(POSIX_SESSION, 'version', ['/bin/codex'])).toEqual({ argv: ['/bin/codex', '--version'] })
    expect(hostCommand(POSIX_SESSION, 'find', ['/bin/zsh'])).toEqual({ argv: ['/bin/zsh', '-lc', 'command -v codex'] })
    expect(hostCommand(POSIX_SESSION, 'remove', ['/a', '/b'])).toEqual({ argv: ['/bin/rm', '-f', '/a', '/b'] })
    const leave = hostCommand(POSIX_SESSION, 'leave', ['/h/run/x.fifo']).argv
    expect([leave[0], leave[1], leave.at(-1)]).toEqual(['/bin/sh', '-c', '/h/run/x.fifo'])
    expect(leave[2]).toContain('exec 4<>"$1"')
    // The links to make and remove go on stdin, a line each.
    const links = hostCommand(POSIX_SESSION, 'links', ['/o/a.subcodex.jsonl', '/m/a.jsonl', '/o/b.subcodex.jsonl', ''])
    expect(links.argv.slice(0, 2)).toEqual(['/bin/sh', '-c'])
    expect(links.stdin).toBe('/o/a.subcodex.jsonl\n/m/a.jsonl\n/o/b.subcodex.jsonl\n\n')
  })

  test('an operation with nothing to do on a system is not run', async () => {
    expect(hostCommand(windowsOf(), 'leave', ['C:\\h\\run\\x.fifo'])).toEqual({ argv: [] })
    const session = { plugin: windowsOf().plugin, process: { run: async () => Promise.reject(new Error('run')) } } as unknown as EngineInterface
    expect((await hostRun(session, 'leave', ['C:\\h\\run\\x.fifo'])).exitCode).toBe(0)
  })

  test('on Windows they are PowerShell 7 scripts, their arguments PowerShell literals', () => {
    const { argv } = hostCommand(windowsOf(), 'send', ['C:\\a b\\x.fifo'])
    expect(argv.slice(0, -1)).toEqual(['pwsh.exe', '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand'])
    expect(decoded(argv.at(-1) ?? '')).toContain("$a = @('C:\\a b\\x.fifo')")
    const removed = hostCommand(windowsOf(), 'remove', ['C:\\a.json', 'C:\\b.json'])
    expect(removed.stdin).toBe('C:\\a.json\nC:\\b.json\n')
    // A longer script goes on stdin, its arguments with it; the command line reads and runs it.
    const serve = hostCommand(windowsOf(), 'serve', ['C:\\run\\x.fifo', 'C:\\mod', 'C:\\own', 'C:\\mod\\config.toml.x', 'auth.json', '--', 'C:\\c\\codex.exe'])
    expect(decoded(serve.argv.at(-1) ?? '')).toContain('[Console]::OpenStandardInput()')
    expect(serve.stdin).toContain("$a = @('C:\\run\\x.fifo', 'C:\\mod', 'C:\\own', 'C:\\mod\\config.toml.x', 'auth.json', '--', 'C:\\c\\codex.exe')")
    expect(serve.stdin).toContain('function Walk')
    expect(serve.argv.join(' ').length).toBeLessThan(1_000)
    const links = hostCommand(windowsOf(), 'links', ['C:\\o\\a.subcodex.jsonl', 'C:\\m\\a.jsonl', 'C:\\o\\b.subcodex.jsonl', ''])
    expect(links.stdin).toContain("$a = @('C:\\o\\a.subcodex.jsonl', 'C:\\m\\a.jsonl', 'C:\\o\\b.subcodex.jsonl', '')")
  })

  test('a PowerShell command carries its script encoded and its arguments as literals', () => {
    const script = decoded(pwsh('exit 0', ['C:\\a b\\x', "it's ‘quoted’"]).at(-1) ?? '')
    expect(script).toContain("$a = @('C:\\a b\\x', 'it''s ‘‘quoted’’')")
    expect(script.endsWith('\nexit 0')).toBe(true)
  })

  test('encodes any text as UTF-16LE in base64', () => {
    for (const text of ['', 'a', 'ab', 'abc', 'Écrit — 编码 ✓']) expect(decoded(encoded(text))).toBe(text)
  })

  test('takes a string literal for any text', () => {
    expect(literal("O'Neil")).toBe("'O''Neil'")
    expect(literal('$env:Path `n')).toBe("'$env:Path `n'")
  })
})

describe("Codex's sandbox on Windows", () => {
  const MXC = ['-c', 'features.prefer_mxc=true', '-c', 'suppress_unstable_features_warning=true']

  test('where the config chooses nothing, Codex prefers MXC, without the under-development warning', () => {
    expect(sandboxChoice(windowsOf(), '')).toEqual(MXC)
    expect(sandboxChoice(windowsOf(), 'model = "gpt-x"\nsandbox_mode = "workspace-write"\n\n[features]\nmulti_agent = true\n\n[windows_tools]\nsandbox = "x"')).toEqual(MXC)
    expect(sandboxChoice(windowsOf(), '# prefer_mxc = false\n[windows]\n# sandbox = "elevated"')).toEqual(MXC)
    // A profile chooses only while it is the active one.
    expect(sandboxChoice(windowsOf(), '[profiles.work.windows]\nsandbox = "elevated"')).toEqual(MXC)
    expect(sandboxChoice(windowsOf(), 'profile = "home"\n[profiles.work.windows]\nsandbox = "elevated"')).toEqual(MXC)
    expect(sandboxChoice(windowsOf(), 'notes = """\n{ sandbox = 1 }\n"""')).toEqual(MXC)
  })

  test('where the config chooses, it is left alone', () => {
    for (const config of [
      '[features]\nprefer_mxc = false',
      'features.prefer_mxc = false',
      'features = { multi_agent = true, prefer_mxc = false }',
      '[windows]\nsandbox = "elevated"',
      '[windows]\nallow_mxc = true\nsandbox = "unelevated"',
      'windows.sandbox = "mxc"',
      'windows = { sandbox = "unelevated" }',
      '[projects]\nlist = [\n  ["a"],\n  ["b"],\n]\n\n[windows]\nsandbox = "elevated"',
      'windows = {\n  allow_mxc = true,\n  sandbox = "elevated",\n}',
      'profile = "work"\n[profiles.work.windows]\nsandbox = "elevated"',
      "profile = 'work'\n[profiles.work]\nfeatures = { prefer_mxc = false }",
      'profile = "my work"\n[profiles."my work"]\nwindows.sandbox = "unelevated"',
    ]) {
      expect(sandboxChoice(windowsOf(), config)).toEqual([])
    }
  })

  test('a value that spans lines is not read as keys or tables', () => {
    expect(keysOf('[a]\nlist = [\n  ["b"],\n]\nkey = 1\ntext = """\nx = 2\n"""')).toEqual(['a.list', 'a.key', 'a.text'])
  })

  test('elsewhere nothing is added', () => {
    expect(sandboxChoice(POSIX_SESSION, '')).toEqual([])
  })
})

describe('what the mod reads on Windows', () => {
  test('the home directory is USERPROFILE, and Codex is where PowerShell finds it', async () => {
    const codex = await findCodex(windowsOf())
    expect(codex.home).toBe('C:\\Users\\p')
    expect(codex.bin).toBe('C:\\c\\codex.exe')
    expect(await recordPath(windowsOf(), 'a1b2c3')).toBe('C:\\Users\\p/.claude/subcodex/agents/a1b2c3.json')
  })

  test('the plugin folders named in CLAUDE_CODE_PLUGIN_DIRS are separated by semicolons', async () => {
    const there = new Set(['C:\\dev\\x/skills', 'D:\\dev\\y/skills'])
    expect(await skillRoots(windowsOf(there), 'C:\\Users\\p', 'C:\\w')).toEqual(['C:\\dev\\x/skills', 'D:\\dev\\y/skills'])
  })
})
