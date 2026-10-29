// What every part of the panel shares: names, limits, the settings, the
// runtime values one module sets and another reads, and the types of a page.
// No `$.state` values live here: the engine reads each module's own.

import type { EngineInterface, RenderElement } from 'claude-code'

import type { Change, Repo, Shown, Tab, View } from '../types'
import type { DiffLine } from './git'
import type { IconMode } from './icons'

export const PANE = 'git'
export const COMMAND = 'git-pane'
// The Files pane of 0.1, now a tab: closed if a reload finds it open.
export const OLD_FILES_PANE = 'files'

// The tab row, in order. A diff is no tab: it opens over the tab it came from.
// Each tab's icon: [Nerd Font, Codicon].
export const TABS: { id: Exclude<Tab, 'diff'>; label: string; glyph: readonly [string, string] }[] = [
  { id: 'files', label: 'Files', glyph: ['', ''] },
  { id: 'changes', label: 'Changes', glyph: ['', ''] },
  { id: 'commits', label: 'Commits', glyph: ['', ''] },
  { id: 'restore', label: 'Restore', glyph: ['\uf1da', '\uea82'] },
]

// Toolbar and tree glyphs.
const GLYPH = {
  // name: [Nerd Font, Codicon, outline (common mono fonts), plain]
  search: ['', '', '⌕', 'search'],
  close: ['', '', '✕', '×'],
  collapse: ['', '', '⊟', 'collapse'],
  refresh: ['', '', '⟳', '↻'],
  diffAll: ['', '', '±', '±'],
  back: ['', '', '←', '←'],
  left: ['', '', '‹', '◀'],
  right: ['', '', '›', '▶'],
  branch: ['', '', '', ''],
  open: ['', '', '⌄', '▾'],
  shut: ['', '', '›', '▸'],
  claude: ['', '', '✦', '✦'],
  review: ['', '', '◎', '?'],
  edit: ['', '', '↗', '↗'],
  stage: ['', '', '+', '+'],
  unstage: ['', '', '−', '−'],
  discard: ['', '', '↺', '↺'],
  commit: ['', '', '●', '●'],
  turn: ['', '', '◷', '◷'],
  note: ['', '', '✎', '✎'],
  send: ['', '', '→', '→'],
  addNote: ['', '', '+', '+'],
  debug: ['', '', '▷', '▷'],
  // The header's title, and the content card's.
  git: ['\ue702', '\uea68', '⎇', ''],
  folder: ['\uf07b', '\uea83', '', ''],
  file: ['\uf15b', '\uea7b', '', ''],
  history: ['\uf1da', '\uea82', '◷', ''],
} as const

export type GlyphName = keyof typeof GLYPH

export function glyph(name: GlyphName) {
  return GLYPH[name][ctx.iconMode === 'nerd' ? 0 : ctx.iconMode === 'line' ? 1 : ctx.iconMode === 'outline' ? 2 : 3]
}

// Limits that keep one refresh cheap and one drawing under the engine's text cap.
export const LOG_LIMIT = 300
export const UNTRACKED_IN_DIFF = 25
export const DIFF_CHARS = 90_000
export const SOURCE_LINES = 2000
export const TREE_ROWS = 3000
export const SEARCH_RESULTS = 200
// Entries read from one folder; past this the rest are counted, not listed.
export const DIR_ENTRIES = 1000
export const SIDE_STEP = 12
// A full refresh at least this often, even when git reports nothing new
// (a folder's new files, an untracked file's growing line count).
export const FULL_EVERY = 5
// Tools that write files, and Bash, which may.
export const EDITORS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
export const WRITERS = new Set([...EDITORS, 'Bash'])
// The model that drafts commit messages: fast, and the diff is small.
export const DRAFT_MODEL = 'claude-haiku-5-5'

export const EMPTY_REPO: Repo = { root: '', branch: '', ahead: 0, behind: 0, files: [] }
export const EMPTY_SHOWN: Shown = { of: '', title: '', diffs: [], isCut: false }

export type Config = {
  isAutoOpen: boolean
  intervalMs: number
  icons: IconMode | 'auto'
  background: string
  rows: number
  placement: 'side' | 'prompt'
  editor: string
}

// The runtime values the modules share. A reload of the module starts them over.
export const ctx = {
  config: {
    isAutoOpen: true, intervalMs: 2000, icons: 'auto', background: 'none', rows: 16, placement: 'side', editor: 'auto',
  } as Config,
  // The icon set in force for this drawing: the setting, or what auto found.
  iconMode: 'simple' as IconMode,
  // Sideways scrolling: text is cut `slideX` in, and the widest row seen while
  // building a page says whether there is anything to slide to.
  slideX: 0,
  widest: 0,
  // What the last drawing laid out, for the wheel to move against.
  lastPage: { key: '', total: 0, room: 0 },
  // The last value written to each state key, as JSON, so an unchanged
  // refresh writes nothing and redraws nothing.
  written: new Map<string, string>(),
  isBusy: false,
  isAgain: false,
  // A refresh asked for while one ran is to read everything.
  isAgainFull: false,
  needsLog: true,
  // What git said last time, so a tick where nothing moved does no more work.
  lastSignature: '',
  ticks: 0,
  // The session the panel last read for; a /clear moves the process to a new one.
  sessionId: '',
  // Files listed for search, read once each time search opens.
  searchable: [] as string[],
}

// True when `value` differs from what was last written under `key`.
export function isNew(key: string, value: unknown) {
  const json = JSON.stringify(value)
  if (ctx.written.get(key) === json) return false
  ctx.written.set(key, json)
  return true
}

export function viewKey(one: View) {
  return one.kind === 'all' ? 'all' : one.kind === 'turn' ? 'turn' : one.kind === 'file' ? `file:${one.path}` : one.kind === 'checkpoint' ? `point:${one.ref}` : `commit:${one.hash}`
}

export function describe(change: Change) {
  const where = [
    change.index !== ' ' && change.index !== '?' ? 'staged' : '',
    change.worktree !== ' ' && change.worktree !== '?' ? 'unstaged' : '',
  ].filter(Boolean).join(' + ')
  const kind = change.kind === 'untracked' ? 'new file, not tracked' : change.kind
  return `${kind}${where ? ` · ${where}` : ''}${change.from ? ` · from ${change.from}` : ''}`
}

// A path relative to the repository, from one a tool was given.
export function relativeTo(root: string, path: string) {
  if (root !== '' && path.startsWith(`${root}/`)) return path.slice(root.length + 1)
  return path.startsWith('/') ? '' : path
}

// ---------------------------------------------------------------- snapshots

// Snapshots of the working tree (this turn's start, restore points) live in a
// repository of their own inside .git: .git/clawd-git/points.git. It reads the
// project's objects (git's alternates), so it stores only what is new, and
// writes nothing to the project's repository: no refs, no objects, nothing in
// `git log --all`.
type Side = { dir: string; gitDir: string }
const sides = new Map<string, Side>()

export async function sideOf($: EngineInterface, root: string): Promise<Side | undefined> {
  const known = sides.get(root)
  if (known) return known
  const out = await git($, root, ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir']).catch(() => undefined)
  if (!out || out.exitCode !== 0) return undefined
  const [gitDir = '', common = ''] = out.stdout.trim().split('\n')
  if (gitDir === '' || common === '') return undefined
  const dir = `${common}/clawd-git/points.git`
  try {
    if (!(await $.fs.exists(`${dir}/HEAD`))) {
      const made = await $.process.run(['git', 'init', '--bare', '-q', dir], { cwd: root, timeoutMs: 15_000 })
      if (made.exitCode !== 0) return undefined
    }
    await $.fs.write(`${dir}/objects/info/alternates`, `${common}/objects\n`)
  } catch {
    return undefined
  }
  const side = { dir, gitDir }
  sides.set(root, side)
  return side
}

// git in the snapshot repository, over the project's working tree; with
// `withIndex`, through a copy of the project's index (git's own is untouched,
// and its stat cache means only files changed since the last `git add` are read).
let indexes = 0
export async function sideGit(
  $: EngineInterface, root: string, args: string[], opts: { withIndex?: boolean; env?: Record<string, string>; timeoutMs?: number } = {},
) {
  const side = await sideOf($, root)
  if (!side) return { exitCode: 1, stdout: '', stderr: 'not a git repository' }
  const index = opts.withIndex ? `${side.dir}/snapshot-${++indexes}.index` : undefined
  try {
    if (index) {
      const hasIndex = await $.fs.stat(`${side.gitDir}/index`).then(() => true).catch(() => false)
      if (hasIndex) await $.process.run(['cp', `${side.gitDir}/index`, index], { timeoutMs: 15_000 })
      // The project's own ignore list for this repository, as git reads it.
      const exclude = await $.fs.read(`${side.gitDir}/info/exclude`).catch(() => undefined)
      if (exclude !== undefined) await $.fs.write(`${side.dir}/info/exclude`, String(exclude)).catch(() => undefined)
    }
    const env = { GIT_DIR: side.dir, GIT_WORK_TREE: root, ...(index ? { GIT_INDEX_FILE: index } : {}), ...(opts.env ?? {}) }
    return await $.process.run(['git', '-c', 'core.quotePath=false', '-c', 'color.ui=never', ...args], { cwd: root, env, timeoutMs: opts.timeoutMs ?? 30_000 })
  } finally {
    if (index) await $.process.run(['rm', '-f', index], { timeoutMs: 5000 }).catch(() => undefined)
  }
}

// The working tree as it stands, as a tree in the snapshot repository:
// tracked and new files, ignored ones left out.
export async function snapshotTree($: EngineInterface, root: string): Promise<string | undefined> {
  const side = await sideOf($, root)
  if (!side) return undefined
  const index = `${side.dir}/snapshot-${++indexes}.index`
  try {
    const hasIndex = await $.fs.stat(`${side.gitDir}/index`).then(() => true).catch(() => false)
    if (hasIndex) await $.process.run(['cp', `${side.gitDir}/index`, index], { timeoutMs: 15_000 })
    const exclude = await $.fs.read(`${side.gitDir}/info/exclude`).catch(() => undefined)
    if (exclude !== undefined) await $.fs.write(`${side.dir}/info/exclude`, String(exclude)).catch(() => undefined)
    const env = { GIT_DIR: side.dir, GIT_WORK_TREE: root, GIT_INDEX_FILE: index }
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

export async function git($: EngineInterface, cwd: string, args: string[], timeoutMs = 15_000, stdin?: string) {
  return $.process.run(['git', '-c', 'core.quotePath=false', '-c', 'color.ui=never', ...args], { cwd, timeoutMs, stdin })
}

// ---------------------------------------------------------------- page types

export type El = ReturnType<EngineInterface['ui']['resolve']>
export type Node = RenderElement | string | null

// A toolbar button: an icon and a word, so it says what it does. On the
// header's key bar, `key` names the bar slot it fills (see BAR in draw).
export type Action = { key: string; label: string; word?: string; color?: string; onPress: () => void }

// One line of a page: something drawn, or a line of code drawn with its run.
export type Row =
  | { kind: 'node'; key: string; node: Node }
  | { kind: 'diff'; key: string; run: string; path: string; line: DiffLine }
  | { kind: 'source'; key: string; run: string; path: string; no: number; text: string }

export type Page = {
  // Where this page's scroll position is kept.
  key: string
  // The content card's title (in the accent, after `icon`) and what follows
  // it, dim: as clawd-debug titles its code card with the file and its folder.
  title: string
  icon?: GlyphName
  sub?: Node
  // What the page can do now: each fills the header's key bar slot of its key.
  actions: Action[]
  // A pinned line under the title (the search field, a question, a draft).
  extra?: Node
  rows: Row[]
}

// Notes how wide a row's text would be, and cuts it for sideways scrolling.
export function slid(text: string, natural: number) {
  ctx.widest = Math.max(ctx.widest, natural)
  return text.slice(ctx.slideX)
}

// The pane is drawn as clawd-statusbar draws its bar: rounded dim frames,
// parts joined by a dim " · ", plain terminal colors, nothing filled.
export const DOT = ' · '
// Rows the pane draws around a page's rows: the header card (its border and
// three rows), the tab row, and the content card's border and title line.
export const HEADER_ROWS = 5
export const PINNED = HEADER_ROWS + 1 + 3
// Frame borders and padding: one cell of border and one of padding a side.
export const FRAME_X = 4
// Hover: color alone, never a background block, so text stays readable on
// any theme. A row turns cyan; a toolbar button turns cyan and underlines.
export const HOVER = { color: 'cyan' } as const
export const HOVER_ACCENT = { color: 'cyan', underline: true } as const
// Claude's own mark: the files it changed this session.
export const CLAUDE_COLOR = '#d97757'

// The clawd family's look (shared with clawd-debug): the accent, card frames,
// and chips (dark text on a colour).
export const ACCENT = CLAUDE_COLOR
export const BORDER = '#5c6370'
export const CHIP_TEXT = '#1e2127'
export const BRANCH_CHIP = '#c678dd'
export const OK = '#98c379'
export const WARN = '#e5c07b'
export const ERR = '#e06c75'
// The scrollbar and section rules, as clawd-debug draws them.
export const SCROLL_THUMB = '#7f848e'
export const SCROLL_TRACK = '#3e4451'
export const RULE = 'subtle'
