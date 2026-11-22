# Markdown Preview

Local, Medium-style WYSIWYG Markdown preview/editor for AI workflows. Includes live reload, comments, and side-by-side comparison.

## Install

Requires Node.js 18+ and macOS for browser auto-opening. Clone this repo into a skill folder, or run it from any checked-out directory.

    node scripts/render-preview.mjs /absolute/path/to/article.md
    node scripts/render-preview.mjs --compare /path/to/original.md /path/to/revised.md

Opens at http://localhost:3456 (or next free port). Edits save back to source markdown.

## Security

This is a local editor, not a public web service. It binds only to 127.0.0.1, checks Host headers, and refuses cross-origin writes. Only open Markdown you trust. It can read linked local images and write Markdown, so do not expose it through tunnels or port forwarding.

Read [SKILL.md](SKILL.md) for full usage.

## License

MIT.
