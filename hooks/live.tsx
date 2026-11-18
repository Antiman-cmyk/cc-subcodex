import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { LIVE_CHARS } from './config'

// The output of Codex's commands while they run, drawn under each running
// command row (Bash or PowerShell) of a Codex agent; the row's result shows
// the whole output once the command ends.

/** The latest output of each running mirrored command, by its row's tool_use_id. */
const live = atom({ plugin: 'subcodex', key: 'live' } as const, {})

/** How many of a command's last lines are drawn. */
const DRAWN_LINES = 5

/** Adds a piece of a running command's output. */
export async function addOutput($: EngineInterface, toolUseId: string, text: string): Promise<void> {
  await update($, live, now => ({ ...now, [toolUseId]: `${now[toolUseId] ?? ''}${text}`.slice(-LIVE_CHARS) }))
}

/** Drops the output kept for rows whose tool_use_id starts with `prefix`: one row, or all of an agent's. */
export async function dropOutput($: EngineInterface, prefix: string): Promise<void> {
  await update($, live, now =>
    Object.keys(now).some(id => id.startsWith(prefix))
      ? Object.fromEntries(Object.entries(now).filter(([id]) => !id.startsWith(prefix)))
      : now,
  )
}

/** The last lines of a command's output, without terminal control codes. */
export function lastLines(text: string): string[] {
  return text
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => line.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trimEnd())
    .filter(line => line !== '')
    .slice(-DRAWN_LINES)
}

export function registerLive(on: Parameters<Register>[0]): void {
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if ((e.props.tool !== 'Bash' && e.props.tool !== 'PowerShell') || !e.props.isRunning) return next(e)
    const output = (await read($, live))[e.props.tool_use_id]
    const lines = output === undefined ? [] : lastLines(output)
    if (lines.length === 0) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {await next(e)}
        <Text dimColor wrap="truncate-end">
          {lines.join('\n')}
        </Text>
      </Box>
    )
  })
}
