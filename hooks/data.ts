// Reading git and the disk into the panel's state. A tick first asks git for
// its status alone; only when that, HEAD or the index moved (or every few
// ticks, or when asked) does it read the counts, the log, the folders and the
// open diff, so a quiet repository costs one `git status` per tick.

import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { Change, Entry, FileDiff, Repo, Shown, View } from '../types'
import { LOG_FORMAT, SEP, parseLog, parseNumstat, parseStatus, sortEntries, splitDiff } from './git'
import { iconSetFor } from './icons'
import type { IconMode } from './icons'
import {
  DIFF_CHARS, DIR_ENTRIES, EMPTY_REPO, EMPTY_SHOWN, FULL_EVERY, LOG_LIMIT, PANE, SOURCE_LINES, UNTRACKED_IN_DIFF,
  ctx, describe, git, isNew, viewKey,
} from './shared'

const isShown = atom({ plugin: 'clawd-git', key: 'isShown' } as const, true)
const tab = atom({ plugin: 'clawd-git', key: 'tab' } as const, 'files')
const repo = atom({ plugin: 'clawd-git', key: 'repo' } as const, EMPTY_REPO)
const view = atom({ plugin: 'clawd-git', key: 'view' } as const, { kind: 'all' })
const shown = atom({ plugin: 'clawd-git', key: 'shown' } as const, EMPTY_SHOWN)
const log = atom({ plugin: 'clawd-git', key: 'log' } as const, [])
const listing = atom({ plugin: 'clawd-git', key: 'listing' } as const, {})
const filesRoot = atom({ plugin: 'clawd-git', key: 'filesRoot' } as const, '')
const openDirs = atom({ plugin: 'clawd-git', key: 'openDirs' } as const, [])
const turnBase = atom({ plugin: 'clawd-git', key: 'turnBase' } as const, null)
const turnFiles = atom({ plugin: 'clawd-git', key: 'turnFiles' } as const, [])

// Whether the panel is on screen: the side pane shown, or the band's panel up.
export async function isAnyPaneShown($: EngineInterface) {
  if (ctx.config.placement === 'prompt') return read($, isShown)
  const panes = await $.ui.panes().catch(() => [])
  return panes.some(pane => pane.id === PANE && pane.isShown && pane.isPlaced)
}

// ---------------------------------------------------------------- the repository

async function topOf($: EngineInterface): Promise<string> {
  const cwd = await $.session.cwd()
  const top = await git($, cwd, ['rev-parse', '--show-toplevel']).catch(() => undefined)
  return top && top.exitCode === 0 ? top.stdout.trim() : ''
}

// What says the repository moved: the status, and the times of HEAD and the
// index (a commit, a checkout, a stage leave the status alone sometimes).
async function signatureOf($: EngineInterface, root: string): Promise<{ status: string; signature: string } | undefined> {
  const [status, head, index] = await Promise.all([
    git($, root, ['status', '--porcelain=v1', '-b', '--untracked-files=all']).catch(() => undefined),
    $.fs.stat(`${root}/.git/HEAD`).catch(() => undefined),
    $.fs.stat(`${root}/.git/index`).catch(() => undefined),
  ])
  if (!status || status.exitCode !== 0) return undefined
  return { status: status.stdout, signature: `${status.stdout}|${head?.mtimeMs ?? 0}|${index?.mtimeMs ?? 0}` }
}

export async function readRepo($: EngineInterface, root: string, status: string): Promise<Repo> {
  const [unstaged, staged] = await Promise.all([
    git($, root, ['diff', '--numstat']),
    git($, root, ['diff', '--cached', '--numstat']),
  ])
  const parsed = parseStatus(status)
  const counts = [parseNumstat(unstaged.stdout), parseNumstat(staged.stdout)]
  const files = await Promise.all(parsed.files.map(async (one): Promise<Change> => {
    let added = 0
    let removed = 0
    for (const map of counts) {
      const n = map.get(one.path)
      if (n) { added += n.added; removed += n.removed }
    }
    if (one.kind === 'untracked') added = await linesOf($, `${root}/${one.path}`)
    return { ...one, added, removed }
  }))
  return { root, branch: parsed.branch, ahead: parsed.ahead, behind: parsed.behind, files }
}

// An untracked file's line count, kept until its size or time changes.
const lineCache = new Map<string, { stamp: string; lines: number }>()
async function linesOf($: EngineInterface, path: string): Promise<number> {
  const stat = await $.fs.stat(path).catch(() => undefined)
  if (!stat || stat.kind !== 'file' || stat.size > 1_000_000) return 0
  const stamp = `${stat.size}:${stat.mtimeMs}`
  const kept = lineCache.get(path)
  if (kept?.stamp === stamp) return kept.lines
  const text = await $.fs.read(path).catch(() => '')
  const lines = text.includes('\u0000') ? 0 : text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
  lineCache.set(path, { stamp, lines })
  return lines
}

// ---------------------------------------------------------------- snapshots

// The repository's top folder, or '' outside one.
export async function repoRoot($: EngineInterface): Promise<string> {
  return topOf($)
}

// The working tree as it stands, as a git tree object: tracked and new files,
// ignored ones left out. Written through a copy of the index, so git's own
// index, the files and the history are untouched; a copy keeps git's stat
// cache, so only files changed since the last `git add` are read.
let snapshots = 0
export async function snapshotTree($: EngineInterface, root: string): Promise<string | undefined> {
  const dir = await git($, root, ['rev-parse', '--absolute-git-dir']).catch(() => undefined)
  if (!dir || dir.exitCode !== 0) return undefined
  const gitDir = dir.stdout.trim()
  const index = `${gitDir}/clawd-git-snapshot-${++snapshots}.index`
  try {
    const hasIndex = await $.fs.stat(`${gitDir}/index`).then(() => true).catch(() => false)
    if (hasIndex) await $.process.run(['cp', `${gitDir}/index`, index], { timeoutMs: 15_000 })
    const env = { GIT_INDEX_FILE: index }
    const add = await $.process.run(['git', 'add', '-A'], { cwd: root, env, timeoutMs: 120_000 })
    if (add.exitCode !== 0) return undefined
    const tree = await $.process.run(['git', 'write-tree'], { cwd: root, env, timeoutMs: 30_000 })
    return tree.exitCode === 0 ? tree.stdout.trim() : undefined
  } catch {
    return undefined
  } finally {
    await $.process.run(['rm', '-f', index], { timeoutMs: 5000 }).catch(() => undefined)
  }
}

// A new turn of Claude's begins: remember the tree as it stands.
export async function startTurn($: EngineInterface, turnId: string) {
  const root = await topOf($)
  if (root === '') return
  const tree = await snapshotTree($, root)
  if (!tree) return
  const at = await $.clock.now()
  await update($, turnBase, () => ({ tree, turnId, at }))
  await update($, turnFiles, () => [])
}

// The files this turn has changed so far: the start's tree against now's.
export async function updateTurnFiles($: EngineInterface) {
  const base = await read($, turnBase)
  const root = await topOf($)
  if (!base || root === '') return
  const now = await snapshotTree($, root)
  if (!now) return
  const out = await git($, root, ['diff', '--name-only', base.tree, now]).catch(() => undefined)
  const files = (out?.stdout ?? '').split('\n').filter(Boolean)
  if (isNew('turnFiles', files)) await update($, turnFiles, () => files)
}

// ---------------------------------------------------------------- diffs

export async function workingDiff($: EngineInterface, root: string, path?: string): Promise<string> {
  const only = path === undefined ? [] : ['--', path]
  const head = await git($, root, ['diff', 'HEAD', '--no-ext-diff', ...only])
  if (head.exitCode === 0) return head.stdout
  // No commit yet: staged against the empty tree, then unstaged.
  const [staged, unstaged] = await Promise.all([
    git($, root, ['diff', '--cached', '--no-ext-diff', ...only]),
    git($, root, ['diff', '--no-ext-diff', ...only]),
  ])
  return staged.stdout + unstaged.stdout
}

async function untrackedDiff($: EngineInterface, root: string, path: string): Promise<string> {
  // Exit 1 means "files differ", which is what we asked for.
  const out = await git($, root, ['diff', '--no-index', '--no-ext-diff', '--', '/dev/null', path]).catch(() => undefined)
  return out?.stdout ?? ''
}

function capDiffs(diffs: FileDiff[]): { diffs: FileDiff[]; isCut: boolean } {
  let room = DIFF_CHARS
  const out: FileDiff[] = []
  for (const one of diffs) {
    if (room <= 0) return { diffs: out, isCut: true }
    if (one.hunks.length > room) {
      // Cut on a hunk boundary so the diff still parses.
      const hunks = one.hunks.split(/\n(?=@@ )/)
      let kept = ''
      for (const hunk of hunks) {
        if (kept.length + hunk.length + 1 > room) break
        kept += (kept === '' ? '' : '\n') + hunk
      }
      out.push({ ...one, hunks: kept, note: kept === '' ? 'too large to show' : 'cut: too large to show whole' })
      return { diffs: out, isCut: true }
    }
    room -= one.hunks.length
    out.push(one)
  }
  return { diffs: out, isCut: false }
}

async function readShown($: EngineInterface, state: Repo, one: View): Promise<Shown> {
  const of = viewKey(one)
  const root = state.root
  if (root === '') return { ...EMPTY_SHOWN, of }
  if (one.kind === 'turn') {
    const base = await read($, turnBase)
    if (!base) return { ...EMPTY_SHOWN, of, title: 'This turn', detail: 'No turn has started since the panel loaded.' }
    const now = await snapshotTree($, root)
    if (!now) return { ...EMPTY_SHOWN, of, title: 'This turn', detail: 'Could not read the working tree.' }
    const out = await git($, root, ['diff', '--no-ext-diff', base.tree, now])
    const capped = capDiffs(splitDiff(out.stdout))
    const n = capped.diffs.length
    return {
      of,
      title: 'This turn',
      detail: n === 0 ? 'Nothing changed since your last message.' : `${n} file${n === 1 ? '' : 's'} changed since your last message`,
      ...capped,
    }
  }
  if (one.kind === 'commit') {
    const out = await git($, root, ['show', '--no-ext-diff', '--format=%H%x1f%an%x1f%ar%x1f%s%x1f%b%x1e', one.hash])
    if (out.exitCode !== 0) return { ...EMPTY_SHOWN, of, title: one.hash, detail: out.stderr.trim() }
    const end = out.stdout.indexOf('\u001e')
    const [hash = one.hash, author = '', age = '', subject = '', body = ''] = out.stdout.slice(0, end).split(SEP)
    const capped = capDiffs(splitDiff(out.stdout.slice(end + 1)))
    return { of, title: `${hash.slice(0, 10)}  ${subject}`, detail: `${author} · ${age}${body.trim() ? '\n' + body.trim() : ''}`, ...capped }
  }
  if (one.kind === 'file') {
    const change = state.files.find(file => file.path === one.path)
    if (change) {
      const text = change.kind === 'untracked' ? await untrackedDiff($, root, one.path) : await workingDiff($, root, one.path)
      return { of, title: one.path, detail: describe(change), ...capDiffs(splitDiff(text)) }
    }
    // An unchanged file: its contents.
    const text = await $.fs.read(`${root}/${one.path}`).catch(() => undefined)
    if (text === undefined) return { ...EMPTY_SHOWN, of, title: one.path, detail: 'Could not read this file.' }
    if (text.includes('\u0000')) return { ...EMPTY_SHOWN, of, title: one.path, detail: 'Binary file.' }
    const lines = text.split('\n')
    let kept = lines.slice(0, SOURCE_LINES).join('\n')
    let isCut = lines.length > SOURCE_LINES
    if (kept.length > DIFF_CHARS) { kept = kept.slice(0, DIFF_CHARS); isCut = true }
    return { of, title: one.path, detail: 'No changes', diffs: [], source: { path: one.path, text: kept.replace(/\r/g, ''), isCut }, isCut }
  }
  // Every change: tracked files in one diff, then the newest untracked files.
  const untracked = state.files.filter(file => file.kind === 'untracked').slice(0, UNTRACKED_IN_DIFF)
  const [tracked, ...news] = await Promise.all([
    workingDiff($, root),
    ...untracked.map(file => untrackedDiff($, root, file.path)),
  ])
  const capped = capDiffs([...splitDiff(tracked), ...splitDiff(news.join(''))])
  const left = state.files.filter(file => file.kind === 'untracked').length - untracked.length
  return {
    of,
    title: 'All changes',
    detail: left > 0 ? `${left} more new files not shown` : undefined,
    diffs: capped.diffs,
    isCut: capped.isCut,
  }
}

// ---------------------------------------------------------------- refresh

// Reads what changed. `isFull` (an action, an edit of Claude's) reads it all
// whatever git says; a tick reads only what moved since the last one.
export async function refresh($: EngineInterface, isFull = true) {
  if (ctx.isBusy) {
    ctx.isAgain = true
    ctx.isAgainFull = ctx.isAgainFull || isFull
    return
  }
  ctx.isBusy = true
  try {
    let full = isFull
    do {
      ctx.isAgain = false
      const isPaneUp = await isAnyPaneShown($)
      const root = await topOf($)
      if (root === '') {
        const cwd = await $.session.cwd()
        const none: Repo = { ...EMPTY_REPO, error: `Not a git repository: ${cwd}` }
        if (isNew('repo', none)) await update($, repo, () => none)
        if (isPaneUp && (await read($, tab)) === 'files') await refreshFiles($, cwd, false)
      } else {
        const sig = await signatureOf($, root)
        ctx.ticks++
        const hasMoved = sig !== undefined && sig.signature !== ctx.lastSignature
        if (sig && (full || hasMoved || ctx.ticks % FULL_EVERY === 0)) {
          ctx.lastSignature = sig.signature
          if (hasMoved) ctx.needsLog = true
          const state = await readRepo($, root, sig.status)
          if (isNew('repo', state)) await update($, repo, () => state)
          if (isPaneUp) await refreshViews($, state)
        }
      }
      full = ctx.isAgainFull
      ctx.isAgainFull = false
    } while (ctx.isAgain)
  } catch (error) {
    $.ui.log(`clawd-git: refresh failed: ${String(error)}`, { to: 'debug' })
  } finally {
    ctx.isBusy = false
  }
}

// The open tab's own data: the folders, the log, the diff.
async function refreshViews($: EngineInterface, state: Repo) {
  const current = await read($, tab)
  if (current === 'files') await refreshFiles($, state.root, true)
  if (current === 'commits' || ctx.needsLog) {
    ctx.needsLog = false
    const out = await git($, state.root, ['log', '--graph', '--all', '--date-order', `-n${LOG_LIMIT}`, `--format=${LOG_FORMAT}`])
    const rows = out.exitCode === 0 ? parseLog(out.stdout) : []
    if (isNew('log', rows)) await update($, log, () => rows)
  }
  if (current === 'diff') {
    const next = await readShown($, state, await read($, view))
    if (isNew('shown', next)) await update($, shown, () => next)
  }
}

// ---------------------------------------------------------------- files

// Reads the root folder and every open folder from disk; git-ignored entries
// are marked so the tree can dim them.
async function refreshFiles($: EngineInterface, root: string, isRepo: boolean) {
  if (isNew('filesRoot', root)) {
    await update($, filesRoot, () => root)
    // Another folder: what was open belonged to the old one.
    if (ctx.written.has('listing')) await update($, openDirs, () => [])
  }
  const open = await read($, openDirs)
  // An open folder inside a closed one is not drawn, so it is not read.
  const isOpen = new Set(open)
  const shownDirs = ['', ...open.filter(dir => dir.split('/').every((_, i, parts) => isOpen.has(parts.slice(0, i + 1).join('/'))))]
  const next: Record<string, Entry[]> = {}
  await Promise.all(shownDirs.map(async dir => {
    const entries = await readDir($, root, dir, isRepo)
    if (entries) next[dir] = entries
  }))
  if (isNew('listing', next)) await update($, listing, () => next)
}

async function readDir($: EngineInterface, root: string, dir: string, isRepo: boolean): Promise<Entry[] | undefined> {
  const abs = dir === '' ? root : `${root}/${dir}`
  const raw = await $.fs.list(abs).catch(() => undefined)
  if (!raw) return undefined
  const kept = raw.filter(one => !(one.name === '.git' && one.kind === 'dir')).slice(0, DIR_ENTRIES)
  const rel = (name: string) => (dir === '' ? name : `${dir}/${name}`)
  let ignored = new Set<string>()
  if (isRepo && kept.length > 0) {
    // check-ignore prints the ignored ones; exit 1 means none are.
    const asked = await git($, root, ['check-ignore', '--stdin'], 10_000,
      kept.map(one => rel(one.name) + (one.kind === 'dir' ? '/' : '')).join('\n') + '\n').catch(() => undefined)
    ignored = new Set((asked?.stdout ?? '').split('\n').map(line => line.replace(/\/$/, '')).filter(Boolean))
  }
  const entries: Entry[] = kept.map(one => ({
    name: one.name,
    isDir: one.kind === 'dir',
    isIgnored: ignored.has(rel(one.name)),
  }))
  if (raw.length > kept.length) entries.push({ name: `… ${raw.length - kept.length} more`, isDir: false, isIgnored: true })
  return sortEntries(entries)
}

// ---------------------------------------------------------------- fonts

// Which icon set this machine's fonts can draw. Terminals on Linux and macOS
// fall back to any installed font holding a glyph, so installed decides it.
export async function findIconSet($: EngineInterface): Promise<Exclude<IconMode, 'off'>> {
  const families = async (charset: string) => {
    const out = await $.process.run(['fc-list', `:charset=${charset}`, 'family'], { timeoutMs: 5000 }).catch(() => undefined)
    return out && out.exitCode === 0 ? out.stdout : ''
  }
  const [nerd, outline] = await Promise.all([families('f07b'), families('1f5c0')])
  if (nerd !== '' || outline !== '') return iconSetFor(nerd, outline)
  // No fontconfig (macOS): look in the font folders for a Nerd Font.
  const home = (await $.env.get('HOME').catch(() => undefined)) ?? ''
  for (const dir of ['/Library/Fonts', `${home}/Library/Fonts`]) {
    const names = await $.fs.list(dir).catch(() => [])
    if (names.some(one => /nerd|NFM?[-.]/i.test(one.name))) return 'line'
  }
  return 'simple'
}
