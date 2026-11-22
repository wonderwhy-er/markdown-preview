---
## name: markdown-preview description: Preview and edit local markdown files with clean, Medium-style typography in Chrome. Includes WYSIWYG editing with floating toolbar, auto-save back to .md, and live reload. Use when the user wants to preview, view, read, or edit a .md file as a formatted page — especially blog drafts, articles, documentation, or KB notes. Triggers on phrases like "preview markdown", "edit this article", "show me how this looks", "render this .md file", or "open this nicely". version: 2.1.0

# Markdown Preview & Editor

Preview and edit any local `.md` file as a beautifully formatted, Medium-style page in Chrome — with WYSIWYG editing and auto-save.

## When to Use

- Previewing blog article drafts before publishing
- Editing articles with Medium-style formatting (select text → floating toolbar)
- Reading KB notes, documentation, or READMEs with proper formatting
- Reviewing markdown content with tables, code blocks, and images
- Any time the user wants to "see" or "edit" a markdown file as a formatted page

## Workflow

### Step 1: Start the editor

```bash
# Single file
node ~/.desktop-commander/skills/markdown-preview/scripts/render-preview.mjs /path/to/file.md

# Multiple files in parallel (one server, switch via dropdown or ?f=N)
node ~/.desktop-commander/skills/markdown-preview/scripts/render-preview.mjs /path/to/article-1.md /path/to/article-2.md /path/to/article-3.md
```

Opens Chrome automatically. With multiple files, each gets its own URL (`/?f=0`, `/?f=1`, ...) — open them in separate tabs for side-by-side editing, or use the file-switcher dropdown in the topbar to jump between them.

### Step 2: Edit (Medium-style)

- **Click anywhere** to start typing
- **Select text** → floating toolbar appears with: Bold, Italic, Code, H2, H3, Link, Blockquote, Section break
- **Keyboard shortcuts**: Cmd+B bold, Cmd+I italic, Cmd+K link, Cmd+S save
- **Auto-saves** to the `.md` file after 1.5s of inactivity
- **YAML frontmatter** is preserved automatically on save

### Step 3: External editing

If the file is edited externally (e.g., in VS Code), the browser refreshes automatically.

### Step 4: Stop

The server runs until terminated (Ctrl+C or kill the process).

## Features

- **Medium-style WYSIWYG** — Edit rendered text directly, saves back as markdown
- **Floating toolbar** — Appears on text selection with formatting buttons
- **Auto-save** — Debounced 1.5s save with status indicator (Saved/Editing.../Error)
- **Frontmatter preservation** — YAML frontmatter untouched during editing
- **Medium-style typography** — Source Serif 4 font, 728px content width
- **GitHub-flavored markdown** — tables, task lists, code blocks
- **Syntax-highlighted code** — highlight.js with GitHub theme
- **Local image support** — relative paths resolved from markdown directory
- **Image placeholders** — `<!-- IMAGE: description -->` rendered as placeholder cards
- **Reading time & progress** — auto-calculated in top bar
- **Live reload** — external file changes trigger browser refresh
- **Port fallback** — auto-increments if default port is taken
- **Multi-file mode** — pass several `.md` files; one server hosts all of them with a topbar dropdown switcher and per-file URLs (`/?f=N`)
- **Recent-file server history** — when the requested port already has a markdown-preview server, a new preview command reuses that server, adds the new file to its switcher, and opens it there instead of starting another port
- **Collapsible headings** — hover any heading for a `▾` caret to fold its section; nested H1/H2/H3 cascade automatically. `Cmd+Shift+[` collapses all, `Cmd+Shift+]` expands all. Per-file collapse state persists in `localStorage`.

## Options

| Flag | Default | Description |
|------|---------|-------------|
| `--port` | 3456 | HTTP port for the server |

## Scripts

- [render-preview.mjs](scripts/render-preview.mjs) — Editor + preview server

## Integrated three-panel comparison mode (suggested changes)

Use the **existing Markdown Preview editors** in an editable comparison mode:

```bash
node ~/.desktop-commander/skills/markdown-preview/scripts/render-preview.mjs \
  --compare /path/to/original.md /path/to/revised.md
```

The command opens a local Chrome page with **Original | Changes | Revised**:

1. **Original (left):** the **full normal Markdown Preview editor**, including WYSIWYG editing, floating toolbar, comments/annotations, and autosave. Editing this pane changes the **original .md file**.
2. **Changes (middle):** read-only diff showing removed words red/struck-through and added words green. This automatically refreshes roughly every 1.8 seconds after changes are saved.
3. **Revised (right):** another **full normal Markdown Preview editor**, including all its writing and review features. Editing this pane changes the **revised .md file**.

**Both outer panes are editable and autosave directly to their respective source files.** To preserve a pristine original, duplicate it first or edit only the revised pane. The middle is not an editable merge resolver; accept/reject suggestions by making edits in either text panel. Markdown syntax is stripped from the comparison tokens.

Implementation: `scripts/compare-view.mjs` is imported by `render-preview.mjs`. The compare page uses the regular editor server's `/?f=0` and `/?f=1` pages inside iframes, so existing WYSIWYG, annotations, media handling, saving, and other editor behaviors are shared rather than reimplemented. The middle diff is refreshed from `/__compare-diff` as source files change.

For offline exports, the older `scripts/compare-markdown.py` exists but is **deprecated**; it uses a separate renderer and may display raw Markdown or poor alignment.

Limitations: unusual Markdown structures and heavily reordered documents may produce imperfect paragraph alignment. Comparison has no one-click accept/reject buttons yet.

## Limitations

- HTML→Markdown roundtrip may simplify some complex markdown constructs
- Code block editing is basic (no syntax-aware editing)
- Table editing preserves content but may reformat alignment
- Images cannot be inserted via the editor (add in markdown directly)
