import type { SessionMessage } from 'claude-code'

import { KEPT_CHARS } from './config'

// Compaction of a Codex agent's context in the engine, without a model: the
// task, one line for what is left out, and the latest rows. The saved
// transcript is not affected; Codex compacts its own context itself.

/** Starts the line that stands for the rows left out. */
export const COMPACT_MARK = '[subcodex]'

const sizeOf = (message: SessionMessage): number =>
  message.text.length +
  message.toolUses.reduce((sum, use) => sum + JSON.stringify(use).length, 0) +
  (message.toolResults ?? []).reduce((sum, result) => sum + JSON.stringify(result).length, 0)

/**
 * The conversation cut down to its first message, a line for what is left
 * out, and the latest rows up to `KEPT_CHARS`, starting at an assistant row
 * so no call is parted from its result. Undefined where nothing can go.
 */
export function compacted(messages: readonly SessionMessage[]): SessionMessage[] | undefined {
  let start = messages.length
  let kept = 0
  while (start > 1) {
    const size = sizeOf(messages[start - 1] as SessionMessage)
    if (kept > 0 && kept + size > KEPT_CHARS) break
    kept += size
    start--
  }
  while (start < messages.length && messages[start]?.role !== 'assistant') start++
  if (start <= 1) return undefined
  const first = messages[0] as SessionMessage
  const note: SessionMessage = {
    role: 'user',
    text: `${COMPACT_MARK} ${start - 1} earlier rows of this agent's transcript are left out of this context to keep it small. They were Codex at work: what it said, the commands it ran and their output. Codex itself still has all of it, and the saved transcript is whole. Nothing is asked of you by this line.`,
    toolUses: [],
  }
  return [first, note, ...messages.slice(start)]
}
