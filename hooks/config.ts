// Names, paths and limits shared across the mod.

export const PLUGIN = 'subcodex'
/** The mod's version, as in plugin.json; sent to app-server as the client version. */
export const VERSION = '1.0.0'
/** The agent type's short name: the type is `subcodex:codex`. */
export const NAME = 'codex'
export const TYPE = `${PLUGIN}:${NAME}`

/**
 * The model stamped on every row the mod writes into an agent's transcript.
 * Claude Code uses it for rows that no model request produced; usage tools
 * skip such rows.
 */
export const SYNTHETIC = '<synthetic>'

/** The mod's own tools, written only by the mod as rows of an agent's transcript. */
export const CHECKPOINT = `mcp__${PLUGIN}__checkpoint`
export const CLAUDE_TOOL = `mcp__${PLUGIN}__claude_tool`

/** Everything the mod keeps on disk, relative to the home directory. */
export const DATA_DIR = `.claude/${PLUGIN}`
/** The Codex home the mod's app-servers run on. */
export const CODEX_HOME = `${DATA_DIR}/codex-home`
/** One record per Codex agent (`<agent id>.json`): the thread it goes on in. */
export const AGENTS_DIR = `${DATA_DIR}/agents`
/** Pipes to running app-servers (mode 700). */
export const RUN_DIR = `${DATA_DIR}/run`
/** Entries of the person's Codex home linked into the mod's. */
export const SHARED = ['rules', 'hooks.json', 'packages', 'models_cache.json']
/** Links that older versions made in the mod's Codex home; removed at start. */
export const UNSHARED = ['config.toml', 'AGENTS.md', 'AGENTS.override.md', 'plugins', 'agents']
/** Config tables and top-level keys left out of the mod's copy of the person's Codex config. */
export const CONTEXT_TABLES = ['mcp_servers', 'plugins', 'marketplaces', 'memories', 'skills', 'apps', 'agents']
export const CONTEXT_KEYS = [
  'instructions',
  'developer_instructions',
  'model_instructions_file',
  'experimental_instructions_file',
]

/** The person's own Codex home, relative to the home directory. */
export const OWN_CODEX_HOME = '.codex'
/**
 * Marks the links to the mod's session files that are kept in the person's
 * Codex home (`rollout-…<mark>.jsonl`), where usage tools count them.
 */
export const USAGE_MARK = '.subcodex'

/** How much of a command's output a transcript row shows: its start and its end. */
export const ROW_OUTPUT_HEAD = 2_000
export const ROW_OUTPUT_TAIL = 6_000
/** How much of an agent's latest rows its context keeps when compacted. */
export const KEPT_CHARS = 60_000
/** How much of a Claude tool's result Codex is given. */
export const TOOL_RESULT_CHARS = 30_000
