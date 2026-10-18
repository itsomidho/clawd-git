# clawd-git

A live git panel for Claude Code, docked beside the conversation and styled like [clawd-statusbar](https://github.com/itsomidho/clawd-statusbar). It updates as Claude edits files. Prefer it inside the main screen? Set **Placement** to `prompt` and it sits above the prompt instead.

## Install

In Claude Code, type:

```
/plugin install clawd-git --marketplace itsomidho/claude-plugins
```

Answer `y` to add the marketplace if asked, then choose a scope. From a shell: `claude plugin install clawd-git --marketplace itsomidho/claude-plugins`.

The Plan tab reads [clawd-tasks](https://github.com/itsomidho/clawd-tasks), from the same marketplace. File icons follow your fonts: with a [Nerd Font](https://www.nerdfonts.com/) installed, crisp line icons (VS Code's Codicons), or colored file-type icons with `nerd`; without one, outline folder and page symbols (🗀 🗁 🗋, from Noto Sans Symbols 2, which most Linux desktops ship); with neither, colored dots. Nothing draws as boxes. Force a set with the **File icons** setting (`auto`, `line`, `nerd`, `outline`, `simple`, `off`).

## What it shows

One panel, with a row of tabs:

| Tab | Shows |
|---|---|
| **Files** | The folder tree on disk, as an editor's sidebar: click a folder to open or close it, a file to see its diff (or its text). File icons, git-ignored entries dimmed, changed files colored, folders holding changes marked • |
| **Changes** | The branch, and each changed file (staged, unstaged, new, conflicts) with `+added −removed`; "diff all" shows every change at once |
| **Commits** | The commit graph across all branches, one color per lane; press a commit to see its diff |
| **Plan** | Claude's plan from clawd-tasks, live: a progress bar, each task's time and changes, the running task's steps; press a task to open it, a file to see its diff |

A diff opens over the tab you pressed it from; **Back** returns there. The toolbar icons search every file by name, close every folder and refresh.

`/git-pane` shows or hides it; `/git-pane files`, `changes`, `commits`, `plan` or `diff` opens it on that tab. Click anything in it, scroll it with the wheel, or focus it with ctrl+x tab to move through it by keyboard. Above the prompt, its height is the **Panel height** setting (16 rows by default).

It re-reads git every 2 seconds while shown, and right after each Edit, Write or Bash call. Settings (`/config`): **Open on start**, **Refresh every (seconds)**.
