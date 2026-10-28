// Drawing the panel as clawd-debug draws its pane: a header card (Git, the
// branch chip, the tree's state or the latest notice, and a key bar), the tab
// pills, and a content card titled like clawd-debug's code card: a window over
// the page's rows with a scrollbar. Diff and source rows are drawn in runs by Code.

import { atom, read } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { NoteTarget, Notice, Repo, Tab } from '../types'
import { hasDebugger, isDebuggable, slide, startNote } from './actions'
import { hunkOf } from './git'
import { changesPage, commitsPage, diffPage, filesPage, node, searchPage } from './pages'
import {
  ACCENT, BORDER, BRANCH_CHIP, CHIP_TEXT, CLAUDE_COLOR, ctx, DOT, EMPTY_REPO, EMPTY_SHOWN, ERR, FRAME_X, glyph, HEADER_ROWS, HOVER_ACCENT, OK,
  PINNED, SCROLL_THUMB, SCROLL_TRACK, SIDE_STEP, TABS, WARN,
} from './shared'
import type { Action, El, GlyphName, Node, Page, Row } from './shared'

const tab = atom({ plugin: 'clawd-git', key: 'tab' } as const, 'files')
const back = atom({ plugin: 'clawd-git', key: 'back' } as const, 'changes')
const repo = atom({ plugin: 'clawd-git', key: 'repo' } as const, EMPTY_REPO)
const view = atom({ plugin: 'clawd-git', key: 'view' } as const, { kind: 'all' })
const shown = atom({ plugin: 'clawd-git', key: 'shown' } as const, EMPTY_SHOWN)
const log = atom({ plugin: 'clawd-git', key: 'log' } as const, [])
const listing = atom({ plugin: 'clawd-git', key: 'listing' } as const, {})
const filesRoot = atom({ plugin: 'clawd-git', key: 'filesRoot' } as const, '')
const openDirs = atom({ plugin: 'clawd-git', key: 'openDirs' } as const, [])
const query = atom({ plugin: 'clawd-git', key: 'query' } as const, null)
const matches = atom({ plugin: 'clawd-git', key: 'matches' } as const, [])
const scrollY = atom({ plugin: 'clawd-git', key: 'scrollY' } as const, {})
const scrollX = atom({ plugin: 'clawd-git', key: 'scrollX' } as const, 0)
const detected = atom({ plugin: 'clawd-git', key: 'iconSet' } as const, 'simple')
const touched = atom({ plugin: 'clawd-git', key: 'touched' } as const, {})
const sessionOnly = atom({ plugin: 'clawd-git', key: 'sessionOnly' } as const, false)
const confirm = atom({ plugin: 'clawd-git', key: 'confirm' } as const, null)
const draft = atom({ plugin: 'clawd-git', key: 'draft' } as const, null)
const notice = atom({ plugin: 'clawd-git', key: 'notice' } as const, null)
const turnBase = atom({ plugin: 'clawd-git', key: 'turnBase' } as const, null)
const turnFiles = atom({ plugin: 'clawd-git', key: 'turnFiles' } as const, [])
const notes = atom({ plugin: 'clawd-git', key: 'notes' } as const, [])
const noteDraft = atom({ plugin: 'clawd-git', key: 'noteDraft' } as const, null)

// The tab row between the cards, as clawd-debug draws its tabs: pills, the lit
// one filled with the accent, each with its count.
function tabRow(el: El, lit: Tab, badges: Partial<Record<Tab, string>>, info: string, onTab: (id: Tab) => void) {
  const { Box, Text, Button } = el
  return (
    <Box flexDirection="row" height={1} overflow="hidden">
      <Text>{'  '}</Text>
      {TABS.map(one => {
        const isLit = one.id === lit
        const tabIcon = ctx.iconMode === 'nerd' ? one.glyph[0] : ctx.iconMode === 'line' ? one.glyph[1] : ''
        return (
          <Box key={`tabbox:${one.id}`} flexDirection="row">
            <Button key={`tab:${one.id}`} plain hover={isLit ? undefined : { color: ACCENT }} onPress={() => onTab(one.id)}>
              <Text backgroundColor={isLit ? ACCENT : undefined} color={isLit ? CHIP_TEXT : undefined} bold={isLit} dimColor={!isLit}>
                {` ${tabIcon ? tabIcon + ' ' : ''}${one.label}${badges[one.id] ? ' ' + badges[one.id] : ''} `}
              </Text>
            </Button>
            <Text> </Text>
          </Box>
        )
      })}
      <Text dimColor>{info ? `  ${info}` : ''}</Text>
    </Box>
  )
}

// The header card's key bar: every key always drawn, dim when the page has
// nothing for it (a button that went away would take the pane's keyboard
// focus with it), as clawd-debug's step bar.
type Slot = { id: string; key: string; label: string; icon: GlyphName; row: 1 | 2 }
const BAR: Slot[] = [
  { id: 'back', key: 'h', label: 'back', icon: 'back', row: 1 },
  { id: 'search', key: 'f', label: 'search', icon: 'search', row: 1 },
  { id: 'collapse', key: 'z', label: 'collapse', icon: 'collapse', row: 1 },
  { id: 'all', key: 'd', label: 'diff all', icon: 'diffAll', row: 1 },
  { id: 'turn', key: 't', label: 'turn', icon: 'turn', row: 1 },
  { id: 'session', key: 'b', label: "Claude's", icon: 'claude', row: 1 },
  { id: 'review', key: 'x', label: 'review', icon: 'review', row: 2 },
  { id: 'send-review', key: 'v', label: 'notes', icon: 'send', row: 2 },
  { id: 'commit', key: 'm', label: 'commit', icon: 'commit', row: 2 },
  { id: 'edit', key: 'o', label: 'open', icon: 'edit', row: 2 },
  { id: 'debug', key: 'g', label: 'debug', icon: 'debug', row: 2 },
  { id: 'refresh', key: 'r', label: 'refresh', icon: 'refresh', row: 2 },
]

const RENAMED = new Set(['Explain', 'All files', 'End search'])

// A bar icon: none in the plain set, whose glyphs are words.
function barIcon(name: GlyphName) {
  return ctx.iconMode === 'simple' || ctx.iconMode === 'off' ? '' : glyph(name)
}

function barRow(el: El, row: 1 | 2, actions: Action[]) {
  const { Box, Text, Button } = el
  return (
    <Box flexDirection="row" height={1} overflow="hidden">
      {BAR.filter(one => one.row === row).map(one => {
        const act = actions.find(each => each.key === one.id)
        const icon = barIcon(one.icon)
        // The slot's own word, and the page's count when it gives one; a few
        // pages name the key otherwise (explain a commit, end a search).
        const word = act?.word ?? ''
        const count = /\d+$/.exec(word)?.[0]
        const label = RENAMED.has(word) ? word.toLowerCase() : `${one.label}${count ? ` ${count}` : ''}`
        return (
          <Box key={`barbox:${one.id}`}>
            <Button key={one.id} hotkey={one.key} plain hover={HOVER_ACCENT} onPress={() => { act?.onPress() }}>
              <Text dimColor={!act} color={act?.color === CLAUDE_COLOR ? CLAUDE_COLOR : undefined}>{`${icon ? `${icon} ` : ''}${label}`}</Text>
            </Button>
            <Text>  </Text>
          </Box>
        )
      })}
    </Box>
  )
}

// The header card: Git, the branch as a chip, where the tree stands (or the
// latest notice), and the key bar.
function headerCard(el: El, state: Repo, said: Notice | null, actions: Action[]) {
  const { Box, Text } = el
  const icon = barIcon('git')
  const branch = state.root === '' ? 'no repository' : `${glyph('branch') ? glyph('branch') + ' ' : ''}${state.branch || 'detached'}`
  const n = state.files.length
  const status = said
    ? <Text color={said.kind === 'error' ? ERR : OK} wrap="truncate-end">{`${said.kind === 'error' ? '✗' : '✓'} ${said.text}`}</Text>
    : state.root === ''
      ? <Text dimColor wrap="truncate-end">{state.error ?? 'Looking for a git repository…'}</Text>
      : (
          <Text wrap="truncate-end">
            {n > 0 ? <Text color={WARN}>{`●${n} changed`}</Text> : <Text dimColor>clean</Text>}
            {state.ahead > 0 ? [<Text dimColor>{DOT}</Text>, <Text color={OK}>{`↑${state.ahead}`}</Text>] : null}
            {state.behind > 0 ? [<Text dimColor>{DOT}</Text>, <Text color={ERR}>{`↓${state.behind}`}</Text>] : null}
          </Text>
        )
  return (
    <Box borderStyle="round" borderColor={BORDER} paddingX={1} flexDirection="column" height={HEADER_ROWS}>
      <Box flexDirection="row" height={1} overflow="hidden">
        <Text color={ACCENT} bold>{`${icon ? `${icon} ` : ''}Git`}</Text>
        <Text>  </Text>
        <Text backgroundColor={state.root === '' ? BORDER : BRANCH_CHIP} color={CHIP_TEXT} bold>{` ${branch} `}</Text>
        <Text>  </Text>
        {status}
      </Box>
      {barRow(el, 1, actions)}
      {barRow(el, 2, actions)}
    </Box>
  )
}

// The content card's title: the page's icon and title in the accent, then
// what it is, dim; ◀ ▶ on the right when rows are wider than the card.
function titleRow(el: El, page: Page, side: Action[]) {
  const { Box, Text, Button } = el
  const icon = page.icon ? barIcon(page.icon) : ''
  return (
    <Box flexDirection="row" justifyContent="space-between" height={1} overflow="hidden">
      <Box flexDirection="row" flexShrink={1} overflow="hidden">
        <Text color={ACCENT} bold wrap="truncate-end">{`${icon ? `${icon} ` : ''}${page.title}`}</Text>
        {page.sub ? <Box flexShrink={1} overflow="hidden"><Text>  </Text>{page.sub as never}</Box> : null}
      </Box>
      <Box flexDirection="row" flexShrink={0} marginLeft={1}>
        {side.map(one => (
          <Box key={`act:${one.key}`} flexDirection="row">
            <Button key={one.key} plain hover={HOVER_ACCENT} onPress={one.onPress}>
              <Text> </Text>
              <Text color={one.color ?? ACCENT}>{one.label}</Text>
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

// The line a code row stands for, as a note names it.
function targetOf(row: Row): NoteTarget | undefined {
  if (row.kind === 'source') return { path: row.path, line: row.no, side: 'new', code: row.text }
  if (row.kind === 'diff') {
    const side = row.line.kind === 'del' ? 'old' : 'new'
    return { path: row.path, line: side === 'old' ? row.line.oldAt : row.line.newAt, side, code: row.line.text }
  }
  return undefined
}

const noteKey = (one: { path: string; side: string; line: number }) => `${one.path}|${one.side}|${one.line}`

// The column left of a run of code: + to write a note on a line, ✎ where one is.
function noteGutter(el: El, rows: Row[], noted: Set<string>, onNote: (target: NoteTarget) => void) {
  const { Box, Text, Button } = el
  return (
    <Box flexDirection="column" width={2} flexShrink={0}>
      {rows.map(row => {
        const target = targetOf(row)
        if (!target) return <Text key={`gut:${row.key}`}>{'  '}</Text>
        const has = noted.has(noteKey(target))
        return (
          <Box key={`gutbox:${row.key}`} height={1}>
            <Button key={`note:${row.key}`} plain hover={{ color: 'cyan' }} onPress={() => onNote(target)}>
              <Text color={has ? CLAUDE_COLOR : 'gray'} dimColor={!has}>{(has ? glyph('note') : glyph('addNote')) + ' '}</Text>
            </Button>
          </Box>
        )
      })}
    </Box>
  )
}

// The slim bar beside the window: a thumb where the window is.
export function barCells(total: number, room: number, offset: number): boolean[] {
  if (total <= room) return Array.from({ length: room }, () => false)
  const size = Math.max(1, Math.round((room * room) / total))
  const start = Math.round((offset / (total - room)) * (room - size))
  return Array.from({ length: room }, (_, i) => i >= start && i < start + size)
}

function drawPage(
  el: El, page: Page, offset: number, room: number, x: number, width: number, height: number,
  side: Action[], header: Node, tabs: Node, noted: Set<string>, onNote: (target: NoteTarget) => void,
) {
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
  const background = ctx.config.background === 'none' ? undefined : ctx.config.background
  const extra = page.extra ? 1 : 0
  return (
    <Box flexDirection="column" width={width} height={height} backgroundColor={background}>
      {header as never}
      {tabs as never}
      <Box borderStyle="round" borderColor={BORDER} paddingX={1} flexDirection="column" width={width} height={room + extra + 3}>
        {titleRow(el, page, side)}
        {page.extra ? <Box height={1} overflow="hidden">{page.extra as never}</Box> : null}
        {blocks.map(block => {
          const first = block.rows[0]!
          const isCode = first.kind !== 'node'
          const content = isCode ? codeRun(el, block.rows, x) : first.node
          return (
            <Box key={`blk:${first.key}`} flexDirection="row" height={block.rows.length} overflow="hidden">
              {isCode ? noteGutter(el, block.rows, noted, onNote) : null}
              <Box width={inner - 1 - (isCode ? 2 : 0)} height={block.rows.length} overflow="hidden" flexDirection="column">{content as never}</Box>
              {hasBar && (
                <Box flexDirection="column" width={1}>
                  {block.rows.map((row, i) => (
                    bar[block.at + i]
                      ? <Text key={`bar:${row.key}`} color={SCROLL_THUMB}>┃</Text>
                      : <Text key={`bar:${row.key}`} color={SCROLL_TRACK}>│</Text>
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

// The whole panel, `columns` wide and `rows` tall, wherever it is drawn.
export async function drawGit($: EngineInterface, el: El, columns: number, rows: number, onTab: (id: Tab) => void) {
  const { Text } = el
  const width = Math.max(24, columns)
  // Inside the content card, less the scrollbar.
  const inner = width - FRAME_X - 1
  const [stored, storedBack, state, offsets, x, claude, said, notesList, writingNote, base, changedThisTurn] = await Promise.all([
    read($, tab), read($, back), read($, repo), read($, scrollY), read($, scrollX), read($, touched), read($, notice),
    read($, notes), read($, noteDraft), read($, turnBase), read($, turnFiles),
  ])
  // A tab this version no longer has (0.2's Plan) falls back to Files.
  const isKnown = (one: Tab) => one === 'diff' || TABS.some(each => each.id === one)
  const current: Tab = isKnown(stored) ? stored : 'files'
  const from: Tab = isKnown(storedBack) && storedBack !== 'diff' ? storedBack : 'changes'
  // While a diff is open, the tab it came from stays lit.
  const lit = current === 'diff' ? from : current
  ctx.iconMode = ctx.config.icons === 'auto' ? await read($, detected) : ctx.config.icons

  // Text is cut `x` in on every page; each builder notes how wide it would be.
  ctx.slideX = x
  ctx.widest = 0
  let page: Page
  // clawd-debug is loaded: debuggable files get a ▷ that opens them in its pane.
  const canDebug = current !== 'commits' && (await hasDebugger($))
  if (current === 'files') {
    const [root, list, open, shownView, typed, found] = await Promise.all([
      read($, filesRoot), read($, listing), read($, openDirs), read($, view), read($, query), read($, matches),
    ])
    const selected = shownView.kind === 'file' ? shownView.path : undefined
    page = typed === null
      ? filesPage(el, $, state, root, list, open, selected, claude, inner, canDebug)
      : searchPage(el, $, state, root, typed, found, selected, claude, inner)
  } else if (state.root === '') {
    page = { key: 'norepo', title: TABS.find(one => one.id === current)?.label ?? '', actions: [], rows: [
      node('norepo', <Text color="gray" wrap="truncate-end">{state.error ?? 'Looking for a git repository…'}</Text>),
    ] }
  } else if (current === 'changes') {
    const [isSessionOnly, asked, drafting] = await Promise.all([read($, sessionOnly), read($, confirm), read($, draft)])
    page = changesPage(el, $, state, claude, isSessionOnly, asked, drafting, { files: changedThisTurn, isOn: base !== null }, notesList, inner, canDebug)
  } else if (current === 'diff') {
    const shownView = await read($, view)
    page = diffPage(el, $, await read($, shown), shownView, notesList, writingNote, inner, shownView.kind === 'file' && canDebug && isDebuggable(shownView.path))
  }
  else page = commitsPage(el, $, state, await read($, log), inner)

  // Anything wider than the panel slides sideways with ◀ ▶.
  const maxX = ctx.widest > inner ? ctx.widest - inner + SIDE_STEP : 0
  const side: Action[] = maxX > 0 || x > 0
    ? [
        { key: 'left', label: glyph('left'), onPress: () => { void slide($, -SIDE_STEP, maxX) } },
        { key: 'right', label: glyph('right'), word: x > 0 ? `col ${x + 1}` : undefined, onPress: () => { void slide($, SIDE_STEP, maxX) } },
      ]
    : []
  const height = Math.max(PINNED + 4, rows)
  const room = height - PINNED - (page.extra ? 1 : 0)
  const offset = Math.min(Math.max(0, page.rows.length - room), Math.max(0, offsets[page.key] ?? 0))
  ctx.lastPage = { key: page.key, total: page.rows.length, room }
  const noted = new Set(notesList.map(noteKey))
  // Where the window is, beside the tabs, as clawd-debug shows its details'.
  const total = page.rows.length
  const where = total > room ? `${offset + 1}–${Math.min(total, offset + room)} of ${total}` : ''
  const tabs = tabRow(el, lit, { changes: state.files.length > 0 ? String(state.files.length) : '' }, where, onTab)
  const header = headerCard(el, state, said, page.actions)
  return drawPage(el, page, offset, room, x, width, height, side, header, tabs, noted, target => { void startNote($, target) })
}
