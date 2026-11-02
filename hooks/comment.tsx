// The comment dialog: a press on a thread in Comments opens it whole in a pane
// of its own, over the panel, with the keyboard. Every note in full, the
// arrows scroll it, Escape closes it; Fix, Reply, Resolve and Web from there.

import { atom, read } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { MrState, MrThread } from '../types'
import { cancelConfirm, closeComment, fixThreads, openInEditor, openMrWeb, selectTab, startReply } from './actions'
import { askResolve, isMine, whereOf } from './mr'
import { ageOf, wrapText } from './pages'
import { ACCENT, BORDER, CLAUDE_COLOR, DOT, glyph, HOVER_ACCENT, OK } from './shared'
import type { El } from './shared'

const mr = atom({ plugin: 'clawd-git', key: 'mr' } as const, { status: 'idle', branch: '', threads: [], at: 0 })
const reading = atom({ plugin: 'clawd-git', key: 'reading' } as const, null)

// Closes the dialog first, then acts in the panel (Reply's field, Resolve's question live there).
function thenClose($: EngineInterface, act: () => Promise<void>) {
  return () => { void closeComment($).then(() => selectTab($, 'comments')).then(act) }
}

export async function drawComment($: EngineInterface, el: El, columns: number) {
  const { Box, Text } = el
  const [state, id] = await Promise.all([read($, mr), read($, reading)])
  const one = state.threads.find(each => each.id === id)
  const width = Math.max(20, columns)
  if (!one) {
    return (
      <Box flexDirection="column" width={width}>
        <Text dimColor>That comment is gone (resolved elsewhere, or the merge request changed). Escape closes this.</Text>
      </Box>
    )
  }
  const inner = width - 4
  return (
    <Box flexDirection="column" width={width}>
      {headCard(el, $, state, one, width)}
      {one.notes.map((note, i) => (
        <Box key={`note:${note.id}`} flexDirection="column" borderStyle="round" borderColor={i === 0 ? ACCENT : BORDER} paddingX={1} width={width}>
          <Box key={`notehead:${note.id}`} flexDirection="row" height={1} overflow="hidden">
            <Text bold color={note.author === state.me ? undefined : ACCENT}>{note.author}</Text>
            <Text dimColor wrap="truncate-end">{`${DOT}${ageOf(note.at)} ago${i === 0 ? '' : `${DOT}reply ${i}`}`}</Text>
          </Box>
          {bodyRows(el, note.body, inner, note.id)}
        </Box>
      ))}
      <Text dimColor>{'  ↑↓ scroll · Esc closes'}</Text>
    </Box>
  )
}

// The thread's place and the actions, in a card above the notes.
function headCard(el: El, $: EngineInterface, state: MrState, one: MrThread, width: number) {
  const { Box, Text, Button } = el
  const isDone = one.isResolved
  const buttons: { key: string; label: string; color: string; onPress: () => void }[] = [
    ...(isDone ? [] : [{ key: 'dlg-fix', label: `${glyph('claude')} fix`, color: CLAUDE_COLOR, onPress: thenClose($, () => fixThreads($, [one])) }]),
    { key: 'dlg-reply', label: '↩ reply', color: ACCENT, onPress: thenClose($, () => startReply($, { id: one.id, where: whereOf(one), author: one.notes[0]?.author ?? '' })) },
    ...(one.isResolvable && !isDone ? [{ key: 'dlg-resolve', label: `${glyph('check')} resolve`, color: OK, onPress: thenClose($, async () => { await cancelConfirm($); await askResolve($, one) }) }] : []),
    { key: 'dlg-web', label: `${glyph('web')} web`, color: 'gray', onPress: () => { void openMrWeb($, one) } },
    { key: 'dlg-close', label: 'close', color: 'gray', onPress: () => { void closeComment($) } },
  ]
  const status = isDone ? 'resolved' : isMine(state, one) ? 'yours' : one.isResolvable ? 'unresolved' : 'comment'
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={BORDER} paddingX={1} width={width}>
      <Box flexDirection="row" height={1} overflow="hidden">
        <Text color={ACCENT} bold>{`${glyph('comment') ? `${glyph('comment')} ` : ''}!${state.iid}`}</Text>
        <Text dimColor>{`${DOT}${status}${DOT}`}</Text>
        {one.path
          ? (
              <Box key="dlg-where-box" flexShrink={1} overflow="hidden">
                <Button key="dlg-where" plain hover={HOVER_ACCENT} onPress={() => { void openInEditor($, one.path!, one.line ?? 1) }}>
                  <Text color="cyan" wrap="truncate-start">{whereOf(one)}</Text>
                </Button>
              </Box>
            )
          : <Text dimColor italic>{whereOf(one)}</Text>}
      </Box>
      <Box flexDirection="row" height={1} overflow="hidden">
        {buttons.map(one => (
          <Box key={`${one.key}:box`}>
            <Button key={one.key} plain hover={HOVER_ACCENT} onPress={one.onPress}>
              <Text color={one.color}>{` ${one.label} `}</Text>
            </Button>
          </Box>
        ))}
      </Box>
    </Box>
  )
}

// A note's text in full, wrapped to the card; code fences drawn dim, code in them kept as is.
function bodyRows(el: El, body: string, width: number, id: number) {
  const { Text } = el
  let isCode = false
  return body.replace(/\r/g, '').split('\n').flatMap((line, i) => {
    if (/^\s*```/.test(line)) {
      isCode = !isCode
      return [<Text key={`b:${id}:${i}`} dimColor>{line}</Text>]
    }
    return wrapText(line, width).map((part, j) => (
      <Text key={`b:${id}:${i}:${j}`} color={isCode ? 'green' : undefined}>{part === '' ? ' ' : part}</Text>
    ))
  })
}
