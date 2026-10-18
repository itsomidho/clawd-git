import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginState, Register, RenderElement } from 'claude-code'

import type { Change, Entry, FileDiff, LogRow, Repo, Shown, Tab, View } from '../types'
import { hasNerdFont, iconFor, iconSetFor, lineIconFor, outlineIconFor, simpleIconFor } from './icons'
import type { IconMode } from './icons'
import { LOG_FORMAT, SEP, fit, fitPath, fsTreeRows, hunkLines, hunkOf, parseLog, parseNumstat, parseStatus, sortEntries, splitDiff } from './git'
import type { DiffLine } from './git'

const PANE = 'git'
const COMMAND = 'git-pane'
// The Files pane of 0.1, now a tab: closed if a reload finds it open.
const OLD_FILES_PANE = 'files'

// The tab row, in order. A diff is no tab: it opens over the tab it came from.
// Each tab's icon: [Nerd Font, Codicon].
const TABS: { id: Exclude<Tab, 'diff'>; label: string; glyph: readonly [string, string] }[] = [
  { id: 'files', label: 'Files', glyph: ['\uf07b', '\ueaf0'] },
  { id: 'changes', label: 'Changes', glyph: ['\uf126', '\uea68'] },
  { id: 'commits', label: 'Commits', glyph: ['\uf1da', '\uea82'] },
  { id: 'plan', label: 'Plan', glyph: ['\uf0ae', '\ueab3'] },
]

// Toolbar and tree glyphs (Nerd Font), each with a plain fallback.
const GLYPH = {
  // name: [Nerd Font, Codicon, outline (common mono fonts), plain]
  search: ['\uf002', '\uea6d', '⌕', 'search'],
  close: ['\uf00d', '\uea76', '✕', '×'],
  collapse: ['\uf066', '\ueac5', '⊟', 'collapse'],
  refresh: ['\uf021', '\ueb37', '⟳', '↻'],
  diffAll: ['\uf440', '\ueae1', '±', '±'],
  back: ['\uf060', '\uea9b', '←', '←'],
  left: ['\uf053', '\ueab5', '‹', '◀'],
  right: ['\uf054', '\ueab6', '›', '▶'],
  branch: ['\ue725', '\uea68', '', ''],
  open: ['\uf078', '\ueab4', '⌄', '▾'],
  shut: ['\uf054', '\ueab6', '›', '▸'],
} as const

function glyph(name: keyof typeof GLYPH) {
  return GLYPH[name][iconMode === 'nerd' ? 0 : iconMode === 'line' ? 1 : iconMode === 'outline' ? 2 : 3]
}

// Files listed for search, read once each time search opens.
let searchable: string[] = []
const SEARCH_RESULTS = 200

// Limits that keep one refresh cheap and one drawing under the engine's text cap.
const LOG_LIMIT = 300
const UNTRACKED_IN_DIFF = 25
const DIFF_CHARS = 90_000
const SOURCE_LINES = 2000
const TREE_ROWS = 3000
// Entries read from one folder; past this the rest are counted, not listed.
const DIR_ENTRIES = 1000
// Tools that may change the working tree: a refresh follows each one.
const WRITERS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash'])

const EMPTY_REPO: Repo = { root: '', branch: '', ahead: 0, behind: 0, files: [] }
const EMPTY_SHOWN: Shown = { of: '', title: '', diffs: [], isCut: false }

// Whether the panel is up, above the prompt.
const isShown = atom({ plugin: 'clawd-git', key: 'isShown' } as const, true)
const tab = atom({ plugin: 'clawd-git', key: 'tab' } as const, 'files')
// The tab a diff was opened from, which its Back button returns to.
const back = atom({ plugin: 'clawd-git', key: 'back' } as const, 'changes')
const repo = atom({ plugin: 'clawd-git', key: 'repo' } as const, EMPTY_REPO)
const view = atom({ plugin: 'clawd-git', key: 'view' } as const, { kind: 'all' })
const shown = atom({ plugin: 'clawd-git', key: 'shown' } as const, EMPTY_SHOWN)
const log = atom({ plugin: 'clawd-git', key: 'log' } as const, [])
const listing = atom({ plugin: 'clawd-git', key: 'listing' } as const, {})
const openTasks = atom({ plugin: 'clawd-git', key: 'openTasks' } as const, [])
// clawd-tasks' own values: its plan, and the clock it moves while a task runs.
const board = atom({ plugin: 'clawd-tasks', key: 'board' } as const, { tasks: [], loose: 0 })
const boardNow = atom({ plugin: 'clawd-tasks', key: 'now' } as const, 0)
const filesRoot = atom({ plugin: 'clawd-git', key: 'filesRoot' } as const, '')
// The search box: null while closed, else what was typed; and what it matched.
const query = atom({ plugin: 'clawd-git', key: 'query' } as const, null)
const matches = atom({ plugin: 'clawd-git', key: 'matches' } as const, [])
// The window of each page, by page key; and how far code is slid sideways.
const scrollY = atom({ plugin: 'clawd-git', key: 'scrollY' } as const, {})
const scrollX = atom({ plugin: 'clawd-git', key: 'scrollX' } as const, 0)
const openDirs = atom({ plugin: 'clawd-git', key: 'openDirs' } as const, [])

let config: { isAutoOpen: boolean; intervalMs: number; icons: IconMode | 'auto'; background: string; rows: number; placement: 'side' | 'prompt' } = {
  isAutoOpen: true, intervalMs: 2000, icons: 'auto', background: 'none', rows: 16, placement: 'side',
}
// The icon set in force for this drawing: the setting, or what auto found.
let iconMode: IconMode = 'simple'
// What auto found on this machine, kept for the session.
const detected = atom({ plugin: 'clawd-git', key: 'iconSet' } as const, 'simple')

// Which icon set this machine's fonts can draw. Terminals on Linux and macOS
// fall back to any installed font holding a glyph, so installed decides it.
async function findIconSet($: EngineInterface): Promise<Exclude<IconMode, 'off'>> {
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
// The last value written to each atom, as JSON, so an unchanged refresh
// writes nothing and redraws nothing.
const written = new Map<string, string>()
let isBusy = false
let isAgain = false
let needsLog = true

function viewKey(one: View) {
  return one.kind === 'all' ? 'all' : one.kind === 'file' ? `file:${one.path}` : `commit:${one.hash}`
}

// True when `value` differs from what was last written under `key`.
function isNew(key: string, value: unknown) {
  const json = JSON.stringify(value)
  if (written.get(key) === json) return false
  written.set(key, json)
  return true
}

async function git($: EngineInterface, cwd: string, args: string[], timeoutMs = 15_000) {
  return $.process.run(['git', '-c', 'core.quotePath=false', '-c', 'color.ui=never', ...args], { cwd, timeoutMs })
}

// ---------------------------------------------------------------- refresh

async function readRepo($: EngineInterface): Promise<Repo> {
  const cwd = await $.session.cwd()
  const top = await git($, cwd, ['rev-parse', '--show-toplevel']).catch(() => undefined)
  if (!top || top.exitCode !== 0) return { ...EMPTY_REPO, error: `Not a git repository: ${cwd}` }
  const root = top.stdout.trim()
  const [status, unstaged, staged] = await Promise.all([
    git($, root, ['status', '--porcelain=v1', '-b', '--untracked-files=all']),
    git($, root, ['diff', '--numstat']),
    git($, root, ['diff', '--cached', '--numstat']),
  ])
  if (status.exitCode !== 0) return { ...EMPTY_REPO, root, error: status.stderr.trim() || 'git status failed' }
  const parsed = parseStatus(status.stdout)
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

async function workingDiff($: EngineInterface, root: string, path?: string): Promise<string> {
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

async function refresh($: EngineInterface) {
  if (isBusy) { isAgain = true; return }
  isBusy = true
  try {
    do {
      isAgain = false
      const current = await read($, tab)
      const state = await readRepo($)
      if (isNew('repo', state)) await update($, repo, () => state)
      if (!(await isAnyPaneShown($))) continue
      if (current === 'files') await refreshFiles($, state.root || (await $.session.cwd()), state.root !== '')
      if (state.root === '') continue
      if (current === 'commits' || needsLog) {
        needsLog = false
        const out = await git($, state.root, ['log', '--graph', '--all', '--date-order', `-n${LOG_LIMIT}`, `--format=${LOG_FORMAT}`])
        const rows = out.exitCode === 0 ? parseLog(out.stdout) : []
        if (isNew('log', rows)) await update($, log, () => rows)
      }
      if (current === 'diff') {
        const next = await readShown($, state, await read($, view))
        if (isNew('shown', next)) await update($, shown, () => next)
      }
    } while (isAgain)
  } catch (error) {
    $.ui.log(`clawd-git: refresh failed: ${String(error)}`, { to: 'debug' })
  } finally {
    isBusy = false
  }
}

// The ids of this mod's panes that are on screen now.
// Whether the panel is on screen: the side pane shown, or the band's panel up.
async function isAnyPaneShown($: EngineInterface) {
  if (config.placement === 'prompt') return read($, isShown)
  const panes = await $.ui.panes().catch(() => [])
  return panes.some(pane => pane.id === PANE && pane.isShown && pane.isPlaced)
}

// ---------------------------------------------------------------- files

// Reads the root folder and every open folder from disk; git-ignored entries
// are marked so the tree can dim them.
async function refreshFiles($: EngineInterface, root: string, isRepo: boolean) {
  if (isNew('filesRoot', root)) {
    await update($, filesRoot, () => root)
    // Another folder: what was open belonged to the old one.
    if (written.has('listing')) await update($, openDirs, () => [])
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
    const asked = await $.process.run(['git', '-c', 'core.quotePath=false', 'check-ignore', '--stdin'], {
      cwd: root,
      stdin: kept.map(one => rel(one.name) + (one.kind === 'dir' ? '/' : '')).join('\n') + '\n',
      timeoutMs: 10_000,
    }).catch(() => undefined)
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

// ---------------------------------------------------------------- actions

async function selectTab($: EngineInterface, next: Tab) {
  await update($, tab, () => next)
  await update($, scrollX, () => 0)
  if (next === 'commits') needsLog = true
  await refresh($)
}

// Opens a diff (all changes, a file, a commit) over the current tab.
async function openView($: EngineInterface, next: View) {
  const from = await read($, tab)
  if (from !== 'diff') await update($, back, () => from)
  await update($, view, () => next)
  // A new diff starts at its top-left.
  await update($, scrollY, all => ({ ...all, [`diff:${viewKey(next)}`]: 0 }))
  await update($, scrollX, () => 0)
  await update($, tab, () => 'diff')
  await refresh($)
}

async function goBack($: EngineInterface) {
  await selectTab($, await read($, back))
}

async function toggleDir($: EngineInterface, path: string) {
  await update($, openDirs, list => (list.includes(path) ? list.filter(one => one !== path) : [...list, path]))
  await refresh($)
}

async function openSearch($: EngineInterface) {
  const state = await read($, repo)
  if (state.root !== '') {
    const out = await git($, state.root, ['ls-files', '--cached', '--others', '--exclude-standard']).catch(() => undefined)
    searchable = [...new Set((out?.stdout ?? '').split('\n').filter(Boolean))]
  }
  await update($, query, () => '')
  await update($, matches, () => [])
}

async function closeSearch($: EngineInterface) {
  await update($, query, () => null)
  await update($, matches, () => [])
}

// Names that start with the text first, then names holding it, then paths.
async function search($: EngineInterface, text: string) {
  await update($, query, () => text)
  const needle = text.trim().toLowerCase()
  if (needle === '') { await update($, matches, () => []); return }
  const scored: { path: string; score: number }[] = []
  for (const path of searchable) {
    const lower = path.toLowerCase()
    const name = lower.slice(lower.lastIndexOf('/') + 1)
    const score = name.startsWith(needle) ? 0 : name.includes(needle) ? 1 : lower.includes(needle) ? 2 : -1
    if (score >= 0) scored.push({ path, score })
  }
  scored.sort((a, b) => a.score - b.score || a.path.length - b.path.length || a.path.localeCompare(b.path))
  const found = scored.slice(0, SEARCH_RESULTS).map(one => one.path)
  await update($, matches, () => found)
}

async function reload($: EngineInterface) {
  needsLog = true
  written.clear()
  await refresh($)
}

// ---------------------------------------------------------------- drawing
//
// Each tab builds a Page: a header (title and toolbar) that stays pinned, and
// rows, each exactly one line tall. The pane shows a window of the rows under
// the header and moves it on the wheel and the scroll keys itself, so the tabs
// never scroll away; a slim bar on the right says where the window is. Diff and
// source lines are rows too, drawn in runs through Code, and slide sideways.

function describe(change: Change) {
  const where = [
    change.index !== ' ' && change.index !== '?' ? 'staged' : '',
    change.worktree !== ' ' && change.worktree !== '?' ? 'unstaged' : '',
  ].filter(Boolean).join(' + ')
  const kind = change.kind === 'untracked' ? 'new file, not tracked' : change.kind
  return `${kind}${where ? ` · ${where}` : ''}${change.from ? ` · from ${change.from}` : ''}`
}

type El = ReturnType<EngineInterface['ui']['resolve']>
type Node = RenderElement | string | null

// A toolbar button: an icon and a word, so it says what it does.
type Action = { key: string; label: string; word?: string; onPress: () => void }

// Sideways scrolling for every page: text is cut `slideX` columns in, and the
// widest row seen while building says whether there is anything to slide to.
let slideX = 0
let widest = 0

function slid(text: string, natural: number) {
  widest = Math.max(widest, natural)
  return text.slice(slideX)
}

// One line of a page: something drawn, or a line of code drawn with its run.
type Row =
  | { kind: 'node'; key: string; node: Node }
  | { kind: 'diff'; key: string; run: string; path: string; line: DiffLine }
  | { kind: 'source'; key: string; run: string; path: string; no: number; text: string }

type Page = {
  // Where this page's scroll position is kept.
  key: string
  title: Node
  actions: Action[]
  // A second pinned line under the title (the search field).
  extra?: Node
  rows: Row[]
  // The longest code line, when the page slides sideways.
  longest?: number
}

// What the last drawing laid out, for the wheel to move against.
let lastPage = { key: '', total: 0, room: 0 }
const SIDE_STEP = 12
// Hover: color alone, never a background block, so text stays readable on
// any theme. A row turns cyan; a toolbar button turns cyan and underlines.
const HOVER = { color: 'cyan' } as const
const HOVER_ACCENT = { color: 'cyan', underline: true } as const

// A folder as the statusbar writes it: home as ~.
function homePath(path: string) {
  return path.replace(/^\/(home|Users)\/[^/]+/, '~')
}

// The statusbar's line: parts joined by a dim " · ".
function parts(el: El, items: { text: string; color?: string; bold?: boolean; dim?: boolean }[]) {
  const { Text } = el
  const shown = items.filter(one => one.text !== '')
  return (
    <Text wrap="truncate-end">
      {shown.map((one, i) => [
        i > 0 ? <Text dimColor>{DOT}</Text> : null,
        <Text color={one.color} bold={one.bold} dimColor={one.dim}>{one.text}</Text>,
      ])}
    </Text>
  )
}

function node(key: string, one: Node): Row {
  return { kind: 'node', key, node: one }
}

// Status marks, in the person's theme colors.
const KIND_STYLE = {
  modified: { mark: 'M', color: 'yellow' },
  added: { mark: 'A', color: 'green' },
  deleted: { mark: 'D', color: 'red' },
  renamed: { mark: 'R', color: 'cyan' },
  untracked: { mark: 'U', color: 'green' },
  conflict: { mark: '!', color: 'red' },
} as const

function iconText({ Text }: El, name: string, isDir: boolean, isOpen: boolean, isDim: boolean, isSelected: boolean) {
  if (iconMode === 'off') return null
  const icon = iconMode === 'nerd' ? iconFor(name, isDir, isOpen)
    : iconMode === 'line' ? lineIconFor(name, isDir, isOpen)
    : iconMode === 'outline' ? outlineIconFor(name, isDir, isOpen)
    : simpleIconFor(name, isDir, isOpen)
  return (
    <Text color={isSelected ? 'cyan' : icon.color} dimColor={isDim && !isSelected}>
      {icon.glyph + ' '}
    </Text>
  )
}

// A file line: icon, name, its folder dim, then right-aligned figures.
function fileLine(
  el: El, key: string, path: string, width: number, onPress: () => void,
  opts: { color?: string; isSelected?: boolean; isStruck?: boolean; showDir?: boolean; tail?: Node; tailWidth?: number; isTailInline?: boolean },
) {
  const { Box, Text, Button } = el
  const slash = path.lastIndexOf('/')
  const name = path.slice(slash + 1)
  const dir = opts.showDir === false || slash <= 0 ? '' : path.slice(0, slash)
  const icon = iconMode === 'off' ? 0 : 2
  const room = Math.max(6, width - icon - (opts.tailWidth ?? 0) - 1)
  widest = Math.max(widest, icon + name.length + (dir ? dir.length + 1 : 0) + (opts.tailWidth ?? 0) + 1)
  const shownName = fit(name.slice(slideX), room)
  const restDir = dir.slice(Math.max(0, slideX - name.length))
  const shownDir = restDir === '' ? '' : ' ' + fitPath(restDir, Math.max(0, room - shownName.length - 1))
  const pad = opts.isTailInline ? ' ' : ' '.repeat(Math.max(1, room - shownName.length - shownDir.length + 1))
  // After an inline tail, blanks to the row's end, so the hover spans it.
  const fill = opts.isTailInline ? ' '.repeat(Math.max(0, room - shownName.length - shownDir.length - 1)) : ''
  const sel = opts.isSelected === true
  const bg = undefined
  return (
    <Box key={`${key}:box`} height={1} overflow="hidden">
      <Button key={key} plain hover={HOVER} onPress={onPress}>
        {iconText(el, name, false, false, false, sel)}
        <Text backgroundColor={bg} color={sel ? 'cyan' : opts.color} bold={sel} strikethrough={opts.isStruck}>{shownName}</Text>
        <Text backgroundColor={bg} color={sel ? 'cyan' : 'gray'} dimColor={!sel}>{shownDir}</Text>
        <Text backgroundColor={bg}>{pad}</Text>
        {opts.tail ?? null}
        {fill ? <Text>{fill}</Text> : null}
      </Button>
    </Box>
  )
}

function counts(el: El, added: number, removed: number) {
  const { Text } = el
  return [
    <Text color="green" dimColor={added === 0}>{`+${added}`}</Text>,
    <Text color="red" dimColor={removed === 0}>{` −${removed}`}</Text>,
  ]
}

// ---------------------------------------------------------------- pages

function filesPage(
  el: El, $: EngineInterface, state: Repo, root: string,
  list: Record<string, Entry[]>, open: string[], selected: string | undefined, width: number,
): Page {
  const { Box, Text, Button } = el
  const name = root.split('/').pop() || root
  const page: Page = {
    key: 'files',
    title: parts(el, [
      { text: homePath(root) || 'Files', color: 'blue' },
      { text: state.branch ? `${glyph('branch') ? glyph('branch') + ' ' : ''}${state.branch}` : '', color: 'magenta' },
      { text: state.files.length > 0 ? `●${state.files.length}` : '', color: 'yellow' },
    ]),
    actions: [
      { key: 'search', label: glyph('search'), word: 'Search', onPress: () => { void openSearch($) } },
      ...(open.length > 0 ? [{ key: 'collapse', label: glyph('collapse'), word: 'Collapse', onPress: () => { void update($, openDirs, () => []) } }] : []),
      { key: 'refresh', label: glyph('refresh'), word: 'Refresh', onPress: () => { void reload($) } },
    ],
    rows: [],
  }
  if (root === '' || list[''] === undefined) {
    page.rows.push(node('reading', <Text color="gray">Reading the folder…</Text>))
    return page
  }
  const changed = new Map(state.files.map(one => [one.path, one]))
  for (const row of fsTreeRows(list, open, new Set(changed.keys()), TREE_ROWS)) {
    // A thin guide per level, as editors draw them.
    const guides = '│ '.repeat(row.depth)
    if (!row.isDir && row.label.startsWith('… ')) {
      page.rows.push(node(`more:${row.path}`, <Text color="gray">{guides + '  ' + row.label}</Text>))
      continue
    }
    const change = row.isDir ? undefined : changed.get(row.path)
    const style = change ? KIND_STYLE[change.kind] : undefined
    const sel = !row.isDir && row.path === selected
    const ink = sel ? 'cyan' : undefined
    const bg = undefined
    const lead = guides.length + 2 + (iconMode === 'off' ? 0 : 2)
    const room = Math.max(4, width - lead - 3)
    const label = fit(slid(row.label, lead + row.label.length + 3), room)
    // The change mark sits right after the name; a folder holding changes is tinted.
    const mark = style ? ` ${style.mark}` : row.isChanged ? ' •' : ''
    const tint = style ? style.color : row.isChanged ? 'yellow' : undefined
    // Fill the row only where it is selected, so the highlight spans it.
    const pad = ' '.repeat(Math.max(0, width - lead - label.length - mark.length - (row.isLoading ? 2 : 0)))
    page.rows.push(node(`row:${row.path}`, (
      <Box key={`row:${row.path}`} height={1} overflow="hidden">
        <Button
          key={`${row.isDir ? 'dir' : 'file'}:${row.path}`}
          plain
          hover={HOVER}
          onPress={() => { void (row.isDir ? toggleDir($, row.path) : openView($, { kind: 'file', path: row.path })) }}
        >
          <Text backgroundColor={bg} color={ink ?? 'gray'} dimColor={!sel}>{guides}</Text>
          <Text backgroundColor={bg} color={ink ?? 'gray'}>{row.isDir ? `${glyph(row.isOpen ? 'open' : 'shut')} ` : '  '}</Text>
          {iconText(el, row.label, row.isDir, row.isOpen, row.isIgnored, sel)}
          <Text backgroundColor={bg} color={ink ?? tint} bold={sel} dimColor={row.isIgnored && !tint && !sel}>{label}</Text>
          <Text backgroundColor={bg} color={ink ?? tint}>{mark}</Text>
          <Text backgroundColor={bg} color="gray">{row.isLoading ? ' …' : ''}</Text>
          <Text backgroundColor={bg}>{pad}</Text>
        </Button>
      </Box>
    )))
  }
  return page
}

// Search over every file git knows (tracked and new, not ignored).
function searchPage(
  el: El, $: EngineInterface, state: Repo, root: string,
  typed: string, found: string[], selected: string | undefined, width: number,
): Page {
  const { Text } = el
  // Mobile draws no text field.
  const Input = 'Input' in el ? el.Input : undefined
  const changed = new Map(state.files.map(one => [one.path, one]))
  const name = root.split('/').pop() || root
  const page: Page = {
    key: 'search',
    title: <Text bold wrap="truncate-end">{`Search ${name}`}</Text>,
    actions: [{ key: 'search-close', label: glyph('close'), word: 'Close', onPress: () => { void closeSearch($) } }],
    extra: Input
      ? <Input key="search-input" placeholder="File name or path" value={typed} autoFocus
          onInput={(value: string) => { void search($, value) }} onSubmit={(value: string) => { void search($, value) }} />
      : <Text color="gray">Search needs a surface that takes typing.</Text>,
    rows: [],
  }
  if (state.root === '') page.rows.push(node('norepo', <Text color="gray">Search lists the files of a git repository.</Text>))
  if (typed.trim() !== '' && found.length === 0) page.rows.push(node('none', <Text color="gray">No file matches.</Text>))
  if (found.length > 0) {
    page.rows.push(node('count', <Text color="gray">{`${found.length >= SEARCH_RESULTS ? `${SEARCH_RESULTS}+` : found.length} files`}</Text>))
  }
  for (const path of found) {
    const change = changed.get(path)
    const style = change ? KIND_STYLE[change.kind] : undefined
    page.rows.push(node(`hit:${path}`, fileLine(el, `found:${path}`, path, width, () => { void openView($, { kind: 'file', path }) }, {
      color: style?.color,
      isSelected: path === selected,
      tail: style ? <Text color={style.color}>{style.mark}</Text> : null,
      tailWidth: style ? 1 : 0,
      isTailInline: true,
    })))
  }
  return page
}

function changesPage(el: El, $: EngineInterface, state: Repo, width: number): Page {
  const { Text } = el
  const added = state.files.reduce((n, one) => n + one.added, 0)
  const removed = state.files.reduce((n, one) => n + one.removed, 0)
  const page: Page = {
    key: 'changes',
    title: parts(el, [
      { text: `${glyph('branch') ? glyph('branch') + ' ' : ''}${state.branch || 'detached'}`, color: 'magenta' },
      { text: state.ahead > 0 ? `↑${state.ahead}` : '', color: 'green' },
      { text: state.behind > 0 ? `↓${state.behind}` : '', color: 'red' },
      { text: state.files.length > 0 ? `${state.files.length} changed` : 'clean', dim: true },
      { text: state.files.length > 0 ? `+${added} −${removed}` : '', color: 'green' },
    ]),
    actions: [
      ...(state.files.length > 0 ? [{ key: 'all', label: glyph('diffAll'), word: 'Diff all', onPress: () => { void openView($, { kind: 'all' }) } }] : []),
      { key: 'refresh', label: glyph('refresh'), word: 'Refresh', onPress: () => { void reload($) } },
    ],
    rows: [],
  }
  if (state.files.length === 0) {
    page.rows.push(node('clean', <Text color="gray">No changes. The working tree is clean.</Text>))
    return page
  }
  const groups: { title: string; files: Change[] }[] = [
    { title: 'Conflicts', files: state.files.filter(one => one.kind === 'conflict') },
    { title: 'Staged', files: state.files.filter(one => one.kind !== 'conflict' && one.kind !== 'untracked' && one.index !== ' ') },
    { title: 'Changes', files: state.files.filter(one => one.kind !== 'conflict' && one.kind !== 'untracked' && one.index === ' ') },
    { title: 'New', files: state.files.filter(one => one.kind === 'untracked') },
  ]
  groups.filter(group => group.files.length > 0).forEach((group, g) => {
    if (g > 0) page.rows.push(node(`gap:${group.title}`, ' '))
    page.rows.push(node(`g:${group.title}`, <Text color="gray" bold>{`${group.title.toUpperCase()}  ${group.files.length}`}</Text>))
    for (const one of group.files) {
      const style = KIND_STYLE[one.kind]
      const tail = `+${one.added} −${one.removed} ${style.mark}`
      page.rows.push(node(`chgrow:${one.path}`, fileLine(el, `chg:${one.path}`, one.path, width, () => { void openView($, { kind: 'file', path: one.path }) }, {
        color: one.kind === 'deleted' ? 'red' : undefined,
        isStruck: one.kind === 'deleted',
        tail: [...counts(el, one.added, one.removed), <Text color={style.color}>{` ${style.mark}`}</Text>] as unknown as Node,
        tailWidth: tail.length,
      })))
    }
  })
  return page
}

const GRAPH_COLORS = ['cyan', 'green', 'yellow', 'magenta', 'blue', 'red']

function commitsPage(el: El, $: EngineInterface, rows: LogRow[], width: number): Page {
  const { Box, Text, Button } = el
  const commits = rows.filter(row => row.hash).length
  const page: Page = {
    key: 'commits',
    title: parts(el, [
      { text: 'History', bold: true },
      { text: `${commits}${commits >= LOG_LIMIT ? '+' : ''} commits`, dim: true },
      { text: 'all branches', dim: true },
    ]),
    actions: [{ key: 'refresh', label: glyph('refresh'), word: 'Refresh', onPress: () => { void reload($) } }],
    rows: [],
  }
  if (rows.length === 0) page.rows.push(node('none', <Text color="gray">No commits yet.</Text>))
  rows.forEach((row, i) => {
    // One color per lane, so a branch is easy to follow.
    const graph = [...row.graph].map((c, col) => (c === ' '
      ? ' '
      : <Text color={c === '*' ? 'text' : GRAPH_COLORS[Math.floor(col / 2) % GRAPH_COLORS.length]}>{c === '*' ? '●' : c}</Text>))
    if (!row.hash) {
      page.rows.push(node(`l:${i}`, <Text wrap="truncate-end">{graph}</Text>))
      return
    }
    const refs = row.refs ? ` ${row.refs}` : ''
    const age = row.age ? `  ${row.age.replace(/ ago$/, '')}` : ''
    const shownRefs = fit(refs, Math.max(0, Math.floor((width - row.graph.length) / 3)))
    const room = Math.max(4, width - row.graph.length - row.hash.length - 2 - shownRefs.length - age.length)
    const subject = fit(slid(row.subject ?? '', row.graph.length + row.hash.length + 2 + shownRefs.length + (row.subject ?? '').length + age.length), room)
    const pad = ' '.repeat(Math.max(1, room - subject.length + 1))
    page.rows.push(node(`crow:${i}`, (
      <Box key={`crow:${row.hash}:${i}`} height={1} overflow="hidden">
        <Button key={`c:${row.hash}:${i}`} plain hover={HOVER} onPress={() => { void openView($, { kind: 'commit', hash: row.hash! }) }}>
          {graph}
          <Text color="gray">{' ' + row.hash}</Text>
          {shownRefs !== '' && <Text color="cyan" bold>{shownRefs}</Text>}
          <Text>{' ' + subject}</Text>
          <Text>{pad}</Text>
          <Text color="gray" dimColor>{age}</Text>
        </Button>
      </Box>
    )))
  })
  return page
}

function diffPage(el: El, $: EngineInterface, one: Shown, current: View, width: number): Page {
  const { Box, Text, Button } = el
  const isStale = one.of !== viewKey(current)
  const page: Page = {
    key: `diff:${viewKey(current)}`,
    title: (
      <Box flexDirection="row" columnGap={2}>
        <Box key="backrow">
          <Button key="back" plain hover={HOVER} onPress={() => { void goBack($) }}>
            <Text color="cyan">{`${glyph('back')} Back`}</Text>
          </Button>
        </Box>
        <Text bold wrap="truncate-end">{isStale ? 'Loading…' : fit(one.title, Math.max(8, width - 26))}</Text>
      </Box>
    ),
    actions: [],
    rows: [],
  }
  if (isStale) return page
  for (const [i, line] of (one.detail ?? '').split('\n').entries()) {
    if (line.trim() !== '') page.rows.push(node(`detail:${i}`, <Text color="gray" wrap="truncate-end">{line}</Text>))
  }
  if (one.diffs.length === 0 && !one.source) page.rows.push(node('nothing', <Text color="gray">Nothing to show.</Text>))
  let longest = 0
  if (one.source) {
    one.source.text.split('\n').forEach((text, i) => {
      const clean = text.replace(/\t/g, '    ')
      longest = Math.max(longest, clean.length)
      widest = Math.max(widest, clean.length + 10)
      page.rows.push({ kind: 'source', key: `src:${i}`, run: 'src', path: one.source!.path, no: i + 1, text: clean })
    })
    if (one.source.isCut) page.rows.push(node('srccut', <Text color="gray">{`… only the first ${SOURCE_LINES} lines are shown`}</Text>))
  }
  one.diffs.forEach((file, f) => {
    if (page.rows.length > 0) page.rows.push(node(`fgap:${f}`, ' '))
    if (current.kind !== 'file') {
      page.rows.push(node(`dh:${f}`, fileLine(el, `dh:${f}:${file.path}`, file.path, width, () => { void openView($, { kind: 'file', path: file.path }) }, {
        tail: counts(el, file.added, file.removed) as unknown as Node,
        tailWidth: `+${file.added} −${file.removed}`.length,
      })))
    }
    let run = 0
    hunkLines(file.hunks).forEach((line, l) => {
      if (line.kind === 'hunk') {
        run++
        // Where the hunk starts, and the function it is in when git says.
        page.rows.push(node(`hk:${f}:${l}`, (
          <Text color="gray" dimColor wrap="truncate-end">{`  ⋯ line ${line.newAt}${line.text ? '  ' + line.text : ''}`}</Text>
        )))
        return
      }
      longest = Math.max(longest, line.text.length)
      widest = Math.max(widest, line.text.length + 10)
      page.rows.push({ kind: 'diff', key: `dl:${f}:${l}`, run: `${f}:${run}`, path: file.path, line })
    })
    if (file.note) page.rows.push(node(`note:${f}`, <Text color="gray">{file.note}</Text>))
  })
  if (one.isCut) page.rows.push(node('cut', <Text color="gray">… the rest is too large for the pane</Text>))
  page.longest = longest
  return page
}

type Board = PluginState['clawd-tasks']['board']
type PlanTask = Board['tasks'][number]

function duration(ms: number) {
  const sec = Math.max(0, Math.round(ms / 1000))
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ${String(sec % 60).padStart(2, '0')}s`
  return `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, '0')}m`
}

function taskTime(task: PlanTask, now: number) {
  return task.startedAt === undefined ? '' : duration((task.endedAt ?? now) - task.startedAt)
}

function shortTool(tool: string) {
  return tool.startsWith('mcp__') ? tool.split('__').pop() ?? tool : tool
}

async function toggleTask($: EngineInterface, id: string) {
  await update($, openTasks, list => (list.includes(id) ? list.filter(one => one !== id) : [...list, id]))
}

const STATUS = {
  completed: { mark: '✓', color: 'green' },
  in_progress: { mark: '●', color: 'yellow' },
  pending: { mark: '○', color: 'gray' },
} as const

// Claude's plan from clawd-tasks: progress, each task with its time and the
// files it changed; the running task (and any pressed one) open to its steps.
function planPage(el: El, $: EngineInterface, plan: Board, now: number, open: string[], width: number): Page {
  const { Box, Text, Button } = el
  const done = plan.tasks.filter(task => task.status === 'completed').length
  const total = plan.tasks.length
  const took = plan.startedAt === undefined ? '' : ` · ${duration(now - plan.startedAt)}`
  const page: Page = {
    key: 'plan',
    title: parts(el, [
      { text: 'Plan', bold: true },
      { text: total > 0 ? `${done}/${total} done` : '', color: done === total && total > 0 ? 'green' : 'yellow' },
      { text: took.replace(/^ · /, ''), dim: true },
    ]),
    actions: [],
    rows: [],
  }
  if (total === 0) {
    page.rows.push(node('none', <Text bold>No plan yet</Text>))
    page.rows.push(node('none2', <Text color="gray" wrap="truncate-end">Claude's plan shows here, live, when it starts work of three or more steps.</Text>))
    page.rows.push(node('none3', <Text color="gray" wrap="truncate-end">It comes from clawd-tasks; keep that plugin installed and enabled.</Text>))
    if (plan.loose > 0) page.rows.push(node('loose', <Text color="gray">{`${plan.loose} tool calls so far outside any task`}</Text>))
    return page
  }
  const barWidth = Math.max(10, width)
  const filled = Math.round((done / total) * barWidth)
  page.rows.push(node('bar', (
    <Text>
      <Text color="green">{'━'.repeat(filled)}</Text>
      <Text color="gray" dimColor>{'━'.repeat(barWidth - filled)}</Text>
    </Text>
  )))
  page.rows.push(node('bargap', ' '))
  const runningId = [...plan.tasks].reverse().find(task => task.status === 'in_progress')?.id
  for (const task of plan.tasks) {
    const status = STATUS[task.status]
    const isRunning = task.id === runningId
    const isOpen = isRunning || open.includes(task.id)
    const added = task.files.reduce((n, file) => n + file.added, 0)
    const removed = task.files.reduce((n, file) => n + file.removed, 0)
    const facts = [taskTime(task, now), task.agents > 0 ? `${task.agents} agent${task.agents > 1 ? 's' : ''}` : ''].filter(Boolean).join(' · ')
    const figures = task.files.length > 0 ? `  +${added} −${removed}` : ''
    const room = Math.max(6, width - 4 - facts.length - figures.length - 2)
    const title = isRunning ? task.activeForm || task.subject : task.subject
    const label = fit(slid(title, 4 + title.length + facts.length + figures.length + 2), room)
    const hasMore = task.steps.length > 0 || task.files.length > 0
    page.rows.push(node(`taskrow:${task.id}`, (
      <Box key={`taskrow:${task.id}`} height={1} overflow="hidden">
        <Button key={`t:${task.id}`} plain hover={HOVER} onPress={() => { void toggleTask($, task.id) }}>
          <Text color={status.color}>{`${status.mark} `}</Text>
          <Text bold={isRunning} color={task.status === 'completed' ? 'gray' : undefined}>{label}</Text>
          <Text>{' '.repeat(Math.max(1, room - label.length + 1))}</Text>
          {facts !== '' && <Text color={isRunning ? 'yellow' : 'gray'}>{facts}</Text>}
          {figures !== '' && <Text color="green">{`  +${added}`}</Text>}
          {figures !== '' && <Text color="red">{` −${removed}`}</Text>}
          <Text color="gray">{hasMore && !isRunning ? (isOpen ? ' ▾' : ' ▸') : '  '}</Text>
        </Button>
      </Box>
    )))
    if (!isOpen) continue
    const steps = task.steps.slice(isRunning && !open.includes(task.id) ? -6 : -30)
    const earlier = task.dropped + task.steps.length - steps.length
    if (earlier > 0) page.rows.push(node(`early:${task.id}`, <Text color="gray">{`  │ ${earlier} earlier steps`}</Text>))
    for (const step of steps) {
      const tool = shortTool(step.tool).slice(0, 7).padEnd(7)
      const when = step.isError ? 'failed' : step.endedAt === undefined ? 'running' : duration(step.endedAt - step.startedAt)
      const stepRoom = Math.max(6, width - 4 - 8 - when.length - 2)
      const full = step.label + (step.agentId ? ' (agent)' : '')
      const text = fit(slid(full, 4 + 8 + full.length + when.length + 2), stepRoom)
      page.rows.push(node(`s:${task.id}:${step.id}`, (
        <Text wrap="truncate-end">
          <Text color="gray">{'  │ '}</Text>
          <Text color={step.isError ? 'red' : step.endedAt === undefined ? 'yellow' : 'cyan'}>{tool}</Text>
          <Text color={step.endedAt === undefined ? undefined : 'gray'}>{' ' + text}</Text>
          <Text>{' '.repeat(Math.max(1, stepRoom - text.length + 1))}</Text>
          <Text color={step.isError ? 'red' : 'gray'}>{when}</Text>
        </Text>
      )))
    }
    for (const file of task.files) {
      const line = fileLine(el, `f:${task.id}:${file.path}`, file.path, width - 4, () => { void openView($, { kind: 'file', path: file.path }) }, {
        tail: counts(el, file.added, file.removed) as unknown as Node,
        tailWidth: `+${file.added} −${file.removed}`.length,
      })
      page.rows.push(node(`frow:${task.id}:${file.path}`, (
        <Box key={`fbox:${task.id}:${file.path}`} flexDirection="row" height={1} overflow="hidden">
          <Text color="gray">{'  │ '}</Text>
          {line}
        </Box>
      )))
    }
  }
  if (plan.loose > 0) {
    page.rows.push(node('loosegap', ' '))
    page.rows.push(node('loose', <Text color="gray">{`${plan.loose} tool calls outside any task`}</Text>))
  }
  return page
}

// ---------------------------------------------------------------- the pane

// The pane is drawn as clawd-statusbar draws its bar: rounded dim frames,
// parts joined by a dim " · ", plain terminal colors, nothing filled.
const DOT = ' · '
// Rows the pane draws around a page's rows: the header frame (the tabs, a
// divider, the title line, and its border), and the content frame's border.
const PINNED = 7

function tabRow(el: El, $: EngineInterface, lit: Tab, badges: Partial<Record<Tab, string>>) {
  const { Box, Text, Button } = el
  return (
    <Box flexDirection="row" height={1} overflow="hidden">
      {TABS.map((one, i) => {
        const isLit = one.id === lit
        const tabIcon = iconMode === 'nerd' ? one.glyph[0] : iconMode === 'line' ? one.glyph[1] : ''
        return (
          <Box key={`tabbox:${one.id}`} flexDirection="row">
            {i > 0 && <Text dimColor>·</Text>}
            <Button key={`tab:${one.id}`} plain hover={HOVER_ACCENT} onPress={() => { void selectTab($, one.id) }}>
              <Text> </Text>
              <Text color={isLit ? 'cyan' : undefined} dimColor={!isLit}>{isLit ? '◆ ' : tabIcon ? tabIcon + ' ' : ''}</Text>
              <Text color={isLit ? 'cyan' : undefined} bold={isLit} dimColor={!isLit}>{one.label}</Text>
              {badges[one.id] ? <Text color={isLit ? 'yellow' : undefined} dimColor={!isLit}>{' ' + badges[one.id]}</Text> : null}
              <Text> </Text>
            </Button>
          </Box>
        )
      })}
    </Box>
  )
}

function titleRow(el: El, page: Page, side: Action[]) {
  const { Box, Text, Button } = el
  const actions = [...side, ...page.actions]
  return (
    <Box flexDirection="row" justifyContent="space-between" height={1} overflow="hidden">
      <Box flexShrink={1} overflow="hidden">{page.title as never}</Box>
      <Box flexDirection="row" flexShrink={0} marginLeft={1}>
        {actions.map((one, i) => (
          <Box key={`act:${one.key}`} flexDirection="row">
            <Button key={one.key} plain hover={HOVER_ACCENT} onPress={one.onPress}>
              <Text> </Text>
              <Text color="cyan">{one.label}</Text>
              {one.word ? <Text dimColor>{' ' + one.word}</Text> : null}
              <Text> </Text>
            </Button>
          </Box>
        ))}
      </Box>
    </Box>
  )
}

// A run of code lines as one Code: a diff hunk made to fit them, or source
// numbered from its first line; each cut `x` columns in.
function codeRun(el: El, rows: Row[], x: number) {
  const { Code } = el
  const first = rows[0]!
  if (first.kind === 'source') {
    const lines = rows.map(row => (row.kind === 'source' ? row.text.slice(x) : ''))
    return <Code source={lines.join('\n')} path={first.path} startLine={first.no} wrap="truncate-end" />
  }
  const lines = rows.flatMap(row => (row.kind === 'diff' ? [row.line] : []))
  return <Code source={hunkOf(lines, x)} path={first.kind === 'diff' ? first.path : undefined} format="diff" wrap="truncate-end" />
}

// The slim bar beside the window: a thumb where the window is.
function barCells(total: number, room: number, offset: number): boolean[] {
  if (total <= room) return Array.from({ length: room }, () => false)
  const size = Math.max(1, Math.round((room * room) / total))
  const start = Math.round((offset / (total - room)) * (room - size))
  return Array.from({ length: room }, (_, i) => i >= start && i < start + size)
}

// Frame borders and padding: one cell of border and one of padding a side.
const FRAME_X = 4

function drawPage(el: El, page: Page, offset: number, room: number, x: number, width: number, height: number, side: Action[], tabs: Node) {
  const { Box, Text } = el
  const visible = page.rows.slice(offset, offset + room)
  const bar = barCells(page.rows.length, room, offset)
  const hasBar = page.rows.length > room
  const inner = width - FRAME_X
  // Consecutive code lines of one run are drawn by one Code.
  const blocks: { rows: Row[]; at: number }[] = []
  visible.forEach((row, i) => {
    const last = blocks[blocks.length - 1]
    const lastRow = last?.rows[last.rows.length - 1]
    if (last && lastRow && row.kind !== 'node' && lastRow.kind === row.kind && 'run' in lastRow && lastRow.run === row.run) last.rows.push(row)
    else blocks.push({ rows: [row], at: i })
  })
  const background = config.background === 'none' ? undefined : config.background
  const extra = page.extra ? 1 : 0
  return (
    <Box flexDirection="column" width={width} height={height} backgroundColor={background}>
      <Box borderStyle="round" borderDimColor paddingX={1} flexDirection="column" width={width} height={5}>
        {tabs as never}
        <Text dimColor>{'─'.repeat(Math.max(0, inner))}</Text>
        {titleRow(el, page, side)}
      </Box>
      <Box borderStyle="round" borderDimColor paddingX={1} flexDirection="column" width={width} height={room + extra + 2}>
        {page.extra ? <Box height={1} overflow="hidden">{page.extra as never}</Box> : null}
        {blocks.map(block => {
          const first = block.rows[0]!
          const content = first.kind === 'node' ? first.node : codeRun(el, block.rows, x)
          return (
            <Box key={`blk:${first.key}`} flexDirection="row" height={block.rows.length} overflow="hidden">
              <Box width={inner - 2} height={block.rows.length} overflow="hidden" flexDirection="column">{content as never}</Box>
              <Text> </Text>
              {hasBar && (
                <Box flexDirection="column" width={1}>
                  {block.rows.map((row, i) => (
                    bar[block.at + i]
                      ? <Text key={`bar:${row.key}`} color="cyan">┃</Text>
                      : <Text key={`bar:${row.key}`} dimColor>│</Text>
                  ))}
                </Box>
              )}
            </Box>
          )
        })}
      </Box>
    </Box>
  )
}

export const register: Register = (on, options) => {
  config = {
    isAutoOpen: options.autoOpen !== false,
    intervalMs: Math.max(1, Number(options.refreshSeconds ?? 2)) * 1000,
    icons: (['auto', 'line', 'nerd', 'outline', 'simple', 'off'] as const).find(one => one === options.icons) ?? 'auto',
    background: typeof options.background === 'string' && options.background.trim() !== '' ? options.background.trim() : 'none',
    rows: Math.max(10, Math.round(Number(options.rows ?? 16)) || 16),
    placement: options.placement === 'prompt' ? 'prompt' : 'side',
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Show or hide the git panel: files, changes, commits and Claude\'s plan',
      argumentHint: '[files | changes | commits | plan | diff | close]',
    }).catch(() => {})
    written.clear()
    needsLog = true
    if (config.icons === 'auto') void findIconSet($).then(found => update($, detected, () => found)).catch(() => {})
    $.clock.every(config.intervalMs, () => {
      void (async () => {
        if (await isAnyPaneShown($)) await refresh($)
      })().catch(() => {})
    })
    const started = await next(e)
    void (async () => {
      const panes = await $.ui.panes()
      // The Files pane of 0.1; and the side pane while the panel is above the prompt.
      for (const id of config.placement === 'prompt' ? [PANE, OLD_FILES_PANE] : [OLD_FILES_PANE]) {
        if (panes.some(pane => pane.id === id)) await $.ui.close({ id })
      }
      if (!config.isAutoOpen) await update($, isShown, () => false)
      else if (config.placement === 'side') await $.ui.open({ id: PANE, title: 'Git' })
      await refresh($)
    })().catch(() => {})
    return started
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const arg = String(e.args ?? '').trim().toLowerCase()
    const pick = TABS.find(one => one.id === arg)
    // Bare /git-pane toggles; a tab name always shows it on that tab.
    if (arg === 'close' || (arg === '' && await isAnyPaneShown($))) {
      await update($, isShown, () => false)
      if (config.placement === 'side') await $.ui.close({ id: PANE }).catch(() => {})
      return { text: 'Git panel hidden.' }
    }
    await update($, isShown, () => true)
    if (config.placement === 'side') {
      const opened = await $.ui.open({ id: PANE, title: 'Git' })
      if (!opened.isPlaced) return { text: `The git panel is waiting for room: ${opened.reason}` }
    }
    if (arg === 'diff') await openView($, { kind: 'all' })
    else if (pick) await selectTab($, pick.id)
    else void refresh($)
    return { text: 'Git panel shown.' }
  })

  // Claude edited a file or ran a command: show it right away.
  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    if (WRITERS.has(String(e.tool))) {
      if (String(e.tool) === 'Bash') needsLog = true
      void (async () => {
        if (await isAnyPaneShown($)) await refresh($)
      })().catch(() => {})
    }
    return result
  }).catch(($, e, next) => next(e))

  // The wheel and the scroll keys move the page's window, not the pane's, so
  // the tabs and the title stay put.
  on('ui.scroll', async ($, e, next) => {
    const isOurs = config.placement === 'side'
      ? e.component === 'Pane' && e.requestId === PANE
      : e.component === 'AbovePrompt' && (await read($, isShown))
    const page = lastPage
    if (!isOurs || page.key === '') return next(e)
    const max = Math.max(0, page.total - page.room)
    await update($, scrollY, all => ({ ...all, [page.key]: Math.min(max, Math.max(0, (all[page.key] ?? 0) + e.by)) }))
    return {}
  })

  // The side pane: docked beside the conversation (the default placement).
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const el = $.ui.resolve(e)
    return drawGit($, el, e.props.bodyColumns, e.props.scroll?.bodyRows ?? 30)
  })

  // Or the band above the prompt, with what another plugin draws there
  // (clawd-guard) under it.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (config.placement !== 'prompt' || e.props.hasSurvey || !(await read($, isShown))) return next(e)
    const below = await next(e)
    const el = $.ui.resolve(e)
    const { Box } = el
    const rows = Math.min(config.rows, (e.props.maxRows ?? 30) - (below ? 1 : 0))
    const panel = await drawGit($, el, e.props.bodyColumns, rows)
    return below ? <Box flexDirection="column">{panel}{below as never}</Box> : panel
  })
}

// The whole panel, `columns` wide and `rows` tall, wherever it is drawn.
async function drawGit($: EngineInterface, el: El, columns: number, rows: number) {
  const { Text } = el
  const width = Math.max(24, columns)
  // Inside the frames, less the scrollbar and its gap.
  const inner = width - FRAME_X - 2
  const [current, from, state, plan, offsets, x] = await Promise.all([
    read($, tab), read($, back), read($, repo), read($, board), read($, scrollY), read($, scrollX),
  ])
  const planDone = plan.tasks.filter(task => task.status === 'completed').length
  // While a diff is open, the tab it came from stays lit.
  const lit = current === 'diff' ? from : current
  const tabs = tabRow(el, $, lit, {
    changes: state.files.length > 0 ? String(state.files.length) : '',
    plan: plan.tasks.length > 0 ? `${planDone}/${plan.tasks.length}` : '',
  })

  iconMode = config.icons === 'auto' ? await read($, detected) : config.icons
  // Text is cut `x` in on every page; each builder notes how wide it would be.
  slideX = x
  widest = 0
  let page: Page
  if (current === 'plan') {
    const [ticked, open, clock] = await Promise.all([read($, boardNow), read($, openTasks), $.clock.now()])
    page = planPage(el, $, plan, Math.max(ticked, clock), open, inner)
  } else if (current === 'files') {
    const [root, list, open, shownView, typed, found] = await Promise.all([
      read($, filesRoot), read($, listing), read($, openDirs), read($, view), read($, query), read($, matches),
    ])
    const selected = shownView.kind === 'file' ? shownView.path : undefined
    page = typed === null
      ? filesPage(el, $, state, root, list, open, selected, inner)
      : searchPage(el, $, state, root, typed, found, selected, inner)
  } else if (state.root === '') {
    page = { key: 'norepo', title: <Text bold>{TABS.find(one => one.id === current)?.label ?? ''}</Text>, actions: [], rows: [
      node('norepo', <Text color="gray" wrap="truncate-end">{state.error ?? 'Looking for a git repository…'}</Text>),
    ] }
  } else if (current === 'changes') page = changesPage(el, $, state, inner)
  else if (current === 'diff') page = diffPage(el, $, await read($, shown), await read($, view), inner)
  else page = commitsPage(el, $, await read($, log), inner)

  // Anything wider than the panel slides sideways with ◀ ▶.
  const maxX = widest > inner ? widest - inner + SIDE_STEP : 0
  const side: Action[] = maxX > 0 || x > 0
    ? [
        { key: 'left', label: glyph('left'), onPress: () => { void update($, scrollX, n => Math.max(0, n - SIDE_STEP)) } },
        { key: 'right', label: glyph('right'), word: x > 0 ? `col ${x + 1}` : undefined, onPress: () => {
          void update($, scrollX, n => Math.min(maxX, n + SIDE_STEP))
        } },
      ]
    : []
  const height = Math.max(PINNED + 4, rows)
  const room = height - PINNED - (page.extra ? 1 : 0)
  const offset = Math.min(Math.max(0, page.rows.length - room), Math.max(0, offsets[page.key] ?? 0))
  lastPage = { key: page.key, total: page.rows.length, room }
  return drawPage(el, page, offset, room, x, width, height, side, tabs)
}
