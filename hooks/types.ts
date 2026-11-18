
/** One thing Codex did, in order. */
export type Ev =
  // `id` names the message a piece of streamed text belongs to. `by` names
  // the sub-agent of Codex's own that said it or ran it, where one did.
  // `isAside` marks a line the mod writes about what Codex did (it started a
  // sub-agent, it compacted its context): shown, but not Codex's own words.
  // `isClosing` marks the message Codex itself calls its final answer, apart
  // from what it says along the way.
  | { t: 'text'; text: string; id?: string; by?: string; isAside?: boolean; isClosing?: boolean }
  | { t: 'thinking'; text: string; id?: string }
  | { t: 'cmd'; id: string; command: string; by?: string }
  // A file Codex changed in place (`update`, a unified diff) or made (`add`).
  | { t: 'edit'; id: string; path: string; kind: 'update' | 'add'; diff: string; by?: string }
  | { t: 'cmd_done'; id: string; output: string; exitCode: number | null }
  // A piece of a running command's output.
  | { t: 'cmd_output'; id: string; text: string }
  // Codex asks something of the Claude session: a tool it has connected, or
  // a message to the agent's caller. `rpc` is the request to answer.
  | { t: 'ctool'; rpc: number | string; name: string; args: Record<string, unknown> }
  // Codex compacted its own context, which had reached so many tokens. `by`
  // names the sub-agent whose context it was, where it was one's.
  | { t: 'compacted'; tokens?: number; by?: string }
  // The tokens Codex's context held at its latest request. Counted, not shown.
  | { t: 'usage'; tokens: number }
  // How much of the person's Codex usage limits is used. Counted, not shown.
  | { t: 'limits'; limits: Limit[] }
  | { t: 'done' }

/** One usage limit of the person's Codex account: a window of time, and how much of it is used. */
export type Limit = {
  /** The limit's own name where it is not the account's general one. */
  name: string | undefined
  /** How long the window is, in minutes, and when it starts over (seconds since 1970). */
  minutes: number | undefined
  resetsAt: number | undefined
  /** How much is used, in percent. */
  used: number
}

/** One Codex turn in flight. */
export type Run = {
  /** The next event. */
  pull: () => Promise<Ev>
  /** Events a `tool.call` hook read past while it waited for its command. */
  buffered: Ev[]
  /** tool_use_id of a mirrored command row -> the Codex item it mirrors. */
  tools: Map<string, string>
  /** tool_use_id of a mirrored Edit or Write call -> the edit it shows. */
  edits: Map<string, Extract<Ev, { t: 'edit' }>>
  /** tool_use_id of a row made for something Codex asked of the session -> what it asked. */
  calls: Map<string, Extract<Ev, { t: 'ctool' }>>
  /** Answers something Codex asked (`rpc`). */
  reply: (rpc: number | string, result: Record<string, unknown>) => Promise<void>
}

/** Which Codex model and reasoning effort a run uses; absent: Codex's own. */
export type Settings = { model: string | undefined; effort: string | undefined }

/** One message of app-server's JSON-RPC, either way. */
export type Rpc = {
  id?: number | string
  method?: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  params?: Record<string, any>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  result?: Record<string, any>
  error?: { code?: number; message?: string }
}

/** A running app-server and the pipe its stdin is. */
export type Conn = {
  /** The person's home directory. */
  home: string
  /** The next piece of the server's output; `done` once it has ended. */
  next: () => Promise<{ done?: boolean; value?: { stream: string; text: string } }>
  kill: () => void
  fifo: string
  /** Output read so far that ends mid-line. */
  partial: string
  /** Messages read while waiting for a response, for the turn to take. */
  held: Rpc[]
  nextId: number
  /** The thread this server has loaded, and its turn in flight. */
  threadId: string | undefined
  turnId: string | undefined
  /** How many tokens Codex's own context held at its last request, as it reports. */
  contextTokens: number | undefined
  /** The usage limits this server has already said are nearly used up. */
  warned: Set<string>
  /** Messages passed on to Codex's turn, by request id, until Codex takes them. */
  steers: Map<number, string>
  /** False when the server never answered its greeting. */
  isUp: boolean
  /** False when the server could not be logged in. */
  isLoggedIn: boolean
  /** True when the agent was stopped while the server was starting. */
  isStopped: boolean
  hasEnded: boolean
  /** The last write to the server; writes are made one after another. */
  sending: Promise<void>
  /** Codex's own sub-agents, by thread: each one's name, and the messages already headed with it. */
  subs: Map<string, { path: string; headed: Set<string> }>
}

/** One Codex agent of this session. */
export type Agent = {
  settings: Settings
  /** The permission mode the agent runs under: its parent's at the spawn, or at the message that last resumed it. */
  mode: string | undefined
  /** Where the agent works, when its call said. */
  cwd: string | undefined
  /** The agent that delegated the task, when it was not the main one. */
  caller: string | undefined
  /**
   * The task as the spawn gave it, for an agent whose conversation the mod
   * cannot read (a workflow's).
   */
  task: string
  /** True where the agent's first Codex turn is a review, as its call asked. */
  isReview: boolean
  /** The Codex turn in flight, if one is. */
  run: Run | undefined
  /**
   * What the next step does after a Codex turn has ended: `echo` repeats
   * Codex's closing message alone, as the agent's result; `deliver` makes the
   * native closing call; `delivered` means that call did not end the turn.
   */
  closing: 'echo' | 'deliver' | 'delivered' | undefined
  /**
   * Why the next step starts another Codex turn in the same agent turn:
   * messages sent as the last one ended, which Codex has not taken in
   * (`late`), or a reminder to submit the workflow result (`remind`).
   */
  carryOn: 'late' | 'remind' | undefined
  /** The agent turn (`turnId`) the mod last worked in. */
  turnId: string | undefined
  /** True once Codex has been reminded, in this agent turn, to submit the workflow result. */
  isReminded: boolean
  /** True once this agent turn's workflow result has been accepted. */
  hasResult: boolean
  /** Codex turns begun. */
  turns: number
  /** Codex's thread, which a later turn resumes. */
  threadId: string | undefined
  /** The app-server this agent's Codex turns run under, while one is up. */
  conn: Conn | undefined
  /** Usage limits reported during this turn, for /subcodex. */
  limits: Map<string, Limit>
  /** What Codex said to close the turn just ended; empty if nothing. */
  turnReport: string
  /**
   * Messages Codex has not taken in, oldest first: given to a turn it has not
   * begun on, passed into its turn and not yet confirmed, or sent while no
   * Codex turn ran. Kept in the agent's record until Codex takes them.
   */
  unsent: string[]
  /** The messages the latest Codex turn was given. */
  given: string[]
  /** True for an agent started by a workflow's script. */
  isWorkflow: boolean
  /** Whether this workflow's native tool schema has been read. */
  isPrepared: boolean
  outputSchema: Record<string, unknown> | undefined
  /** A message or structured result waiting for native delivery. */
  relay: Relay | undefined
}

/** A pending message or workflow result, submitted to its native tool once. */
export type Relay = {
  rpc: number | string
  tool: 'SendMessage' | 'StructuredOutput'
  input: Record<string, unknown>
  answer: (isLetThrough: boolean, why: string) => Record<string, unknown>
  isWritten: boolean
}

/** Where Codex is, and what its own setup says. */
export type Codex = {
  bin: string
  /** The person's home directory. */
  home: string
  /** The model and effort their Codex config sets, and the models it lists. */
  defaults: Settings
  models: string[]
  /** Whether their Codex config says when Codex asks before it acts. */
  hasApprovalPolicy: boolean
  /** Whether the program the mod runs its own work in could not start (`HOST_MISSING`). */
  isHostMissing: boolean
}
