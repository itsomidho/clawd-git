import { expect, test } from 'claude-code/testing'

import { fsTreeRows, parseLog, parseNumstat, parseStatus, sortEntries, splitDiff } from '../hooks/git'
import { iconFor } from '../hooks/icons'

test('status: branch, ahead/behind, kinds and renames', async () => {
  const out = parseStatus([
    '## main...origin/main [ahead 2, behind 1]',
    ' M src/a.ts',
    'M  src/b.ts',
    'A  new.ts',
    ' D gone.ts',
    'R  old.ts -> moved.ts',
    '?? notes.md',
    'UU clash.ts',
    '',
  ].join('\n'))
  expect(out.branch).toBe('main')
  expect(out.ahead).toBe(2)
  expect(out.behind).toBe(1)
  expect(out.files.map(f => f.kind)).toEqual(['modified', 'modified', 'added', 'deleted', 'renamed', 'untracked', 'conflict'])
  expect(out.files[4]?.path).toBe('moved.ts')
  expect(out.files[4]?.from).toBe('old.ts')
})

test('status: a repository with no commits yet', async () => {
  expect(parseStatus('## No commits yet on main\n').branch).toBe('main')
})

test('numstat: counts, binary and renames', async () => {
  const out = parseNumstat('3\t1\tsrc/a.ts\n-\t-\tlogo.png\n2\t0\tsrc/{old => new}/c.ts\n')
  expect(out.get('src/a.ts')).toEqual({ added: 3, removed: 1 })
  expect(out.get('logo.png')).toEqual({ added: 0, removed: 0 })
  expect(out.get('src/new/c.ts')).toEqual({ added: 2, removed: 0 })
})

test('diff: one entry per file with its hunks alone', async () => {
  const files = splitDiff([
    'diff --git a/src/a.ts b/src/a.ts',
    'index 1..2 100644',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1,2 +1,2 @@',
    ' keep',
    '-old',
    '+new',
    'diff --git a/logo.png b/logo.png',
    'Binary files a/logo.png and b/logo.png differ',
    '',
  ].join('\n'))
  expect(files.length).toBe(2)
  expect(files[0]?.path).toBe('src/a.ts')
  expect(files[0]?.hunks.startsWith('@@ -1,2 +1,2 @@')).toBe(true)
  expect(files[0]?.added).toBe(1)
  expect(files[0]?.removed).toBe(1)
  expect(files[1]?.note).toBe('binary file')
})

test('log: graph rows with and without commits', async () => {
  const rows = parseLog('* \u001fabc1234\u001fHEAD -> main\u001fFix it\u001fOmid\u001f2 hours ago\n|\\\n')
  expect(rows[0]?.hash).toBe('abc1234')
  expect(rows[0]?.subject).toBe('Fix it')
  expect(rows[0]?.graph).toBe('*')
  expect(rows[1]?.hash).toBe(undefined)
})

test('tree: open folders show their entries, changes marked up the path', async () => {
  const listing = {
    '': sortEntries([
      { name: 'README.md', isDir: false, isIgnored: false },
      { name: 'src', isDir: true, isIgnored: false },
      { name: 'node_modules', isDir: true, isIgnored: true },
    ]),
    src: [{ name: 'a.ts', isDir: false, isIgnored: false }],
  }
  const closed = fsTreeRows(listing, [], new Set(['src/a.ts']))
  expect(closed.map(row => row.label)).toEqual(['node_modules', 'src', 'README.md'])
  expect(closed[1]?.isChanged).toBe(true)
  expect(closed[0]?.isIgnored).toBe(true)
  const open = fsTreeRows(listing, ['src', 'node_modules'], new Set(['src/a.ts']))
  expect(open.map(row => row.path)).toEqual(['node_modules', 'src', 'src/a.ts', 'README.md'])
  expect(open[0]?.isLoading).toBe(true)
  expect(open[2]?.isChanged).toBe(true)
})

test('icons: by name, by extension, folders and a fallback', async () => {
  expect(iconFor('package.json', false, false).glyph).toBe('')
  expect(iconFor('a.ts', false, false).glyph).toBe('')
  expect(iconFor('page.blade.php', false, false).glyph).toBe('')
  expect(iconFor('src', true, true).glyph).toBe('')
  expect(iconFor('src', true, false).glyph).toBe('')
  expect(iconFor('Makefile', false, false).glyph).toBe('')
  expect(iconFor('weird', false, false).glyph).toBe('')
})
