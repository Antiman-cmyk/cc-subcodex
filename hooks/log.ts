import type { EngineInterface } from 'claude-code'

/** Writes a line to the debug log (`claude --debug`). Never pass secrets. */
export function trace($: EngineInterface, text: string): void {
  $.ui.log(`subcodex: ${text}`, { to: 'debug' })
}
