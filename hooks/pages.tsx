// Each tab as a Page: a title, a toolbar, and rows one line tall each. Pure:
// a page is built from the values it is handed; presses call the actions.

import type { EngineInterface } from 'claude-code'

import type { Change, Confirm, Draft, Entry, LogRow, Note, NoteTarget, Repo, Shown, Touch, View } from '../types'
import {
  askDiscard, askReview, cancelConfirm, cancelNote, clearNotes, closeSearch, collapseAll, commitDraft,
  confirmDiscard, debugFile, draftCommit, draftToClaude, dropDraft, goBack, openInEditor, openSearch, openView, reload,
  isDebuggable, removeNote, saveNote, search, sendReview, stage, toggleDir, toggleSessionOnly, unstage,
} from './actions'
import { fit, fitPath, fsTreeRows, hunkLines } from './git'
import { iconFor, lineIconFor, outlineIconFor, simpleIconFor } from './icons'
import {
  ACCENT, BRANCH_CHIP, CHIP_TEXT, CLAUDE_COLOR, ctx, DOT, glyph, HOVER, LOG_LIMIT, SEARCH_RESULTS, slid, SOURCE_LINES, TREE_ROWS, viewKey,
} from './shared'
import type { Action, El, Node, Page, Row } from './shared'

// ---------------------------------------------------------------- pieces

// A folder as the statusbar writes it: home as ~.
export function homePath(path: string) {
  return path.replace(/^\/(home|Users)\/[^/]+/, '~')
}

// The statusbar's line: parts joined by a dim " · "; a `chip` part is drawn
// as a chip (dark text on that colour) and needs no dot after it.
export function parts(el: El, items: { text: string; color?: string; bold?: boolean; dim?: boolean; chip?: string }[]) {
  const { Text } = el
  const shown = items.filter(one => one.text !== '')
  return (
    <Text wrap="truncate-end">
      {shown.map((one, i) => [
        i > 0 ? <Text dimColor>{shown[i - 1]?.chip ? '  ' : DOT}</Text> : null,
        one.chip
          ? <Text backgroundColor={one.chip} color={CHIP_TEXT} bold>{` ${one.text} `}</Text>
          : <Text color={one.color} bold={one.bold} dimColor={one.dim}>{one.text}</Text>,
      ])}
    </Text>
  )
}

// The first header line: the repository's folder, whole when it fits; a long
// one loses its start (…/sites/app), since the end names the project.
function pathTitle(el: El, root: string, fallback: string) {
  const { Text } = el
  return <Text color={ACCENT} bold wrap="truncate-start">{homePath(root) || fallback}</Text>
}

// The branch as a chip, for the second header line.
function branchChip(state: Repo) {
  return { text: `${glyph('branch') ? glyph('branch') + ' ' : ''}${state.branch || 'detached'}`, chip: BRANCH_CHIP }
}

export function node(key: string, one: Node): Row {
  return { kind: 'node', key, node: one }
}

// Status marks, in the terminal's colors.
const KIND_STYLE = {
  modified: { mark: 'M', color: 'yellow' },
  added: { mark: 'A', color: 'green' },
  deleted: { mark: 'D', color: 'red' },
  renamed: { mark: 'R', color: 'cyan' },
  untracked: { mark: 'U', color: 'green' },
  conflict: { mark: '!', color: 'red' },
} as const

function iconText({ Text }: El, name: string, isDir: boolean, isOpen: boolean, isDim: boolean, isSelected: boolean) {
  if (ctx.iconMode === 'off') return null
  const icon = ctx.iconMode === 'nerd' ? iconFor(name, isDir, isOpen)
    : ctx.iconMode === 'line' ? lineIconFor(name, isDir, isOpen)
    : ctx.iconMode === 'outline' ? outlineIconFor(name, isDir, isOpen)
    : simpleIconFor(name, isDir, isOpen)
  return <Text color={isSelected ? 'cyan' : icon.color} dimColor={isDim && !isSelected}>{icon.glyph + ' '}</Text>
}

// Claude's mark on a file it changed this session.
function claudeMark({ Text }: El, isTouched: boolean) {
  return isTouched ? <Text color={CLAUDE_COLOR}>{' ' + glyph('claude')}</Text> : null
}

// A file line: icon, name, its folder dim, then right-aligned figures.
function fileLine(
  el: El, key: string, path: string, width: number, onPress: () => void,
  opts: {
    color?: string; isSelected?: boolean; isStruck?: boolean; showDir?: boolean
    tail?: Node; tailWidth?: number; isTailInline?: boolean; isTouched?: boolean
  },
) {
  const { Box, Text, Button } = el
  const slash = path.lastIndexOf('/')
  const name = path.slice(slash + 1)
  const dir = opts.showDir === false || slash <= 0 ? '' : path.slice(0, slash)
  const icon = ctx.iconMode === 'off' ? 0 : 2
  const mark = opts.isTouched ? 2 : 0
  const room = Math.max(6, width - icon - mark - (opts.tailWidth ?? 0) - 1)
  ctx.widest = Math.max(ctx.widest, icon + mark + name.length + (dir ? dir.length + 1 : 0) + (opts.tailWidth ?? 0) + 1)
  const shownName = fit(name.slice(ctx.slideX), room)
  const restDir = dir.slice(Math.max(0, ctx.slideX - name.length))
  const shownDir = restDir === '' ? '' : ' ' + fitPath(restDir, Math.max(0, room - shownName.length - 1))
  const pad = opts.isTailInline ? ' ' : ' '.repeat(Math.max(1, room - shownName.length - shownDir.length + 1))
  // After an inline tail, blanks to the row's end, so the hover spans it.
  const fill = opts.isTailInline ? ' '.repeat(Math.max(0, room - shownName.length - shownDir.length - 1)) : ''
  const sel = opts.isSelected === true
  return (
    <Box key={`${key}:box`} height={1} overflow="hidden" flexGrow={1}>
      <Button key={key} plain hover={HOVER} onPress={onPress}>
        {iconText(el, name, false, false, false, sel)}
        <Text color={sel ? 'cyan' : opts.color} bold={sel} strikethrough={opts.isStruck}>{shownName}</Text>
        {claudeMark(el, opts.isTouched === true)}
        <Text color={sel ? 'cyan' : 'gray'} dimColor={!sel}>{shownDir}</Text>
        <Text>{pad}</Text>
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

// Small buttons at a row's right end (stage, unstage, discard).
function rowButtons(el: El, key: string, buttons: { key: string; label: string; color: string; onPress: () => void }[]) {
  const { Box, Text, Button } = el
  return (
    <Box key={`${key}:acts`} flexDirection="row" flexShrink={0}>
      {buttons.map(one => (
        <Box key={`${one.key}:box`}>
          <Button key={one.key} plain hover={{ color: 'cyan', underline: true }} onPress={one.onPress}>
            <Text color={one.color}>{` ${one.label} `}</Text>
          </Button>
        </Box>
      ))}
    </Box>
  )
}

// ---------------------------------------------------------------- Files

export function filesPage(
  el: El, $: EngineInterface, state: Repo, root: string, list: Record<string, Entry[]>,
  open: string[], selected: string | undefined, touched: Record<string, Touch>, width: number,
  canDebug = false,
): Page {
  const { Box, Text, Button } = el
  const page: Page = {
    key: 'files',
    title: pathTitle(el, root, 'Files'),
    subtitle: parts(el, [
      branchChip(state),
      { text: state.files.length > 0 ? `●${state.files.length} changed` : 'clean', color: state.files.length > 0 ? 'yellow' : undefined, dim: state.files.length === 0 },
    ]),
    actions: [
      { key: 'search', label: glyph('search'), word: 'Search', onPress: () => { void openSearch($) } },
      ...(open.length > 0 ? [{ key: 'collapse', label: glyph('collapse'), word: 'Collapse', onPress: () => { void collapseAll($) } }] : []),
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
    const isTouched = !row.isDir && touched[row.path] !== undefined
    const ink = sel ? 'cyan' : undefined
    const lead = guides.length + 2 + (ctx.iconMode === 'off' ? 0 : 2)
    const room = Math.max(4, width - lead - 5)
    const label = fit(slid(row.label, lead + row.label.length + 5), room)
    // The change mark sits right after the name; a folder holding changes is tinted.
    const mark = style ? ` ${style.mark}` : row.isChanged ? ' •' : ''
    const tint = style ? style.color : row.isChanged ? 'yellow' : undefined
    const debug = canDebug && !row.isDir && isDebuggable(row.path)
    const pad = ' '.repeat(Math.max(0, width - lead - label.length - mark.length - (isTouched ? 2 : 0) - (row.isLoading ? 2 : 0) - (debug ? 3 : 0)))
    page.rows.push(node(`row:${row.path}`, (
      <Box key={`row:${row.path}`} flexDirection="row" height={1} overflow="hidden">
        <Button
          key={`${row.isDir ? 'dir' : 'file'}:${row.path}`}
          plain
          hover={HOVER}
          onPress={() => { void (row.isDir ? toggleDir($, row.path) : openView($, { kind: 'file', path: row.path })) }}
        >
          <Text color={ink ?? 'gray'} dimColor={!sel}>{guides}</Text>
          <Text color={ink ?? 'gray'}>{row.isDir ? `${glyph(row.isOpen ? 'open' : 'shut')} ` : '  '}</Text>
          {iconText(el, row.label, row.isDir, row.isOpen, row.isIgnored, sel)}
          <Text color={ink ?? tint} bold={sel} dimColor={row.isIgnored && !tint && !sel}>{label}</Text>
          <Text color={ink ?? tint}>{mark}</Text>
          {claudeMark(el, isTouched)}
          <Text color="gray">{row.isLoading ? ' …' : ''}</Text>
          <Text>{pad}</Text>
        </Button>
        {debug ? rowButtons(el, `fdbg:${row.path}`, [debugButton($, row.path)]) : null}
      </Box>
    )))
  }
  return page
}

// The ▷ on a file's row: open it in clawd-debug.
function debugButton($: EngineInterface, path: string) {
  return { key: `debug:${path}`, label: glyph('debug'), color: 'cyan', onPress: () => { void debugFile($, path) } }
}

// Search over every file git knows (tracked and new, not ignored).
export function searchPage(
  el: El, $: EngineInterface, state: Repo, root: string,
  typed: string, found: string[], selected: string | undefined, touched: Record<string, Touch>, width: number,
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
      isTouched: touched[path] !== undefined,
      tail: style ? <Text color={style.color}>{style.mark}</Text> : null,
      tailWidth: style ? 1 : 0,
      isTailInline: true,
    })))
  }
  return page
}

// ---------------------------------------------------------------- Changes

function isStaged(one: Change) {
  return one.kind !== 'untracked' && one.kind !== 'conflict' && one.index !== ' '
}

function hasUnstaged(one: Change) {
  return one.kind === 'untracked' || (one.worktree !== ' ' && one.worktree !== '?')
}

export function changesPage(
  el: El, $: EngineInterface, state: Repo, touched: Record<string, Touch>, isSessionOnly: boolean,
  asked: Confirm | null, drafting: Draft | null, turn: { files: string[]; isOn: boolean }, notes: Note[], width: number,
  canDebug = false,
): Page {
  const { Box, Text } = el
  const byClaude = state.files.filter(one => touched[one.path] !== undefined)
  const files = isSessionOnly ? byClaude : state.files
  const added = files.reduce((n, one) => n + one.added, 0)
  const removed = files.reduce((n, one) => n + one.removed, 0)
  const stagedCount = state.files.filter(isStaged).length
  const page: Page = {
    key: isSessionOnly ? 'changes:session' : 'changes',
    title: pathTitle(el, state.root, 'Changes'),
    subtitle: parts(el, [
      branchChip(state),
      { text: state.ahead > 0 ? `↑${state.ahead}` : '', color: 'green' },
      { text: state.behind > 0 ? `↓${state.behind}` : '', color: 'red' },
      { text: files.length > 0 ? `${files.length} changed` : 'clean', dim: true },
      { text: files.length > 0 ? `+${added} −${removed}` : '', color: 'green' },
    ]),
    actions: [
      // What Claude changed since your last message, as one diff.
      // Shown from the first turn on, so it can be found; the count once Claude changed something.
      ...(turn.isOn
        ? [{ key: 'turn', label: glyph('turn'), word: turn.files.length > 0 ? `This turn ${turn.files.length}` : 'This turn', color: CLAUDE_COLOR, onPress: () => { void openView($, { kind: 'turn' }) } }]
        : []),
      ...(notes.length > 0
        ? [{ key: 'send-review', label: glyph('send'), word: `Send review ${notes.length}`, color: CLAUDE_COLOR, onPress: () => { void sendReview($) } }]
        : []),
      // Claude's files: the filter, with how many there are.
      ...(byClaude.length > 0 || isSessionOnly
        ? [{ key: 'session', label: glyph('claude'), word: isSessionOnly ? 'All files' : `By Claude ${byClaude.length}`, color: CLAUDE_COLOR, onPress: () => { void toggleSessionOnly($) } }]
        : []),
      ...(stagedCount > 0 ? [{ key: 'commit', label: glyph('commit'), word: 'Commit', onPress: () => { void draftCommit($) } }] : []),
      ...(files.length > 0 ? [{ key: 'all', label: glyph('diffAll'), word: 'Diff all', onPress: () => { void openView($, { kind: 'all' }) } }] : []),
      { key: 'refresh', label: glyph('refresh'), word: 'Refresh', onPress: () => { void reload($) } },
    ],
    rows: [],
  }
  // A question before something that cannot be undone.
  if (asked) {
    const { Button } = el
    page.extra = (
      <Box flexDirection="row" height={1} overflow="hidden">
        <Text color="red">{`${asked.how === 'restore' ? 'Discard the changes to' : 'Delete'} ${fitPath(asked.path, Math.max(8, width - 34))}? `}</Text>
        <Box key="yesbox"><Button key="confirm-yes" plain hover={{ color: 'red', underline: true }} onPress={() => { void confirmDiscard($) }}><Text color="red" bold> Yes </Text></Button></Box>
        <Box key="nobox"><Button key="confirm-no" plain hover={HOVER} onPress={() => { void cancelConfirm($) }}><Text> Cancel </Text></Button></Box>
      </Box>
    )
  }
  // The commit message being drafted for what is staged.
  if (drafting) draftRows(el, $, drafting, width).forEach(row => page.rows.push(row))
  // The review notes waiting to go to Claude.
  if (notes.length > 0) notesRows(el, $, notes, width).forEach(row => page.rows.push(row))
  if (files.length === 0) {
    page.rows.push(node('clean', <Text color="gray">{isSessionOnly ? 'Claude has not changed any file that still differs.' : 'No changes. The working tree is clean.'}</Text>))
    return page
  }
  const groups: { title: string; files: Change[]; act?: { label: string; onPress: () => void } }[] = [
    { title: 'Conflicts', files: files.filter(one => one.kind === 'conflict') },
    { title: 'Staged', files: files.filter(isStaged), act: { label: 'Unstage all', onPress: () => { void unstage($, files.filter(isStaged).map(one => one.path)) } } },
    { title: 'Changes', files: files.filter(one => !isStaged(one) && one.kind !== 'untracked' && one.kind !== 'conflict'), act: { label: 'Stage all', onPress: () => { void stage($, files.filter(one => !isStaged(one) && one.kind !== 'untracked' && one.kind !== 'conflict').map(one => one.path)) } } },
    { title: 'New', files: files.filter(one => one.kind === 'untracked'), act: { label: 'Stage all', onPress: () => { void stage($, files.filter(one => one.kind === 'untracked').map(one => one.path)) } } },
  ]
  // A staged file with more changes on top shows in Staged with an unstaged mark.
  groups.filter(group => group.files.length > 0).forEach(group => {
    page.rows.push(node(`g:${group.title}`, (
      <Box key={`ghead:${group.title}`} flexDirection="row" justifyContent="space-between" height={1} overflow="hidden">
        <Text color="gray" bold>{`${group.title.toUpperCase()}  ${group.files.length}`}</Text>
        {group.act ? rowButtons(el, `gact:${group.title}`, [{ key: `gact:${group.title}`, label: group.act.label, color: 'gray', onPress: group.act.onPress }]) : null}
      </Box>
    )))
    for (const one of group.files) {
      const style = KIND_STYLE[one.kind]
      const figures = `+${one.added} −${one.removed} ${style.mark}`
      const buttons = [
        ...(canDebug && one.kind !== 'deleted' && isDebuggable(one.path) ? [debugButton($, one.path)] : []),
        ...(hasUnstaged(one) ? [{ key: `stage:${one.path}`, label: glyph('stage'), color: 'green', onPress: () => { void stage($, [one.path]) } }] : []),
        ...(isStaged(one) ? [{ key: `unstage:${one.path}`, label: glyph('unstage'), color: 'yellow', onPress: () => { void unstage($, [one.path]) } }] : []),
        ...(one.kind !== 'conflict' ? [{ key: `discard:${one.path}`, label: glyph('discard'), color: 'red', onPress: () => { void askDiscard($, one) } }] : []),
      ]
      const actionsWidth = buttons.reduce((n, one) => n + one.label.length + 2, 0)
      page.rows.push(node(`chgrow:${one.path}`, (
        <Box key={`chgline:${one.path}`} flexDirection="row" height={1} overflow="hidden">
          {fileLine(el, `chg:${one.path}`, one.path, width - actionsWidth, () => { void openView($, { kind: 'file', path: one.path }) }, {
            color: one.kind === 'deleted' ? 'red' : undefined,
            isStruck: one.kind === 'deleted',
            isTouched: touched[one.path] !== undefined,
            tail: [...counts(el, one.added, one.removed), <Text color={style.color}>{` ${style.mark}`}</Text>] as unknown as Node,
            tailWidth: figures.length,
          })}
          {rowButtons(el, `rowacts:${one.path}`, buttons)}
        </Box>
      )))
    }
  })
  return page
}

// The review notes, each with where it is, and Send review / Clear.
function notesRows(el: El, $: EngineInterface, notes: Note[], width: number): Row[] {
  const { Box, Text, Button } = el
  const rows: Row[] = [node('notes:head', (
    <Box key="notes:headbox" flexDirection="row" justifyContent="space-between" height={1} overflow="hidden">
      <Text color={CLAUDE_COLOR} bold>{`${glyph('note')} REVIEW NOTES  ${notes.length}`}</Text>
      {rowButtons(el, 'notes:acts', [
        { key: 'notes-send', label: 'Send review', color: CLAUDE_COLOR, onPress: () => { void sendReview($) } },
        { key: 'notes-clear', label: 'Clear', color: 'gray', onPress: () => { void clearNotes($) } },
      ])}
    </Box>
  ))]
  for (const one of notes) {
    const where = `${one.path.split('/').pop()}:${one.line}`
    rows.push(node(`note:${one.id}`, (
      <Box key={`notebox:${one.id}`} flexDirection="row" height={1} overflow="hidden">
        <Box key={`notego:${one.id}`} flexGrow={1} overflow="hidden">
          <Button key={`noteopen:${one.id}`} plain hover={HOVER} onPress={() => { void openView($, { kind: 'file', path: one.path }) }}>
            <Text color="cyan">{'  ' + where}</Text>
            <Text>{' ' + fit(one.text, Math.max(8, width - where.length - 8))}</Text>
          </Button>
        </Box>
        {rowButtons(el, `noterm:${one.id}`, [{ key: `note-remove:${one.id}`, label: glyph('close'), color: 'gray', onPress: () => { void removeNote($, one.id) } }])}
      </Box>
    )))
  }
  return rows
}

function draftRows(el: El, $: EngineInterface, drafting: Draft, width: number): Row[] {
  const { Box, Text, Button } = el
  const rows: Row[] = [node('draft:head', <Text bold color="cyan">{`${glyph('commit')} Commit message`}</Text>)]
  if (drafting.state === 'writing') {
    rows.push(node('draft:writing', <Text color="gray">Writing a message for the staged changes…</Text>))
  } else {
    drafting.text.split('\n').forEach((line, i) => {
      rows.push(node(`draft:${i}`, <Text color={drafting.state === 'error' ? 'red' : undefined} wrap="truncate-end">{fit('  ' + line, width)}</Text>))
    })
  }
  const buttons: { key: string; label: string; color?: string; onPress: () => void }[] = drafting.state === 'ready'
    ? [
        { key: 'draft-commit', label: 'Commit', color: 'green', onPress: () => { void commitDraft($) } },
        { key: 'draft-again', label: 'Again', onPress: () => { void draftCommit($) } },
        { key: 'draft-claude', label: 'Ask Claude', color: CLAUDE_COLOR, onPress: () => { void draftToClaude($) } },
        { key: 'draft-drop', label: 'Cancel', onPress: () => { void dropDraft($) } },
      ]
    : drafting.state === 'error'
      ? [{ key: 'draft-again', label: 'Try again', onPress: () => { void draftCommit($) } }, { key: 'draft-drop', label: 'Cancel', onPress: () => { void dropDraft($) } }]
      : [{ key: 'draft-drop', label: 'Cancel', onPress: () => { void dropDraft($) } }]
  rows.push(node('draft:buttons', (
    <Box key="draft:btns" flexDirection="row" height={1} overflow="hidden">
      {buttons.map(one => (
        <Box key={`${one.key}:box`}>
          <Button key={one.key} plain hover={{ color: 'cyan', underline: true }} onPress={one.onPress}>
            <Text color={one.color}>{` ${one.label} `}</Text>
          </Button>
        </Box>
      ))}
    </Box>
  )))
  return rows
}

// ---------------------------------------------------------------- Commits

const GRAPH_COLORS = ['cyan', 'green', 'yellow', 'magenta', 'blue', 'red']

export function commitsPage(el: El, $: EngineInterface, state: Repo, rows: LogRow[], width: number): Page {
  const { Box, Text, Button } = el
  const commits = rows.filter(row => row.hash).length
  const page: Page = {
    key: 'commits',
    title: pathTitle(el, state.root, 'History'),
    subtitle: parts(el, [
      branchChip(state),
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
      : <Text color={c === '*' ? 'cyan' : GRAPH_COLORS[Math.floor(col / 2) % GRAPH_COLORS.length]}>{c === '*' ? '●' : c}</Text>))
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

// ---------------------------------------------------------------- a diff

export function diffPage(
  el: El, $: EngineInterface, one: Shown, current: View, notes: Note[], draft: NoteTarget | null, width: number,
  // clawd-debug is loaded: a file can be opened in its debugger.
  canDebug = false,
): Page {
  const { Box, Text, Button } = el
  // The notes on one line of this diff, drawn right under it.
  const notesOn = (path: string, side: 'new' | 'old', line: number) =>
    notes.filter(note => note.path === path && note.side === side && note.line === line)
  const noteRow = (note: Note) => node(`dnote:${note.id}`, (
    <Box key={`dnotebox:${note.id}`} flexDirection="row" height={1} overflow="hidden">
      <Text color={CLAUDE_COLOR}>{`      ${glyph('note')} `}</Text>
      <Box key={`dnotetext:${note.id}`} flexGrow={1} overflow="hidden">
        <Text color={CLAUDE_COLOR} wrap="truncate-end">{note.text}</Text>
      </Box>
      {rowButtons(el, `dnoterm:${note.id}`, [{ key: `dnote-remove:${note.id}`, label: glyph('close'), color: 'gray', onPress: () => { void removeNote($, note.id) } }])}
    </Box>
  ))
  const isStale = one.of !== viewKey(current)
  // Where the editor opens: the first changed line of a file's diff.
  const firstLine = current.kind === 'file'
    ? (hunkLines(one.diffs[0]?.hunks ?? '').find(line => line.kind !== 'hunk')?.newAt ?? 1)
    : 1
  const actions: Action[] = [
    ...(notes.length > 0
      ? [{ key: 'send-review', label: glyph('send'), word: `Send review ${notes.length}`, color: CLAUDE_COLOR, onPress: () => { void sendReview($) } }]
      : []),
    { key: 'review', label: glyph('claude'), word: current.kind === 'commit' ? 'Explain' : 'Review', color: CLAUDE_COLOR, onPress: () => { void askReview($, current) } },
    ...(current.kind === 'file'
      ? [{ key: 'edit', label: glyph('edit'), word: 'Open', onPress: () => { void openInEditor($, current.path, firstLine) } }]
      : []),
    ...(current.kind === 'file' && canDebug
      ? [{ key: 'debug', label: glyph('debug'), word: 'Debug', onPress: () => { void debugFile($, current.path) } }]
      : []),
  ]
  const page: Page = {
    key: `diff:${viewKey(current)}`,
    title: (
      <Box flexDirection="row" columnGap={1}>
        <Box key="backrow">
          <Button key="back" plain hover={{ color: 'cyan', underline: true }} onPress={() => { void goBack($) }}>
            <Text color="cyan">{`${glyph('back')} Back`}</Text>
          </Button>
        </Box>
        <Text bold wrap="truncate-end">{isStale ? 'Loading…' : fit(one.title, Math.max(8, width - 40))}</Text>
      </Box>
    ),
    actions: isStale ? [] : actions,
    rows: [],
  }
  if (isStale) return page
  // A note being written: its field, pinned under the title.
  const Input = 'Input' in el ? el.Input : undefined
  if (draft && Input) {
    const where = `${draft.path.split('/').pop()}:${draft.line}`
    page.extra = (
      <Box flexDirection="row" height={1} overflow="hidden">
        <Text color={CLAUDE_COLOR}>{`${glyph('note')} ${where} `}</Text>
        <Box key="noteinputbox" flexGrow={1}>
          <Input key="note-input" placeholder="Note for Claude, Enter adds it" autoFocus
            onSubmit={(value: string) => { void saveNote($, value) }} />
        </Box>
        <Box key="notecancelbox">
          <Button key="note-cancel" plain hover={HOVER} onPress={() => { void cancelNote($) }}><Text color="gray"> Cancel</Text></Button>
        </Box>
      </Box>
    )
  }
  for (const [i, line] of (one.detail ?? '').split('\n').entries()) {
    if (line.trim() !== '') page.rows.push(node(`detail:${i}`, <Text color="gray" wrap="truncate-end">{line}</Text>))
  }
  if (one.diffs.length === 0 && !one.source) page.rows.push(node('nothing', <Text color="gray">Nothing to show.</Text>))
  if (one.source) {
    one.source.text.split('\n').forEach((text, i) => {
      const clean = text.replace(/\t/g, '    ')
      ctx.widest = Math.max(ctx.widest, clean.length + 10)
      page.rows.push({ kind: 'source', key: `src:${i}`, run: 'src', path: one.source!.path, no: i + 1, text: clean })
      notesOn(one.source!.path, 'new', i + 1).forEach(note => page.rows.push(noteRow(note)))
    })
    if (one.source.isCut) page.rows.push(node('srccut', <Text color="gray">{`… only the first ${SOURCE_LINES} lines are shown`}</Text>))
  }
  one.diffs.forEach((file, f) => {
    // A file's own header row sets it apart; one diff of one file needs no gap.
    if (current.kind === 'file' && page.rows.length > 0) page.rows.push(node(`fgap:${f}`, ' '))
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
      ctx.widest = Math.max(ctx.widest, line.text.length + 10)
      page.rows.push({ kind: 'diff', key: `dl:${f}:${l}`, run: `${f}:${run}`, path: file.path, line })
      const side = line.kind === 'del' ? 'old' : 'new'
      notesOn(file.path, side, side === 'old' ? line.oldAt : line.newAt).forEach(note => page.rows.push(noteRow(note)))
    })
    if (file.note) page.rows.push(node(`note:${f}`, <Text color="gray">{file.note}</Text>))
  })
  if (one.isCut) page.rows.push(node('cut', <Text color="gray">… the rest is too large for the pane</Text>))
  return page
}
