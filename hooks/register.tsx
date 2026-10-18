import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginState, Register } from 'claude-code'

import type { Change, Entry, FileDiff, LogRow, Repo, Shown, Tab, View } from '../types'
import { iconFor } from './icons'
import { LOG_FORMAT, SEP, fit, fitPath, fsTreeRows, parseLog, parseNumstat, parseStatus, sortEntries, splitDiff } from './git'

const PANE = 'git'
const TITLE = 'Git'
const COMMAND = 'git-pane'
const FILES = 'files'
const FILES_TITLE = 'Files'

const TABS: { id: Tab; label: string }[] = [
  { id: 'changes', label: 'Changes' },
  { id: 'diff', label: 'Diff' },
  { id: 'commits', label: 'Commits' },
  { id: 'plan', label: 'Plan' },
]

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

const tab = atom({ plugin: 'clawd-git', key: 'tab' } as const, 'changes')
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
const openDirs = atom({ plugin: 'clawd-git', key: 'openDirs' } as const, [])

let config = { isAutoOpen: true, intervalMs: 2000, hasIcons: true }
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
      const shownPanes = await panesShown($)
      if (shownPanes.has(FILES)) await refreshFiles($, state.root || (await $.session.cwd()), state.root !== '')
      if (state.root === '' || !shownPanes.has(PANE)) continue
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
async function panesShown($: EngineInterface): Promise<Set<string>> {
  const panes = await $.ui.panes().catch(() => [])
  return new Set(panes.filter(pane => pane.isShown && pane.isPlaced).map(pane => pane.id))
}

async function isAnyPaneShown($: EngineInterface) {
  return (await panesShown($)).size > 0
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
  if (next === 'commits') needsLog = true
  void $.ui.scroll({ in: PANE, to: 'start' }).catch(() => {})
  await refresh($)
}

async function openView($: EngineInterface, next: View) {
  await update($, view, () => next)
  await update($, tab, () => 'diff')
  void $.ui.scroll({ in: PANE, to: 'start' }).catch(() => {})
  await refresh($)
}

async function toggleDir($: EngineInterface, path: string) {
  await update($, openDirs, list => (list.includes(path) ? list.filter(one => one !== path) : [...list, path]))
  await refresh($)
}

// A file pressed in the Files pane: its diff (or its text) in the Git pane.
async function showFile($: EngineInterface, path: string) {
  await $.ui.open({ id: PANE, title: TITLE }).catch(() => {})
  await openView($, { kind: 'file', path })
}

// ---------------------------------------------------------------- drawing

const KIND = {
  modified: { mark: 'M', color: 'yellow' },
  added: { mark: 'A', color: 'green' },
  deleted: { mark: 'D', color: 'red' },
  renamed: { mark: 'R', color: 'cyan' },
  untracked: { mark: 'U', color: 'green' },
  conflict: { mark: '!', color: 'red' },
} as const

function describe(change: Change) {
  const where = [
    change.index !== ' ' && change.index !== '?' ? 'staged' : '',
    change.worktree !== ' ' && change.worktree !== '?' ? 'unstaged' : '',
  ].filter(Boolean).join(' + ')
  const kind = change.kind === 'untracked' ? 'new file, not tracked' : change.kind
  return `${kind}${where ? ` · ${where}` : ''}${change.from ? ` · from ${change.from}` : ''}`
}

type El = ReturnType<EngineInterface['ui']['resolve']>

export const register: Register = (on, options) => {
  config = {
    isAutoOpen: options.autoOpen !== false,
    intervalMs: Math.max(1, Number(options.refreshSeconds ?? 2)) * 1000,
    hasIcons: options.icons !== false,
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Open the git panes: changed files, diffs and the commit graph (Git), and the folder tree (Files)',
      argumentHint: '[changes | diff | commits | plan | files | close]',
    }).catch(() => {})
    written.clear()
    needsLog = true
    $.clock.every(config.intervalMs, () => {
      void (async () => {
        if (await isAnyPaneShown($)) await refresh($)
      })().catch(() => {})
    })
    const started = await next(e)
    if (config.isAutoOpen) {
      // Files first, so Git is the pane shown.
      void (async () => {
        await $.ui.open({ id: FILES, title: FILES_TITLE })
        await $.ui.open({ id: PANE, title: TITLE })
        await refresh($)
      })().catch(() => {})
    }
    return started
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const arg = String(e.args ?? '').trim().toLowerCase()
    if (arg === 'close') {
      await $.ui.close({ id: PANE }).catch(() => {})
      await $.ui.close({ id: FILES }).catch(() => {})
      return { text: 'Git panes closed.' }
    }
    if (arg === 'files') {
      const opened = await $.ui.open({ id: FILES, title: FILES_TITLE })
      await refresh($)
      return { text: opened.isPlaced ? 'Files pane opened.' : `Files pane is waiting for room: ${opened.reason}` }
    }
    const opened = await $.ui.open({ id: PANE, title: TITLE })
    const pick = TABS.find(one => one.id === arg)
    if (pick) await selectTab($, pick.id)
    else void refresh($)
    return { text: opened.isPlaced ? 'Git pane opened.' : `Git pane is waiting for room: ${opened.reason}` }
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

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const el = $.ui.resolve(e)
    const { Box, Text, Button } = el
    const width = Math.max(20, e.props.bodyColumns)
    const [current, state, plan] = await Promise.all([read($, tab), read($, repo), read($, board)])
    const planDone = plan.tasks.filter(task => task.status === 'completed').length

    const added = state.files.reduce((n, one) => n + one.added, 0)
    const removed = state.files.reduce((n, one) => n + one.removed, 0)

    const header = state.root === ''
      ? <Text color="red" wrap="truncate-end">{state.error ?? 'Looking for a git repository…'}</Text>
      : (
        <Text wrap="truncate-end">
          <Text color="magenta">⎇ </Text>
          <Text bold>{state.branch || 'detached'}</Text>
          {state.ahead > 0 && <Text color="green">{` ↑${state.ahead}`}</Text>}
          {state.behind > 0 && <Text color="red">{` ↓${state.behind}`}</Text>}
          <Text dimColor>{`  ${state.files.length} changed  `}</Text>
          <Text color="green">{`+${added}`}</Text>
          <Text> </Text>
          <Text color="red">{`−${removed}`}</Text>
        </Text>
      )

    const tabs = (
      <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
        {TABS.map((one, i) => (
          <Button
            key={`tab:${one.id}`}
            hotkey={String(i + 1)}
            variant={one.id === current ? 'primary' : undefined}
            label={one.id === 'changes' && state.files.length > 0
              ? `${one.label} ${state.files.length}`
              : one.id === 'plan' && plan.tasks.length > 0 ? `${one.label} ${planDone}/${plan.tasks.length}` : one.label}
            onPress={() => { void selectTab($, one.id) }}
          />
        ))}
      </Box>
    )

    let body
    if (current === 'plan') {
      const [ticked, open, clock] = await Promise.all([read($, boardNow), read($, openTasks), $.clock.now()])
      body = planTab(el, $, plan, Math.max(ticked, clock), open, width)
    } else if (state.root === '') body = <Text dimColor>Start Claude inside a git repository to see its changes.</Text>
    else if (current === 'changes') body = changesTab(el, $, state, width)
    else if (current === 'diff') body = diffTab(el, $, await read($, shown), await read($, view), width)
    else if (current === 'commits') body = commitsTab(el, $, await read($, log), width)

    return (
      <Box flexDirection="column">
        {header}
        {tabs}
        <Text dimColor>{'─'.repeat(width)}</Text>
        {body}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: FILES }, async ($, e) => {
    const el = $.ui.resolve(e)
    const width = Math.max(20, e.props.bodyColumns)
    const [state, root, list, open, current] = await Promise.all([
      read($, repo), read($, filesRoot), read($, listing), read($, openDirs), read($, view),
    ])
    const selected = current.kind === 'file' ? current.path : undefined
    return filesPane(el, $, state, root, list, open, selected, width)
  })
}

// ---------------------------------------------------------------- tabs

function changesTab({ Box, Text, Button }: El, $: EngineInterface, state: Repo, width: number) {
  if (state.files.length === 0) return <Text dimColor>Working tree clean.</Text>
  const groups: { title: string; files: Change[] }[] = [
    { title: 'Conflicts', files: state.files.filter(one => one.kind === 'conflict') },
    { title: 'Staged', files: state.files.filter(one => one.kind !== 'conflict' && one.kind !== 'untracked' && one.index !== ' ') },
    { title: 'Changes', files: state.files.filter(one => one.kind !== 'conflict' && one.kind !== 'untracked' && one.index === ' ') },
    { title: 'New files', files: state.files.filter(one => one.kind === 'untracked') },
  ]
  return (
    <Box flexDirection="column">
      <Button key="all" plain label="▸ Show all changes as one diff" onPress={() => { void openView($, { kind: 'all' }) }} />
      {groups.filter(group => group.files.length > 0).map(group => (
        <Box key={`g:${group.title}`} flexDirection="column" marginTop={1}>
          <Text bold dimColor>{`${group.title} (${group.files.length})`}</Text>
          {group.files.map(one => {
            const kind = KIND[one.kind]
            const counts = `+${one.added} −${one.removed}`
            const room = Math.max(8, width - counts.length - 4)
            const shownPath = fitPath(one.path, room)
            const slash = shownPath.lastIndexOf('/')
            return (
              <Button key={`chg:${one.path}`} plain onPress={() => { void openView($, { kind: 'file', path: one.path }) }}>
                <Text color={kind.color}>{`${kind.mark} `}</Text>
                <Text dimColor>{shownPath.slice(0, slash + 1)}</Text>
                {shownPath.slice(slash + 1)}
                <Text>{' '.repeat(Math.max(1, room - shownPath.length + 1))}</Text>
                <Text color="green">{`+${one.added}`}</Text>
                <Text> </Text>
                <Text color="red">{`−${one.removed}`}</Text>
              </Button>
            )
          })}
        </Box>
      ))}
    </Box>
  )
}

function diffTab({ Box, Text, Button, Code }: El, $: EngineInterface, one: Shown, current: View, width: number) {
  const isStale = one.of !== viewKey(current)
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" columnGap={1}>
        {current.kind !== 'all' && <Button key="back" label="← All changes" onPress={() => { void openView($, { kind: 'all' }) }} />}
        <Text bold wrap="truncate-end">{isStale ? 'Loading…' : fit(one.title, width - 18)}</Text>
      </Box>
      {!isStale && one.detail && <Text dimColor>{one.detail}</Text>}
      {!isStale && one.diffs.length === 0 && !one.source && <Text dimColor>Nothing to show.</Text>}
      {!isStale && one.source && (
        <Box marginTop={1} flexDirection="column">
          <Code source={one.source.text} path={one.source.path} startLine={1} wrap="truncate-end" />
          {one.source.isCut && <Text dimColor>{`… only the first ${SOURCE_LINES} lines are shown`}</Text>}
        </Box>
      )}
      {!isStale && one.diffs.map((file, i) => (
        <Box key={`d:${i}:${file.path}`} flexDirection="column" marginTop={1}>
          {current.kind === 'file'
            ? null
            : (
              <Button key={`dh:${i}:${file.path}`} plain onPress={() => { void openView($, { kind: 'file', path: file.path }) }}>
                <Text bold>{fitPath(file.path, Math.max(8, width - 16))}</Text>
                <Text>  </Text>
                <Text color="green">{`+${file.added}`}</Text>
                <Text> </Text>
                <Text color="red">{`−${file.removed}`}</Text>
              </Button>
            )}
          {file.hunks !== '' && <Code source={file.hunks} path={file.path} format="diff" wrap="truncate-end" />}
          {file.note && <Text dimColor>{file.note}</Text>}
        </Box>
      ))}
      {!isStale && one.isCut && <Text dimColor>… the rest is too large for the pane</Text>}
    </Box>
  )
}

const GRAPH_COLORS = ['magenta', 'cyan', 'yellow', 'green', 'blue', 'red']

function commitsTab({ Box, Text, Button }: El, $: EngineInterface, rows: LogRow[], width: number) {
  if (rows.length === 0) return <Text dimColor>No commits yet.</Text>
  return (
    <Box flexDirection="column">
      {rows.map((row, i) => {
        // Color each graph column, so the lanes are easy to follow.
        const graph = [...row.graph].map((c, col) => (c === ' ' ? ' ' : <Text color={c === '*' ? 'white' : GRAPH_COLORS[Math.floor(col / 2) % GRAPH_COLORS.length]}>{c === '*' ? '●' : c}</Text>))
        if (!row.hash) return <Text key={`l:${i}`}>{graph}</Text>
        const refs = row.refs ? ` (${row.refs})` : ''
        const tail = `  ${row.author} · ${row.age}`
        const room = Math.max(4, width - row.graph.length - row.hash.length - 2 - refs.length - tail.length)
        return (
          <Button key={`c:${row.hash}:${i}`} plain onPress={() => { void openView($, { kind: 'commit', hash: row.hash! }) }}>
            {graph}
            <Text> </Text>
            <Text color="yellow">{row.hash}</Text>
            {refs !== '' && <Text color="cyan">{fit(refs, Math.max(6, width - row.graph.length - row.hash.length - 12))}</Text>}
            <Text>{' ' + fit(row.subject ?? '', room)}</Text>
            {room > 12 && <Text dimColor>{fit(tail, Math.max(0, width - row.graph.length - row.hash.length - refs.length - (row.subject ?? '').length - 2))}</Text>}
          </Button>
        )
      })}
      <Text dimColor>{`Showing up to ${LOG_LIMIT} commits on all branches. Press one to see its diff.`}</Text>
    </Box>
  )
}

// Status marks in the Files pane, in the person's theme colors.
const TREE_KIND = {
  modified: { mark: 'M', color: 'warning' },
  added: { mark: 'A', color: 'success' },
  deleted: { mark: 'D', color: 'error' },
  renamed: { mark: 'R', color: 'suggestion' },
  untracked: { mark: 'U', color: 'success' },
  conflict: { mark: '!', color: 'error' },
} as const

function filesPane(
  { Box, Text, Button }: El, $: EngineInterface, state: Repo, root: string,
  list: Record<string, Entry[]>, open: string[], selected: string | undefined, width: number,
) {
  const name = root.split('/').pop() || root
  if (root === '' || list[''] === undefined) return <Text color="subtle">Reading {name || 'the folder'}…</Text>
  const changed = new Map(state.files.map(one => [one.path, one]))
  const rows = fsTreeRows(list, open, new Set(changed.keys()), TREE_ROWS)
  const count = state.files.length
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" justifyContent="space-between" marginBottom={1}>
        <Text bold wrap="truncate-end">{fit(name, Math.max(8, width - 22))}</Text>
        <Box flexDirection="row" columnGap={2}>
          {count > 0 && <Text color="subtle">{`${count} changed`}</Text>}
          {open.length > 0 && (
            <Box key="collapse-row">
              <Button key="collapse" plain dimColor hover={{ color: 'suggestion' }} label="collapse"
                onPress={() => { void update($, openDirs, () => []) }} />
            </Box>
          )}
        </Box>
      </Box>
      {rows.map(row => {
        // A thin guide per level, as editors draw them; no branches.
        const guides = '│ '.repeat(row.depth)
        const iconCells = config.hasIcons ? 2 : 0
        const room = Math.max(4, width - guides.length - 2 - iconCells - 2)
        if (!row.isDir && row.label.startsWith('… ')) {
          return <Text key={`more:${row.path}`} color="subtle">{guides + '  ' + row.label}</Text>
        }
        const change = row.isDir ? undefined : changed.get(row.path)
        const kind = change ? TREE_KIND[change.kind] : undefined
        const isSelected = !row.isDir && row.path === selected
        const label = fit(row.label, room)
        const pad = ' '.repeat(Math.max(1, room - label.length + 1))
        const mark = kind ? kind.mark : row.isChanged ? '•' : ' '
        const nameColor = isSelected ? 'suggestion' : kind ? kind.color : undefined
        return (
          <Box key={`row:${row.path}`}>
          <Button
            key={`${row.isDir ? 'dir' : 'file'}:${row.path}`}
            plain
            hover={{ color: 'suggestion' }}
            onPress={() => { void (row.isDir ? toggleDir($, row.path) : showFile($, row.path)) }}
          >
            <Text color="subtle" dimColor>{guides}</Text>
            <Text color="subtle">{row.isDir ? (row.isOpen ? '▾ ' : '▸ ') : '  '}</Text>
            {config.hasIcons && (() => {
              const icon = iconFor(row.label, row.isDir, row.isOpen)
              return <Text color={icon.color} dimColor={row.isIgnored}>{icon.glyph + ' '}</Text>
            })()}
            <Text color={nameColor} bold={isSelected} dimColor={row.isIgnored && !kind}>{label}</Text>
            <Text color="subtle">{row.isLoading ? ' …' : ''}</Text>
            <Text>{pad.slice(row.isLoading ? 2 : 0)}</Text>
            <Text color={kind ? kind.color : 'warning'} dimColor={!kind}>{mark}</Text>
          </Button>
          </Box>
        )
      })}
      {rows.length >= TREE_ROWS && <Text color="subtle">… more; collapse some folders to see the rest</Text>}
    </Box>
  )
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
  completed: { mark: '✓', color: 'success' },
  in_progress: { mark: '●', color: 'warning' },
  pending: { mark: '○', color: 'subtle' },
} as const

// Claude's plan from clawd-tasks: progress, each task with its time and the
// files it changed; the running task (and any pressed one) open to its steps.
function planTab({ Box, Text, Button }: El, $: EngineInterface, plan: Board, now: number, open: string[], width: number) {
  if (plan.tasks.length === 0) {
    return (
      <Box flexDirection="column">
        <Text bold>No plan yet</Text>
        <Text color="subtle">Claude's plan shows here, live, when it starts work of three or more steps.</Text>
        <Text color="subtle">It comes from clawd-tasks; keep that plugin installed and enabled.</Text>
        {plan.loose > 0 && <Text color="subtle">{`${plan.loose} tool calls so far outside any task`}</Text>}
      </Box>
    )
  }
  const done = plan.tasks.filter(task => task.status === 'completed').length
  const total = plan.tasks.length
  const took = plan.startedAt === undefined ? '' : ` · ${duration(now - plan.startedAt)}`
  const barWidth = Math.max(10, width - 2)
  const filled = Math.round((done / total) * barWidth)
  const runningId = [...plan.tasks].reverse().find(task => task.status === 'in_progress')?.id
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" justifyContent="space-between">
        <Text bold>Plan</Text>
        <Text color="subtle">{`${done}/${total} done${took}`}</Text>
      </Box>
      <Text>
        <Text color="success">{'━'.repeat(filled)}</Text>
        <Text color="subtle" dimColor>{'━'.repeat(barWidth - filled)}</Text>
      </Text>
      {plan.tasks.map((task, i) => {
        const status = STATUS[task.status]
        const isRunning = task.id === runningId
        const isOpen = isRunning || open.includes(task.id)
        const added = task.files.reduce((n, file) => n + file.added, 0)
        const removed = task.files.reduce((n, file) => n + file.removed, 0)
        const time = taskTime(task, now)
        const facts = [time, task.agents > 0 ? `${task.agents} agent${task.agents > 1 ? 's' : ''}` : ''].filter(Boolean).join(' · ')
        const counts = task.files.length > 0 ? `+${added} −${removed}` : ''
        const right = [facts, counts].filter(Boolean).join('  ')
        const title = isRunning ? task.activeForm || task.subject : task.subject
        const room = Math.max(6, width - 4 - right.length - 2)
        const label = fit(title, room)
        const hasMore = task.steps.length > 0 || task.files.length > 0
        const steps = isOpen ? task.steps.slice(isRunning && !open.includes(task.id) ? -6 : -30) : []
        const earlier = isOpen ? task.dropped + task.steps.length - steps.length : 0
        return (
          <Box key={`task:${task.id}`} flexDirection="column" marginTop={i === 0 ? 1 : 0}>
            <Box key={`taskrow:${task.id}`}>
              <Button key={`t:${task.id}`} plain hover={{ color: 'suggestion' }} onPress={() => { void toggleTask($, task.id) }}>
                <Text color={status.color}>{`${status.mark} `}</Text>
                <Text bold={isRunning} color={task.status === 'completed' ? 'subtle' : undefined}>{label}</Text>
                <Text>{' '.repeat(Math.max(1, room - label.length + 1))}</Text>
                {facts !== '' && <Text color={isRunning ? 'warning' : 'subtle'}>{facts}</Text>}
                {counts !== '' && <Text>  </Text>}
                {counts !== '' && <Text color="success">{`+${added}`}</Text>}
                {counts !== '' && <Text color="error">{` −${removed}`}</Text>}
                <Text color="subtle">{hasMore && !isRunning ? (isOpen ? ' ▾' : ' ▸') : '  '}</Text>
              </Button>
            </Box>
            {isOpen && earlier > 0 && <Text color="subtle">{`  │ ${earlier} earlier steps`}</Text>}
            {steps.map(step => {
              const tool = shortTool(step.tool).slice(0, 7).padEnd(7)
              const when = step.isError ? 'failed' : step.endedAt === undefined ? 'running' : duration(step.endedAt - step.startedAt)
              const stepRoom = Math.max(6, width - 4 - 8 - when.length - 2)
              const text = fit(step.label + (step.agentId ? ' (agent)' : ''), stepRoom)
              return (
                <Text key={`s:${task.id}:${step.id}`} wrap="truncate-end">
                  <Text color="subtle">{'  │ '}</Text>
                  <Text color={step.isError ? 'error' : step.endedAt === undefined ? 'warning' : 'suggestion'}>{tool}</Text>
                  <Text color={step.endedAt === undefined ? undefined : 'subtle'}>{' ' + text}</Text>
                  <Text>{' '.repeat(Math.max(1, stepRoom - text.length + 1))}</Text>
                  <Text color={step.isError ? 'error' : 'subtle'}>{when}</Text>
                </Text>
              )
            })}
            {isOpen && task.files.map(file => {
              const icon = config.hasIcons ? iconFor(file.path.split('/').pop() ?? file.path, false, false) : undefined
              const tail = `+${file.added} −${file.removed}`
              const fileRoom = Math.max(6, width - 4 - (icon ? 2 : 0) - tail.length - 2)
              const path = fitPath(file.path, fileRoom)
              return (
                <Box key={`frow:${task.id}:${file.path}`}>
                  <Button key={`f:${task.id}:${file.path}`} plain hover={{ color: 'suggestion' }} onPress={() => { void openView($, { kind: 'file', path: file.path }) }}>
                    <Text color="subtle">{'  │ '}</Text>
                    {icon && <Text color={icon.color}>{icon.glyph + ' '}</Text>}
                    <Text>{path}</Text>
                    <Text>{' '.repeat(Math.max(1, fileRoom - path.length + 1))}</Text>
                    <Text color="success">{`+${file.added}`}</Text>
                    <Text color="error">{` −${file.removed}`}</Text>
                  </Button>
                </Box>
              )
            })}
          </Box>
        )
      })}
      {plan.loose > 0 && <Box marginTop={1}><Text color="subtle">{`${plan.loose} tool calls outside any task`}</Text></Box>}
    </Box>
  )
}
