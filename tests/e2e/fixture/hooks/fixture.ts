import type { Register } from 'claude-code'

// Harmless tools for the end-to-end tests of the subcodex bridge, standing for
// ones the session has connected: `stamp` answers `STAMP-<word>-OK`, `picture`
// a small picture of one color.

export const NAME = 'mcp__subcodex-fixture__stamp'
export const PICTURE = 'mcp__subcodex-fixture__picture'
/** An 8 by 8 PNG, all red. */
const RED = 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGO4IyKCFTEMLQkAmD9BAZzFjLYAAAAASUVORK5CYII='

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'stamp',
      description: 'Returns a stamp for a word: STAMP-<word>-OK. A test fixture; it does nothing else.',
      inputSchema: { type: 'object', properties: { word: { type: 'string' } }, required: ['word'] },
      isDeferred: true,
    })
    await $.tool.register({
      name: 'picture',
      description: 'Returns a small picture of one color, and a line of text. A test fixture; it does nothing else.',
      inputSchema: { type: 'object' },
      isDeferred: true,
    })
    return next(e)
  })
  on('tool.call', async (_$, e, next) => {
    if ((e.tool as string) === PICTURE) {
      return { result: [{ type: 'text', text: 'Here is the picture.' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: RED } }] } as never
    }
    if ((e.tool as string) !== NAME) return next(e)
    const word = String((e as unknown as Record<string, unknown>).word ?? '')
    return { result: `STAMP-${word}-OK` }
  })
}
