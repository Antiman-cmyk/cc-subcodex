import type { EngineInterface, ToolInfo } from 'claude-code'

import { PLUGIN, TOOL_RESULT_CHARS } from './config'

// The tools Codex is given as a client of app-server: the tools the Claude
// session has connected (MCP servers, connectors, plugins), as deferred tools
// that Codex's own tool search loads, one namespace per connection; and a
// message to the agent's caller. Calls run on Claude's side as Codex asks; the
// engine still applies deny rules. No input schemas are available, so Codex
// takes the arguments from each tool's description.

/** The tool, and the row name, of a message to the caller. */
export const MESSAGE = 'message_parent'
/** A workflow result uses the same schema as the engine's StructuredOutput tool. */
export const RESULT = 'workflow_result'
/** The prompt of a Codex turn that ended without submitting the workflow result. */
export const REMIND = `You ended your turn without submitting the workflow result. Call ${RESULT} now with the result, in its schema; if it is refused, correct it and submit again.`

const MESSAGE_TOOL = {
  type: 'function',
  name: MESSAGE,
  description:
    'Send a short message to the agent that delegated this task, while you keep working. It does not wait: a reply, if one comes, arrives later as a new user message. For something that agent must know now, or a question you cannot settle yourself; your final report still goes in your final message.',
  inputSchema: {
    type: 'object',
    properties: { message: { type: 'string' } },
    required: ['message'],
  },
}

/** Each session tool's namespace: this, then the name of its connection. */
const NAMESPACE = 'claude_'
/** What app-server takes as a namespace or tool name. */
const NAME = /^[a-zA-Z0-9_-]{1,64}$/

/** A session tool's connection and own name: `mcp__<connection>__<tool>`. */
function partsOf(name: string): { connection: string; tool: string } | undefined {
  if (!name.startsWith('mcp__')) return undefined
  const rest = name.slice('mcp__'.length)
  const at = rest.indexOf('__')
  return at < 1 ? undefined : { connection: rest.slice(0, at), tool: rest.slice(at + 2) }
}

/** The session's tools Codex is offered, deferred, in one namespace per connection. */
export function sessionTools(tools: readonly ToolInfo[]): Record<string, unknown>[] {
  const byNamespace = new Map<string, Record<string, unknown>[]>()
  for (const info of tools) {
    const parts = isOffered(info.name) ? partsOf(info.name) : undefined
    if (parts === undefined) continue
    const namespace = `${NAMESPACE}${parts.connection}`
    if (!NAME.test(namespace) || !NAME.test(parts.tool)) continue
    byNamespace.set(namespace, [
      ...(byNamespace.get(namespace) ?? []),
      {
        type: 'function',
        name: parts.tool,
        description: info.description.trim() === '' ? info.name : info.description,
        inputSchema: { type: 'object', additionalProperties: true },
        deferLoading: true,
      },
    ])
  }
  return [...byNamespace].map(([namespace, list]) => ({
    type: 'namespace',
    name: namespace,
    description: `Tools the Claude Code session has connected through ${namespace.slice(NAMESPACE.length)}. Their argument schemas are not shown: take the arguments from each tool's description, and if a call is refused as invalid, correct the fields its error names.`,
    tools: list,
  }))
}

/** The name of what a call of Codex's asks for: a session tool's full name, or one of the mod's own. */
export function claudeName(namespace: string | null | undefined, tool: string): string {
  return namespace?.startsWith(NAMESPACE) === true ? `mcp__${namespace.slice(NAMESPACE.length)}__${tool}` : tool
}

/** All the tools a new thread is given: the message, the workflow result where there is a schema, the session's. */
export function toolsFor(schema: Record<string, unknown> | undefined, tools: readonly ToolInfo[]): Record<string, unknown>[] {
  const result = {
    type: 'function',
    name: RESULT,
    description: 'Submit the completed workflow result using this exact schema. This ends the delegated task when accepted. If validation fails, correct the arguments and submit again.',
    inputSchema: schema,
  }
  return [MESSAGE_TOOL, ...(schema === undefined ? [] : [result]), ...sessionTools(tools)]
}

/** Developer instructions for a new thread: its place in the Claude session. */
export const CODEX_BRIEF = [
  'You are working as a delegated agent inside a Claude Code session: another agent gave you this task and will read only your final message, so end with a report of what you did and what you found.',
  "Besides your own tools you can use what that session has connected and you do not have, its MCP servers, connectors and plugins' tools: they are among your deferred tools, one namespace per connection (`claude_<connection>`), and your tool search finds them.",
  'While you work, that agent may send you a message; it arrives as a new user message, and you take it into account. You can send it one with `message_parent`, which does not wait for an answer: use it sparingly, for something it must know before you finish.',
  'If you cannot go on without an answer, a decision or an approval from that agent (leave your own approval reviewer refused, say), do not guess and do not work around it: end your turn with the question as your final message, saying what you found and what you need, and for an approval the exact action and its risk. Its reply arrives as your next message, in this same conversation.',
].join(' ')

/**
 * Tools not offered among the session's `mcp__` tools: the desktop app's own
 * controls and this mod's. Built-in tools are not offered at all.
 */
const NOT_OFFERED = ['mcp__ccd_', `mcp__${PLUGIN}__`]

/** Call keys that are not a tool's arguments; never taken from Codex. */
const RESERVED = ['tool', 'tool_use_id', 'consent', 'requestMeta']

export const isOffered = (tool: string): boolean =>
  tool.startsWith('mcp__') && !NOT_OFFERED.some(prefix => tool.startsWith(prefix))

/** A tool's arguments as Codex gave them, less the reserved keys. */
const own = (args: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(args).filter(([key]) => !RESERVED.includes(key)))

/** The images of a tool's result blocks, as data or web URLs. */
export function imagesOf(result: unknown): string[] {
  if (!Array.isArray(result)) return []
  return result.flatMap(block => {
    const source = (block as { type?: string; source?: { type?: string; media_type?: string; data?: string; url?: string } }).type === 'image'
      ? (block as { source?: { type?: string; media_type?: string; data?: string; url?: string } }).source
      : undefined
    if (source?.type === 'base64' && source.data !== undefined) return [`data:${source.media_type ?? 'image/png'};base64,${source.data}`]
    if (source?.type === 'url' && source.url !== undefined) return [source.url]
    return []
  })
}

/** Runs a call of one of the session's tools for Codex: its text, and the images it gave. */
export async function runForCodex(
  $: EngineInterface,
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; images: string[]; isDone: boolean }> {
  let text: string
  let images: string[] = []
  let isDone = false
  if (!isOffered(name)) {
    text = `${name} is not offered to Codex: it is given what the Claude session has connected (MCP servers, connectors, plugins' tools), and has its own tools for the rest.`
  } else {
    try {
      const ran = await $.tool.call({ ...own(args), tool: name } as never)
      if (ran.deny !== undefined) {
        text = `The Claude session did not allow this call: ${ran.deny}`
      } else {
        isDone = ran.isError !== true
        images = imagesOf(ran.result)
        text =
          ran.text ??
          (typeof ran.result === 'string' ? ran.result : JSON.stringify(ran.result ?? ''))
      }
    } catch (error) {
      text = `The call could not be made: ${String(error)}`
    }
  }
  return {
    text: text.length > TOOL_RESULT_CHARS ? `${text.slice(0, TOOL_RESULT_CHARS)}\n[cut]` : text,
    images,
    isDone,
  }
}
