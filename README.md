# clawd-git

A live git side pane for Claude Code. It docks beside the conversation (fullscreen terminal) and updates as Claude edits files.

## Install

In Claude Code, type:

```
/plugin install clawd-git --marketplace itsomidho/claude-plugins
```

Answer `y` to add the marketplace if asked, then choose a scope. From a shell: `claude plugin install clawd-git --marketplace itsomidho/claude-plugins`.

The Plan tab reads [clawd-tasks](https://github.com/itsomidho/clawd-tasks), from the same marketplace. File icons need a [Nerd Font](https://www.nerdfonts.com/) in your terminal (turn them off with the **File icons** setting).

## What it shows

| Tab | Hotkey | Shows |
|---|---|---|
| Changes | 1 | Changed files from `git status`, grouped (conflicts, staged, unstaged, new), with `+added −removed` |
| Diff | 2 | The diff of every change, one file, or one commit, with colored hunks |
| Commits | 3 | `git log --graph --all`, colored lanes; press a commit to see its diff |
| Plan | 4 | Claude's plan from clawd-tasks, live: progress bar, each task's time and changes; the running task shows its steps, press any task to open it, press a file to see its diff |

A second pane, **Files**, is the real folder tree on disk: click a folder to open or close it, a file to see its diff (or its text) in the Git pane. Git-ignored entries are dimmed; changed files are colored and folders holding changes get a •.

Open with `/git-pane` (or `/git-pane diff`, `commits`, `plan`, `files`), close both with `/git-pane close`. Focus it with ctrl+x tab, then use the hotkeys and arrows.

It re-reads git every 2 seconds while shown, and right after each Edit, Write or Bash call. Settings (`/config`): **Open on start**, **Refresh every (seconds)**.
