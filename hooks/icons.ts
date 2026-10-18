// Nerd Font icons for the Files pane, colored like an editor's file icons.
// Needs a Nerd Font in the terminal; the `icons` option turns them off.

export type Icon = { glyph: string; color: string }

const FOLDER: Icon = { glyph: '', color: '#7aa2f7' }
const FOLDER_OPEN: Icon = { glyph: '', color: '#7aa2f7' }
const FILE: Icon = { glyph: '', color: '#8a8f98' }

const CONFIG: Icon = { glyph: '', color: '#8a8f98' }
const IMAGE: Icon = { glyph: '', color: '#a074c4' }
const ARCHIVE: Icon = { glyph: '', color: '#e0af68' }
const TEXT: Icon = { glyph: '', color: '#8a8f98' }
const SHELL: Icon = { glyph: '', color: '#89e051' }
const GIT: Icon = { glyph: '', color: '#f14c28' }

// Whole file names first: they win over the extension.
const BY_NAME: Record<string, Icon> = {
  'package.json': { glyph: '', color: '#e8274b' },
  'package-lock.json': { glyph: '', color: '#7a0d21' },
  'composer.json': { glyph: '', color: '#c49a6c' },
  'composer.lock': { glyph: '', color: '#7a5f43' },
  dockerfile: { glyph: '', color: '#458ee6' },
  'docker-compose.yml': { glyph: '', color: '#458ee6' },
  'docker-compose.yaml': { glyph: '', color: '#458ee6' },
  makefile: { glyph: '', color: '#6d8086' },
  license: { glyph: '', color: '#d0bf41' },
  'license.md': { glyph: '', color: '#d0bf41' },
  '.gitignore': GIT,
  '.gitattributes': GIT,
  '.gitmodules': GIT,
  '.gitlab-ci.yml': { glyph: '', color: '#e24329' },
  '.env': { glyph: '', color: '#faf743' },
  '.editorconfig': CONFIG,
  'claude.md': { glyph: '', color: '#d97757' },
}

const BY_EXT: Record<string, Icon> = {
  ts: { glyph: '', color: '#519aba' },
  mts: { glyph: '', color: '#519aba' },
  cts: { glyph: '', color: '#519aba' },
  tsx: { glyph: '', color: '#1354bf' },
  jsx: { glyph: '', color: '#20c2e3' },
  js: { glyph: '', color: '#cbcb41' },
  mjs: { glyph: '', color: '#cbcb41' },
  cjs: { glyph: '', color: '#cbcb41' },
  json: { glyph: '', color: '#cbcb41' },
  jsonc: { glyph: '', color: '#cbcb41' },
  md: { glyph: '', color: '#519aba' },
  mdx: { glyph: '', color: '#519aba' },
  php: { glyph: '', color: '#a074c4' },
  html: { glyph: '', color: '#e44d26' },
  htm: { glyph: '', color: '#e44d26' },
  css: { glyph: '', color: '#42a5f5' },
  scss: { glyph: '', color: '#f55385' },
  sass: { glyph: '', color: '#f55385' },
  less: { glyph: '', color: '#563d7c' },
  vue: { glyph: '', color: '#8dc149' },
  svelte: { glyph: '', color: '#ff3e00' },
  py: { glyph: '', color: '#ffbc03' },
  go: { glyph: '', color: '#00add8' },
  rs: { glyph: '', color: '#dea584' },
  rb: { glyph: '', color: '#cc342d' },
  java: { glyph: '', color: '#cc3e44' },
  c: { glyph: '', color: '#599eff' },
  h: { glyph: '', color: '#a074c4' },
  cpp: { glyph: '', color: '#f34b7d' },
  cs: { glyph: '', color: '#596706' },
  swift: { glyph: '', color: '#e37933' },
  kt: { glyph: '', color: '#7f52ff' },
  lua: { glyph: '', color: '#51a0cf' },
  sql: { glyph: '', color: '#dad8d8' },
  sh: SHELL,
  bash: SHELL,
  zsh: SHELL,
  fish: SHELL,
  yml: CONFIG,
  yaml: CONFIG,
  toml: CONFIG,
  ini: CONFIG,
  conf: CONFIG,
  cfg: CONFIG,
  env: { glyph: '', color: '#faf743' },
  xml: { glyph: '', color: '#e37933' },
  lock: { glyph: '', color: '#bbbbbb' },
  txt: TEXT,
  log: TEXT,
  csv: { glyph: '', color: '#89e051' },
  pdf: { glyph: '', color: '#b30b00' },
  png: IMAGE,
  jpg: IMAGE,
  jpeg: IMAGE,
  gif: IMAGE,
  webp: IMAGE,
  ico: IMAGE,
  svg: { glyph: '', color: '#ffb13b' },
  mp3: { glyph: '', color: '#66d8ef' },
  wav: { glyph: '', color: '#66d8ef' },
  mp4: { glyph: '', color: '#fd971f' },
  zip: ARCHIVE,
  tar: ARCHIVE,
  gz: ARCHIVE,
  tgz: ARCHIVE,
  '7z': ARCHIVE,
  woff: { glyph: '', color: '#ececec' },
  woff2: { glyph: '', color: '#ececec' },
  ttf: { glyph: '', color: '#ececec' },
}

// Folders with a well-known role get their own glyph.
const DIR_BY_NAME: Record<string, string> = {
  '.git': '',
  '.github': '',
  node_modules: '',
  '.claude': '',
}

export function iconFor(name: string, isDir: boolean, isOpen: boolean): Icon {
  const lower = name.toLowerCase()
  if (isDir) {
    const glyph = DIR_BY_NAME[lower]
    if (glyph) return { glyph, color: FOLDER.color }
    return isOpen ? FOLDER_OPEN : FOLDER
  }
  const named = BY_NAME[lower]
  if (named) return named
  if (lower.endsWith('.blade.php')) return { glyph: '', color: '#f05340' }
  if (lower.startsWith('.env')) return BY_EXT.env!
  if (lower.endsWith('.test.ts') || lower.endsWith('.spec.ts')) return { glyph: '', color: '#2b7489' }
  const dot = lower.lastIndexOf('.')
  if (dot > 0) return BY_EXT[lower.slice(dot + 1)] ?? FILE
  return FILE
}
