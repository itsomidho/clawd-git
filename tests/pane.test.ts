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
function world(on: On, opts: { diff?: string } = {}) {
  on('session.cwd', () => ({ value: '/work/app' }))
  on('process.run', ($, e) => {
    const args = e.argv.join(' ')
    if (args.includes('rev-parse --show-toplevel')) return ok('/work/app\n')
    if (args.includes('status --porcelain')) return ok('## main...origin/main [ahead 1]\n M src/a.ts\n?? notes.md\n')
    if (args.includes('diff --cached --numstat')) return ok('')
    if (args.includes('diff --numstat')) return ok('2\t1\tsrc/a.ts\n')
    if (args.includes('diff --no-index')) return ok(NEW_FILE, 1)
    if (args.includes('diff HEAD')) return ok(opts.diff ?? DIFF)
    if (args.includes(' log ')) return ok('* \u001fabc1234\u001fHEAD -> main\u001fAdd a\u001fOmid\u001f1 hour ago\n* \u001fdef5678\u001f\u001fFirst\u001fOmid\u001f2 days ago\n')
    if (args.includes('ls-files')) return ok('src/a.ts\nsrc/b.ts\nREADME.md\nnotes.md\n')
    if (args.includes('check-ignore')) return ok('node_modules/\n')
    if (args.includes(' show ')) return ok(`abc1234full\u001fOmid\u001f1 hour ago\u001fAdd a\u001f\u001e\n${DIFF}`)
    return ok('')
  })
  on('fs.list', ($, e) => ({ value: e.path === '/work/app'
    ? [dir('.git'), dir('src'), dir('node_modules'), file('README.md'), file('notes.md'), file('a-really-long-file-name-that-runs-past-the-pane-edge.md')]
    : e.path === '/work/app/src' ? [file('a.ts'), file('b.ts')] : [] }))
  on('fs.stat', () => ({ value: { kind: 'file' as const, size: 8, mtimeMs: 1, isLink: false } }))
  on('fs.read', () => ({ value: 'one\ntwo\n' }))
  on('ui.panes', () => ({ value: [{ id: 'git', title: 'Git', isShown: true, isFocused: false, isPlaced: true }] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.scroll', () => ({}))
  on('clock.now', () => ({ value: 100_000 }))
  on('ui.render', ($, e) => h($.ui.resolve(e).Box, {}) as RenderElement)
}

// The side pane, the default placement.
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

// The band above the prompt, under placement: prompt.
const BAND = {
  component: 'AbovePrompt' as const,
  props: { hasSurvey: false, isWorking: false, maxRows: 40, bodyColumns: 70, scroll: { offset: 0, bodyRows: 39 }, view: {} },
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

    // Back returns to the Changes tab; "diff all" shows the tracked diff and the new file.
    await ui.press({ key: 'back' })
    expect(await ui.find({ key: 'chg:src/a.ts' })).toBeDefined()
    await ui.press({ key: 'all' })
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

test('the Files tab reads folders from disk and opens them on press', async ($, on) => {
  world(on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'clawd-git', surface, ...PANE })
    await ui.press({ key: 'tab:files' })

    expect(await ui.find({ key: 'dir:src' })).toBeDefined()
    expect(await ui.find({ key: 'dir:.git' })).toBe(undefined)
    expect(await ui.find({ key: 'dir:node_modules' })).toBeDefined()
    expect(await ui.find({ key: 'file:src/a.ts' })).toBe(undefined)
    // src holds a change, so it carries the dot.
    expect((await ui.find({ key: 'dir:src' }))?.text).toMatch(/src •\s*$/)

    await ui.press({ key: 'dir:src' })
    expect((await ui.find({ key: 'file:src/a.ts' }))?.text).toContain('M')
    expect(await ui.find({ key: 'file:src/b.ts' })).toBeDefined()

    // A file opens its diff; Back returns to the tree.
    await ui.press({ key: 'file:src/a.ts' })
    expect((await ui.find({ type: 'Code' }))?.props.format).toBe('diff')
    await ui.press({ key: 'back' })
    expect(await ui.find({ key: 'file:src/a.ts' })).toBeDefined()

    await ui.press({ key: 'dir:src' })
    expect(await ui.find({ key: 'file:src/a.ts' })).toBe(undefined)

    // Search lists matching files across the project; a hit opens its diff.
    await ui.press({ key: 'search' })
    await ui.input({ key: 'search-input', text: 'a.ts', kind: 'change' })
    expect(await ui.find({ key: 'found:src/a.ts' })).toBeDefined()
    expect(await ui.find({ key: 'found:README.md' })).toBe(undefined)
    await ui.press({ key: 'found:src/a.ts' })
    expect((await ui.find({ type: 'Code' }))?.props.format).toBe('diff')
    await ui.press({ key: 'back' })
    await ui.press({ key: 'search-close' })
    expect(await ui.find({ key: 'dir:src' })).toBeDefined()
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

test('rows are windowed under pinned tabs, and long code lines slide sideways', async ($, on) => {
  const long = 'x'.repeat(200)
  world(on, { diff: `diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,1 @@\n-old\n+${long}\n` })
  const small = { ...PANE, props: { ...PANE.props, bodyColumns: 50, scroll: { offset: 0, bodyRows: 11 } } }
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'clawd-git', surface, ...small })
    await ui.press({ key: 'tab:files' })
    await ui.press({ key: 'dir:src' })
    // 4 rows fit under the header frame: node_modules, src, src/a.ts, src/b.ts.
    expect(await ui.find({ key: 'dir:node_modules' })).toBeDefined()
    expect(await ui.find({ key: 'file:src/b.ts' })).toBeDefined()
    expect(await ui.find({ key: 'file:notes.md' })).toBe(undefined)
    // The tabs stay drawn above the window.
    expect(await ui.find({ key: 'tab:files' })).toBeDefined()

    await ui.press({ key: 'file:src/a.ts' })
    await ui.redraw({ ...small.props, scroll: { offset: 0, bodyRows: 21 } })
    const before = String((await ui.find({ type: 'Code' }))?.props.source)
    expect(before).toContain('+xxxx')
    await ui.press({ key: 'right' })
    const after = String((await ui.find({ type: 'Code' }))?.props.source)
    expect(after.split('\n').find(line => line.startsWith('+'))?.length).toBe(1 + 200 - 12)
    await ui.press({ key: 'left' })
    await ui.press({ key: 'back' })
    await ui.press({ key: 'dir:src' })
    await ui.unmount()
  }
})

test('any tab slides sideways when a row is wider than the pane', async ($, on) => {
  world(on)
  const narrow = { ...PANE, props: { ...PANE.props, bodyColumns: 36 } }
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'clawd-git', surface, ...narrow })
    await ui.press({ key: 'tab:files' })
    const key = 'file:a-really-long-file-name-that-runs-past-the-pane-edge.md'
    expect((await ui.find({ key }))?.text).toContain('a-really')
    expect(await ui.find({ key: 'right' })).toBeDefined()
    await ui.press({ key: 'right' })
    expect((await ui.find({ key }))?.text).not.toContain('a-really')
    expect((await ui.find({ key: 'right' }))?.text).toContain('col 13')
    await ui.press({ key: 'left' })
    expect((await ui.find({ key }))?.text).toContain('a-really')
    await ui.unmount()
  }
})

test('icons fall back to symbols every font has unless set to nerd', async ($, on) => {
  world(on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'clawd-git', surface, ...PANE })
    await ui.press({ key: 'tab:files' })
    const text = (await ui.find({ key: 'file:README.md' }))?.text ?? ''
    expect(text).toContain('●')
    // No private-use glyph (where Nerd Font icons live) anywhere in the row.
    expect(/[-]/.test(text)).toBe(false)
    await ui.unmount()
  }
})

test('icons set to nerd draw Nerd Font glyphs', { options: { icons: 'nerd' } }, async ($, on) => {
  world(on)
  const ui = await $.ui.mount({ plugin: 'clawd-git', surface: 'terminal', ...PANE })
  await ui.press({ key: 'tab:files' })
  expect((await ui.find({ key: 'file:README.md' }))?.text).toContain('')
  await ui.unmount()
})

test('icons set to outline draw line folders, pages and chevrons', { options: { icons: 'outline' } }, async ($, on) => {
  world(on)
  const ui = await $.ui.mount({ plugin: 'clawd-git', surface: 'terminal', ...PANE })
  await ui.press({ key: 'tab:files' })
  expect((await ui.find({ key: 'file:README.md' }))?.text).toContain('\u{1F5CB}')
  expect((await ui.find({ key: 'dir:src' }))?.text).toContain('› \u{1F5C0}')
  await ui.press({ key: 'dir:src' })
  expect((await ui.find({ key: 'dir:src' }))?.text).toContain('⌄ \u{1F5C1}')
  expect((await ui.find({ key: 'search' }))?.text).toContain('⌕')
  await ui.unmount()
})

test('icons set to line draw Codicons for folders, pages, tabs and toolbar', { options: { icons: 'line' } }, async ($, on) => {
  world(on)
  const ui = await $.ui.mount({ plugin: 'clawd-git', surface: 'terminal', ...PANE })
  await ui.press({ key: 'tab:files' })
  expect((await ui.find({ key: 'file:README.md' }))?.text).toContain('')
  expect((await ui.find({ key: 'dir:src' }))?.text).toContain(' ')
  // The lit tab carries the statusbar's diamond; the others their icons.
  expect((await ui.find({ key: 'tab:files' }))?.text).toContain('◆ Files')
  expect((await ui.find({ key: 'tab:changes' }))?.text).toContain('')
  expect((await ui.find({ key: 'search' }))?.text).toContain('')
  await ui.unmount()
})

test('above the prompt, /git-pane hides and shows the panel', { options: { placement: 'prompt' } }, async ($, on) => {
  world(on)
  const ui = await $.ui.mount({ plugin: 'clawd-git', surface: 'terminal', ...BAND })
  expect(await ui.find({ key: 'tab:files' })).toBeDefined()
  await $.command.run({ command: 'git-pane' } as never)
  await ui.redraw()
  expect(await ui.find({ key: 'tab:files' })).toBe(undefined)
  await $.command.run({ command: 'git-pane', args: 'changes' } as never)
  await ui.redraw()
  expect(await ui.find({ key: 'chg:src/a.ts' })).toBeDefined()
  await ui.unmount()
})
