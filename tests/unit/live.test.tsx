import { expect, test } from 'claude-code/testing'

import { lastLines } from '../../hooks/live'

// The output of a running command of Codex's, drawn under its Bash row.

const ID = 'toolu_subcodex_abc123_turn0001_3_item7'
const rowOf = (tool: string, isRunning: boolean) =>
  ({
    plugin: 'subcodex',
    component: 'ToolUse',
    requestId: ID,
    props: { tool_use_id: ID, tool, input: { command: 'make' }, isRunning, isErrored: false, isInterrupted: false },
  }) as const

test('the last lines are drawn, without terminal control codes', () => {
  expect(lastLines('\u001b[32mok\u001b[0m 1\r\nok 2\nprogress 10%\rprogress 90%\n\n')).toEqual(['ok 1', 'ok 2', 'progress 10%', 'progress 90%'])
  expect(lastLines('1\n2\n3\n4\n5\n6\n7\n')).toEqual(['3', '4', '5', '6', '7'])
})

test('a running command shows its latest output under its row, on every surface', async ($, on) => {
  // Stands for the engine, drawing the row itself.
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>Bash(make)</Text>
  })
  // Stands for the session's state: the output kept so far.
  on('state.get', () => ({ value: { value: { [ID]: 'compiling a\ncompiling b\n' }, version: 1 } }))
  // A Bash row, or a PowerShell row as on Windows.
  for (const tool of ['Bash', 'PowerShell']) {
    for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
      const ui = await $.ui.mount({ ...rowOf(tool, true), surface })
      expect((await ui.find({ type: 'Text', text: /Bash\(make\)/ }))?.text).toBe('Bash(make)')
      expect((await ui.find({ type: 'Text', text: /compiling b/ }))?.text).toBe('compiling a\ncompiling b')
      await ui.unmount()
    }
  }
})

test('a command that has ended, or any other row, is drawn as the engine draws it', async ($, on) => {
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>the row</Text>
  })
  on('state.get', () => ({ value: { value: { [ID]: 'compiling a\n' }, version: 1 } }))
  for (const row of [rowOf('Bash', false), rowOf('Read', true)]) {
    const ui = await $.ui.mount({ ...row, surface: 'desktop' })
    expect(await ui.find({ type: 'Text', text: /compiling/ })).toBe(undefined)
    await ui.unmount()
  }
})

test('a running command with no output yet is the row alone', async ($, on) => {
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>the row</Text>
  })
  const ui = await $.ui.mount({ ...rowOf('Bash', true), surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /row/ }))?.text).toBe('the row')
  await ui.unmount()
})
