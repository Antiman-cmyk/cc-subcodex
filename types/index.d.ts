// The values the subcodex mod keeps in the session's state.

/** The latest output of each running mirrored command, by its row's tool_use_id. */
export type LiveOutput = Record<string, string>

/** One instruction file the engine loaded for the session's context. */
export type InstructionCopy = { path: string; content: string }

declare module 'claude-code' {
  interface PluginState {
    subcodex: {
      live: LiveOutput
      instructions: InstructionCopy[] | null
    }
  }
}
