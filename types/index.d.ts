// 'diff' is no tab of the row: it opens over the tab it came from.
export type Tab = 'files' | 'changes' | 'diff' | 'commits' | 'restore' | 'comments'

export type ChangeKind = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflict'

// One path from `git status`, with its line counts from `git diff --numstat`.
export type Change = {
  path: string
  from?: string
  // Porcelain letters: index (staged) and worktree (unstaged).
  index: string
  worktree: string
  kind: ChangeKind
  added: number
  removed: number
}

// One file of a unified diff: its hunks only, as Code's diff format reads them.
export type FileDiff = { path: string; hunks: string; added: number; removed: number; note?: string }

// One row of `git log --graph`: the graph, and a commit when the row has one.
export type LogRow = { graph: string; hash?: string; refs?: string; subject?: string; author?: string; age?: string }

// One entry of a folder on disk.
export type Entry = { name: string; isDir: boolean; isIgnored: boolean }

export type TreeRow = {
  path: string
  label: string
  depth: number
  isDir: boolean
  isOpen: boolean
  isChanged: boolean
  isIgnored: boolean
  // An open folder whose entries have not been read yet.
  isLoading: boolean
}

// What the Diff tab shows: every change, this turn's changes, one file, or one commit.
export type View =
  | { kind: 'all' }
  | { kind: 'turn' }
  | { kind: 'file'; path: string }
  | { kind: 'commit'; hash: string }
  // What restoring a restore point would change: from now back to it.
  | { kind: 'checkpoint'; ref: string }

export type Repo = {
  // Absolute path of the repository's top folder; empty outside a repository.
  root: string
  branch: string
  ahead: number
  behind: number
  files: Change[]
  error?: string
}

export type Shown = {
  // What `view` this was computed for, so a stale one is not drawn.
  of: string
  title: string
  detail?: string
  diffs: FileDiff[]
  // A file that is not changed: its text, shown with line numbers.
  source?: { path: string; text: string; isCut: boolean }
  isCut: boolean
}

// A file Claude changed this session: when last, with which tool, how often.
export type Touch = { at: number; tool: string; count: number }

// A question the panel is asking before it does something it cannot undo.
export type Confirm =
  | { kind: 'discard'; path: string; how: 'clean' | 'remove' | 'restore' }
  | { kind: 'restore'; ref: string; when: string; label: string; changed: number }
  | { kind: 'resolve'; id: string; where: string }

// A restore point: the working tree as it stood (tracked and new files, not
// ignored ones), kept as a commit under refs/clawd-git/checkpoints/ so git's
// cleanup keeps it, outside every branch. Taken when a turn begins, when you
// save one, and before a restore (so the restore can be undone).
export type Checkpoint = {
  ref: string
  commit: string
  tree: string
  at: number
  // The message the turn began with; "saved by you"; or what the restore replaced.
  label: string
  kind: 'turn' | 'manual' | 'undo'
  // Files that differ between it and the working tree now.
  changed: number
}

// One comment of a merge request thread.
export type MrNote = { id: number; author: string; body: string; at: string }

// A thread on the merge request: on a line of a file (path and line set), or
// on the request as a whole. `isResolvable` is false for a plain comment.
export type MrThread = {
  id: string
  path?: string
  line?: number
  // The line is on the old side of the diff (a removed line).
  isOld?: boolean
  isResolvable: boolean
  isResolved: boolean
  notes: MrNote[]
}

// The open merge request of the current branch and its threads, or why there is none.
export type MrState = {
  status: 'idle' | 'loading' | 'ok' | 'noglab' | 'auth' | 'nomr' | 'github' | 'error'
  // The branch this was read for, so a branch switch reads again.
  branch: string
  iid?: number
  title?: string
  url?: string
  threads: MrThread[]
  // When it was last read (ms); 0 never.
  at: number
  error?: string
}

// A commit message being drafted for what is staged.
export type Draft = { state: 'writing' | 'ready' | 'error'; text: string }

// The working tree as it stood when the current turn began: a git tree object,
// written from a copy of the index, so nothing in the repository changes.
export type TurnBase = { tree: string; turnId: string; at: number }

// A line of a diff the person wants to tell Claude about.
export type NoteTarget = { path: string; line: number; side: 'new' | 'old'; code: string }
export type Note = NoteTarget & { id: string; text: string }

// A one-line note in the panel's title line.
export type Notice = { text: string; kind: 'ok' | 'error' }

declare module 'claude-code' {
  interface PluginState {
    'clawd-git': {
      // Whether the panel is up, above the prompt.
      isShown: boolean
      tab: Tab
      back: Tab
      repo: Repo
      view: View
      shown: Shown
      log: LogRow[]
      // Folder (relative to the repository root, '' for the root) → its entries.
      listing: Record<string, Entry[]>
      // The folder the Files pane shows: the repository's top, else the session's folder.
      filesRoot: string
      openDirs: string[]
      // The Files search box: null while closed, else the typed text; and its matches.
      query: string | null
      // Each page's first row in view, by page; and how far code is slid sideways.
      scrollY: Record<string, number>
      scrollX: number
      matches: string[]
      // The files Claude changed this session, by path; and whether Changes
      // lists only those.
      touched: Record<string, Touch>
      sessionOnly: boolean
      confirm: Confirm | null
      draft: Draft | null
      notice: Notice | null
      // This turn: where it began, and the files it has changed so far.
      turnBase: TurnBase | null
      turnFiles: string[]
      // The restore points of this repository, newest first.
      checkpoints: Checkpoint[]
      // Review notes on diff lines, and the line a note is being written for.
      notes: Note[]
      noteDraft: NoteTarget | null
      // The branch's merge request and its review threads; and whether
      // resolved threads are listed too.
      mr: MrState
      showResolved: boolean
      // The icon set this machine's fonts can draw, found when the session starts.
      iconSet: 'line' | 'nerd' | 'outline' | 'simple'
    }
  }
}
