"""Render docs/demo.gif: the clawd-git panel through one short session.

Claude edits a file and it shows up marked in Files and Changes; the
"By Claude" filter narrows Changes to Claude's files; a diff opens with Review
and Open; the files are staged, a commit message is drafted and committed, and
the commit graph shows it. Each frame is drawn cell by cell as the Pane
hook in hooks/draw.tsx lays the panel out: the same frames, marks, colors and
columns, with the line icons (Codicons). Needs Pillow and FiraCode Nerd Font
Mono (paths below are the per-user font folder on Linux).

    python3 docs/demo_gif.py docs/demo.gif
"""
import os
import sys

from PIL import Image, ImageDraw, ImageFont

OUT = sys.argv[1]
FONTS = os.path.expanduser("~/.local/share/fonts/FiraCodeNerdFont")
SIZE = 20

# The Hybrid palette, as the terminal draws the named colors.
COLORS = {
    "bg": (22, 23, 24),
    "text": (197, 200, 198),
    "dim": (98, 104, 110),
    "cyan": (127, 190, 179),
    "blue": (109, 144, 176),
    "magenta": (160, 126, 171),
    "yellow": (227, 181, 94),
    "green": (179, 190, 90),
    "red": (204, 102, 102),
    "claude": (217, 119, 87),
}

mono = ImageFont.truetype(f"{FONTS}/FiraCodeNerdFontMono-Regular.ttf", SIZE)
bold = ImageFont.truetype(f"{FONTS}/FiraCodeNerdFontMono-Bold.ttf", SIZE)
asc, desc = mono.getmetrics()
CW = round(mono.getlength("M"))
CH = asc + desc + 2

W = 64          # the pane's columns
H = 30          # its rows
INNER = W - 4   # inside a frame: border and padding
PAD = 16

# Codicons, as the line icon set draws them.
I = {
    "files": "", "changes": "", "commits": "",
    "folder": "", "open": "", "file": "", "down": "", "right": "",
    "search": "", "refresh": "", "collapse": "", "branch": "",
    "sparkle": "", "diff": "", "commit": "", "back": "",
    "goto": "", "add": "", "remove": "", "discard": "",
}


def run(text, color="text", is_bold=False, underline=False):
    return (text, color, is_bold, underline)


def width(row):
    return sum(len(t) for t, _, _, _ in row)


def pad_to(row, cols):
    return row + [run(" " * max(0, cols - width(row)))]


def boxed(rows, height):
    """Rows inside a rounded dim frame of `height` rows, as the pane draws it."""
    out = [[run("╭" + "─" * (W - 2) + "╮", "dim")]]
    body = rows + [[] for _ in range(height - 2 - len(rows))]
    for row in body[: height - 2]:
        inner = row[:]
        while width(inner) > INNER:
            text, color, b, u = inner[-1]
            over = width(inner) - INNER
            inner[-1] = (text[:-over] if over < len(text) else "", color, b, u)
            if inner[-1][0] == "":
                inner.pop()
        out.append([run("│ ", "dim")] + pad_to(inner, INNER) + [run(" │", "dim")])
    out.append([run("╰" + "─" * (W - 2) + "╯", "dim")])
    return out


def tabs(lit, changes="", hover=None):
    row = []
    for i, (key, label, badge) in enumerate([("files", "Files", ""), ("changes", "Changes", changes),
                                              ("commits", "Commits", "")]):
        if i:
            row.append(run("·", "dim"))
        is_lit = key == lit
        is_hover = key == hover
        color = "cyan" if is_lit or is_hover else "dim"
        row.append(run(" "))
        row.append(run(("◆ " if is_lit else I[key] + " "), color, underline=is_hover))
        row.append(run(label, color, is_lit, underline=is_hover))
        if badge:
            row.append(run(" " + badge, "yellow" if is_lit else "dim", underline=is_hover))
        row.append(run(" "))
    return row


def divider(notice=None, kind="ok"):
    if not notice:
        return [run("─" * INNER, "dim")]
    text = f" {'✓' if kind == 'ok' else '✗'} {notice} "
    return [run("──", "dim"), run(text, "green" if kind == "ok" else "red"), run("─" * (INNER - 2 - len(text)), "dim")]


def title_line(left, actions, hover=None):
    right = []
    for key, icon, word, color in actions:
        is_hover = key == hover
        right += [run(" "), run(icon, "cyan" if is_hover else color, underline=is_hover),
                  run(" " + word, "cyan" if is_hover else "dim", underline=is_hover), run(" ")]
    # The title gives way, as the pane's title box shrinks before the toolbar.
    room = INNER - width(right) - 1
    kept = []
    for text, color, b, u in left:
        if width(kept) + len(text) > room:
            cut = room - width(kept)
            if cut > 1:
                kept.append((text[: cut - 1] + "…", color, b, u))
            break
        kept.append((text, color, b, u))
    gap = INNER - width(kept) - width(right)
    return kept + [run(" " * max(1, gap))] + right


def dots(*parts):
    row = []
    for i, part in enumerate(p for p in parts if p):
        if i:
            row.append(run(" · ", "dim"))
        row.append(part)
    return row


def pane(lit, title, actions, rows, changes="", notice=None, hover=None, kind="ok"):
    header = boxed([tabs(lit, changes, hover), divider(notice, kind), title_line(title, actions, hover)], 5)
    return header + boxed(rows, H - 5)


BRANCH = run(f"{I['branch']} main", "magenta")
FILES_TITLE = dots(run("~/projects/shop", "blue"), BRANCH)
FILES_ACTIONS = [("search", I["search"], "Search", "cyan"), ("collapse", I["collapse"], "Collapse", "cyan"),
                 ("refresh", I["refresh"], "Refresh", "cyan")]


def tree(marked=None, hover=None, selected=None):
    """The Files tab: app/ open, its files; a mark after a changed name."""
    def folder(name, depth=0, is_open=False, tint=None, dot=False):
        guides = "│ " * depth
        return [run(guides, "dim"), run((I["down"] if is_open else I["right"]) + " ", "dim"),
                run((I["open"] if is_open else I["folder"]) + " ", "blue"),
                run(name, tint or "text")] + ([run(" •", "yellow")] if dot else [])

    def leaf(name, depth=1, mark=None, claude=False):
        path = f"app/{name}"
        is_sel = path == selected
        is_hover = path == hover
        color = "cyan" if is_sel or is_hover else ({"M": "yellow", "U": "green"}.get(mark) if mark else "text")
        row = [run("│ " * depth, "dim"), run("  "), run(I["file"] + " ", "cyan" if is_sel else "dim"),
               run(name, color, is_sel, underline=is_hover)]
        if mark:
            row.append(run(" " + mark, color))
        if claude:
            row.append(run(" " + I["sparkle"], "claude"))
        return row

    marked = marked or {}
    return [
        folder("app", 0, True, "yellow" if marked else None, bool(marked)),
        leaf("cart.ts", 1, *marked.get("cart.ts", (None, False))),
        leaf("checkout.ts", 1, *marked.get("checkout.ts", (None, False))),
        leaf("discounts.ts", 1, *marked.get("discounts.ts", (None, False))),
        leaf("payment.ts", 1, *marked.get("payment.ts", (None, False))),
        folder("config"),
        folder("public"),
        folder("tests", 0, False, "yellow" if "tests" in marked else None, "tests" in marked),
        folder("node_modules", 0, False, "dim"),
        [run("  "), run(I["file"] + " ", "dim"), run(".gitignore")],
        [run("  "), run(I["file"] + " ", "dim"), run("package.json")],
        [run("  "), run(I["file"] + " ", "dim"), run("README.md")],
        [run("  "), run(I["file"] + " ", "dim"), run("tsconfig.json")],
    ]


def change_row(name, added, removed, mark, claude=False, staged=False, hover=None):
    color = {"M": "yellow", "U": "green", "A": "green"}[mark]
    is_hover = name == hover
    left = [run(I["file"] + " ", "dim"), run(name.split("/")[-1], "cyan" if is_hover else "text", underline=is_hover)]
    if claude:
        left.append(run(" " + I["sparkle"], "claude"))
    if "/" in name:
        left.append(run(" " + name.rsplit("/", 1)[0], "dim"))
    figures = [run(f"+{added}", "green"), run(f" −{removed}", "red" if removed else "dim"), run(f" {mark}", color)]
    buttons = ([run(" " + I["remove"], "yellow")] if staged else [run(" " + I["add"], "green")]) + [run(" " + I["discard"], "red")]
    gap = INNER - 2 - width(left) - width(figures) - width(buttons)
    return left + [run(" " * max(1, gap))] + figures + buttons


def group(title, n, act):
    gap = INNER - 2 - len(f"{title}  {n}") - len(act) - 1
    return [run(f"{title}  {n}", "dim", True), run(" " * gap), run(" " + act, "dim")]


CHANGES_ACTIONS = [("session", I["sparkle"], "By Claude 2", "claude"), ("all", I["diff"], "Diff all", "cyan"),
                   ("refresh", I["refresh"], "Refresh", "cyan")]


def changes_title(n, added, removed):
    return dots(BRANCH, run(f"{n} changed", "dim"), run(f"+{added} −{removed}", "green"))


def diff_rows():
    """A file's diff as Code draws it: gutters, markers, add and remove colors."""
    lines = [
        (None, None, " ", "  … line 18  export function total(cart: Cart)", "dim"),
        (18, 18, " ", "  const items = cart.items", "text"),
        (19, None, "-", "  let sum = items.reduce((n, i) => n + i.price, 0)", "red"),
        (None, 19, "+", "  let sum = items.reduce((n, i) => n + i.price * i.qty, 0)", "green"),
        (None, 20, "+", "  sum -= discountFor(cart, sum)", "green"),
        (20, 21, " ", "  return round(sum)", "text"),
        (21, 22, " ", "}", "text"),
        (None, None, " ", "", "text"),
        (None, None, " ", "  … line 41  function round(n: number)", "dim"),
        (41, 42, " ", "  return Math.round(n * 100) / 100", "text"),
    ]
    rows = [[run("modified · unstaged", "dim")], []]
    for old, new, mark, text, color in lines:
        if old is None and new is None:
            rows.append([run(text, color)])
            continue
        gutter = f"{old if old else '':>3} {new if new else '':>3} "
        rows.append([run(gutter, "dim"), run(mark + " ", color), run(text[2:], color)])
    return rows


def graph_rows(extra=None):
    commits = ([extra] if extra else []) + [
        ("a91f3c2", "" if extra else "main", "Round cart totals to cents", "2h"),
        ("7c0e5d1", "", "Add the payment provider", "1d"),
        ("e4b2a90", "", "Checkout page skeleton", "2d"),
        ("19d7f44", "", "First commit", "3d"),
    ]
    rows = []
    for i, (h, ref, subject, age) in enumerate(commits):
        row = [run("● ", "cyan"), run(h, "dim")]
        if ref:
            row.append(run(f" ({ref})", "cyan", True))
        row.append(run(" " + subject))
        row.append(run(" " * max(1, INNER - 2 - width(row) - len(age))))
        row.append(run(age, "dim"))
        rows.append(row)
        if i < len(commits) - 1:
            rows.append([run("│", "dim")])
    return rows


# ------------------------------------------------------------------ the story

scenes = []  # (rows, ms)


def scene(rows, ms):
    scenes.append((rows, ms))


scene(pane("files", FILES_TITLE, FILES_ACTIONS, tree()), 1600)
marked = {"discounts.ts": ("U", True)}
scene(pane("files", dots(run("~/projects/shop", "blue"), BRANCH, run("●1", "yellow")), FILES_ACTIONS,
           tree(marked), changes="1", notice=None), 1100)
marked = {"discounts.ts": ("U", True), "cart.ts": ("M", True), "tests": ("", False)}
scene(pane("files", dots(run("~/projects/shop", "blue"), BRANCH, run("●3", "yellow")), FILES_ACTIONS,
           tree({"discounts.ts": ("U", True), "cart.ts": ("M", True)}), changes="3", hover="changes"), 1300)

changes = [
    group("CHANGES", 2, "Stage all"),
    change_row("app/cart.ts", 2, 1, "M", claude=True),
    change_row("README.md", 4, 0, "M"),
    [],
    group("NEW", 1, "Stage all"),
    change_row("app/discounts.ts", 38, 0, "U", claude=True),
]
scene(pane("changes", changes_title(3, 44, 1), CHANGES_ACTIONS, changes, changes="3"), 1500)
scene(pane("changes", changes_title(3, 44, 1), CHANGES_ACTIONS, changes, changes="3", hover="session"), 900)
only = [group("CHANGES", 1, "Stage all"), change_row("app/cart.ts", 2, 1, "M", claude=True), [],
        group("NEW", 1, "Stage all"), change_row("app/discounts.ts", 38, 0, "U", claude=True)]
by_claude = [("session", I["sparkle"], "All files", "claude"), ("all", I["diff"], "Diff all", "cyan"),
             ("refresh", I["refresh"], "Refresh", "cyan")]
scene(pane("changes", changes_title(2, 40, 1), by_claude, only, changes="3"), 1300)
scene(pane("changes", changes_title(2, 40, 1), by_claude,
           [group("CHANGES", 1, "Stage all"), change_row("app/cart.ts", 2, 1, "M", claude=True, hover="app/cart.ts"), [],
            group("NEW", 1, "Stage all"), change_row("app/discounts.ts", 38, 0, "U", claude=True)], changes="3"), 800)

back = [run(I["back"] + " Back", "cyan"), run(" "), run("app/cart.ts", "text", True)]
diff_actions = [("review", I["sparkle"], "Review", "claude"), ("edit", I["goto"], "Open", "cyan")]
scene(pane("changes", back, diff_actions, diff_rows(), changes="3"), 2000)
scene(pane("changes", back, diff_actions, diff_rows(), changes="3", hover="review"), 800)
scene(pane("changes", back, diff_actions, diff_rows(), changes="3", notice="Asked Claude to review the changes."), 1800)

staged = [
    group("STAGED", 2, "Unstage all"),
    change_row("app/cart.ts", 2, 1, "M", claude=True, staged=True),
    change_row("app/discounts.ts", 38, 0, "A", claude=True, staged=True),
    [],
    group("CHANGES", 1, "Stage all"),
    change_row("README.md", 4, 0, "M"),
]
commit_actions = [("commit", I["commit"], "Commit", "cyan"), ("all", I["diff"], "Diff all", "cyan"),
                  ("refresh", I["refresh"], "Refresh", "cyan")]
scene(pane("changes", changes_title(3, 44, 1), commit_actions, staged, changes="3", notice="Staged 2 files"), 1400)
scene(pane("changes", changes_title(3, 44, 1), commit_actions, staged, changes="3", hover="commit"), 700)
draft = [
    [run(I["commit"] + " Commit message", "cyan", True)],
    [run("  Add discount codes to cart totals")],
    [],
    [run("  Totals now multiply by quantity and take off the discount", "dim")],
    [run("  for the cart's code; discounts live in app/discounts.ts.", "dim")],
    [run(" Commit ", "green"), run(" Again "), run(" Ask Claude ", "claude"), run(" Cancel ")],
    [],
] + staged
scene(pane("changes", changes_title(3, 44, 1), commit_actions, draft, changes="3"), 2400)
scene(pane("commits", dots(run("History", "text", True), run("5 commits", "dim"), run("all branches", "dim")),
           [("refresh", I["refresh"], "Refresh", "cyan")],
           graph_rows(("b3e81d0", "main", "Add discount codes to cart totals", "now")), changes="1",
           notice="Committed."), 2000)


# ------------------------------------------------------------------ drawing


def draw(rows):
    img = Image.new("RGB", (W * CW + 2 * PAD, H * CH + 2 * PAD), COLORS["bg"])
    d = ImageDraw.Draw(img)
    for r, row in enumerate(rows[:H]):
        col = 0
        for text, color, is_bold, underline in row:
            rgb = COLORS[color]
            for ch in text:
                x, y = PAD + col * CW, PAD + r * CH
                if ch in "─│╭╮╰╯━┃":
                    # Box lines drawn as lines, so they join across rows.
                    mid_x, mid_y = x + CW // 2, y + CH // 2
                    thick = 2 if ch in "━┃" else 1
                    if ch in "─━":
                        d.line([(x, mid_y), (x + CW, mid_y)], fill=rgb, width=thick)
                    elif ch in "│┃":
                        d.line([(mid_x, y), (mid_x, y + CH)], fill=rgb, width=thick)
                    else:
                        # Rounded corners: a quarter circle joining the two lines.
                        rad = min(CW, CH) // 2
                        right = ch in "╭╰"
                        down = ch in "╭╮"
                        cx = mid_x + (rad if right else -rad)
                        cy = mid_y + (rad if down else -rad)
                        start = {"╭": 180, "╮": 270, "╰": 90, "╯": 0}[ch]
                        d.arc([cx - rad, cy - rad, cx + rad, cy + rad], start, start + 90, fill=rgb)
                        d.line([(cx, mid_y), (x + CW if right else x, mid_y)], fill=rgb)
                        d.line([(mid_x, cy), (mid_x, y + CH if down else y)], fill=rgb)
                elif ch != " ":
                    d.text((x, y + 1), ch, font=bold if is_bold else mono, fill=rgb)
                if underline and ch != " ":
                    d.line([(x, y + CH - 3), (x + CW, y + CH - 3)], fill=rgb)
                col += 1
    return img


frames = [draw(rows).quantize(colors=64, dither=Image.Dither.NONE) for rows, _ in scenes]
frames[0].save(OUT, save_all=True, append_images=frames[1:], duration=[ms for _, ms in scenes], loop=0, optimize=True)
print(f"{OUT}: {len(frames)} frames, {sum(ms for _, ms in scenes) / 1000:.1f}s")
