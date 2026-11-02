// The Comments tab's data: the open GitLab merge request of the current branch
// and its review threads, read with glab (the API through the login glab
// keeps), and what a press there does: hand a thread to Claude, resolve it,
// open it in the browser.

import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { Confirm, MrNote, MrState, MrThread } from '../types'
import { git } from './shared'

const mr = atom({ plugin: 'clawd-git', key: 'mr' } as const, { status: 'idle', branch: '', threads: [], at: 0 })
const confirm = atom({ plugin: 'clawd-git', key: 'confirm' } as const, null)

// How old the threads may get: while the tab is open, and otherwise (for its count).
export const FRESH_OPEN_MS = 60_000
export const FRESH_AWAY_MS = 5 * 60_000

// glab on the PATH, else the copy clawd-statusbar installs.
let glabPath: string | undefined
async function findGlab($: EngineInterface): Promise<string | undefined> {
  if (glabPath) return glabPath
  const which = await $.process.run(['which', 'glab'], { timeoutMs: 3000 }).catch(() => undefined)
  if (which && which.exitCode === 0 && which.stdout.trim() !== '') return (glabPath = which.stdout.trim())
  const home = (await $.env.get('HOME').catch(() => undefined)) ?? ''
  const local = `${home}/.local/share/clawd-statusbar/bin/glab`
  if (home !== '' && (await $.fs.exists(local).catch(() => false))) return (glabPath = local)
  return undefined
}

async function glab($: EngineInterface, root: string, args: string[], stdin?: string) {
  const bin = await findGlab($)
  if (!bin) return { exitCode: 127, stdout: '', stderr: 'glab not found' }
  return $.process.run([bin, ...args], { cwd: root, timeoutMs: 20_000, ...(stdin !== undefined ? { stdin } : {}) })
    .catch(error => ({ exitCode: 1, stdout: '', stderr: String(error) }))
}

function failed(stderr: string): Pick<MrState, 'status' | 'error'> {
  if (/glab not found/.test(stderr)) return { status: 'noglab' }
  if (/401|unauthori[sz]ed|not been authenticated|auth login/i.test(stderr)) return { status: 'auth', error: firstLine(stderr) }
  return { status: 'error', error: firstLine(stderr) }
}

const firstLine = (text: string) => text.trim().split('\n').find(line => line.trim() !== '')?.trim().slice(0, 200) ?? ''

type RawNote = { id: number; body?: string; system?: boolean; author?: { username?: string }; created_at?: string; resolvable?: boolean; resolved?: boolean; position?: { new_path?: string; old_path?: string; new_line?: number | null; old_line?: number | null } | null }
type RawDiscussion = { id: string; notes?: RawNote[] }

// GitLab's discussions as threads: system notes (pushes, label changes) left out.
export function parseThreads(json: string): MrThread[] {
  let raw: RawDiscussion[]
  try {
    raw = JSON.parse(json) as RawDiscussion[]
  } catch {
    return []
  }
  if (!Array.isArray(raw)) return []
  return raw.flatMap(one => {
    const notes = (one.notes ?? []).filter(note => !note.system)
    const first = notes[0]
    if (!first) return []
    const pos = first.position ?? undefined
    const line = pos ? (pos.new_line ?? pos.old_line ?? undefined) : undefined
    const thread: MrThread = {
      id: one.id,
      ...(pos && (pos.new_path || pos.old_path) ? { path: pos.new_path || pos.old_path } : {}),
      ...(line ? { line } : {}),
      ...(pos && pos.new_line == null && pos.old_line != null ? { isOld: true } : {}),
      isResolvable: first.resolvable === true,
      isResolved: first.resolvable === true && first.resolved === true,
      notes: notes.map((note): MrNote => ({ id: note.id, author: note.author?.username ?? '?', body: note.body ?? '', at: note.created_at ?? '' })),
    }
    return [thread]
  })
}

let isReading = false

// Reads the branch's merge request again when what is kept is older than
// `maxAgeMs`, or was read for another branch; `force` reads it now.
export async function refreshMr($: EngineInterface, root: string, branch: string, opts: { maxAgeMs?: number; force?: boolean } = {}) {
  if (isReading || root === '') return
  const kept = await read($, mr)
  const isStale = kept.branch !== branch || Date.now() - kept.at > (opts.maxAgeMs ?? FRESH_OPEN_MS)
  if (!opts.force && !isStale) return
  isReading = true
  try {
    if (kept.at === 0 || kept.branch !== branch) await update($, mr, (): MrState => ({ status: 'loading', branch, threads: [], at: 0 }))
    const next = await readMr($, root, branch)
    await update($, mr, () => next)
  } catch (error) {
    await update($, mr, (old): MrState => ({ ...old, status: 'error', error: String(error), at: Date.now() }))
  } finally {
    isReading = false
  }
}

async function readMr($: EngineInterface, root: string, branch: string): Promise<MrState> {
  const base = { branch, threads: [], at: Date.now() }
  const remote = await git($, root, ['remote', 'get-url', 'origin']).catch(() => undefined)
  if (remote && /github\.com[:/]/.test(remote.stdout)) return { ...base, status: 'github' }
  if (branch === '') return { ...base, status: 'nomr' }
  const found = await glab($, root, ['api', `projects/:fullpath/merge_requests?source_branch=${encodeURIComponent(branch)}&state=opened&per_page=1`])
  if (found.exitCode !== 0) return { ...base, ...failed(found.stderr || found.stdout) }
  let first: { iid?: number; title?: string; web_url?: string } | undefined
  try {
    first = (JSON.parse(found.stdout) as { iid?: number; title?: string; web_url?: string }[])[0]
  } catch {
    return { ...base, status: 'error', error: 'GitLab answered with something that is not JSON.' }
  }
  if (!first || !first.iid) return { ...base, status: 'nomr' }
  const [talk, me] = await Promise.all([
    glab($, root, ['api', `projects/:fullpath/merge_requests/${first.iid}/discussions?per_page=100`]),
    whoAmI($, root),
  ])
  if (talk.exitCode !== 0) return { ...base, ...failed(talk.stderr || talk.stdout) }
  return { ...base, status: 'ok', iid: first.iid, title: first.title ?? '', url: first.web_url ?? '', threads: parseThreads(talk.stdout), ...(me ? { me } : {}) }
}

// The username glab is logged in as on this repository's GitLab, read once per project.
const users = new Map<string, string>()
async function whoAmI($: EngineInterface, root: string): Promise<string | undefined> {
  const known = users.get(root)
  if (known) return known
  const out = await glab($, root, ['api', 'user'])
  if (out.exitCode !== 0) return undefined
  try {
    const name = (JSON.parse(out.stdout) as { username?: string }).username
    if (name) users.set(root, name)
    return name
  } catch {
    return undefined
  }
}

// A thread only you wrote in: your own note, or one no one has answered.
// One a reviewer replied to is someone else's request too, so it stays.
export function isMine(state: MrState, one: MrThread) {
  return state.me !== undefined && one.notes.every(note => note.author === state.me)
}

// Threads waiting on you: not resolved, not only yours.
export function openThreads(state: MrState) {
  return state.threads.filter(one => !one.isResolved && !isMine(state, one))
}

// What the list hides until asked: your own open threads.
export function hiddenThreads(state: MrState) {
  return state.threads.filter(one => !one.isResolved && isMine(state, one))
}

// Resolved threads, newest first: listed at the end, one line each.
export function resolvedThreads(state: MrState) {
  return state.threads.filter(one => one.isResolved).reverse()
}

export function unresolvedCount(state: MrState) {
  return openThreads(state).filter(one => one.isResolvable).length
}

// ---------------------------------------------------------------- asking Claude

export function whereOf(one: MrThread) {
  return one.path ? `${one.path}${one.line ? `:${one.line}` : ''}${one.isOld ? ' (a removed line)' : ''}` : 'the merge request as a whole'
}

function quoted(one: MrThread) {
  return one.notes.map(note => `${note.author}:\n${note.body.split('\n').map(line => `> ${line}`).join('\n')}`).join('\n\n')
}

// The request to Claude for one thread or several.
export function fixText(state: MrState, threads: MrThread[]) {
  const head = `Review comments on GitLab merge request !${state.iid}${state.title ? ` (${state.title})` : ''}${state.url ? `, ${state.url}` : ''}.`
  const body = threads.map((one, i) => `${threads.length > 1 ? `${i + 1}. ` : ''}On ${whereOf(one)}:\n${quoted(one)}`).join('\n\n')
  const ask = threads.length > 1
    ? 'Address each comment in the code, one by one. Where you disagree with a comment, or it is unclear, say so instead of changing the code. Don\'t reply on GitLab or resolve the threads; tell me what you changed for each.'
    : 'Address this comment in the code. If you disagree with it, or it is unclear, say so instead of changing the code. Don\'t reply on GitLab or resolve the thread; tell me what you changed.'
  return `${head}\n\n${body}\n\n${ask}`
}

// ---------------------------------------------------------------- GitLab

// Resolving is seen by everyone on the merge request: it asks first.
export async function askResolve($: EngineInterface, one: MrThread) {
  const asked: Confirm = { kind: 'resolve', id: one.id, where: whereOf(one) }
  await update($, confirm, () => asked)
}

export async function confirmResolve($: EngineInterface, root: string, branch: string): Promise<{ ok: boolean; text: string }> {
  const asked = await read($, confirm)
  await update($, confirm, () => null)
  const state = await read($, mr)
  if (!asked || asked.kind !== 'resolve' || !state.iid) return { ok: false, text: 'Nothing to resolve.' }
  const out = await glab($, root, ['api', '-X', 'PUT', `projects/:fullpath/merge_requests/${state.iid}/discussions/${asked.id}?resolved=true`])
  if (out.exitCode !== 0) return { ok: false, text: `Could not resolve: ${firstLine(out.stderr || out.stdout) || 'glab failed'}` }
  await update($, mr, old => ({ ...old, threads: old.threads.map(one => (one.id === asked.id ? { ...one, isResolved: true } : one)) }))
  void refreshMr($, root, branch, { force: true })
  return { ok: true, text: `Resolved the thread on ${asked.where}.` }
}

// Adds `text` to the thread as a reply of yours: everyone on the merge request sees it.
export async function postReply($: EngineInterface, root: string, branch: string, id: string, text: string): Promise<{ ok: boolean; text: string }> {
  const state = await read($, mr)
  if (!state.iid) return { ok: false, text: 'No merge request to reply on.' }
  // The body as JSON on stdin: the text goes as it is, whatever it holds
  // (older glab read a -f value in brackets as an array).
  const out = await glab($, root, ['api', '-X', 'POST', '-H', 'Content-Type: application/json', `projects/:fullpath/merge_requests/${state.iid}/discussions/${id}/notes`, '--input', '-'], JSON.stringify({ body: text }))
  if (out.exitCode !== 0) return { ok: false, text: `Could not reply: ${firstLine(out.stderr || out.stdout) || 'glab failed'}` }
  void refreshMr($, root, branch, { force: true })
  return { ok: true, text: 'Replied on GitLab.' }
}

// The thread (or the whole request) in the browser.
export async function openWeb($: EngineInterface, state: MrState, one?: MrThread): Promise<{ ok: boolean; text: string }> {
  if (!state.url) return { ok: false, text: 'No merge request to open.' }
  const url = one ? `${state.url}#note_${one.notes[0]?.id ?? ''}` : state.url
  for (const opener of ['xdg-open', 'open']) {
    const which = await $.process.run(['which', opener], { timeoutMs: 3000 }).catch(() => undefined)
    if (which && which.exitCode === 0) {
      const out = await $.process.run([opener, url], { timeoutMs: 15_000 }).catch(() => undefined)
      return out && out.exitCode === 0 ? { ok: true, text: 'Opened in the browser.' } : { ok: false, text: `Could not open ${url}` }
    }
  }
  return { ok: false, text: `No browser opener found: ${url}` }
}
