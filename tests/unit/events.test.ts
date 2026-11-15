import { describe, expect, test } from 'claude-code/testing'

import { fromServer, fromThread, inline, newSeen } from '../../hooks/events'
import type { Ev } from '../../hooks/types'

// What app-server sends -> what the transcript shows. The messages below are
// as real Codex (codex-cli 0.165.0) sent them, cut down to what is read.

const text = (events: Ev[]): string => events.map(ev => (ev.t === 'text' ? ev.text : `<${ev.t}>`)).join('|')
const completed = (item: Record<string, unknown>) => ({ method: 'item/completed', params: { threadId: 't', item } })

describe("Codex's messages", () => {
  test('the message Codex marks as its final answer is told apart from what it says along the way', () => {
    const seen = newSeen()
    fromThread({ method: 'item/started', params: { item: { type: 'agentMessage', id: 'm1', text: '', phase: 'commentary' } } }, seen)
    const along = fromThread({ method: 'item/agentMessage/delta', params: { itemId: 'm1', delta: 'Looking.' } }, seen)
    fromThread({ method: 'item/started', params: { item: { type: 'agentMessage', id: 'm2', text: '', phase: 'final_answer' } } }, seen)
    const final = fromThread({ method: 'item/agentMessage/delta', params: { itemId: 'm2', delta: 'It is red.' } }, seen)
    expect(along).toEqual([{ t: 'text', text: 'Looking.', id: 'm1' }])
    expect(final).toEqual([{ t: 'text', text: 'It is red.', id: 'm2', isClosing: true }])
  })

  test('a message that came in pieces is not said again when it completes', () => {
    const seen = newSeen()
    fromThread({ method: 'item/agentMessage/delta', params: { itemId: 'm1', delta: 'Hi' } }, seen)
    expect(fromThread(completed({ type: 'agentMessage', id: 'm1', text: 'Hi' }), seen)).toEqual([])
    // One that did not (a review's result) is said when it completes.
    expect(fromThread(completed({ type: 'agentMessage', id: 'm9', text: 'Review comment', phase: null }), seen)).toEqual([
      { t: 'text', text: 'Review comment', id: 'm9' },
    ])
  })
})

describe("Codex's commands and edits", () => {
  test('a command begins a row and ends it with its output and exit code', () => {
    const seen = newSeen()
    expect(fromThread({ method: 'item/started', params: { item: { type: 'commandExecution', id: 'exec-1', command: "/bin/zsh -lc 'wc -l note.txt'" } } }, seen)).toEqual([
      { t: 'cmd', id: 'exec-1', command: "/bin/zsh -lc 'wc -l note.txt'" },
    ])
    expect(fromThread(completed({ type: 'commandExecution', id: 'exec-1', aggregatedOutput: '3 note.txt\n', exitCode: 0 }), seen)).toEqual([
      { t: 'cmd_done', id: 'exec-1', output: '3 note.txt\n', exitCode: 0 },
    ])
  })

  test('a command that was refused leave ends with no exit code', () => {
    const done = fromThread(completed({ type: 'commandExecution', id: 'exec-2', status: 'declined', aggregatedOutput: null, exitCode: null }), newSeen())
    expect(done).toEqual([{ t: 'cmd_done', id: 'exec-2', output: '', exitCode: null }])
  })

  test('an applied edit is an edit of each file, with its diff', () => {
    const events = fromThread(
      completed({
        type: 'fileChange',
        id: 'p1',
        status: 'completed',
        changes: [
          { path: '/w/cart.py', kind: { type: 'update', move_path: null }, diff: '@@ -1 +1 @@\n-a\n+b' },
          { path: '/w/new.py', kind: { type: 'add' }, diff: 'x = 1\n' },
        ],
      }),
      newSeen(),
    )
    expect(events).toEqual([
      { t: 'edit', id: 'p1_0', path: '/w/cart.py', kind: 'update', diff: '@@ -1 +1 @@\n-a\n+b' },
      { t: 'edit', id: 'p1_1', path: '/w/new.py', kind: 'add', diff: 'x = 1\n' },
    ])
  })

  test('a delete or a move is a command row that names its files and shows the diff', () => {
    const events = fromThread(
      completed({ type: 'fileChange', id: 'p3', status: 'completed', changes: [{ path: '/w/old.py', kind: { type: 'delete' }, diff: 'gone\n' }] }),
      newSeen(),
    )
    expect(events[0]).toEqual({ t: 'cmd', id: 'p3', command: 'apply_patch  # /w/old.py' })
    expect(events[1]).toEqual({ t: 'cmd_done', id: 'p3', output: 'delete /w/old.py\ngone\n', exitCode: 0 })
  })

  test('an edit that failed or was declined ends with an exit code of 1 and says so', () => {
    for (const [status, said] of [['failed', 'not applied'], ['declined', 'declined']] as const) {
      const events = fromThread(
        completed({ type: 'fileChange', id: 'p2', status, changes: [{ path: '/w/a.py', kind: { type: 'add' }, diff: '+x' }] }),
        newSeen(),
      )
      expect(events[1]).toEqual({ t: 'cmd_done', id: 'p2', output: `The edit was ${said}.\nadd /w/a.py\n+x`, exitCode: 1 })
    }
  })
})

describe("what Codex does with means of its own", () => {
  test('looking at an image', () => {
    expect(text(fromThread(completed({ type: 'imageView', id: 'exec-8', path: '/w/red.png' }), newSeen()))).toBe('[Codex looked at the image /w/red.png]')
  })

  test('waiting', () => {
    expect(text(fromThread(completed({ type: 'sleep', id: 'call_9', durationMs: 2000 }), newSeen()))).toBe('[Codex waited 2 s]')
  })

  test('a web search, with what it found', () => {
    const line = text(
      fromThread(
        completed({
          type: 'webSearch',
          id: 'exec-1e',
          query: 'site:python.org latest Python stable release',
          action: { type: 'search', query: 'site:python.org latest Python stable release', queries: null },
          results: [
            { type: 'text_result', domain: 'www.python.org', title: 'Python Source Releases | Python.org', url: 'https://www.python.org/downloads/source/' },
            { type: 'text_result', domain: 'www.python.org', title: 'Download Python', url: 'https://www.python.org/downloads/' },
          ],
        }),
        newSeen(),
      ),
    )
    expect(line).toBe(
      '[Codex searched the web: site:python.org latest Python stable release; it found:\n- Python Source Releases | Python.org (https://www.python.org/downloads/source/)\n- Download Python (https://www.python.org/downloads/)]',
    )
  })

  test('a web search that found nothing yet says only what was searched', () => {
    const line = text(fromThread(completed({ type: 'webSearch', id: 's', query: 'x', action: { type: 'search' }, results: null }), newSeen()))
    expect(line).toBe('[Codex searched the web: x]')
  })

  test("its own reviewer's verdict, with the risk and the reason", () => {
    const line = text(
      fromThread(
        {
          method: 'item/autoApprovalReview/completed',
          params: {
            threadId: 't',
            targetItemId: 'exec-ca',
            decisionSource: 'agent',
            review: { status: 'approved', riskLevel: 'low', userAuthorization: 'high', rationale: 'The user explicitly authorized creating this single file.' },
            action: { type: 'command', source: 'unifiedExec', command: "/bin/zsh -lc 'touch ~/x.txt'", cwd: '/w' },
          },
        },
        newSeen(),
      ),
    )
    expect(line).toBe("[Codex's own reviewer allowed the command `/bin/zsh -lc 'touch ~/x.txt'` (risk low): The user explicitly authorized creating this single file.]")
  })

  test('the same verdict said once more as a warning is passed over, and a review still under way says nothing', () => {
    const seen = newSeen()
    expect(fromThread({ method: 'guardianWarning', params: { threadId: 't', message: 'Automatic approval review approved (risk: low)' } }, seen)).toEqual([])
    expect(fromThread({ method: 'item/autoApprovalReview/started', params: { review: { status: 'inProgress' }, action: { type: 'command' } } }, seen)).toEqual([])
  })

  test('review mode, a plan, a compaction', () => {
    const seen = newSeen()
    expect(text(fromThread(completed({ type: 'enteredReviewMode', id: 'r', review: 'current changes' }), seen))).toBe("[Codex's review mode: current changes]")
    expect(text(fromThread({ method: 'turn/plan/updated', params: { explanation: null, plan: [{ step: 'Read', status: 'completed' }, { step: 'Fix', status: 'inProgress' }, { step: 'Test', status: 'pending' }] } }, seen))).toBe(
      "[Codex's plan]\n- [x] Read\n- [ ] Fix (in progress)\n- [ ] Test",
    )
    expect(fromThread(completed({ type: 'contextCompaction', id: 'c' }), seen)).toEqual([{ t: 'compacted' }])
  })
})

describe('counts and limits', () => {
  test("a thread's token count", () => {
    const count = (n: number) => ({ totalTokens: n, inputTokens: n - 10, cachedInputTokens: 5, cacheWriteInputTokens: 0, outputTokens: 10, reasoningOutputTokens: 0 })
    const events = fromThread({ method: 'thread/tokenUsage/updated', params: { threadId: 't', turnId: 'u', tokenUsage: { total: count(300), last: count(100), modelContextWindow: 475000 } } }, newSeen())
    expect(events).toEqual([{ t: 'usage', tokens: 100 }])
  })

  test("the person's usage limits, each window that is reported", () => {
    const events = fromServer({
      method: 'account/rateLimits/updated',
      params: { rateLimits: { limitId: 'codex', limitName: null, primary: { usedPercent: 34, windowDurationMins: 300, resetsAt: 1794600000 }, secondary: null } },
    })
    expect(events).toEqual([{ t: 'limits', limits: [{ name: undefined, minutes: 300, resetsAt: 1794600000, used: 34 }] }])
  })
})

describe('how a turn ends', () => {
  test('an error the server will retry is not shown; one it will not is', () => {
    expect(fromThread({ method: 'error', params: { willRetry: true, error: { message: 'stream dropped' } } }, newSeen())).toEqual([])
    expect(text(fromThread({ method: 'error', params: { willRetry: false, error: { message: 'usage limit reached' } } }, newSeen()))).toBe('Codex error: usage limit reached')
  })

  test('a turn that failed says why, and ends', () => {
    expect(fromThread({ method: 'turn/completed', params: { turn: { status: 'failed', error: { message: 'boom' } } } }, newSeen())).toEqual([
      { t: 'text', text: 'Codex turn failed: boom' },
      { t: 'done' },
    ])
    expect(fromThread({ method: 'turn/completed', params: { turn: { status: 'completed' } } }, newSeen())).toEqual([{ t: 'done' }])
  })
})

describe("a sub-agent of Codex's own, in the agent's transcript", () => {
  test('its words bear its name once a message; its commands are marked as its; its turn ending is not ours', () => {
    const headed = new Set<string>()
    expect(inline('/root/counter', headed, { t: 'text', text: 'Counting', id: 's1' })).toEqual([{ t: 'text', text: '[Codex sub-agent /root/counter] Counting', id: 's1', by: '/root/counter' }])
    expect(inline('/root/counter', headed, { t: 'text', text: ' lines.', id: 's1' })).toEqual([{ t: 'text', text: ' lines.', id: 's1', by: '/root/counter' }])
    expect(inline('/root/counter', headed, { t: 'cmd', id: 'c1', command: 'wc -l' })).toEqual([{ t: 'cmd', id: 'c1', command: 'wc -l', by: '/root/counter' }])
    expect(inline('/root/counter', headed, { t: 'done' })).toEqual([])
    expect(inline('/root/counter', headed, { t: 'thinking', text: 'hm' })).toEqual([])
  })
})
