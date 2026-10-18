import { expect, test } from 'claude-code/testing'
import type { On, RenderElement } from 'claude-code'

const DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,2 +1,3 @@',
  ' keep',
  '-old',
  '+new',
  '+more',
  '',
].join('\n')

const NEW_FILE = [
  'diff --git a/notes.md b/notes.md',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/notes.md',
  '@@ -0,0 +1,2 @@',
  '+one',
  '+two',
  '',
].join('\n')

const dir = (name: string) => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 1, isLink: false })
const file = (name: string) => ({ name, kind: 'file' as const, size: 8, mtimeMs: 1, isLink: false })

function ok(stdout: string, exitCode = 0) {
  return { value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
}

// A fake repository at /work/app: one changed file, one new file, two commits.
function world(on: On) {
  on('session.cwd', () => ({ value: '/work/app' }))
  on('process.run', ($, e) => {
    const args = e.argv.join(' ')
    if (args.includes('rev-parse --show-toplevel')) return ok('/work/app\n')
    if (args.includes('status --porcelain')) return ok('## main...origin/main [ahead 1]\n M src/a.ts\n?? notes.md\n')
    if (args.includes('diff --cached --numstat')) return ok('')
    if (args.includes('diff --numstat')) return ok('2\t1\tsrc/a.ts\n')
    if (args.includes('diff --no-index')) return ok(NEW_FILE, 1)
    if (args.includes('diff HEAD')) return ok(DIFF)
    if (args.includes(' log ')) return ok('* \u001fabc1234\u001fHEAD -> main\u001fAdd a\u001fOmid\u001f1 hour ago\n* \u001fdef5678\u001f\u001fFirst\u001fOmid\u001f2 days ago\n')
    if (args.includes('ls-files')) return ok('src/a.ts\nsrc/b.ts\nREADME.md\nnotes.md\n')
    if (args.includes('check-ignore')) return ok('node_modules/\n')
    if (args.includes(' show ')) return ok(`abc1234full\u001fOmid\u001f1 hour ago\u001fAdd a\u001f\u001e\n${DIFF}`)
    return ok('')
  })
  on('fs.list', ($, e) => ({ value: e.path === '/work/app'
    ? [dir('.git'), dir('src'), dir('node_modules'), file('README.md'), file('notes.md')]
    : e.path === '/work/app/src' ? [file('a.ts'), file('b.ts')] : [] }))
  on('fs.stat', () => ({ value: { kind: 'file' as const, size: 8, mtimeMs: 1, isLink: false } }))
  on('fs.read', () => ({ value: 'one\ntwo\n' }))
  on('ui.panes', () => ({ value: [
    { id: 'git', title: 'Git', isShown: true, isFocused: false, isPlaced: true },
    { id: 'files', title: 'Files', isShown: true, isFocused: false, isPlaced: true },
  ] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.scroll', () => ({}))
  on('clock.now', () => ({ value: 100_000 }))
  on('ui.render', ($, e) => h($.ui.resolve(e).Box, {}) as RenderElement)
}

const PANE = {
  component: 'Pane' as const,
  requestId: 'git',
  props: {
    title: 'Git',
    isFocused: false,
    bodyColumns: 70,
    placement: 'dock' as const,
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
}

test('the pane walks through every tab on terminal and desktop', async ($, on) => {
  world(on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'clawd-git', surface, ...PANE })

    // Changes: the branch, both files and their counts.
    await ui.press({ key: 'tab:changes' })
    expect((await ui.find({ text: /main/ }))).toBeDefined()
    expect(await ui.find({ key: 'chg:src/a.ts' })).toBeDefined()
    expect(await ui.find({ key: 'chg:notes.md' })).toBeDefined()
    expect((await ui.find({ key: 'tab:changes' }))?.text).toContain('Changes 2')

    // A file opens its diff.
    await ui.press({ key: 'chg:src/a.ts' })
    const code = await ui.find({ type: 'Code' })
    expect(code?.props.format).toBe('diff')
    expect(String(code?.props.source)).toContain('+new')

    // Back to every change: the tracked diff and the new file.
    await ui.press({ key: 'back' })
    expect((await ui.findAll({ type: 'Code' })).length).toBe(2)

    // Commits: the graph, and a commit opens its diff.
    await ui.press({ key: 'tab:commits' })
    expect(await ui.find({ key: 'c:abc1234:0' })).toBeDefined()
    await ui.press({ key: 'c:abc1234:0' })
    expect((await ui.find({ text: /Add a/ }))).toBeDefined()
    expect(await ui.find({ type: 'Code' })).toBeDefined()

    // Plan: the placeholder.
    await ui.press({ key: 'tab:plan' })
    expect(await ui.find({ text: /No plan yet/ })).toBeDefined()

    await ui.press({ key: 'tab:changes' })
    await ui.unmount()
  }
})

test('the Files pane reads folders from disk and opens them on press', async ($, on) => {
  world(on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'clawd-git', surface, ...PANE, requestId: 'files', props: { ...PANE.props, title: 'Files' } })
    // A press on the Git pane's tab runs a refresh, which reads the Files pane too.
    await $.ui.mount({ plugin: 'clawd-git', surface, ...PANE }).then(git => git.press({ key: 'tab:changes' }))

    expect(await ui.find({ key: 'dir:src' })).toBeDefined()
    expect(await ui.find({ key: 'dir:.git' })).toBe(undefined)
    expect((await ui.find({ key: 'dir:node_modules' }))).toBeDefined()
    expect(await ui.find({ key: 'file:src/a.ts' })).toBe(undefined)
    // src holds a change, so it carries the dot.
    expect((await ui.find({ key: 'dir:src' }))?.text).toMatch(/src +•$/)

    await ui.press({ key: 'dir:src' })
    expect((await ui.find({ key: 'file:src/a.ts' }))?.text).toContain('M')
    expect(await ui.find({ key: 'file:src/b.ts' })).toBeDefined()

    await ui.press({ key: 'dir:src' })
    expect(await ui.find({ key: 'file:src/a.ts' })).toBe(undefined)
    await ui.unmount()
  }
})

const BOARD = {
  startedAt: 0,
  loose: 0,
  tasks: [
    { id: '1', subject: 'Read the API', activeForm: 'Reading the API', status: 'completed' as const, startedAt: 0, endedAt: 80_000,
      steps: [], dropped: 0, files: [], agents: 0 },
    { id: '2', subject: 'Write the pane', activeForm: 'Writing the pane', status: 'in_progress' as const, startedAt: 80_000,
      steps: [{ id: 's1', tool: 'Edit', label: 'src/a.ts', startedAt: 90_000, endedAt: 92_000 },
              { id: 's2', tool: 'Bash', label: 'npm test', startedAt: 95_000 }],
      dropped: 0, files: [{ path: 'src/a.ts', added: 2, removed: 1 }], agents: 0 },
    { id: '3', subject: 'Ship it', activeForm: 'Shipping it', status: 'pending' as const, steps: [], dropped: 0, files: [], agents: 0 },
  ],
}

test('the Plan tab draws the clawd-tasks board live', async ($, on) => {
  world(on)
  on('state.get', ($, e, next) => (e.plugin === 'clawd-tasks' && e.key === 'board'
    ? { value: { value: BOARD, version: 1 } }
    : next(e)) as never)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'clawd-git', surface, ...PANE })
    expect((await ui.find({ key: 'tab:plan' }))?.text).toContain('Plan 1/3')
    await ui.press({ key: 'tab:plan' })
    expect(await ui.find({ text: /1\/3 done/ })).toBeDefined()
    // The running task shows its active form, its steps and its files.
    expect((await ui.find({ key: 't:2' }))?.text).toContain('Writing the pane')
    expect(await ui.find({ text: /npm test/ })).toBeDefined()
    expect(await ui.find({ key: 'f:2:src/a.ts' })).toBeDefined()
    // A finished task stays closed; the pending one too.
    expect((await ui.find({ key: 't:1' }))?.text).toContain('1m 20s')
    // A file of the task opens its diff.
    await ui.press({ key: 'f:2:src/a.ts' })
    expect((await ui.find({ type: 'Code' }))?.props.format).toBe('diff')
    await ui.press({ key: 'tab:changes' })
    await ui.unmount()
  }
})
