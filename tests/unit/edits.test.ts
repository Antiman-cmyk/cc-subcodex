import { describe, expect, test } from 'claude-code/testing'

import { editCall, editResult, hunksOf, isEditable } from '../../hooks/edits'

// Codex's edits as native Edit and Write rows.

const DIFF = '@@ -1,3 +1,2 @@\n def total(prices, coupon):\n-    prices = [p * (1 - coupon) for p in prices]\n     return sum(prices) * (1 - coupon)\n@@ -9 +8,2 @@\n-x = 1\n+x = 2\n+y = 3'

describe('a unified diff', () => {
  test('is read into hunks as the native tools hold them', () => {
    expect(hunksOf(DIFF)).toEqual([
      { oldStart: 1, oldLines: 3, newStart: 1, newLines: 2, lines: [' def total(prices, coupon):', '-    prices = [p * (1 - coupon) for p in prices]', '     return sum(prices) * (1 - coupon)'] },
      { oldStart: 9, oldLines: 1, newStart: 8, newLines: 2, lines: ['-x = 1', '+x = 2', '+y = 3'] },
    ])
  })

  test('without hunks has none', () => {
    expect(hunksOf('just text')).toEqual([])
  })
})

describe('which changes are edit rows', () => {
  test('an update in place with hunks, or a new file, at an absolute path', () => {
    expect(isEditable({ path: '/w/a.py', kind: { type: 'update', move_path: null }, diff: DIFF })).toBe(true)
    expect(isEditable({ path: '/w/a.py', kind: { type: 'add' }, diff: 'x' })).toBe(true)
  })

  test('not a move, a delete, a relative path, or an update without hunks', () => {
    expect(isEditable({ path: '/w/a.py', kind: { type: 'update', move_path: '/w/b.py' }, diff: DIFF })).toBe(false)
    expect(isEditable({ path: '/w/a.py', kind: { type: 'delete' }, diff: 'x' })).toBe(false)
    expect(isEditable({ path: 'a.py', kind: { type: 'add' }, diff: 'x' })).toBe(false)
    expect(isEditable({ path: '/w/a.py', kind: { type: 'update', move_path: null }, diff: 'x' })).toBe(false)
  })
})

describe('the row of an edit', () => {
  const update = { t: 'edit' as const, id: 'p1', path: '/w/cart.py', kind: 'update' as const, diff: DIFF }

  test('an update is an Edit of the old and the new text of its hunks', () => {
    expect(editCall(update)).toEqual({
      name: 'Edit',
      input: {
        file_path: '/w/cart.py',
        old_string: 'def total(prices, coupon):\n    prices = [p * (1 - coupon) for p in prices]\n    return sum(prices) * (1 - coupon)\n...\nx = 1',
        new_string: 'def total(prices, coupon):\n    return sum(prices) * (1 - coupon)\n...\nx = 2\ny = 3',
      },
    })
  })

  test("its result is the native Edit's, with the diff's hunks", () => {
    const result = editResult(update)
    expect(result.filePath).toBe('/w/cart.py')
    expect(result.structuredPatch).toEqual(hunksOf(DIFF))
    expect(result.originalFile).toBe(null)
  })

  test('a new file is a Write of its content, created', () => {
    const add = { t: 'edit' as const, id: 'p2', path: '/w/new.py', kind: 'add' as const, diff: 'x = 1\ny = 2' }
    expect(editCall(add)).toEqual({ name: 'Write', input: { file_path: '/w/new.py', content: 'x = 1\ny = 2' } })
    expect(editResult(add)).toEqual({
      type: 'create',
      filePath: '/w/new.py',
      content: 'x = 1\ny = 2',
      structuredPatch: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, lines: ['+x = 1', '+y = 2'] }],
      originalFile: null,
    })
  })
})
