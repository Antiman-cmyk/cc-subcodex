import type { EngineInterface } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'

import { forgetLastPass, linkSessions } from '../../hooks/usage-links'

// The usage links: which day folders a pass looks at, the links it makes and
// removes there, and when it records itself.

const MOD = '/h/.claude/subcodex/codex-home/sessions'
const OWN = '/h/.codex/sessions'
const RECORD = '/h/.claude/subcodex/usage-links.json'
const DAY = 24 * 3600 * 1000

type Node = { kind: 'file' | 'dir'; mtimeMs: number } | { kind: 'link'; to: string }

/** A home `/h` whose file system is `nodes`, by path; folders are laid out for each path. */
function homeOf(nodes: Record<string, Node>, exitCode = 0) {
  const all = new Map<string, Node>()
  const text = new Map<string, string>()
  const runs: { argv: string[]; stdin?: string }[] = []
  for (const [path, node] of Object.entries(nodes)) {
    for (let at = path.lastIndexOf('/'); at > 0; at = path.lastIndexOf('/', at - 1)) {
      if (!all.has(path.slice(0, at))) all.set(path.slice(0, at), { kind: 'dir', mtimeMs: 0 })
    }
  }
  for (const [path, node] of Object.entries(nodes)) all.set(path, node)
  const statOf = (path: string) => {
    const node = all.get(path)
    if (node === undefined) throw new Error(`ENOENT: ${path}`)
    if (node.kind !== 'link') return { kind: node.kind, size: 0, mtimeMs: node.mtimeMs, isLink: false }
    const to = all.get(node.to)
    return to === undefined || to.kind === 'link' ? { kind: 'other', size: 0, mtimeMs: 0, isLink: true } : { kind: to.kind, size: 0, mtimeMs: to.mtimeMs, isLink: true }
  }
  const $ = {
    plugin: { root: '/m' },
    fs: {
      list: async (dir: string) => {
        if (all.get(dir)?.kind !== 'dir') throw new Error(`ENOTDIR: ${dir}`)
        return [...all.entries()]
          .filter(([path]) => path.slice(0, path.lastIndexOf('/')) === dir)
          .map(([path, node]) => ({
            name: path.slice(path.lastIndexOf('/') + 1),
            kind: node.kind === 'link' ? 'other' : node.kind,
            size: 0,
            mtimeMs: node.kind === 'file' ? node.mtimeMs : 0,
            isLink: node.kind === 'link',
          }))
      },
      stat: async (path: string) => statOf(path),
      read: async (path: string) => {
        const found = text.get(path)
        if (found === undefined) throw new Error(`ENOENT: ${path}`)
        return found
      },
      write: async (path: string, value: string) => {
        text.set(path, value)
      },
    },
    process: {
      run: async (argv: string[], init: { stdin?: string } = {}) => {
        runs.push({ argv, stdin: init.stdin })
        return { exitCode, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
      },
    },
  } as unknown as EngineInterface
  return { $, runs, text }
}

/** The pairs a run of `links` was given: a link's path, and the file it leads to ('' to remove it). */
const pairsOf = (run: { stdin?: string } | undefined): [string, string][] => {
  const lines = (run?.stdin ?? '').split('\n').slice(0, -1)
  const pairs: [string, string][] = []
  for (let at = 0; at + 1 < lines.length; at += 2) pairs.push([lines[at] ?? '', lines[at + 1] ?? ''])
  return pairs
}

const sorted = (pairs: [string, string][]) => [...pairs].sort((a, b) => a.join().localeCompare(b.join()))

describe('a pass of the usage links', () => {
  test('the first links every session file, compressed ones too, and records when it began', async () => {
    const now = Date.now()
    const { $, runs, text } = homeOf({
      [`${MOD}/2026/11/18/rollout-a.jsonl`]: { kind: 'file', mtimeMs: now },
      [`${MOD}/2026/10/02/rollout-b.jsonl.zst`]: { kind: 'file', mtimeMs: now - 40 * DAY },
      [`${MOD}/2026/10/02/notes.txt`]: { kind: 'file', mtimeMs: now - 40 * DAY },
    })
    await linkSessions($, '/h')
    expect(runs.length).toBe(1)
    expect(runs[0]?.argv.slice(0, 2)).toEqual(['/bin/sh', '-c'])
    expect(sorted(pairsOf(runs[0]))).toEqual([
      [`${OWN}/2026/10/02/rollout-b.subcodex.jsonl.zst`, `${MOD}/2026/10/02/rollout-b.jsonl.zst`],
      [`${OWN}/2026/11/18/rollout-a.subcodex.jsonl`, `${MOD}/2026/11/18/rollout-a.jsonl`],
    ])
    const began = (JSON.parse(text.get(RECORD) ?? '{}') as { began?: number }).began ?? 0
    expect(began >= now && began <= Date.now()).toBe(true)
  })

  test('a later one looks only at the day folders changed since the last began', async () => {
    const now = Date.now()
    const { $, runs, text } = homeOf({
      [`${MOD}/2026/11/01/rollout-old.jsonl`]: { kind: 'file', mtimeMs: now - 17 * DAY },
      [`${MOD}/2026/11/01`]: { kind: 'dir', mtimeMs: now - 17 * DAY },
      [`${MOD}/2026/11/18/rollout-new.jsonl`]: { kind: 'file', mtimeMs: now },
      [`${MOD}/2026/11/18`]: { kind: 'dir', mtimeMs: now },
    })
    text.set(RECORD, JSON.stringify({ began: now - DAY }))
    await linkSessions($, '/h')
    expect(pairsOf(runs[0])).toEqual([[`${OWN}/2026/11/18/rollout-new.subcodex.jsonl`, `${MOD}/2026/11/18/rollout-new.jsonl`]])
  })

  test('a folder changed just before the last pass began still counts', async () => {
    const now = Date.now()
    const { $, runs, text } = homeOf({
      [`${MOD}/2026/11/18/rollout-a.jsonl`]: { kind: 'file', mtimeMs: now },
      [`${MOD}/2026/11/18`]: { kind: 'dir', mtimeMs: now - DAY - 5_000 },
    })
    text.set(RECORD, JSON.stringify({ began: now - DAY }))
    await linkSessions($, '/h')
    expect(pairsOf(runs[0]).length).toBe(1)
  })

  test('in a changed folder, a link that leads to no file is removed, and a compressed file linked by its new name', async () => {
    const now = Date.now()
    const { $, runs } = homeOf({
      [`${MOD}/2026/11/18/rollout-c.jsonl.zst`]: { kind: 'file', mtimeMs: now },
      [`${OWN}/2026/11/18/rollout-c.subcodex.jsonl`]: { kind: 'link', to: `${MOD}/2026/11/18/rollout-c.jsonl` },
    })
    await linkSessions($, '/h')
    expect(pairsOf(runs[0])).toEqual([
      [`${OWN}/2026/11/18/rollout-c.subcodex.jsonl`, ''],
      [`${OWN}/2026/11/18/rollout-c.subcodex.jsonl.zst`, `${MOD}/2026/11/18/rollout-c.jsonl.zst`],
    ])
  })

  test('a link of the right name that leads nowhere is removed before it is made again', async () => {
    const now = Date.now()
    const { $, runs } = homeOf({
      [`${MOD}/2026/11/18/rollout-d.jsonl`]: { kind: 'file', mtimeMs: now },
      [`${OWN}/2026/11/18/rollout-d.subcodex.jsonl`]: { kind: 'link', to: '/old/home/rollout-d.jsonl' },
    })
    await linkSessions($, '/h')
    expect(pairsOf(runs[0])).toEqual([
      [`${OWN}/2026/11/18/rollout-d.subcodex.jsonl`, ''],
      [`${OWN}/2026/11/18/rollout-d.subcodex.jsonl`, `${MOD}/2026/11/18/rollout-d.jsonl`],
    ])
  })

  test("links that lead to their file, and the person's own files and links, are left alone: then nothing runs", async () => {
    const now = Date.now()
    const { $, runs, text } = homeOf({
      [`${MOD}/2026/11/18/rollout-e.jsonl`]: { kind: 'file', mtimeMs: now },
      [`${OWN}/2026/11/18/rollout-e.subcodex.jsonl`]: { kind: 'link', to: `${MOD}/2026/11/18/rollout-e.jsonl` },
      [`${OWN}/2026/11/18/rollout-theirs.jsonl`]: { kind: 'file', mtimeMs: now },
      [`${OWN}/2026/11/18/rollout-linked.jsonl`]: { kind: 'link', to: '/elsewhere/rollout-linked.jsonl' },
    })
    await linkSessions($, '/h')
    expect(runs).toEqual([])
    expect(text.has(RECORD)).toBe(true)
  })

  test('a pass whose links were not all made leaves the record as it was', async () => {
    const now = Date.now()
    const { $, text } = homeOf({ [`${MOD}/2026/11/18/rollout-f.jsonl`]: { kind: 'file', mtimeMs: now } }, 1)
    await linkSessions($, '/h')
    expect(text.has(RECORD)).toBe(false)
  })

  test('once the last pass is forgotten, the next looks at every day folder', async () => {
    const now = Date.now()
    const { $, runs, text } = homeOf({
      [`${MOD}/2026/01/02/rollout-old.jsonl`]: { kind: 'file', mtimeMs: now - 300 * DAY },
      [`${MOD}/2026/01/02`]: { kind: 'dir', mtimeMs: now - 300 * DAY },
    })
    text.set(RECORD, JSON.stringify({ began: now - DAY }))
    await linkSessions($, '/h')
    expect(runs).toEqual([])
    await forgetLastPass($, '/h')
    await linkSessions($, '/h')
    expect(pairsOf(runs[0])).toEqual([[`${OWN}/2026/01/02/rollout-old.subcodex.jsonl`, `${MOD}/2026/01/02/rollout-old.jsonl`]])
  })

  test('with no session folder, nothing runs', async () => {
    const { $, runs } = homeOf({})
    await linkSessions($, '/h')
    expect(runs).toEqual([])
  })
})
