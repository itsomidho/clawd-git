// Restore points: the working tree kept as it stood before Claude changed it,
// so one press puts every file back, whatever changed them (an edit, or a
// shell command: rm, mv, sed -i, an installer).
//
// A point is the tree `snapshotTree` writes (tracked and new files, ignored
// ones left out) wrapped in a commit and named by a ref under
// refs/clawd-git/checkpoints/ of the snapshot repository (.git/clawd-git/
// points.git, see sideOf): kept from git's cleanup by the ref, and nowhere in
// the project's own repository. The last KEEP are kept. Nothing here touches
// the project's history, branch or index; a restore writes the working tree only.

import { update } from 'claude-code'
import { atom } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { Checkpoint } from '../types'
import { isNew, sideGit, snapshotTree } from './shared'

const checkpoints = atom({ plugin: 'clawd-git', key: 'checkpoints' } as const, [])

export const KEEP = 20
const REFS = 'refs/clawd-git/checkpoints'
// commit-tree needs a name; the point is no one's commit.
const IDENTITY = {
  GIT_AUTHOR_NAME: 'clawd-git', GIT_AUTHOR_EMAIL: 'clawd-git@localhost',
  GIT_COMMITTER_NAME: 'clawd-git', GIT_COMMITTER_EMAIL: 'clawd-git@localhost',
}

type Meta = { at: number; label: string; kind: Checkpoint['kind'] }
type Point = Omit<Checkpoint, 'changed'>

// The points, newest first.
export async function listPoints($: EngineInterface, root: string): Promise<Point[]> {
  const out = await sideGit($, root, ['for-each-ref', '--sort=-refname', '--format=%(refname)%1f%(objectname)%1f%(tree)%1f%(contents:body)%1e', REFS])
  if (out.exitCode !== 0) return []
  return out.stdout.split('\u001e').map(one => one.trim()).filter(Boolean).flatMap(record => {
    const [ref = '', commit = '', tree = '', body = ''] = record.split('\u001f')
    try {
      const meta = JSON.parse(body.trim()) as Meta
      return [{ ref, commit, tree, at: Number(meta.at) || 0, label: String(meta.label ?? ''), kind: meta.kind ?? 'turn' }]
    } catch {
      return []
    }
  })
}

// The first line of a message, short enough for a row.
export function labelOf(text: string) {
  const line = text.trim().split('\n')[0]?.trim() ?? ''
  return line === '' ? 'a turn with no message' : line.length > 120 ? `${line.slice(0, 119)}…` : line
}

// Saves the tree (or the working tree now) as a point. A turn that begins
// where the newest turn point stands takes its place (same files, the newer
// message); a save or a restore over an unchanged tree keeps the one there.
export async function savePoint(
  $: EngineInterface, root: string, label: string, kind: Checkpoint['kind'], tree?: string,
): Promise<{ point?: Point; isNew: boolean }> {
  const t = tree ?? (await snapshotTree($, root))
  if (!t) return { isNew: false }
  const before = await listPoints($, root)
  const newest = before[0]
  if (newest && newest.tree === t) {
    if (!(kind === 'turn' && newest.kind === 'turn')) return { point: newest, isNew: false }
    await sideGit($, root, ['update-ref', '-d', newest.ref])
  }
  // Names sort by time: a later point never takes an earlier one's name.
  const at = Math.max(Date.now(), (newest?.at ?? 0) + 1)
  const meta: Meta = { at, label, kind }
  const made = await sideGit($, root, ['commit-tree', t, '-m', 'clawd-git restore point', '-m', JSON.stringify(meta)], { env: IDENTITY })
  if (made.exitCode !== 0) return { isNew: false }
  const commit = made.stdout.trim()
  const ref = `${REFS}/${String(at).padStart(14, '0')}`
  const named = await sideGit($, root, ['update-ref', ref, commit])
  if (named.exitCode !== 0) return { isNew: false }
  // Only the last KEEP stay.
  const all = await listPoints($, root)
  for (const old of all.slice(KEEP)) await sideGit($, root, ['update-ref', '-d', old.ref])
  return { point: { ref, commit, tree: t, ...meta }, isNew: true }
}

// The points with how many files differ from the working tree now, into state.
export async function readPoints($: EngineInterface, root: string) {
  const points = await listPoints($, root)
  const now = points.length > 0 ? await snapshotTree($, root) : undefined
  const next: Checkpoint[] = await Promise.all(points.map(async one => {
    if (!now) return { ...one, changed: 0 }
    const out = await sideGit($, root, ['diff', '--no-renames', '--name-only', one.tree, now])
    return { ...one, changed: out.stdout.split('\n').filter(Boolean).length }
  }))
  if (isNew('checkpoints', next)) await update($, checkpoints, () => next)
  return next
}

// When a point was taken, as a row shows it: the time today, else the day too.
export function whenOf(at: number, now = Date.now()) {
  const d = new Date(at)
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const today = new Date(now)
  const isToday = d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate()
  return isToday ? time : `${d.toLocaleString('en', { month: 'short' })} ${d.getDate()} ${time}`
}

// Puts the working tree back as it stood at the point: changed and deleted
// files come back, files made since are removed, ignored files, the index,
// the branch and the history are left alone. The present is saved first as a
// point of its own, so restoring that one undoes this.
export async function restorePoint($: EngineInterface, root: string, ref: string): Promise<{ ok: boolean; text: string }> {
  const point = (await listPoints($, root)).find(one => one.ref === ref)
  if (!point) return { ok: false, text: 'That restore point is gone.' }
  const now = await snapshotTree($, root)
  if (!now) return { ok: false, text: 'Could not read the working tree.' }
  if (now === point.tree) return { ok: true, text: 'Nothing to restore: the files are as they were then.' }
  const changed = (await sideGit($, root, ['diff', '--no-renames', '--name-only', point.tree, now])).stdout.split('\n').filter(Boolean)
  await savePoint($, root, `before restoring to ${whenOf(point.at)}`, 'undo', now)
  // Files made since the point: not in it, so restore leaves the untracked ones.
  const made = (await sideGit($, root, ['diff', '--no-renames', '--name-only', '--diff-filter=A', point.tree, now])).stdout.split('\n').filter(Boolean)
  // Through a copy of the project's index: "tracked" means what the project tracks.
  const back = await sideGit($, root, ['restore', `--source=${point.commit}`, '--worktree', '--', ':/'], { withIndex: true, timeoutMs: 120_000 })
  if (back.exitCode !== 0) return { ok: false, text: `git restore failed: ${back.stderr.trim().split('\n')[0] ?? ''}` }
  for (let i = 0; i < made.length; i += 200) {
    const some = made.slice(i, i + 200)
    await $.process.run(['rm', '-f', '--', ...some], { cwd: root, timeoutMs: 30_000 })
    // Folders the removed files leave empty go too.
    const dirs = [...new Set(some.filter(one => one.includes('/')).map(one => one.slice(0, one.lastIndexOf('/'))))]
    if (dirs.length > 0) await $.process.run(['rmdir', '-p', '--ignore-fail-on-non-empty', '--', ...dirs], { cwd: root, timeoutMs: 30_000 }).catch(() => undefined)
  }
  const after = await snapshotTree($, root)
  const n = changed.length
  return after === point.tree
    ? { ok: true, text: `Restored ${n} file${n === 1 ? '' : 's'} to ${whenOf(point.at)}. The files before it are a restore point too.` }
    : { ok: false, text: 'Restored, but some files still differ from the restore point (a file in use?).' }
}
