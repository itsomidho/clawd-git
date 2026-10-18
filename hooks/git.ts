// Pure helpers: turn git's text output into the values the pane draws.
// Nothing here touches `$`, so the tests can feed them plain strings.

import type { Change, Entry, FileDiff, LogRow, TreeRow } from '../types'

// `git status --porcelain=v1 -b` → branch line and one Change per path.
export function parseStatus(text: string): { branch: string; ahead: number; behind: number; files: Change[] } {
  let branch = ''
  let ahead = 0
  let behind = 0
  const files: Change[] = []
  for (const line of text.split('\n')) {
    if (line === '') continue
    if (line.startsWith('## ')) {
      const head = line.slice(3)
      // "main...origin/main [ahead 1, behind 2]", "No commits yet on main", "HEAD (no branch)"
      const unborn = head.match(/^No commits yet on (.+)$/)
      branch = (unborn ? unborn[1] : head.split('...')[0]?.split(' ')[0]) ?? ''
      ahead = Number(head.match(/ahead (\d+)/)?.[1] ?? 0)
      behind = Number(head.match(/behind (\d+)/)?.[1] ?? 0)
      continue
    }
    const x = line[0] ?? ' '
    const y = line[1] ?? ' '
    let path = unquote(line.slice(3))
    let from: string | undefined
    const arrow = path.indexOf(' -> ')
    if ((x === 'R' || x === 'C') && arrow >= 0) {
      from = unquote(path.slice(0, arrow))
      path = unquote(path.slice(arrow + 4))
    }
    files.push({
      path,
      from,
      index: x,
      worktree: y,
      kind: kindOf(x, y),
      added: 0,
      removed: 0,
    })
  }
  return { branch, ahead, behind, files }
}

// git quotes paths with unusual characters: "a b\303\251.txt"
function unquote(path: string): string {
  if (!(path.startsWith('"') && path.endsWith('"'))) return path
  const body = path.slice(1, -1)
  const bytes: number[] = []
  for (let i = 0; i < body.length; i++) {
    const c = body[i] ?? ''
    if (c !== '\\') {
      bytes.push(...new TextEncoder().encode(c))
      continue
    }
    const next = body[++i] ?? ''
    if (/[0-7]/.test(next)) {
      bytes.push(parseInt(body.slice(i, i + 3), 8))
      i += 2
    } else {
      bytes.push(({ n: 10, t: 9, '"': 34, '\\': 92 } as Record<string, number>)[next] ?? next.charCodeAt(0))
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes))
}

export function kindOf(x: string, y: string): Change['kind'] {
  if (x === '?' && y === '?') return 'untracked'
  if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) return 'conflict'
  if (x === 'R' || y === 'R') return 'renamed'
  if (x === 'A' || y === 'A') return 'added'
  if (x === 'D' || y === 'D') return 'deleted'
  return 'modified'
}

// `git diff --numstat` lines: "12\t3\tpath" ("-\t-\t" for binary), renames as "old => new" or "dir/{a => b}".
export function parseNumstat(text: string): Map<string, { added: number; removed: number }> {
  const out = new Map<string, { added: number; removed: number }>()
  for (const line of text.split('\n')) {
    const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/)
    if (!m) continue
    let path = m[3] ?? ''
    const brace = path.match(/^(.*)\{(.*) => (.*)\}(.*)$/)
    if (brace) path = `${brace[1] ?? ''}${brace[3] ?? ''}${brace[4] ?? ''}`.replace(/\/\//g, '/')
    else if (path.includes(' => ')) path = path.split(' => ')[1] ?? path
    path = unquote(path)
    const one = out.get(path) ?? { added: 0, removed: 0 }
    one.added += m[1] === '-' ? 0 : Number(m[1])
    one.removed += m[2] === '-' ? 0 : Number(m[2])
    out.set(path, one)
  }
  return out
}

// A unified diff of many files → one entry per file, its hunks alone (what
// the Code element's diff format reads).
export function splitDiff(text: string): FileDiff[] {
  const out: FileDiff[] = []
  const parts = text.split(/^diff --git /m).slice(1)
  for (const part of parts) {
    const lines = part.split('\n')
    const head = lines[0] ?? ''
    let path = ''
    const plus = lines.find(line => line.startsWith('+++ '))
    const minus = lines.find(line => line.startsWith('--- '))
    if (plus && plus !== '+++ /dev/null') path = unquote(plus.slice(4)).replace(/^b\//, '')
    else if (minus && minus !== '--- /dev/null') path = unquote(minus.slice(4)).replace(/^a\//, '')
    else {
      const m = head.match(/^"?a\/(.+?)"? "?b\/(.+?)"?$/)
      path = m?.[2] ?? head
    }
    const first = lines.findIndex(line => line.startsWith('@@'))
    const isBinary = lines.some(line => line.startsWith('Binary files '))
    const hunks = first < 0 ? '' : trimEnd(lines.slice(first)).join('\n')
    let added = 0
    let removed = 0
    if (first >= 0) {
      for (const line of lines.slice(first)) {
        if (line.startsWith('+')) added++
        else if (line.startsWith('-')) removed++
      }
    }
    const note = isBinary ? 'binary file' : first < 0 ? (lines.some(l => l.startsWith('rename ')) ? 'renamed, no content change' : 'mode change only') : undefined
    out.push({ path, hunks, added, removed, note })
  }
  return out
}

function trimEnd(lines: string[]): string[] {
  let end = lines.length
  while (end > 0 && lines[end - 1] === '') end--
  return lines.slice(0, end)
}

// The separator the log format puts between fields.
export const SEP = '\u001f'
export const LOG_FORMAT = `%x1f%h%x1f%D%x1f%s%x1f%an%x1f%ar`

// `git log --graph --format=<LOG_FORMAT>` → graph rows, a commit on some.
export function parseLog(text: string): LogRow[] {
  const rows: LogRow[] = []
  for (const line of text.split('\n')) {
    if (line === '') continue
    const at = line.indexOf(SEP)
    if (at < 0) {
      rows.push({ graph: line.replace(/\s+$/, '') })
      continue
    }
    const [hash, refs, subject, author, age] = line.slice(at + 1).split(SEP)
    rows.push({ graph: line.slice(0, at).replace(/\s+$/, ''), hash, refs, subject, author, age })
  }
  return rows
}

// The folder listings read so far (folder path relative to the repository
// root, '' for the root) → the visible rows, given the folders that are open.
export function fsTreeRows(
  listing: Readonly<Record<string, readonly Entry[]>>,
  open: readonly string[],
  changed: ReadonlySet<string>,
  limit = 3000,
): TreeRow[] {
  const isOpen = new Set(open)
  const changedDirs = new Set<string>()
  for (const path of changed) {
    const parts = path.split('/')
    for (let i = 1; i < parts.length; i++) changedDirs.add(parts.slice(0, i).join('/'))
  }
  const rows: TreeRow[] = []
  const walk = (dir: string, depth: number) => {
    for (const entry of listing[dir] ?? []) {
      if (rows.length >= limit) return
      const path = dir === '' ? entry.name : `${dir}/${entry.name}`
      const expanded = entry.isDir && isOpen.has(path)
      rows.push({
        path,
        label: entry.name,
        depth,
        isDir: entry.isDir,
        isOpen: expanded,
        isChanged: entry.isDir ? changedDirs.has(path) : changed.has(path),
        isIgnored: entry.isIgnored,
        isLoading: expanded && listing[path] === undefined,
      })
      if (expanded) walk(path, depth + 1)
    }
  }
  walk('', 0)
  return rows
}

// Folders first, then files, each by name.
export function sortEntries(entries: Entry[]): Entry[] {
  return [...entries].sort((a, b) => (a.isDir === b.isDir ? byName(a.name, b.name) : a.isDir ? -1 : 1))
}

function byName(a: string, b: string) {
  return a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true })
}

// Fits a text into `width` cells, an ellipsis where it was cut.
export function fit(text: string, width: number): string {
  if (width <= 1) return text.slice(0, Math.max(0, width))
  return text.length > width ? text.slice(0, width - 1) + '…' : text
}

// Cuts a long path from the left, keeping the file name.
export function fitPath(path: string, width: number): string {
  if (path.length <= width) return path
  if (width <= 2) return path.slice(-width)
  return '…' + path.slice(path.length - width + 1)
}

// One line of a diff's hunks, with the old and new line numbers it sits at,
// so any slice of a diff can be drawn again as a hunk of its own.
export type DiffLine = { kind: 'hunk' | 'add' | 'del' | 'ctx'; text: string; oldAt: number; newAt: number }

export function hunkLines(hunks: string): DiffLine[] {
  const out: DiffLine[] = []
  let oldAt = 0
  let newAt = 0
  for (const line of hunks.split('\n')) {
    const head = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/)
    if (head) {
      oldAt = Number(head[1])
      newAt = Number(head[2])
      out.push({ kind: 'hunk', text: (head[3] ?? '').trim(), oldAt, newAt })
      continue
    }
    if (line.startsWith('\\')) continue
    const text = line.slice(1).replace(/\t/g, '    ')
    if (line.startsWith('+')) { out.push({ kind: 'add', text, oldAt, newAt }); newAt++ }
    else if (line.startsWith('-')) { out.push({ kind: 'del', text, oldAt, newAt }); oldAt++ }
    else { out.push({ kind: 'ctx', text, oldAt, newAt }); oldAt++; newAt++ }
  }
  return out
}

// A run of diff lines as one hunk: a header that fits them, then the lines,
// each cut `x` columns in (the +/- mark kept) for scrolling sideways.
export function hunkOf(lines: readonly DiffLine[], x: number): string {
  const first = lines[0]
  if (!first) return ''
  const olds = lines.filter(one => one.kind !== 'add').length
  const news = lines.filter(one => one.kind !== 'del').length
  const mark = { add: '+', del: '-', ctx: ' ', hunk: ' ' } as const
  return [
    `@@ -${first.oldAt},${olds} +${first.newAt},${news} @@`,
    ...lines.map(one => mark[one.kind] + one.text.slice(x)),
  ].join('\n')
}
