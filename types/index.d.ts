// 'diff' is no tab of the row: it opens over the tab it came from.
export type Tab = 'files' | 'changes' | 'diff' | 'commits' | 'plan'

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

// What the Diff tab shows: every change, one file, or one commit.
export type View =
  | { kind: 'all' }
  | { kind: 'file'; path: string }
  | { kind: 'commit'; hash: string }

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
      // Plan tasks the person opened to see their steps and files.
      openTasks: string[]
      // The icon set this machine's fonts can draw, found when the session starts.
      iconSet: 'line' | 'nerd' | 'outline' | 'simple'
    }
  }
}
