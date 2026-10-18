// What a press in the panel does: tabs, diffs, folders, search, and the
// actions on the repository (stage, unstage, discard, commit), on Claude (ask
// it to review or explain) and on the editor (open a file there).

import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { Change, Repo, Tab, View } from '../types'
import { refresh } from './data'
import { DRAFT_MODEL, EMPTY_REPO, SEARCH_RESULTS, ctx, git, viewKey } from './shared'

const tab = atom({ plugin: 'clawd-git', key: 'tab' } as const, 'files')
const back = atom({ plugin: 'clawd-git', key: 'back' } as const, 'changes')
const view = atom({ plugin: 'clawd-git', key: 'view' } as const, { kind: 'all' })
const repo = atom({ plugin: 'clawd-git', key: 'repo' } as const, EMPTY_REPO)
const scrollY = atom({ plugin: 'clawd-git', key: 'scrollY' } as const, {})
const scrollX = atom({ plugin: 'clawd-git', key: 'scrollX' } as const, 0)
const openDirs = atom({ plugin: 'clawd-git', key: 'openDirs' } as const, [])
const query = atom({ plugin: 'clawd-git', key: 'query' } as const, null)
const matches = atom({ plugin: 'clawd-git', key: 'matches' } as const, [])
const touched = atom({ plugin: 'clawd-git', key: 'touched' } as const, {})
const sessionOnly = atom({ plugin: 'clawd-git', key: 'sessionOnly' } as const, false)
const confirm = atom({ plugin: 'clawd-git', key: 'confirm' } as const, null)
const draft = atom({ plugin: 'clawd-git', key: 'draft' } as const, null)
const notice = atom({ plugin: 'clawd-git', key: 'notice' } as const, null)

// ---------------------------------------------------------------- moving around

export async function selectTab($: EngineInterface, next: Tab) {
  await update($, tab, () => next)
  await update($, scrollX, () => 0)
  if (next === 'commits') ctx.needsLog = true
  await refresh($)
}

// Opens a diff (all changes, a file, a commit) over the current tab.
export async function openView($: EngineInterface, next: View) {
  const from = await read($, tab)
  if (from !== 'diff') await update($, back, () => from)
  await update($, view, () => next)
  // A new diff starts at its top-left.
  await update($, scrollY, all => ({ ...all, [`diff:${viewKey(next)}`]: 0 }))
  await update($, scrollX, () => 0)
  await update($, tab, () => 'diff')
  await refresh($)
}

export async function goBack($: EngineInterface) {
  await selectTab($, await read($, back))
}

export async function toggleDir($: EngineInterface, path: string) {
  await update($, openDirs, list => (list.includes(path) ? list.filter(one => one !== path) : [...list, path]))
  await refresh($)
}

export async function collapseAll($: EngineInterface) {
  await update($, openDirs, () => [])
}

export async function slide($: EngineInterface, by: number, max: number) {
  await update($, scrollX, n => Math.min(max, Math.max(0, n + by)))
}

export async function reload($: EngineInterface) {
  ctx.needsLog = true
  ctx.written.clear()
  ctx.lastSignature = ''
  await refresh($)
}

// ---------------------------------------------------------------- search

export async function openSearch($: EngineInterface) {
  const state = await read($, repo)
  if (state.root !== '') {
    const out = await git($, state.root, ['ls-files', '--cached', '--others', '--exclude-standard']).catch(() => undefined)
    ctx.searchable = [...new Set((out?.stdout ?? '').split('\n').filter(Boolean))]
  }
  await update($, query, () => '')
  await update($, matches, () => [])
}

export async function closeSearch($: EngineInterface) {
  await update($, query, () => null)
  await update($, matches, () => [])
}

// Names that start with the text first, then names holding it, then paths.
export async function search($: EngineInterface, text: string) {
  await update($, query, () => text)
  const needle = text.trim().toLowerCase()
  if (needle === '') { await update($, matches, () => []); return }
  const scored: { path: string; score: number }[] = []
  for (const path of ctx.searchable) {
    const lower = path.toLowerCase()
    const name = lower.slice(lower.lastIndexOf('/') + 1)
    const score = name.startsWith(needle) ? 0 : name.includes(needle) ? 1 : lower.includes(needle) ? 2 : -1
    if (score >= 0) scored.push({ path, score })
  }
  scored.sort((a, b) => a.score - b.score || a.path.length - b.path.length || a.path.localeCompare(b.path))
  const found = scored.slice(0, SEARCH_RESULTS).map(one => one.path)
  await update($, matches, () => found)
}

// ---------------------------------------------------------------- a line of news

// A short note in the panel's title line, gone after a few seconds.
let noticeTimer: { cancel: () => void } | undefined
export async function say($: EngineInterface, text: string, kind: 'ok' | 'error' = 'ok') {
  await update($, notice, () => ({ text, kind }))
  try {
    noticeTimer?.cancel()
    noticeTimer = $.clock.after(kind === 'error' ? 8000 : 4000, () => { void update($, notice, () => null) })
  } catch {
    // No clock (a test, a host without timers): the note stays until the next one.
  }
}

// ---------------------------------------------------------------- what Claude changed

// A file Claude's Edit, Write or notebook tool wrote, noted for the session.
export async function noteTouched($: EngineInterface, path: string, tool: string) {
  if (path === '') return
  const at = await $.clock.now()
  await update($, touched, all => ({ ...all, [path]: { at, tool, count: (all[path]?.count ?? 0) + 1 } }))
}

// After a shell command of Claude's: the files whose change it made (new to
// the status, or with other line counts), noted as Claude's.
export async function noteBashChanges($: EngineInterface, before: Repo, after: Repo) {
  const was = new Map(before.files.map(one => [one.path, `${one.index}${one.worktree}${one.added}/${one.removed}`]))
  for (const one of after.files) {
    if (was.get(one.path) !== `${one.index}${one.worktree}${one.added}/${one.removed}`) await noteTouched($, one.path, 'Bash')
  }
}

export async function toggleSessionOnly($: EngineInterface) {
  await update($, sessionOnly, on => !on)
}

export async function forgetSession($: EngineInterface) {
  await update($, touched, () => ({}))
  await update($, sessionOnly, () => false)
}

// ---------------------------------------------------------------- stage, unstage, discard

async function inRepo($: EngineInterface, args: string[], done: string, stdin?: string) {
  const state = await read($, repo)
  if (state.root === '') return false
  const out = await git($, state.root, args, 15_000, stdin).catch(error => ({ exitCode: 1, stdout: '', stderr: String(error) }))
  if (out.exitCode !== 0) {
    await say($, (out.stderr || out.stdout).trim().split('\n')[0] || `git ${args[0]} failed`, 'error')
    await refresh($)
    return false
  }
  if (done) await say($, done)
  await refresh($)
  return true
}

export async function stage($: EngineInterface, paths: string[]) {
  if (paths.length === 0) return
  await inRepo($, ['add', '--', ...paths], paths.length === 1 ? `Staged ${paths[0]}` : `Staged ${paths.length} files`)
}

export async function unstage($: EngineInterface, paths: string[]) {
  if (paths.length === 0) return
  const state = await read($, repo)
  // With no commit yet there is no HEAD to restore from: take them out of the index.
  const head = await git($, state.root, ['rev-parse', '--verify', '-q', 'HEAD']).catch(() => undefined)
  const args = head && head.exitCode === 0 ? ['restore', '--staged', '--', ...paths] : ['rm', '--cached', '-q', '--', ...paths]
  await inRepo($, args, paths.length === 1 ? `Unstaged ${paths[0]}` : `Unstaged ${paths.length} files`)
}

// Discarding cannot be undone, so it asks first, in the panel.
export async function askDiscard($: EngineInterface, change: Change) {
  // A new file is deleted; a staged new file is taken out of git and deleted;
  // anything else goes back to what HEAD holds.
  const how = change.kind === 'untracked' ? 'clean' : change.index === 'A' ? 'remove' : 'restore'
  await update($, confirm, () => ({ kind: 'discard', path: change.path, how }))
}

export async function cancelConfirm($: EngineInterface) {
  await update($, confirm, () => null)
}

export async function confirmDiscard($: EngineInterface) {
  const asked = await read($, confirm)
  await update($, confirm, () => null)
  if (!asked) return
  const args = asked.how === 'clean' ? ['clean', '-f', '-q', '--', asked.path]
    : asked.how === 'remove' ? ['rm', '-f', '-q', '--', asked.path]
    : ['restore', '--staged', '--worktree', '--source=HEAD', '--', asked.path]
  await inRepo($, args, asked.how === 'restore' ? `Discarded changes to ${asked.path}` : `Deleted ${asked.path}`)
}

// ---------------------------------------------------------------- asking Claude

// Puts a request to Claude as if typed: it starts a turn once the session is idle.
async function ask($: EngineInterface, text: string, done: string) {
  const sent = await $.prompt.submit({ text }).then(() => true).catch(() => false)
  await say($, sent ? done : 'Could not send that to Claude.', sent ? 'ok' : 'error')
}

export async function askReview($: EngineInterface, current: View) {
  if (current.kind === 'commit') {
    await ask($, `Explain commit ${current.hash} (see \`git show ${current.hash}\`): what it changes, why, and anything risky in it.`, 'Asked Claude to explain the commit.')
    return
  }
  const target = current.kind === 'file' ? `\`${current.path}\` (\`git diff HEAD -- ${current.path}\`)` : 'the working tree (`git diff HEAD` and the untracked files)'
  await ask($, `Review the uncommitted changes in ${target}. Point out bugs, risks and anything worth cleaning up, most important first. Don't change any files yet.`, 'Asked Claude to review the changes.')
}

// ---------------------------------------------------------------- commit message

// Drafts a commit message for what is staged, in the style of the recent
// commits, with a quick model call; the person commits it or asks again.
export async function draftCommit($: EngineInterface) {
  const state = await read($, repo)
  const staged = state.files.filter(one => one.index !== ' ' && one.index !== '?')
  if (staged.length === 0) {
    await say($, 'Stage the files to commit first (the + on a row).', 'error')
    return
  }
  await update($, draft, () => ({ state: 'writing', text: '' }))
  const [diff, recent] = await Promise.all([
    git($, state.root, ['diff', '--cached', '--no-ext-diff', '--stat', '-p']),
    git($, state.root, ['log', '-n', '12', '--format=%s']).catch(() => undefined),
  ])
  const shownDiff = diff.stdout.length > 40_000 ? diff.stdout.slice(0, 40_000) + '\n[diff cut here]' : diff.stdout
  const result = await $.model.complete({
    model: DRAFT_MODEL,
    maxTokens: 600,
    system: 'You write git commit messages. Answer with the message alone: a subject line of at most 72 characters in the imperative mood, then, only when the change needs it, a blank line and a short body wrapped at 72 columns saying what and why. Follow the style of the recent subjects you are shown. No code fences, no quotes, no trailers.',
    prompt: `Recent commit subjects in this repository:\n${recent?.stdout.trim() || '(none yet)'}\n\nThe staged changes:\n${shownDiff}`,
  }).catch(() => undefined)
  if (!result || !result.isAnswered || result.text.trim() === '') {
    await update($, draft, () => ({ state: 'error', text: 'The draft could not be written. Try again, or ask Claude.' }))
    return
  }
  await update($, draft, () => ({ state: 'ready', text: result.text.trim().replace(/^```\w*\n?|```$/g, '').trim() }))
}

export async function commitDraft($: EngineInterface) {
  const one = await read($, draft)
  if (!one || one.state !== 'ready') return
  const ok = await inRepo($, ['commit', '-q', '-F', '-'], 'Committed.', one.text + '\n')
  if (ok) {
    ctx.needsLog = true
    await update($, draft, () => null)
  }
}

export async function dropDraft($: EngineInterface) {
  await update($, draft, () => null)
}

// Hands the draft to Claude, to change it or commit it the person's way.
export async function draftToClaude($: EngineInterface) {
  const one = await read($, draft)
  if (!one || one.state !== 'ready') return
  await update($, draft, () => null)
  await ask($, `Commit the staged changes with this message, adjusting it if it misses something:\n\n${one.text}`, 'Asked Claude to commit.')
}

// ---------------------------------------------------------------- the editor

// The editors tried, in order, when the setting is auto; each with how it
// takes a file and a line.
const EDITORS: { name: string; args: (file: string, line: number) => string[] }[] = [
  { name: 'code', args: (file, line) => ['-g', `${file}:${line}`] },
  { name: 'cursor', args: (file, line) => ['-g', `${file}:${line}`] },
  { name: 'zed', args: (file, line) => [`${file}:${line}`] },
  { name: 'subl', args: (file, line) => [`${file}:${line}`] },
  { name: 'phpstorm', args: (file, line) => ['--line', String(line), file] },
]

async function has($: EngineInterface, name: string) {
  const out = await $.process.run(['which', name], { timeoutMs: 3000 }).catch(() => undefined)
  return out !== undefined && out.exitCode === 0
}

// The command that opens `file` at `line`: the setting (with {file} and {line}
// standing for them), or the first editor found, or the system's opener.
export async function editorCommand($: EngineInterface, file: string, line: number): Promise<string[] | undefined> {
  const setting = ctx.config.editor.trim()
  if (setting !== '' && setting !== 'auto') {
    const words = setting.split(/\s+/)
    const hasFile = words.some(word => word.includes('{file}'))
    const filled = words.map(word => word.replace('{file}', file).replace('{line}', String(line)))
    return hasFile ? filled : [...filled, file]
  }
  for (const one of EDITORS) {
    if (await has($, one.name)) return [one.name, ...one.args(file, line)]
  }
  if (await has($, 'xdg-open')) return ['xdg-open', file]
  if (await has($, 'open')) return ['open', file]
  return undefined
}

export async function openInEditor($: EngineInterface, path: string, line = 1) {
  const state = await read($, repo)
  const root = state.root || (await $.session.cwd())
  const file = path.startsWith('/') ? path : `${root}/${path}`
  const argv = await editorCommand($, file, line)
  if (!argv) {
    await say($, 'No editor found: set Editor in /config (e.g. code -g {file}:{line}).', 'error')
    return
  }
  const out = await $.process.run(argv, { timeoutMs: 15_000 }).catch(error => ({ exitCode: 1, stderr: String(error), stdout: '' }))
  if (out.exitCode !== 0) await say($, `${argv[0]}: ${(out.stderr || 'could not open the file').trim().split('\n')[0]}`, 'error')
  else await say($, `Opened ${path.split('/').pop()} in ${argv[0]}.`)
}
