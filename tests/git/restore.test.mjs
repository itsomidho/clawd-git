// Restore points against real git, in a temporary repository: the panel's own
// code (hooks/checkpoints.ts) with an engine whose processes and files are real.
//   node --import ./tests/git/loader.mjs --test tests/git/
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { listPoints, restorePoint, savePoint } from '../../hooks/checkpoints.ts'

const $ = {
  process: {
    run: async (argv, init = {}) => {
      const out = spawnSync(argv[0], argv.slice(1), { cwd: init.cwd, env: { ...process.env, ...(init.env ?? {}) }, input: init.stdin, encoding: 'utf8' })
      return { exitCode: out.status ?? 1, stdout: out.stdout ?? '', stderr: out.stderr ?? '' }
    },
  },
  fs: {
    stat: async path => statSync(path),
    exists: async path => existsSync(path),
    read: async path => readFileSync(path, 'utf8'),
    write: async (path, text) => writeFileSync(path, text),
  },
}

const roots = []
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }) })

const sh = (cwd, ...argv) => (spawnSync(argv[0], argv.slice(1), { cwd, encoding: 'utf8' }).stdout ?? '').trim()
const read = (root, path) => readFileSync(join(root, path), 'utf8')

// Two committed files, a staged change, a new file and an ignored one.
function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), 'clawd-git-restore-'))
  roots.push(root)
  sh(root, 'git', 'init', '-q', '-b', 'main')
  sh(root, 'git', 'config', 'user.email', 'test@example.com')
  sh(root, 'git', 'config', 'user.name', 'Test')
  writeFileSync(join(root, 'a.txt'), 'one\n')
  writeFileSync(join(root, 'b.txt'), 'bee\n')
  writeFileSync(join(root, 's.txt'), 'staged before\n')
  writeFileSync(join(root, '.gitignore'), '.env\n')
  sh(root, 'git', 'add', '-A')
  sh(root, 'git', 'commit', '-q', '-m', 'first')
  writeFileSync(join(root, 's.txt'), 'staged after\n')
  sh(root, 'git', 'add', 's.txt')
  writeFileSync(join(root, 'u.txt'), 'new, not tracked\n')
  writeFileSync(join(root, '.env'), 'SECRET=1\n')
  return root
}

// What Claude might do: edit, delete a tracked and a new file, make folders, touch an ignored file.
function claudeChanges(root) {
  writeFileSync(join(root, 'a.txt'), 'two\n')
  rmSync(join(root, 'b.txt'))
  rmSync(join(root, 'u.txt'))
  mkdirSync(join(root, 'new/dir'), { recursive: true })
  writeFileSync(join(root, 'new/dir/c.txt'), 'made by Claude\n')
  writeFileSync(join(root, '.env'), 'SECRET=2\n')
}

test('restore puts every file back; the index, the history, the branch and ignored files stay', async () => {
  const root = makeRepo()
  const head = sh(root, 'git', 'rev-parse', 'HEAD')
  const index = sh(root, 'git', 'ls-files', '-s')
  const saved = await savePoint($, root, 'Fix the cart', 'turn')
  assert.ok(saved.isNew)
  claudeChanges(root)

  const done = await restorePoint($, root, saved.point.ref)
  assert.equal(done.ok, true, done.text)
  assert.match(done.text, /Restored 4 files/)
  assert.equal(read(root, 'a.txt'), 'one\n')
  assert.equal(read(root, 'b.txt'), 'bee\n')
  assert.equal(read(root, 'u.txt'), 'new, not tracked\n')
  assert.equal(existsSync(join(root, 'new')), false, 'the folders Claude made are gone')
  assert.equal(read(root, '.env'), 'SECRET=2\n', 'ignored files are left alone')
  assert.equal(sh(root, 'git', 'ls-files', '-s'), index, 'the index is untouched')
  assert.equal(sh(root, 'git', 'diff', '--cached', '--name-only'), 's.txt')
  assert.equal(sh(root, 'git', 'rev-parse', 'HEAD'), head)
  assert.equal(sh(root, 'git', 'branch', '--list'), '* main')
})

test('the project repository gets nothing: no refs, no objects, nothing in git log --all', async () => {
  const root = makeRepo()
  const objects = () => sh(root, 'git', 'count-objects', '-v')
  const before = objects()
  const saved = await savePoint($, root, 'Fix the cart', 'turn')
  claudeChanges(root)
  await savePoint($, root, 'after', 'turn')
  await restorePoint($, root, saved.point.ref)
  assert.equal(objects(), before)
  assert.equal(sh(root, 'git', 'for-each-ref'), sh(root, 'git', 'for-each-ref', 'refs/heads'))
  assert.equal(sh(root, 'git', 'log', '--all', '--oneline').split('\n').length, 1)
  assert.equal(sh(root, 'git', 'stash', 'list'), '')
})

test('the files before a restore are a point of their own: restoring it undoes the restore', async () => {
  const root = makeRepo()
  const saved = await savePoint($, root, 'Fix the cart', 'turn')
  claudeChanges(root)
  await restorePoint($, root, saved.point.ref)
  const [undo] = await listPoints($, root)
  assert.equal(undo.kind, 'undo')
  assert.match(undo.label, /^before restoring to \d\d:\d\d$/)
  const done = await restorePoint($, root, undo.ref)
  assert.equal(done.ok, true, done.text)
  assert.equal(read(root, 'a.txt'), 'two\n')
  assert.equal(existsSync(join(root, 'b.txt')), false)
  assert.equal(existsSync(join(root, 'u.txt')), false)
  assert.equal(read(root, 'new/dir/c.txt'), 'made by Claude\n')
})

test('a restore with nothing changed does nothing', async () => {
  const root = makeRepo()
  const saved = await savePoint($, root, 'Fix the cart', 'turn')
  const done = await restorePoint($, root, saved.point.ref)
  assert.equal(done.ok, true)
  assert.match(done.text, /Nothing to restore/)
  assert.equal((await listPoints($, root)).length, 1, 'no undo point for a restore that did nothing')
})

test('the last 20 are kept; a turn over an unchanged tree takes the newest turn point; a save over it keeps it', async () => {
  const root = makeRepo()
  for (let i = 0; i < 22; i++) {
    writeFileSync(join(root, 'a.txt'), `turn ${i}\n`)
    await savePoint($, root, `turn ${i}`, 'turn')
  }
  let points = await listPoints($, root)
  assert.equal(points.length, 20)
  assert.equal(points[0].label, 'turn 21')
  assert.equal(points.at(-1).label, 'turn 2')
  await savePoint($, root, 'nothing changed', 'turn')
  points = await listPoints($, root)
  assert.equal(points.length, 20)
  assert.equal(points[0].label, 'nothing changed')
  const kept = await savePoint($, root, 'saved by you', 'manual')
  assert.equal(kept.isNew, false)
  assert.equal((await listPoints($, root))[0].label, 'nothing changed')
})

test('a point survives git gc, in the project and in the snapshot repository', async () => {
  const root = makeRepo()
  const saved = await savePoint($, root, 'Fix the cart', 'turn')
  claudeChanges(root)
  sh(root, 'git', 'gc', '--prune=now', '--quiet')
  spawnSync('git', ['gc', '--prune=now', '--quiet'], { env: { ...process.env, GIT_DIR: join(root, '.git/clawd-git/points.git') } })
  const done = await restorePoint($, root, saved.point.ref)
  assert.equal(done.ok, true, done.text)
  assert.equal(read(root, 'b.txt'), 'bee\n')
  assert.equal(read(root, 'u.txt'), 'new, not tracked\n')
})
