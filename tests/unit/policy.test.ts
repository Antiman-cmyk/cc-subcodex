import { describe, expect, test } from 'claude-code/testing'

import { afresh, policyFor, promptFor } from '../../hooks/turn'

// How a thread is opened, and the prompt for a thread that lacks earlier messages.

describe('how a thread is opened', () => {
  test("the person's own approval policy is left alone; where they set none, Codex asks when it needs more than its sandbox", () => {
    expect(policyFor('default', true, undefined).approvalPolicy).toBeUndefined()
    expect(policyFor('default', false, undefined).approvalPolicy).toBe('on-request')
  })

  test("Codex's own reviewer answers a request for leave, as in the person's Codex app", () => {
    for (const mode of ['default', 'acceptEdits', 'auto', 'bypassPermissions', undefined]) {
      expect(policyFor(mode, false, 'low').approvalsReviewer).toBe('auto_review')
    }
  })

  test('plan mode, and only plan mode, makes the sandbox read-only, and has a request for more come here, to be refused', () => {
    expect(policyFor('plan', false, undefined)).toMatchObject({ sandbox: 'read-only', approvalsReviewer: 'user' })
    for (const mode of ['default', 'acceptEdits', 'auto', 'bypassPermissions', undefined]) {
      expect('sandbox' in policyFor(mode, false, undefined)).toBe(false)
    }
  })

  test("the call's effort is the thread's own setting, so that a review and sub-agents take it too", () => {
    expect(policyFor('auto', true, 'low')).toEqual({ approvalsReviewer: 'auto_review', config: { model_reasoning_effort: 'low' } })
  })
})

describe('a new thread for an agent that was told things Codex does not have', () => {
  const said = ['Remember the codeword OTTER. Then run sleep 600.', 'Forget the sleep. Reply with the codeword.']

  test("it is given everything the caller said, oldest first, ending on what to do now", () => {
    for (const isLost of [false, true]) {
      const text = afresh(said, isLost)
      expect(text.indexOf(said[0] as string)).toBeGreaterThan(0)
      expect(text.indexOf(said[1] as string)).toBeGreaterThan(text.indexOf(said[0] as string))
      expect(text.endsWith(said[1] as string)).toBe(true)
    }
  })

  test('it is told why: messages that had not reached it, or a thread that is gone with its work', () => {
    expect(afresh(said, false)).toContain('had not reached you yet')
    expect(afresh(said, false)).not.toContain('could not be reopened')
    expect(afresh(said, true)).toContain('could not be reopened')
  })
})

describe('what a Codex turn is given', () => {
  test('one message as it is; several as messages that had not reached Codex, the last being what to do now', () => {
    expect(promptFor(['Fix the bug.'], false)).toBe('Fix the bug.')
    const text = promptFor(['Fix the bug.', 'Also add a test.'], false)
    expect(text).toContain('had not reached you yet')
    expect(text.endsWith('Also add a test.')).toBe(true)
  })

  test('messages sent as its last turn was ending are said to be from the delegating agent', () => {
    const text = promptFor(['Stop after the first file.'], true)
    expect(text).toContain('from the agent that delegated this task')
    expect(text.endsWith('Stop after the first file.')).toBe(true)
  })
})
