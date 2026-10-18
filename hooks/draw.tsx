// Drawing the panel: the header frame (tabs, a divider that carries notices,
// the title line and toolbar) and the content frame, a window over the page's
// rows with a slim scrollbar. Diff and source rows are drawn in runs by Code.

import { atom, read } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { NoteTarget, Notice, Tab } from '../types'
import { slide, startNote } from './actions'
import { hunkOf } from './git'
import { changesPage, commitsPage, diffPage, filesPage, node, searchPage } from './pages'
import {
  CLAUDE_COLOR, EMPTY_REPO, EMPTY_SHOWN, FRAME_X, HOVER_ACCENT, PINNED, SIDE_STEP, TABS, ctx, glyph,
} from './shared'
import type { Action, El, Node, Page, Row } from './shared'

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

function tabRow(el: El, lit: Tab, badges: Partial<Record<Tab, string>>, onTab: (id: Tab) => void) {
  const { Box, Text, Button } = el
  return (
    <Box flexDirection="row" height={1} overflow="hidden">
      {TABS.map((one, i) => {
        const isLit = one.id === lit
        const tabIcon = ctx.iconMode === 'nerd' ? one.glyph[0] : ctx.iconMode === 'line' ? one.glyph[1] : ''
        return (
          <Box key={`tabbox:${one.id}`} flexDirection="row">
            {i > 0 && <Text dimColor>·</Text>}
            <Button key={`tab:${one.id}`} plain hover={HOVER_ACCENT} onPress={() => onTab(one.id)}>
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
        {actions.map(one => (
          <Box key={`act:${one.key}`} flexDirection="row">
            <Button key={one.key} plain hover={HOVER_ACCENT} onPress={one.onPress}>
              <Text> </Text>
              <Text color={one.color ?? 'cyan'}>{one.label}</Text>
              {one.word ? <Text dimColor>{' ' + one.word}</Text> : null}
              <Text> </Text>
            </Button>
          </Box>
        ))}
      </Box>
    </Box>
  )
}

// The divider under the tabs, carrying the latest notice when there is one.
function divider(el: El, inner: number, said: Notice | null) {
  const { Text } = el
  if (!said) return <Text dimColor>{'─'.repeat(Math.max(0, inner))}</Text>
  const text = ` ${said.kind === 'error' ? '✗' : '✓'} ${said.text} `.slice(0, Math.max(0, inner - 4))
  return (
    <Text wrap="truncate-end">
      <Text dimColor>──</Text>
      <Text color={said.kind === 'error' ? 'red' : 'green'}>{text}</Text>
      <Text dimColor>{'─'.repeat(Math.max(0, inner - 2 - text.length))}</Text>
    </Text>
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
  side: Action[], tabs: Node, said: Notice | null, noted: Set<string>, onNote: (target: NoteTarget) => void,
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
      <Box borderStyle="round" borderDimColor paddingX={1} flexDirection="column" width={width} height={room + extra + PINNED}>
        {tabs as never}
        {divider(el, inner, said)}
        {titleRow(el, page, side)}
        <Text dimColor>{'─'.repeat(Math.max(0, inner))}</Text>
        {page.extra ? <Box height={1} overflow="hidden">{page.extra as never}</Box> : null}
        {blocks.map(block => {
          const first = block.rows[0]!
          const isCode = first.kind !== 'node'
          const content = isCode ? codeRun(el, block.rows, x) : first.node
          return (
            <Box key={`blk:${first.key}`} flexDirection="row" height={block.rows.length} overflow="hidden">
              {isCode ? noteGutter(el, block.rows, noted, onNote) : null}
              <Box width={inner - 2 - (isCode ? 2 : 0)} height={block.rows.length} overflow="hidden" flexDirection="column">{content as never}</Box>
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

// The whole panel, `columns` wide and `rows` tall, wherever it is drawn.
export async function drawGit($: EngineInterface, el: El, columns: number, rows: number, onTab: (id: Tab) => void) {
  const { Text } = el
  const width = Math.max(24, columns)
  // Inside the frames, less the scrollbar and its gap.
  const inner = width - FRAME_X - 2
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
  const tabs = tabRow(el, lit, {
    changes: state.files.length > 0 ? String(state.files.length) : '',
  }, onTab)

  // Text is cut `x` in on every page; each builder notes how wide it would be.
  ctx.slideX = x
  ctx.widest = 0
  let page: Page
  if (current === 'files') {
    const [root, list, open, shownView, typed, found] = await Promise.all([
      read($, filesRoot), read($, listing), read($, openDirs), read($, view), read($, query), read($, matches),
    ])
    const selected = shownView.kind === 'file' ? shownView.path : undefined
    page = typed === null
      ? filesPage(el, $, state, root, list, open, selected, claude, inner)
      : searchPage(el, $, state, root, typed, found, selected, claude, inner)
  } else if (state.root === '') {
    page = { key: 'norepo', title: <Text bold>{TABS.find(one => one.id === current)?.label ?? ''}</Text>, actions: [], rows: [
      node('norepo', <Text color="gray" wrap="truncate-end">{state.error ?? 'Looking for a git repository…'}</Text>),
    ] }
  } else if (current === 'changes') {
    const [isSessionOnly, asked, drafting] = await Promise.all([read($, sessionOnly), read($, confirm), read($, draft)])
    page = changesPage(el, $, state, claude, isSessionOnly, asked, drafting, { files: changedThisTurn, isOn: base !== null }, notesList, inner)
  } else if (current === 'diff') page = diffPage(el, $, await read($, shown), await read($, view), notesList, writingNote, inner)
  else page = commitsPage(el, $, await read($, log), inner)

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
  return drawPage(el, page, offset, room, x, width, height, side, tabs, said, noted, target => { void startNote($, target) })
}
