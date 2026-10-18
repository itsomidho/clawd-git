// clawd-git: a live git panel beside the conversation, styled like
// clawd-statusbar. This module wires the hooks; the work is in data (git and
// the disk), actions (what a press does), pages (each tab) and draw (frames).

import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import { forgetSession, noteBashChanges, noteTouched, openView, selectTab } from './actions'
import { findIconSet, isAnyPaneShown, refresh, startTurn, updateTurnFiles } from './data'
import { drawGit } from './draw'
import { COMMAND, EDITORS, EMPTY_REPO, OLD_FILES_PANE, PANE, TABS, WRITERS, ctx, relativeTo } from './shared'

const isShown = atom({ plugin: 'clawd-git', key: 'isShown' } as const, true)
const detected = atom({ plugin: 'clawd-git', key: 'iconSet' } as const, 'simple')
const repo = atom({ plugin: 'clawd-git', key: 'repo' } as const, EMPTY_REPO)
const scrollY = atom({ plugin: 'clawd-git', key: 'scrollY' } as const, {})

export const register: Register = (on, options) => {
  ctx.config = {
    isAutoOpen: options.autoOpen !== false,
    intervalMs: Math.max(1, Number(options.refreshSeconds ?? 2)) * 1000,
    icons: (['auto', 'line', 'nerd', 'outline', 'simple', 'off'] as const).find(one => one === options.icons) ?? 'auto',
    background: typeof options.background === 'string' && options.background.trim() !== '' ? options.background.trim() : 'none',
    rows: Math.max(10, Math.round(Number(options.rows ?? 16)) || 16),
    placement: options.placement === 'prompt' ? 'prompt' : 'side',
    editor: typeof options.editor === 'string' ? options.editor : 'auto',
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Show or hide the git panel: files, changes and commits',
      argumentHint: '[files | changes | commits | diff | turn | close]',
    }).catch(() => {})
    ctx.written.clear()
    ctx.needsLog = true
    ctx.lastSignature = ''
    if (ctx.config.icons === 'auto') void findIconSet($).then(found => update($, detected, () => found)).catch(() => {})
    // A tick reads git's status alone, and the rest only when it moved.
    $.clock.every(ctx.config.intervalMs, () => {
      void (async () => {
        if (await isAnyPaneShown($)) await refresh($, false)
      })().catch(() => {})
    })
    const started = await next(e)
    void (async () => {
      const panes = await $.ui.panes()
      // The Files pane of 0.1; and the side pane while the panel is above the prompt.
      for (const id of ctx.config.placement === 'prompt' ? [PANE, OLD_FILES_PANE] : [OLD_FILES_PANE]) {
        if (panes.some(pane => pane.id === id)) await $.ui.close({ id })
      }
      if (!ctx.config.isAutoOpen) await update($, isShown, () => false)
      else if (ctx.config.placement === 'side') await $.ui.open({ id: PANE, title: 'Git' })
      await refresh($)
    })().catch(() => {})
    return started
  })

  // A turn of the main conversation begins: remember the tree, before Claude
  // changes anything, so "This turn" can show exactly what it changed.
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) await startTurn($, e.turnId).catch(() => {})
    return next(e)
  }).catch(($, e, next) => next(e))

  // The turn ended: settle the list of files it changed.
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined) void updateTurnFiles($).catch(() => {})
    return done
  }).catch(($, e, next) => next(e))

  // A /clear starts a new conversation: what Claude changed goes with the old one.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') await forgetSession($)
    return next(e)
  })

  on('command.run', { command: 'git-pane' }, async ($, e) => {
    const arg = String(e.args ?? '').trim().toLowerCase()
    const pick = TABS.find(one => one.id === arg)
    // Bare /git-pane toggles; a tab name always shows it on that tab.
    if (arg === 'close' || (arg === '' && await isAnyPaneShown($))) {
      await update($, isShown, () => false)
      if (ctx.config.placement === 'side') await $.ui.close({ id: PANE }).catch(() => {})
      return { text: 'Git panel hidden.' }
    }
    await update($, isShown, () => true)
    if (ctx.config.placement === 'side') {
      const opened = await $.ui.open({ id: PANE, title: 'Git' })
      if (!opened.isPlaced) return { text: `The git panel is waiting for room: ${opened.reason}` }
    }
    if (arg === 'diff') await openView($, { kind: 'all' })
    else if (arg === 'turn') await openView($, { kind: 'turn' })
    else if (pick) await selectTab($, pick.id)
    else void refresh($)
    return { text: 'Git panel shown.' }
  })

  // Claude edited a file or ran a command: note what it changed, and show it.
  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    if (!WRITERS.has(tool)) return next(e)
    const before = tool === 'Bash' ? await read($, repo) : undefined
    const result = await next(e)
    void (async () => {
      if (EDITORS.has(tool) && result.isError !== true) {
        const args = e as unknown as { file_path?: unknown; notebook_path?: unknown }
        const path = typeof args.file_path === 'string' ? args.file_path : typeof args.notebook_path === 'string' ? args.notebook_path : ''
        const root = (await read($, repo)).root || (await $.session.cwd())
        await noteTouched($, relativeTo(root, path), tool)
      }
      if (tool === 'Bash') ctx.needsLog = true
      await refresh($)
      if (before && before.root !== '') await noteBashChanges($, before, await read($, repo))
      await updateTurnFiles($)
    })().catch(() => {})
    return result
  }).catch(($, e, next) => next(e))

  // The wheel and the scroll keys move the page's window, not the pane's, so
  // the tabs and the title stay put.
  on('ui.scroll', async ($, e, next) => {
    const isOurs = ctx.config.placement === 'side'
      ? e.component === 'Pane' && e.requestId === PANE
      : e.component === 'AbovePrompt' && (await read($, isShown))
    const page = ctx.lastPage
    if (!isOurs || page.key === '') return next(e)
    const max = Math.max(0, page.total - page.room)
    await update($, scrollY, all => ({ ...all, [page.key]: Math.min(max, Math.max(0, (all[page.key] ?? 0) + e.by)) }))
    return {}
  })

  // The side pane: docked beside the conversation (the default placement).
  on('ui.render', { component: 'Pane', requestId: 'git' }, async ($, e) => {
    const el = $.ui.resolve(e)
    return drawGit($, el, e.props.bodyColumns, e.props.scroll?.bodyRows ?? 30, id => { void selectTab($, id) })
  })

  // Or the band above the prompt, with what another plugin draws there
  // (clawd-guard) under it.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (ctx.config.placement !== 'prompt' || e.props.hasSurvey || !(await read($, isShown))) return next(e)
    const below = await next(e)
    const el = $.ui.resolve(e)
    const { Box } = el
    const rows = Math.min(ctx.config.rows, (e.props.maxRows ?? 30) - (below ? 1 : 0))
    const panel = await drawGit($, el, e.props.bodyColumns, rows, id => { void selectTab($, id) })
    return below ? <Box flexDirection="column">{panel}{below as never}</Box> : panel
  })
}
