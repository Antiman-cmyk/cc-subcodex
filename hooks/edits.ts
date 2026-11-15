import type { Ev } from './types'

// Codex's file edits as the native Edit and Write rows: their input and the
// result the row shows, from Codex's own diff. The tools never run.

export type Edit = Extract<Ev, { t: 'edit' }>

/** One hunk of a unified diff, as the native tools' `structuredPatch` holds it. */
export type Hunk = { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }

const HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

/** The hunks of a unified diff without file headers; none where it has no hunk. */
export function hunksOf(diff: string): Hunk[] {
  const hunks: Hunk[] = []
  for (const line of diff.split('\n')) {
    const header = HEADER.exec(line)
    if (header !== null) {
      hunks.push({
        oldStart: Number(header[1]),
        oldLines: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newLines: header[4] === undefined ? 1 : Number(header[4]),
        lines: [],
      })
      continue
    }
    const hunk = hunks.at(-1)
    if (hunk !== undefined && /^[ +-]/.test(line)) hunk.lines.push(line)
  }
  return hunks
}

/** Whether a change of Codex's can be an edit row: an update of hunks in place, or a new file. */
export function isEditable(change: { path?: string; kind?: { type?: string; move_path?: string | null }; diff?: string }): boolean {
  if (change.path?.startsWith('/') !== true) return false
  if (change.kind?.type === 'add') return true
  return change.kind?.type === 'update' && (change.kind.move_path ?? null) === null && hunksOf(change.diff ?? '').length > 0
}

/** A new file's content: Codex's diff of it, or the text it gives. */
function contentOf(diff: string): string {
  const hunks = hunksOf(diff)
  return hunks.length === 0 ? diff : hunks.flatMap(hunk => hunk.lines.map(line => line.slice(1))).join('\n')
}

/** The row's tool and input: Write for a new file, else Edit with the hunks' old and new text. */
export function editCall(edit: Edit): { name: 'Edit' | 'Write'; input: Record<string, unknown> } {
  if (edit.kind === 'add') return { name: 'Write', input: { file_path: edit.path, content: contentOf(edit.diff) } }
  const sides = hunksOf(edit.diff).map(hunk => ({
    old: hunk.lines.filter(line => !line.startsWith('+')).map(line => line.slice(1)).join('\n'),
    new: hunk.lines.filter(line => !line.startsWith('-')).map(line => line.slice(1)).join('\n'),
  }))
  return {
    name: 'Edit',
    input: {
      file_path: edit.path,
      old_string: sides.map(side => side.old).join('\n...\n'),
      new_string: sides.map(side => side.new).join('\n...\n'),
    },
  }
}

/** The result the row shows, in the native tool's shape. */
export function editResult(edit: Edit): Record<string, unknown> {
  const call = editCall(edit)
  if (call.name === 'Write') {
    const content = String(call.input.content)
    const lines = content.split('\n')
    return {
      type: 'create',
      filePath: edit.path,
      content,
      structuredPatch: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, lines: lines.map(line => `+${line}`) }],
      originalFile: null,
    }
  }
  return {
    filePath: edit.path,
    oldString: call.input.old_string,
    newString: call.input.new_string,
    originalFile: null,
    structuredPatch: hunksOf(edit.diff),
    userModified: false,
    replaceAll: false,
  }
}
