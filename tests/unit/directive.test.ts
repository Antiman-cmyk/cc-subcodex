import { describe, expect, test } from 'claude-code/testing'

import { REVIEW_CHANGES, readDirective } from '../../hooks/agents'

// The first line of a prompt may be for the mod: `@codex ...`. It is cut
// from what Codex reads, and nothing else of the prompt is touched.

describe('the @codex line', () => {
  test('names a model and an effort, and is cut from the task', () => {
    const read = readDirective('@codex model=gpt-x effort=ultra\nFix the bug.\nThen test.')
    expect(read.asked).toEqual({ model: 'gpt-x', effort: 'ultra' })
    expect(read.isReview).toBe(false)
    expect(read.rest).toBe('Fix the bug.\nThen test.')
  })

  test('a prompt without it is the task as it is', () => {
    const read = readDirective('Fix the bug.\n@codex model=gpt-x')
    expect(read.asked).toEqual({ model: undefined, effort: undefined })
    expect(read.rest).toBe('Fix the bug.\n@codex model=gpt-x')
  })

  test('review with something to review keeps that as the task', () => {
    const read = readDirective('@codex review model=gpt-x\nReview only cart.py.')
    expect(read.isReview).toBe(true)
    expect(read.asked.model).toBe('gpt-x')
    expect(read.rest).toBe('Review only cart.py.')
  })

  test('review with nothing more is of the uncommitted changes', () => {
    expect(readDirective('@codex review').rest).toBe(REVIEW_CHANGES)
    expect(readDirective('@codex review\n  \n').rest).toBe(REVIEW_CHANGES)
  })

  test('a word that only contains "review" does not ask for one', () => {
    expect(readDirective('@codex model=review-model\nDo it.').isReview).toBe(false)
  })
})
