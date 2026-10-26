import { expect, mock, test } from 'claude-code/testing'
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

// What the panel asked of the world: git commands, their input, prompts.
type Seen = { argv: string[][]; stdin: (string | undefined)[]; prompts: string[] }

// A fake repository at /work/app: one changed file, one new file, two commits.
function world(on: On, opts: { diff?: string; status?: string; staged?: string; isOwnClock?: boolean; rootFile?: string } = {}): Seen {
  const seen: Seen = { argv: [], stdin: [], prompts: [] }
  let trees = 0
  on('session.cwd', () => ({ value: '/work/app' }))
  on('prompt.submit', ($, e) => { seen.prompts.push(e.text); return { text: e.text } as never })
  on('model.complete', () => ({ value: { isAnswered: true, text: 'Add the a module', usage: {} } }) as never)
  on('tool.call', () => ({ result: {}, text: 'done' }) as never)
  on('process.run', ($, e) => {
    seen.argv.push([...e.argv])
    seen.stdin.push(e.init?.stdin)
    const args = e.argv.join(' ')
    // Snapshots of the working tree: each write-tree a new tree.
    if (args.includes('rev-parse --absolute-git-dir')) return ok('/work/app/.git\n')
    if (e.argv[1] === 'write-tree') return ok(`tree${++trees}\n`)
    if (args.includes('diff --name-only tree')) return ok('src/a.ts\n')
    if (args.includes('diff --no-ext-diff tree')) return ok(DIFF)
    if (e.argv[0] === 'which') return ok(e.argv[1] === 'code' ? '/usr/bin/code\n' : '', e.argv[1] === 'code' ? 0 : 1)
    if (args.includes('rev-parse --show-toplevel')) return ok('/work/app\n')
    if (args.includes('status --porcelain')) return ok(opts.status ?? '## main...origin/main [ahead 1]\n M src/a.ts\n?? notes.md\n')
    if (args.includes('diff --cached --numstat')) return ok(opts.staged ?? '')
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
    ? [dir('.git'), dir('src'), dir('node_modules'), file('README.md'), file('notes.md'), file('a-really-long-file-name-that-runs-past-the-pane-edge.md'), ...(opts.rootFile ? [file(opts.rootFile)] : [])]
    : e.path === '/work/app/src' ? [file('a.ts'), file('b.ts')] : [] }))
  on('fs.stat', () => ({ value: { kind: 'file' as const, size: 8, mtimeMs: 1, isLink: false } }))
  on('fs.read', () => ({ value: 'one\ntwo\n' }))
  on('ui.panes', () => ({ value: [{ id: 'git', title: 'Git', isShown: true, isFocused: false, isPlaced: true }] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.scroll', () => ({}))
  if (!opts.isOwnClock) on('clock.now', () => ({ value: 100_000 }))
  on('ui.render', ($, e) => h($.ui.resolve(e).Box, {}) as RenderElement)
  return seen
}

// Whether a git command was run, by its words after `git -c ... -c ...`.
function ran(seen: Seen, words: string) {
  return seen.argv.some(argv => argv[0] === 'git' && argv.join(' ').includes(words))
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

    // Three tabs: no Plan (clawd-tasks shows the plan under the prompt).
    expect(await ui.find({ key: 'tab:plan' })).toBe(undefined)

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

test('files Claude edits are marked, and Changes can list only those', async ($, on) => {
  world(on)
  const ui = await $.ui.mount({ plugin: 'clawd-git', surface: 'terminal', ...PANE })
  await ui.press({ key: 'tab:changes' })
  expect(await ui.find({ key: 'session' })).toBe(undefined)
  await $.tool.call({ tool: 'Edit', file_path: '/work/app/src/a.ts', old_string: 'old', new_string: 'new' } as never)
  await ui.press({ key: 'tab:changes' })
  expect((await ui.find({ key: 'chg:src/a.ts' }))?.text).toContain('\u2726')
  expect((await ui.find({ key: 'chg:notes.md' }))?.text).not.toContain('\u2726')
  expect((await ui.find({ key: 'session' }))?.text).toContain('By Claude 1')
  await ui.press({ key: 'session' })
  expect(await ui.find({ key: 'chg:src/a.ts' })).toBeDefined()
  expect(await ui.find({ key: 'chg:notes.md' })).toBe(undefined)
  await ui.press({ key: 'session' })
  expect(await ui.find({ key: 'chg:notes.md' })).toBeDefined()
  await ui.unmount()
})

test('stage, unstage, and discard after a confirmation', async ($, on) => {
  const seen = world(on, { status: '## main\nMM src/a.ts\n?? notes.md\n', staged: '1\t0\tsrc/a.ts\n' })
  const ui = await $.ui.mount({ plugin: 'clawd-git', surface: 'terminal', ...PANE })
  await ui.press({ key: 'tab:changes' })
  await ui.press({ key: 'stage:notes.md' })
  expect(ran(seen, 'add -- notes.md')).toBe(true)
  await ui.press({ key: 'unstage:src/a.ts' })
  expect(ran(seen, 'restore --staged -- src/a.ts')).toBe(true)
  await ui.press({ key: 'gact:New' })
  expect(ran(seen, 'add -- notes.md')).toBe(true)
  // Discard asks first, and does nothing on Cancel.
  await ui.press({ key: 'discard:src/a.ts' })
  expect(await ui.find({ key: 'confirm-yes' })).toBeDefined()
  await ui.press({ key: 'confirm-no' })
  expect(ran(seen, 'restore --staged --worktree')).toBe(false)
  await ui.press({ key: 'discard:src/a.ts' })
  await ui.press({ key: 'confirm-yes' })
  expect(ran(seen, 'restore --staged --worktree --source=HEAD -- src/a.ts')).toBe(true)
  // A new file is deleted with git clean.
  await ui.press({ key: 'discard:notes.md' })
  await ui.press({ key: 'confirm-yes' })
  expect(ran(seen, 'clean -f -q -- notes.md')).toBe(true)
  await ui.unmount()
})

test('a diff asks Claude to review it; a commit asks Claude to explain it', async ($, on) => {
  const seen = world(on)
  const ui = await $.ui.mount({ plugin: 'clawd-git', surface: 'terminal', ...PANE })
  await ui.press({ key: 'tab:changes' })
  await ui.press({ key: 'chg:src/a.ts' })
  await ui.press({ key: 'review' })
  expect(seen.prompts[0]).toContain('Review the uncommitted changes in `src/a.ts`')
  await ui.press({ key: 'tab:commits' })
  await ui.press({ key: 'c:abc1234:0' })
  expect((await ui.find({ key: 'review' }))?.text).toContain('Explain')
  await ui.press({ key: 'review' })
  expect(seen.prompts[1]).toContain('Explain commit abc1234')
  await ui.unmount()
})

test('a commit message is drafted for what is staged, and committed', async ($, on) => {
  const seen = world(on, { status: '## main\nM  src/a.ts\n', staged: '2\t1\tsrc/a.ts\n' })
  const ui = await $.ui.mount({ plugin: 'clawd-git', surface: 'terminal', ...PANE })
  await ui.press({ key: 'tab:changes' })
  await ui.press({ key: 'commit' })
  expect(await ui.find({ text: /Add the a module/ })).toBeDefined()
  await ui.press({ key: 'draft-commit' })
  const at = seen.argv.findIndex(argv => argv.join(' ').includes('commit -q -F -'))
  expect(at >= 0).toBe(true)
  expect(seen.stdin[at]).toBe('Add the a module\n')
  expect(await ui.find({ key: 'draft-commit' })).toBe(undefined)
  await ui.unmount()
})

test('a file opens in the editor at its first changed line', async ($, on) => {
  const seen = world(on)
  const ui = await $.ui.mount({ plugin: 'clawd-git', surface: 'terminal', ...PANE })
  await ui.press({ key: 'tab:changes' })
  await ui.press({ key: 'chg:src/a.ts' })
  await ui.press({ key: 'edit' })
  expect(seen.argv.some(argv => argv.join(' ') === 'code -g /work/app/src/a.ts:1')).toBe(true)
  await ui.unmount()
})

// clawd-debug loaded: its /dbg command is listed, and runs are recorded.
function withDebugger(on: On) {
  const commands: { command: string; args?: string }[] = []
  on('command.list', () => ({ value: [{ name: 'dbg', description: 'Step debugger', source: 'plugin' }] }) as never)
  on('command.run', ($, e) => { commands.push({ command: e.command, args: e.args }); return { text: 'ok' } as never })
  return commands
}

test('with clawd-debug loaded, Debug on a file view opens it in the debugger', async ($, on) => {
  world(on, { status: '## main\n M src/a.php\n' })
  const commands = withDebugger(on)
  const ui = await $.ui.mount({ plugin: 'clawd-git', surface: 'terminal', ...PANE })
  await ui.press({ key: 'tab:changes' })
  await ui.press({ key: 'chg:src/a.php' })
  await ui.press({ key: 'debug' })
  expect(commands).toEqual([{ command: 'dbg', args: '/work/app/src/a.php' }])
  await ui.unmount()
})

test('with clawd-debug loaded, debuggable rows in Files and Changes get a ▷', async ($, on) => {
  world(on, { status: '## main\n M src/a.php\n M src/a.ts\n', rootFile: 'tool.py' })
  const commands = withDebugger(on)
  const ui = await $.ui.mount({ plugin: 'clawd-git', surface: 'terminal', ...PANE })
  // Files: tool.py has one, README.md has none.
  await ui.press({ key: 'tab:files' })
  expect(await ui.find({ key: 'debug:README.md' })).toBeUndefined()
  await ui.press({ key: 'debug:tool.py' })
  // Changes: the PHP file has one, the TypeScript file none.
  await ui.press({ key: 'tab:changes' })
  expect(await ui.find({ key: 'debug:src/a.ts' })).toBeUndefined()
  await ui.press({ key: 'debug:src/a.php' })
  expect(commands).toEqual([
    { command: 'dbg', args: '/work/app/tool.py' },
    { command: 'dbg', args: '/work/app/src/a.php' },
  ])
  await ui.unmount()
})

test('without clawd-debug, files have no debug buttons', async ($, on) => {
  world(on, { status: '## main\n M src/a.php\n' })
  on('command.list', () => ({ value: [] }) as never)
  const ui = await $.ui.mount({ plugin: 'clawd-git', surface: 'terminal', ...PANE })
  await ui.press({ key: 'tab:changes' })
  expect(await ui.find({ key: 'debug:src/a.php' })).toBeUndefined()
  await ui.press({ key: 'chg:src/a.php' })
  expect(await ui.find({ key: 'debug' })).toBeUndefined()
  expect(await ui.find({ key: 'edit' })).toBeDefined()
  await ui.unmount()
})

test('an editor command from the setting takes {file} and {line}', { options: { editor: 'myedit --at {line} {file}' } }, async ($, on) => {
  const seen = world(on)
  const ui = await $.ui.mount({ plugin: 'clawd-git', surface: 'terminal', ...PANE })
  await ui.press({ key: 'tab:changes' })
  await ui.press({ key: 'chg:src/a.ts' })
  await ui.press({ key: 'edit' })
  expect(seen.argv.some(argv => argv.join(' ') === 'myedit --at 1 /work/app/src/a.ts')).toBe(true)
  await ui.unmount()
})


test('a Plan tab left open by 0.2 falls back to Files', async ($, on) => {
  world(on)
  on('state.get', ($, e, next) => (e.plugin === 'clawd-git' && e.key === 'tab'
    ? { value: { value: 'plan', version: 1 } }
    : next(e)) as never)
  const ui = await $.ui.mount({ plugin: 'clawd-git', surface: 'terminal', ...PANE })
  expect((await ui.find({ key: 'tab:files' }))?.text).toContain('◆ Files')
  await ui.unmount()
})

test('a note on a diff line goes to Claude with its file, line and code', async ($, on) => {
  const seen = world(on)
  const ui = await $.ui.mount({ plugin: 'clawd-git', surface: 'terminal', ...PANE })
  await ui.press({ key: 'tab:changes' })
  await ui.press({ key: 'chg:src/a.ts' })
  // The + beside "+new" (the hunk header is row 0, then keep, old, new).
  await ui.press({ key: 'note:dl:0:3' })
  expect(await ui.find({ key: 'note-input' })).toBeDefined()
  await ui.input({ key: 'note-input', text: 'handle an empty cart' })
  expect(await ui.find({ key: 'note-input' })).toBe(undefined)
  expect(await ui.find({ text: /handle an empty cart/ })).toBeDefined()
  // The line now shows it has a note; the toolbar offers to send.
  expect((await ui.find({ key: 'note:dl:0:3' }))?.text).toContain('\u270e')
  expect((await ui.find({ key: 'send-review' }))?.text).toContain('Send review 1')
  // Changes lists it too.
  await ui.press({ key: 'back' })
  expect(await ui.find({ key: 'notes-send' })).toBeDefined()
  await ui.press({ key: 'notes-send' })
  expect(seen.prompts[0]).toContain('`src/a.ts:2`')
  expect(seen.prompts[0]).toContain('> new')
  expect(seen.prompts[0]).toContain('handle an empty cart')
  expect(await ui.find({ key: 'notes-send' })).toBe(undefined)
  await ui.unmount()
})

test('this turn shows what changed since the turn began', async ($, on) => {
  world(on)
  on('turn.start', ($, e) => ({ turnId: e.turnId }) as never)
  const ui = await $.ui.mount({ plugin: 'clawd-git', surface: 'terminal', ...PANE })
  await ui.press({ key: 'tab:changes' })
  expect(await ui.find({ key: 'turn' })).toBe(undefined)
  await $.turn.start({ text: 'Fix the cart', turnId: 't1' } as never)
  // Shown as soon as a turn has begun, with no count while nothing changed.
  await ui.press({ key: 'tab:changes' })
  expect((await ui.find({ key: 'turn' }))?.text).toMatch(/This turn\s*$/)
  await $.tool.call({ tool: 'Edit', file_path: '/work/app/src/a.ts', old_string: 'old', new_string: 'new' } as never)
  await ui.press({ key: 'tab:changes' })
  expect((await ui.find({ key: 'turn' }))?.text).toContain('This turn 1')
  await ui.press({ key: 'turn' })
  expect(await ui.find({ text: /1 file changed since your last message/ })).toBeDefined()
  expect(String((await ui.find({ type: 'Code' }))?.props.source)).toContain('+new')
  await ui.unmount()
})

test('a /clear starts the panel over: "This turn" is gone and git is read again', async ($, on) => {
  const seen = world(on, { isOwnClock: true })
  const clock = mock.clock(on)
  let id = 's1'
  on('session.id', () => ({ value: id }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }) as never)
  on('turn.start', ($, e) => ({ turnId: e.turnId }) as never)
  const ui = await $.ui.mount({ plugin: 'clawd-git', surface: 'terminal', ...PANE })
  await $.turn.start({ text: 'Fix the cart', turnId: 't1' } as never)
  await ui.press({ key: 'tab:changes' })
  expect(await ui.find({ key: 'turn' })).toBeDefined()

  // /clear: the session ends, the process goes on under a new id, no session.start.
  id = 's2'
  const before = seen.argv.length
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: {} } as never)
  await clock.advance(500)
  expect(seen.argv.slice(before).some(argv => argv.join(' ').includes('status --porcelain'))).toBe(true)
  await ui.press({ key: 'tab:changes' })
  expect(await ui.find({ key: 'turn' })).toBe(undefined)
  expect(await ui.find({ key: 'chg:src/a.ts' })).toBeDefined()
  await ui.unmount()
})
