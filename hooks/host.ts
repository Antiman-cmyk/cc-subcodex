import type { EngineInterface, ProcessRunInit, ProcessRunResult } from 'claude-code'

import { POSIX } from './posix'
import { WINDOWS } from './windows'

// The host system the mod runs on, and the one place that tells the systems
// apart. Each of the mod's host operations is a command of posix.ts (macOS,
// Linux) or of windows.ts (Windows), taking the same arguments.

/** The mod's host operations. */
export type Op =
  | 'serve'
  | 'send'
  | 'leave'
  | 'links'
  | 'look'
  | 'prune'
  | 'wipe'
  | 'remove'
  | 'sleep'
  | 'noop'
  | 'version'
  | 'find'

/**
 * An operation's command: its argument vector, and the text written to its
 * stdin where it takes some. An operation with nothing to do on a system has
 * no argument vector, and is not run.
 */
export type HostCommand = { argv: string[]; stdin?: string }

/** One system's commands, by operation. */
export type Host = Record<Op, (args: readonly string[]) => HostCommand>

/** Whether the engine said it runs on Windows (`learnSystem`); undefined where it has not said. */
let saidWindows: boolean | undefined

/**
 * Reads the system the engine runs on (`$.session.info().platform`; `wsl` is
 * Linux). Claude Code before 2.1.326 does not say it.
 */
export async function learnSystem($: EngineInterface): Promise<void> {
  try {
    const { platform } = await ($.session as unknown as { info: () => Promise<{ platform?: string }> }).info()
    saidWindows = platform === undefined || platform === 'unknown' ? undefined : platform === 'windows'
  } catch {
    saidWindows = undefined
  }
}

/** Whether the mod runs on Windows: as the engine said, else where its folder has a Windows path. */
export function isWindows($: EngineInterface): boolean {
  return saidWindows ?? /^(?:[A-Za-z]:|\\\\)/.test($.plugin.root)
}

/** Whether a path is absolute, on Windows or elsewhere. */
export const isAbsolute = (path: string): boolean => /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(path)

/** The command of an operation on this system. */
export function hostCommand($: EngineInterface, op: Op, args: readonly string[] = []): HostCommand {
  return (isWindows($) ? WINDOWS : POSIX)[op](args)
}

/** Runs an operation; the operation's own stdin, where it has one, is written in place of `init.stdin`. */
export async function hostRun(
  $: EngineInterface,
  op: Op,
  args: readonly string[] = [],
  init: ProcessRunInit = {},
): Promise<ProcessRunResult> {
  const { argv, stdin } = hostCommand($, op, args)
  if (argv.length === 0) return { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
  return $.process.run(argv, stdin === undefined ? init : { ...init, stdin })
}

/** The person's home directory: on Windows their profile folder. */
export async function homeOf($: EngineInterface): Promise<string> {
  return ((isWindows($) ? await $.env.get('USERPROFILE') : undefined) ?? (await $.env.get('HOME'))) ?? ''
}

/** Said where the program the mod runs its own work in could not start: PowerShell 7, on Windows. */
export const HOST_MISSING =
  'On Windows the subcodex mod runs its own work in PowerShell 7 (`pwsh`), which was not found: install it (for example `winget install Microsoft.PowerShell`), then start a new session.'

/** Where `codex` is looked for, and how the person puts it there, as said to them. */
export function codexSearch($: EngineInterface): { where: string; fix: string } {
  return isWindows($)
    ? { where: 'your PATH', fix: 'put it on your PATH' }
    : { where: "your login shell's PATH", fix: 'put it on the PATH your login shell sets' }
}

/** The folders a list of them names (`CLAUDE_CODE_PLUGIN_DIRS`), without a trailing separator. */
export function folderList($: EngineInterface, list: string): string[] {
  const isWin = isWindows($)
  return list
    .split(isWin ? ';' : ':')
    .map(dir => dir.trim())
    .filter(dir => dir !== '')
    .map(dir => dir.replace(isWin ? /[\\/]$/ : /\/$/, ''))
}

/** The tool whose rows mirror Codex's commands: Bash, or on Windows PowerShell where the session has that tool. */
export async function commandTool($: EngineInterface): Promise<'Bash' | 'PowerShell'> {
  if (!isWindows($)) return 'Bash'
  const tools = await $.tool.list().catch(() => [])
  return tools.some(tool => tool.name === 'PowerShell') ? 'PowerShell' : 'Bash'
}
