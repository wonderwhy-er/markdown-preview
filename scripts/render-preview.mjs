#!/usr/bin/env node
/**
 * markdown-preview: Medium-style markdown editor and previewer.
 * v3: Adds annotation/feedback layer (like/dislike/edit-tracking + comments)
 *
 * Usage:
 *   node scripts/render-preview.mjs /path/to/file.md [--port 3456]
 *
 * Features:
 *   - Medium-style WYSIWYG editing (contenteditable)
 *   - Floating toolbar on text selection
 *   - Auto-save to .md file on edit (debounced)
 *   - Annotation layer: like/dislike/comment per block, saved to sidecar .annotations.json
 *   - Edit tracking: manually edited blocks auto-marked as "edited"
 *   - GitHub-flavored markdown rendering
 *   - Syntax-highlighted code blocks
 *   - Local image support
 *   - YAML frontmatter preserved on save
 *   - Reading progress bar
 */

import { readFileSync, writeFileSync, watchFile, unwatchFile, mkdirSync, existsSync } from 'fs';
import { createServer, request as httpRequest } from 'http';
import { resolve, dirname, basename, extname, join } from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { buildComparePage, buildCompareDiff } from './compare-view.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const compareMode = args.includes('--compare');
const portFlag = args.indexOf('--port');
const port = portFlag !== -1 ? parseInt(args[portFlag + 1], 10) : 3456;
const mdPaths = args
  .filter((a, i) => !a.startsWith('--') && (portFlag === -1 || i !== portFlag + 1))
  .map(p => resolve(p));

if (mdPaths.length === 0 || mdPaths.some(p => !p.endsWith('.md'))) {
  console.error('Usage: node render-preview.mjs <file.md> [<file2.md> ...] [--port 3456]');
  process.exit(1);
}

const files = mdPaths.map(p => ({
  path: p,
  dir: dirname(p),
  title: basename(p, '.md'),
  annotationsPath: p.replace(/\.md$/, '.annotations.json'),
}));

// --- Frontmatter handling ---
function extractFrontmatter(md) {
  if (md.startsWith('---')) {
    const end = md.indexOf('---', 3);
    if (end !== -1) {
      return { frontmatter: md.slice(0, end + 3), body: md.slice(end + 3).trim() };
    }
  }
  return { frontmatter: '', body: md };
}

function wordCount(text) {
  const clean = text.replace(/<[^>]*>/g, '').trim();
  return clean ? clean.split(/\s+/).length : 0;
}

function readingTime(text) {
  return Math.ceil(wordCount(text) / 238);
}

function speakingTime(text) {
  return Math.ceil(wordCount(text) / 120);
}

// --- Markdown → HTML ---
function md2html(md) {
  let html = md;
  html = html.replace(/<!--\s*IMAGE:\s*([\s\S]*?)\s*-->/g,
    (_, d) => `<div class="image-placeholder">${d.trim().replace(/\n/g,'<br>')}</div>`);
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const cls = lang ? ` class="language-${lang}"` : '';
    return `<pre><code${cls}>${code.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</code></pre>`;
  });
  html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, src) => {
    let s = src.trim();
    if (s.startsWith('file://')) s = s.slice('file://'.length);
    if (s.startsWith('/')) {
      s = '/__local?path=' + encodeURIComponent(s);
    }
    return `<img src="${s}" alt="${alt}">`;
  });
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  html = html.replace(/^\s*[-*_]{3,}\s*$/gm, '<hr>');
  html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>');
  html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  html = html.replace(/((?:^\|.+\|$\n?)+)/gm, (block) => {
    const rows = block.trim().split('\n').filter(r => r.trim());
    if (rows.length < 2 || !/^\|[\s-:|]+\|$/.test(rows[1])) return block;
    const hdr = rows[0].split('|').filter(c=>c.trim()).map(c=>c.trim());
    let t = '<table><thead><tr>' + hdr.map(c=>`<th>${c}</th>`).join('') + '</tr></thead><tbody>';
    rows.slice(2).forEach(r => {
      const cells = r.split('|').filter(c=>c.trim()).map(c=>c.trim());
      t += '<tr>' + cells.map(c=>`<td>${c}</td>`).join('') + '</tr>';
    });
    return t + '</tbody></table>';
  });
  const blocks = html.split(/\n{2,}/);
  html = blocks.map(b => {
    const t = b.trim();
    if (!t) return '';
    if (/^<(h[1-6]|pre|table|ul|ol|li|blockquote|hr|div|img|p)/.test(t)) return t;
    return `<p>${t.replace(/\n/g,'<br>')}</p>`;
  }).join('\n\n');
  html = html.replace(/<p>&gt;\s?(.*?)(<br>|<\/p>)/g, (m,c,e) =>
    `<blockquote><p>${c}</p></blockquote>${e==='</p>'?'':''}`);
  return html;
}

// --- Build page with Medium-style editor + annotation layer ---
function buildPage(mdFilePath, fileTitle, fileIndex = 0, allFiles = null) {
  const raw = readFileSync(mdFilePath, 'utf-8');
  const { body } = extractFrontmatter(raw);
  const bodyHTML = md2html(body);
  const minutes = readingTime(body);
  const speakingMinutes = speakingTime(body);

  const filesForClient = allFiles
    ? allFiles.map((f, i) => ({ index: i, title: f.title, path: f.path }))
    : [{ index: 0, title: fileTitle, path: mdFilePath }];
  const filesJson = JSON.stringify(filesForClient).replace(/</g, '\\u003c');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${fileTitle}</title>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github.min.css">
<link href="https://fonts.googleapis.com/css2?family=Source+Serif+4:opsz,wght@8..60,300;8..60,400;8..60,600;8..60,700;8..60,800&display=swap" rel="stylesheet">
<style>
:root{--text:#1a1a1a;--dim:#6b6b6b;--bg:#fff;--surface:#f9f9f9;--border:#e6e6e6;--accent:#1a8917;--code-bg:#f6f8fa;
--font-serif:'Source Serif 4','Georgia',serif;--font-sans:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
--font-mono:'SFMono-Regular','Fira Code','Consolas',monospace;--content-width:728px;
--like-color:#22c55e;--dislike-color:#ef4444;--edit-color:#3b82f6;--comment-bg:#fffbeb}
*{margin:0;padding:0;box-sizing:border-box}
html{font-size:18px;-webkit-font-smoothing:antialiased}
body{font-family:var(--font-serif);color:var(--text);background:var(--bg);line-height:1.72}
.progress-bar{position:fixed;top:0;left:0;height:3px;background:var(--accent);z-index:200;transition:width .1s;width:0%}
.topbar{position:sticky;top:0;z-index:100;background:rgba(255,255,255,.97);border-bottom:1px solid var(--border);padding:10px 24px;display:flex;align-items:center;gap:12px;font-family:var(--font-sans);font-size:13px;color:var(--dim);backdrop-filter:blur(8px)}
.topbar .dot{color:var(--accent);font-size:18px}
.topbar .filepath{font-family:var(--font-mono);font-size:12px;color:var(--dim);opacity:.7;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
.topbar .reading-time{font-weight:600;white-space:nowrap}
.topbar .save-status{font-size:12px;padding:3px 10px;border-radius:12px;transition:all .3s}
.topbar .save-status.saved{color:var(--accent);background:rgba(26,137,23,.08)}
.topbar .save-status.saving{color:var(--dim);background:var(--surface)}
.topbar .save-status.error{color:#c00;background:rgba(200,0,0,.08)}
article{max-width:var(--content-width);margin:0 auto;padding:48px 24px 120px;outline:none}
article:focus{outline:none}
h1{font-family:var(--font-sans);font-size:2.6rem;font-weight:800;line-height:1.12;letter-spacing:-.02em;margin:0 0 12px}
h2{font-family:var(--font-sans);font-size:1.45rem;font-weight:700;line-height:1.25;letter-spacing:-.01em;margin:2.2em 0 .6em}
h3{font-family:var(--font-sans);font-size:1.15rem;font-weight:600;line-height:1.3;margin:1.8em 0 .5em}
h4{font-family:var(--font-sans);font-size:1rem;font-weight:600;margin:1.5em 0 .4em}
h1+p>em:only-child{display:block;font-family:var(--font-serif);font-size:1.25rem;color:var(--dim);line-height:1.5;margin-bottom:32px;font-style:italic}
p{margin:0 0 1.15em;font-size:1rem}
a{color:var(--accent);text-decoration:underline;text-underline-offset:2px}
strong{font-weight:700}
blockquote{border-left:3px solid var(--text);padding-left:20px;margin:1.5em 0;font-style:italic;font-size:1.1rem}
blockquote p{margin-bottom:.5em}
hr{border:none;text-align:center;margin:2.5em 0}
hr::before{content:'···';font-size:1.5rem;letter-spacing:.6em;color:var(--dim)}
ul,ol{margin:0 0 1.15em;padding-left:1.6em}
li{margin-bottom:.35em}
code{font-family:var(--font-mono);font-size:.88em;background:var(--code-bg);border-radius:4px;padding:2px 6px}
pre{background:var(--code-bg);border-radius:8px;padding:20px 24px;margin:1.5em 0;overflow-x:auto;font-size:.82rem;line-height:1.55;border:1px solid var(--border)}
pre code{background:none;padding:0;border-radius:0;font-size:inherit}
table{width:100%;border-collapse:collapse;margin:1.5em 0;font-size:.92rem;font-family:var(--font-sans)}
th,td{text-align:left;padding:10px 14px;border-bottom:1px solid var(--border)}
th{font-weight:600;font-size:.78rem;text-transform:uppercase;letter-spacing:.05em;color:var(--dim)}
tr:hover td{background:var(--surface)}
img{max-width:100%;height:auto;border-radius:4px;margin:1.5em 0;display:block}
.image-placeholder{background:var(--surface);border:2px dashed var(--border);border-radius:8px;padding:24px;margin:1.5em 0;text-align:center;font-family:var(--font-sans);font-size:.85rem;color:var(--dim)}
.image-placeholder::before{content:'🖼';display:block;font-size:1.5rem;margin-bottom:8px}

/* === Floating Toolbar === */
#toolbar{
  position:absolute;display:none;z-index:300;
  background:#1a1a1a;border-radius:6px;padding:4px;
  box-shadow:0 4px 16px rgba(0,0,0,.25);
  transform:translateX(-50%);
  transition:opacity .15s;
}
#toolbar.visible{display:flex;animation:toolbarIn .15s ease}
@keyframes toolbarIn{from{opacity:0;transform:translateX(-50%) translateY(4px)}to{opacity:1;transform:translateX(-50%) translateY(0)}}
#toolbar button{
  background:none;border:none;color:#e0e0e0;font-family:var(--font-sans);
  font-size:14px;padding:6px 10px;cursor:pointer;border-radius:4px;
  display:flex;align-items:center;justify-content:center;min-width:32px;
  transition:background .1s,color .1s;
}
#toolbar button:hover{background:rgba(255,255,255,.15);color:#fff}
#toolbar button.active{background:rgba(26,137,23,.6);color:#fff}
#toolbar .sep{width:1px;background:rgba(255,255,255,.15);margin:4px 2px;align-self:stretch}
#toolbar::after{
  content:'';position:absolute;bottom:-6px;left:50%;transform:translateX(-50%);
  border-left:6px solid transparent;border-right:6px solid transparent;border-top:6px solid #1a1a1a;
}

/* === Collapsible headings === */
h1,h2,h3,h4{position:relative}
.fold-caret{
  position:absolute;left:-26px;top:50%;transform:translateY(-50%);
  width:20px;height:20px;display:inline-flex;align-items:center;justify-content:center;
  cursor:pointer;color:var(--dim);opacity:0;transition:opacity .15s,transform .15s;
  font-family:var(--font-sans);font-size:11px;user-select:none;border-radius:4px;
}
h1:hover .fold-caret,h2:hover .fold-caret,h3:hover .fold-caret,h4:hover .fold-caret,
.fold-caret.collapsed{opacity:1}
.fold-caret:hover{background:var(--surface);color:var(--text)}
.fold-caret.collapsed{transform:translateY(-50%) rotate(-90deg);color:var(--accent)}
.section-hidden{display:none!important}
h1.is-collapsed::after,h2.is-collapsed::after,h3.is-collapsed::after,h4.is-collapsed::after{
  content:'…';color:var(--dim);font-weight:400;margin-left:.4em;opacity:.6;
}
.topbar .fold-toggle{
  background:none;border:1px solid var(--border);color:var(--dim);
  font-family:var(--font-sans);font-size:11px;padding:3px 9px;border-radius:10px;
  cursor:pointer;transition:all .15s;
}
.topbar .fold-toggle:hover{color:var(--text);border-color:var(--text)}
.topbar .file-switcher{
  background:var(--surface);border:1px solid var(--border);color:var(--text);
  font-family:var(--font-sans);font-size:12px;padding:3px 8px;border-radius:10px;
  cursor:pointer;max-width:240px;text-overflow:ellipsis;
}
.topbar .file-switcher:hover{border-color:var(--text)}
@media (max-width:900px){.fold-caret{left:-22px}}

/* === Annotation Layer (inline text highlights) === */
.topbar .ann-summary{
  display:none;font-family:var(--font-sans);font-size:12px;gap:8px;align-items:center;
}
.topbar .ann-summary.visible{display:flex}
.topbar .ann-summary span{display:flex;align-items:center;gap:2px}
.topbar .ann-summary .cnt-like{color:var(--like-color)}
.topbar .ann-summary .cnt-dislike{color:var(--dislike-color)}
.topbar .ann-summary .cnt-comment{color:#b45309}
/* Inline highlights on <mark> elements */
mark.ann-like{background:rgba(34,197,94,.2);border-bottom:2px solid var(--like-color);border-radius:2px;cursor:pointer}
mark.ann-dislike{background:rgba(239,68,68,.18);border-bottom:2px solid var(--dislike-color);border-radius:2px;cursor:pointer}
mark.ann-comment{background:rgba(251,191,36,.18);border-bottom:2px dashed #b45309;border-radius:2px;cursor:pointer}
mark.ann-like:hover,mark.ann-dislike:hover,mark.ann-comment:hover{filter:brightness(.92)}
/* Comment tooltip on hover */
.ann-tooltip{
  position:absolute;z-index:400;
  background:#222;color:#fff;font-family:var(--font-sans);font-size:13px;
  padding:8px 12px;border-radius:6px;max-width:320px;line-height:1.4;
  box-shadow:0 4px 14px rgba(0,0,0,.2);pointer-events:auto;
  white-space:pre-wrap;word-break:break-word;
}
.ann-tooltip::after{
  content:'';position:absolute;top:-6px;left:20px;
  border-left:6px solid transparent;border-right:6px solid transparent;border-bottom:6px solid #222;
}
.ann-tooltip .tip-remove{
  display:inline-block;margin-left:8px;cursor:pointer;opacity:.6;
  font-size:12px;vertical-align:middle;
}
.ann-tooltip .tip-remove:hover{opacity:1}
/* Comment input popover */
#commentPopover{
  position:absolute;z-index:350;display:none;
  background:#fff;border:1px solid var(--border);border-radius:8px;
  box-shadow:0 8px 24px rgba(0,0,0,.12);padding:10px;width:280px;
  font-family:var(--font-sans);font-size:13px;
}
#commentPopover.visible{display:block}
#commentPopover textarea{
  width:100%;min-height:64px;border:1px solid var(--border);border-radius:6px;
  padding:8px;font-family:var(--font-sans);font-size:13px;resize:vertical;
  outline:none;
}
#commentPopover textarea:focus{border-color:var(--accent)}
#commentPopover .cp-actions{display:flex;justify-content:flex-end;gap:6px;margin-top:6px}
#commentPopover .cp-actions button{
  font-family:var(--font-sans);font-size:12px;padding:4px 10px;border-radius:6px;
  cursor:pointer;border:1px solid var(--border);background:var(--surface);color:var(--text);
}
#commentPopover .cp-actions .cp-save{background:var(--accent);color:#fff;border-color:var(--accent)}
/* Remove button on existing annotation hover */
.ann-remove-btn{
  display:inline-flex;align-items:center;justify-content:center;
  width:16px;height:16px;border-radius:50%;background:rgba(0,0,0,.6);color:#fff;
  font-size:10px;cursor:pointer;margin-left:2px;vertical-align:middle;
  border:none;line-height:1;opacity:0;transition:opacity .15s;
}
mark:hover .ann-remove-btn{opacity:1}

@media print{.topbar,.progress-bar,#toolbar,.fold-caret,.ann-tooltip,#commentPopover{display:none!important}mark.ann-like,mark.ann-dislike,mark.ann-comment{background:none;border:none}.section-hidden{display:block!important}article{padding:0;max-width:100%}}
</style>
</head>
<body>
<div class="progress-bar" id="progress"></div>
<div class="topbar">
  <span class="dot">●</span>
  <span class="filepath">${fileTitle}.md</span>
  <select class="file-switcher" id="fileSwitcher" data-files='${filesJson}' data-current="${fileIndex}" ${filesForClient.length > 1 ? '' : 'hidden'} title="Switch file (each file is at /?f=N)"></select>
  <button class="review-toggle" id="reviewToggle" title="Toggle review/annotation mode" style="display:none">📝 Review</button>
  <div class="ann-summary" id="annSummary">
    <span class="cnt-like" title="Liked">👍 <b id="cntLike">0</b></span>
    <span class="cnt-dislike" title="Disliked">👎 <b id="cntDislike">0</b></span>
    <span class="cnt-comment" title="Comments">💬 <b id="cntComment">0</b></span>
  </div>
  <button class="fold-toggle" id="foldToggle" title="Collapse/expand all sections">Collapse all</button>
  <span class="save-status saved" id="saveStatus">Saved</span>
  <span class="reading-time">${minutes} min read · ${speakingMinutes} min speaking</span>
</div>

<!-- Floating toolbar -->
<div id="toolbar">
  <button data-cmd="bold" title="Bold (Cmd+B)"><strong>B</strong></button>
  <button data-cmd="italic" title="Italic (Cmd+I)"><em>I</em></button>
  <button data-cmd="code" title="Inline code">‹›</button>
  <div class="sep"></div>
  <button data-cmd="h1" title="Heading 1">H1</button>
  <button data-cmd="h2" title="Heading 2">H2</button>
  <button data-cmd="h3" title="Heading 3">H3</button>
  <div class="sep"></div>
  <button data-cmd="link" title="Add link (Cmd+K)">🔗</button>
  <button data-cmd="blockquote" title="Blockquote">❝</button>
  <div class="sep"></div>
  <button data-ann="like" title="Like this text — keep it">👍</button>
  <button data-ann="dislike" title="Dislike — change this">👎</button>
  <button data-ann="comment" title="Leave a comment">💬</button>
</div>

<article id="content" contenteditable="true" spellcheck="true">${bodyHTML}</article>

<!-- Comment popover (shown after like/dislike — optional comment) -->
<div id="commentPopover">
  <div class="cp-header" id="cpHeader" style="font-family:var(--font-sans);font-size:13px;margin-bottom:6px;font-weight:600;display:flex;align-items:center;gap:4px"></div>
  <textarea id="commentText" placeholder="Add a comment (optional)"></textarea>
  <div class="cp-actions">
    <button class="cp-cancel">Cancel</button>
    <button class="cp-save">Save</button>
  </div>
</div>

<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>
<script>hljs.highlightAll();</script>
${editorScript()}
${annotationScript()}
</body>
</html>`;
}

// --- Client-side editor JS ---
function editorScript() {
  return `
<script>
(function(){
  const article = document.getElementById('content');
  const toolbar = document.getElementById('toolbar');
  const saveStatus = document.getElementById('saveStatus');
  let saveTimer = null;
  let lastEditTime = 0;
  const _fileParam = new URLSearchParams(location.search).get('f') ?? '0';
  const _saveEndpoint = '/__save?f=' + encodeURIComponent(_fileParam);
  const _changedEndpoint = '/__changed?f=' + encodeURIComponent(_fileParam);

  // === Collapsible headings ===
  const FOLD_KEY = 'mdpreview:folds:' + location.pathname + location.search;
  const headingTag = el => /^H[1-4]$/.test(el?.tagName || '') ? el.tagName : null;
  const headingLevel = el => { const t = headingTag(el); return t ? +t[1] : 0; };

  function slugify(text) {
    return (text || '').toLowerCase().trim()
      .replace(/[^a-z0-9\\s-]/g, '').replace(/\\s+/g, '-').slice(0, 80) || 'h';
  }

  function getHeadings() {
    return Array.from(article.querySelectorAll('h1,h2,h3,h4'));
  }

  function ensureHeadingIds() {
    const seen = new Map();
    getHeadings().forEach(h => {
      if (h.dataset.foldId) return;
      const base = slugify(h.textContent);
      const n = (seen.get(base) || 0) + 1;
      seen.set(base, n);
      h.dataset.foldId = n === 1 ? base : (base + '-' + n);
    });
  }

  function loadFolds() {
    try { return new Set(JSON.parse(localStorage.getItem(FOLD_KEY) || '[]')); }
    catch { return new Set(); }
  }
  function saveFolds(set) {
    try { localStorage.setItem(FOLD_KEY, JSON.stringify([...set])); } catch {}
  }
  let collapsed = loadFolds();

  function forEachInSection(heading, fn) {
    const level = headingLevel(heading);
    let el = heading.nextElementSibling;
    while (el) {
      const elLevel = headingLevel(el);
      if (elLevel && elLevel <= level) break;
      fn(el, elLevel);
      el = el.nextElementSibling;
    }
  }

  function applyFold(heading, isCollapsed) {
    heading.classList.toggle('is-collapsed', isCollapsed);
    const caret = heading.querySelector('.fold-caret');
    if (caret) caret.classList.toggle('collapsed', isCollapsed);
    if (isCollapsed) {
      forEachInSection(heading, el => el.classList.add('section-hidden'));
    } else {
      const level = headingLevel(heading);
      let el = heading.nextElementSibling;
      while (el) {
        const elLevel = headingLevel(el);
        if (elLevel && elLevel <= level) break;
        el.classList.remove('section-hidden');
        if (elLevel && collapsed.has(el.dataset.foldId)) {
          el.classList.add('is-collapsed');
          const innerCaret = el.querySelector('.fold-caret');
          if (innerCaret) innerCaret.classList.add('collapsed');
          forEachInSection(el, inner => inner.classList.add('section-hidden'));
          let skip = el.nextElementSibling;
          while (skip) {
            const sl = headingLevel(skip);
            if (sl && sl <= elLevel) break;
            skip = skip.nextElementSibling;
          }
          el = skip;
          continue;
        }
        el = el.nextElementSibling;
      }
    }
  }

  function toggleHeading(heading) {
    const id = heading.dataset.foldId;
    const willCollapse = !collapsed.has(id);
    if (willCollapse) collapsed.add(id); else collapsed.delete(id);
    saveFolds(collapsed);
    applyFold(heading, willCollapse);
  }

  function injectCarets() {
    getHeadings().forEach(h => {
      if (h.querySelector('.fold-caret')) return;
      const caret = document.createElement('span');
      caret.className = 'fold-caret';
      caret.contentEditable = 'false';
      caret.textContent = '▾';
      caret.title = 'Toggle section';
      caret.addEventListener('mousedown', e => { e.preventDefault(); e.stopPropagation(); });
      caret.addEventListener('click', e => {
        e.preventDefault(); e.stopPropagation();
        toggleHeading(h);
      });
      h.insertBefore(caret, h.firstChild);
    });
  }

  function restoreFolds() {
    if (!collapsed.size) return;
    getHeadings()
      .filter(h => collapsed.has(h.dataset.foldId))
      .sort((a, b) => headingLevel(a) - headingLevel(b))
      .forEach(h => applyFold(h, true));
  }

  function collapseAll() {
    getHeadings().forEach(h => collapsed.add(h.dataset.foldId));
    saveFolds(collapsed);
    getHeadings().forEach(h => {
      h.classList.add('is-collapsed');
      const c = h.querySelector('.fold-caret');
      if (c) c.classList.add('collapsed');
    });
    Array.from(article.children).forEach(el => {
      if (!headingTag(el)) el.classList.add('section-hidden');
    });
    getHeadings().forEach(h => {
      if (headingLevel(h) > 1) h.classList.add('section-hidden');
    });
  }

  function expandAll() {
    collapsed.clear();
    saveFolds(collapsed);
    article.querySelectorAll('.section-hidden').forEach(el => el.classList.remove('section-hidden'));
    article.querySelectorAll('.is-collapsed').forEach(el => el.classList.remove('is-collapsed'));
    article.querySelectorAll('.fold-caret.collapsed').forEach(el => el.classList.remove('collapsed'));
  }

  const foldToggle = document.getElementById('foldToggle');
  let allCollapsed = false;
  function refreshToggleLabel() {
    foldToggle.textContent = allCollapsed ? 'Expand all' : 'Collapse all';
  }
  foldToggle?.addEventListener('click', () => {
    allCollapsed = !allCollapsed;
    if (allCollapsed) collapseAll(); else expandAll();
    refreshToggleLabel();
  });

  document.addEventListener('keydown', e => {
    if (!(e.metaKey || e.ctrlKey) || !e.shiftKey) return;
    if (e.key === '[' || e.code === 'BracketLeft') {
      e.preventDefault(); collapseAll(); allCollapsed = true; refreshToggleLabel();
    } else if (e.key === ']' || e.code === 'BracketRight') {
      e.preventDefault(); expandAll(); allCollapsed = false; refreshToggleLabel();
    }
  });

  function initFolds() {
    ensureHeadingIds();
    injectCarets();
    restoreFolds();
  }
  initFolds();

  const foldObserver = new MutationObserver(muts => {
    const needsInit = muts.some(m =>
      Array.from(m.addedNodes).some(n => n.nodeType === 1 && headingTag(n))
    );
    if (needsInit) initFolds();
  });
  foldObserver.observe(article, { childList: true });

  // === Floating toolbar ===
  function updateToolbar() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !article.contains(sel.anchorNode)) {
      toolbar.classList.remove('visible');
      return;
    }
    const range = sel.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    toolbar.style.top = (rect.top + window.scrollY - 48) + 'px';
    toolbar.style.left = (rect.left + rect.width / 2) + 'px';
    toolbar.classList.add('visible');
    toolbar.querySelectorAll('button[data-cmd]').forEach(btn => {
      const cmd = btn.dataset.cmd;
      let active = false;
      if (cmd === 'bold') active = document.queryCommandState('bold') || !!getParent(sel.anchorNode, 'STRONG') || !!getParent(sel.anchorNode, 'B');
      if (cmd === 'italic') active = document.queryCommandState('italic') || !!getParent(sel.anchorNode, 'EM') || !!getParent(sel.anchorNode, 'I');
      if (cmd === 'code') { const c = getParent(sel.anchorNode, 'CODE'); active = !!c && !c.closest('pre'); }
      const block = getParentBlock(sel.anchorNode);
      if (cmd === 'h2') active = block?.tagName === 'H2';
      if (cmd === 'h3') active = block?.tagName === 'H3';
      if (cmd === 'blockquote') active = !!sel.anchorNode.closest?.('blockquote') || !!getParent(sel.anchorNode, 'BLOCKQUOTE');
      btn.classList.toggle('active', active);
    });
  }

  function getParent(node, tag) {
    while (node && node !== article) {
      if (node.tagName === tag) return node;
      node = node.parentNode;
    }
    return null;
  }

  function getParentBlock(node) {
    while (node && node !== article) {
      if (['H1','H2','H3','H4','P','BLOCKQUOTE','PRE','LI'].includes(node.tagName)) return node;
      node = node.parentNode;
    }
    return null;
  }

  document.addEventListener('selectionchange', () => requestAnimationFrame(updateToolbar));
  document.addEventListener('mouseup', () => setTimeout(updateToolbar, 10));

  // === Toolbar commands ===
  toolbar.addEventListener('click', (e) => {
    // Handle annotation buttons (👍👎)
    const annBtn = e.target.closest('button[data-ann]');
    if (annBtn) {
      e.preventDefault();
      e.stopPropagation();
      if (window._annHandleToolbarClick) window._annHandleToolbarClick(annBtn.dataset.ann);
      return;
    }

    const btn = e.target.closest('button[data-cmd]');
    if (!btn) return;
    e.preventDefault();
    const cmd = btn.dataset.cmd;
    const sel = window.getSelection();
    if (!sel.rangeCount) return;

    if (cmd === 'bold') {
      const wrapper = getParent(sel.anchorNode, 'STRONG') || getParent(sel.anchorNode, 'B');
      if (wrapper && sel.toString().trim() && wrapper.textContent.trim() === sel.toString().trim()) {
        const text = document.createTextNode(wrapper.textContent);
        wrapper.replaceWith(text);
        const r = document.createRange(); r.selectNodeContents(text);
        sel.removeAllRanges(); sel.addRange(r);
      } else {
        document.execCommand('bold');
      }
    }
    else if (cmd === 'italic') {
      const wrapper = getParent(sel.anchorNode, 'EM') || getParent(sel.anchorNode, 'I');
      if (wrapper && sel.toString().trim() && wrapper.textContent.trim() === sel.toString().trim()) {
        const text = document.createTextNode(wrapper.textContent);
        wrapper.replaceWith(text);
        const r = document.createRange(); r.selectNodeContents(text);
        sel.removeAllRanges(); sel.addRange(r);
      } else {
        document.execCommand('italic');
      }
    }
    else if (cmd === 'code') {
      const existingCode = getParent(sel.anchorNode, 'CODE');
      if (existingCode && existingCode.closest('pre') === null) {
        const text = document.createTextNode(existingCode.textContent);
        existingCode.replaceWith(text);
        const r = document.createRange(); r.selectNodeContents(text);
        sel.removeAllRanges(); sel.addRange(r);
      } else {
        const range = sel.getRangeAt(0);
        const text = range.toString();
        if (text) {
          const fragment = range.extractContents();
          const code = document.createElement('code');
          code.textContent = fragment.textContent;
          range.insertNode(code);
          const r = document.createRange(); r.selectNodeContents(code);
          sel.removeAllRanges(); sel.addRange(r);
        }
      }
    }
    else if (cmd === 'h1' || cmd === 'h2' || cmd === 'h3') {
      const block = getParentBlock(sel.anchorNode);
      if (!block) return;
      const tag = cmd.toUpperCase();
      if (block.tagName === tag) {
        const p = document.createElement('p');
        p.innerHTML = block.innerHTML;
        block.replaceWith(p);
      } else {
        const h = document.createElement(tag);
        h.innerHTML = block.innerHTML;
        block.replaceWith(h);
      }
    }
    else if (cmd === 'link') {
      const url = prompt('URL:');
      if (url) document.execCommand('createLink', false, url);
    }
    else if (cmd === 'blockquote') {
      const block = getParentBlock(sel.anchorNode);
      const bq = getParent(sel.anchorNode, 'BLOCKQUOTE');
      if (bq) {
        const p = document.createElement('p');
        p.innerHTML = bq.querySelector('p')?.innerHTML || bq.innerHTML;
        bq.replaceWith(p);
      } else if (block) {
        const q = document.createElement('blockquote');
        const p = document.createElement('p');
        p.innerHTML = block.innerHTML;
        q.appendChild(p);
        block.replaceWith(q);
      }
    }
    else if (cmd === 'hr') {
      const block = getParentBlock(sel.anchorNode);
      if (block) {
        const hr = document.createElement('hr');
        block.parentNode.insertBefore(hr, block);
      }
    }

    scheduleSave();
    setTimeout(updateToolbar, 50);
  });

  // === Keyboard shortcuts ===
  article.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey) {
      if (e.key === 'b') { e.preventDefault(); document.execCommand('bold'); scheduleSave(); }
      if (e.key === 'i') { e.preventDefault(); document.execCommand('italic'); scheduleSave(); }
      if (e.key === 'k') {
        e.preventDefault();
        const url = prompt('URL:');
        if (url) { document.execCommand('createLink', false, url); scheduleSave(); }
      }
      if (e.key === 's') { e.preventDefault(); doSave(); }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      const block = getParentBlock(window.getSelection()?.anchorNode);
      if (block && ['H1','H2','H3','H4'].includes(block.tagName)) {
        e.preventDefault();
        const p = document.createElement('p');
        p.innerHTML = '<br>';
        block.after(p);
        const range = document.createRange();
        range.setStart(p, 0);
        range.collapse(true);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      }
    }
  });

  // === Auto-save (debounced) ===
  article.addEventListener('input', () => scheduleSave());

  function scheduleSave() {
    lastEditTime = Date.now();
    saveStatus.textContent = 'Editing...';
    saveStatus.className = 'save-status saving';
    clearTimeout(saveTimer);
    saveTimer = setTimeout(doSave, 1500);
  }

  async function doSave() {
    saveStatus.textContent = 'Saving...';
    saveStatus.className = 'save-status saving';
    const md = html2md(article);
    try {
      const res = await fetch(_saveEndpoint, {
        method: 'POST',
        headers: {'Content-Type':'text/plain'},
        body: md
      });
      const data = await res.json();
      if (data.ok) {
        saveStatus.textContent = 'Saved';
        saveStatus.className = 'save-status saved';
        const words = md.trim().split(/\\s+/).length;
        document.querySelector('.reading-time').textContent = Math.ceil(words / 238) + ' min read';
      } else {
        saveStatus.textContent = 'Error';
        saveStatus.className = 'save-status error';
      }
    } catch(e) {
      saveStatus.textContent = 'Error';
      saveStatus.className = 'save-status error';
    }
  }

  // === HTML → Markdown converter ===
  function html2md(container) {
    let md = '';
    for (const node of container.childNodes) {
      md += nodeToMd(node);
    }
    return md.replace(/\\n{3,}/g, '\\n\\n').trim() + '\\n';
  }

  function nodeToMd(node) {
    if (node.nodeType === 3) return node.textContent;
    if (node.nodeType !== 1) return '';
    const tag = node.tagName;
    if (tag === 'H1') return '# ' + inline(node) + '\\n\\n';
    if (tag === 'H2') return '## ' + inline(node) + '\\n\\n';
    if (tag === 'H3') return '### ' + inline(node) + '\\n\\n';
    if (tag === 'H4') return '#### ' + inline(node) + '\\n\\n';
    if (tag === 'P') return inline(node) + '\\n\\n';
    if (tag === 'HR') return '---\\n\\n';
    if (tag === 'BR') return '\\n';
    if (tag === 'BLOCKQUOTE') {
      const inner = Array.from(node.childNodes).map(n => nodeToMd(n)).join('').trim();
      return inner.split('\\n').map(l => '> ' + l).join('\\n') + '\\n\\n';
    }
    if (tag === 'PRE') {
      const code = node.querySelector('code');
      const lang = code?.className?.replace('language-','').replace('hljs','').trim() || '';
      const text = code?.textContent || node.textContent;
      return '\\x60\\x60\\x60' + lang + '\\n' + text + '\\n\\x60\\x60\\x60\\n\\n';
    }
    if (tag === 'UL') return Array.from(node.children).map(li => '- ' + inline(li)).join('\\n') + '\\n\\n';
    if (tag === 'OL') return Array.from(node.children).map((li,i) => (i+1) + '. ' + inline(li)).join('\\n') + '\\n\\n';
    if (tag === 'TABLE') return tableToMd(node) + '\\n\\n';
    if (tag === 'IMG') {
      const alt = node.getAttribute('alt') || '';
      let src = node.getAttribute('src') || '';
      const localMatch = src.match(/^\\/__local\\?path=(.+)$/);
      if (localMatch) {
        try { src = decodeURIComponent(localMatch[1]); } catch(_) {}
      }
      return '![' + alt + '](' + src + ')\\n\\n';
    }
    if (tag === 'DIV' && node.classList.contains('image-placeholder')) {
      return '<!-- IMAGE: ' + node.textContent.trim() + ' -->\\n\\n';
    }
    return Array.from(node.childNodes).map(n => nodeToMd(n)).join('');
  }

  function inline(node) {
    let out = '';
    for (const child of node.childNodes) {
      if (child.nodeType === 3) { out += child.textContent; continue; }
      if (child.nodeType !== 1) continue;
      if (child.classList && (child.classList.contains('fold-caret') || child.classList.contains('ann-remove-btn'))) continue;
      const t = child.tagName;
      // Unwrap annotation marks — preserve their text content
      if (t === 'MARK' && (child.classList.contains('ann-like') || child.classList.contains('ann-dislike') || child.classList.contains('ann-comment'))) { out += inline(child); continue; }
      if (t === 'STRONG' || t === 'B') out += '**' + inline(child) + '**';
      else if (t === 'EM' || t === 'I') out += '*' + inline(child) + '*';
      else if (t === 'CODE') out += '\\x60' + child.textContent + '\\x60';
      else if (t === 'A') out += '[' + inline(child) + '](' + child.getAttribute('href') + ')';
      else if (t === 'BR') out += '\\n';
      else if (t === 'IMG') {
        let src = child.getAttribute('src') || '';
        const m = src.match(/^\\/__local\\?path=(.+)$/);
        if (m) { try { src = decodeURIComponent(m[1]); } catch(_) {} }
        out += '![' + (child.alt||'') + '](' + src + ')';
      }
      else out += inline(child);
    }
    return out;
  }

  function tableToMd(table) {
    const rows = Array.from(table.querySelectorAll('tr'));
    if (!rows.length) return '';
    const lines = rows.map(row =>
      '| ' + Array.from(row.cells).map(c => c.textContent.trim()).join(' | ') + ' |'
    );
    if (lines.length > 0) {
      const cols = rows[0].cells.length;
      lines.splice(1, 0, '| ' + Array(cols).fill('---').join(' | ') + ' |');
    }
    return lines.join('\\n');
  }

  // === Progress bar ===
  window.addEventListener('scroll',()=>{
    const h=document.documentElement.scrollHeight-window.innerHeight;
    document.getElementById('progress').style.width=(h>0?(window.scrollY/h)*100:0)+'%';
  });

  // === Live reload ===
  setInterval(async()=>{
    if (Date.now() - lastEditTime < 10000) return;
    try{
      const r=await fetch(_changedEndpoint);
      const d=await r.json();
      if(d.changed) location.reload();
    }catch(e){}
  },2000);

  article.addEventListener('focus', () => { lastEditTime = Date.now(); });
  article.addEventListener('click', () => { lastEditTime = Date.now(); });

  // === Link handling ===
  article.addEventListener('click', (e) => {
    const a = e.target.closest('a[href]');
    if (!a) return;
    const href = a.getAttribute('href');
    if (!href) return;
    if (e.metaKey || e.ctrlKey || e.button === 1) {
      e.preventDefault();
      e.stopPropagation();
      window.open(href, '_blank', 'noopener,noreferrer');
    }
  });
  article.addEventListener('auxclick', (e) => {
    if (e.button !== 1) return;
    const a = e.target.closest('a[href]');
    if (!a) return;
    e.preventDefault();
    e.stopPropagation();
    window.open(a.getAttribute('href'), '_blank', 'noopener,noreferrer');
  });

  // Floating link popup
  const linkPopup = document.createElement('div');
  linkPopup.id = 'linkPopup';
  linkPopup.style.cssText = 'position:fixed;display:none;background:#222;color:#fff;font-family:system-ui,sans-serif;font-size:13px;line-height:1.4;padding:6px 10px;border-radius:6px;box-shadow:0 4px 12px rgba(0,0,0,.18);z-index:300;max-width:480px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:auto';
  document.body.appendChild(linkPopup);
  let popupHideTimer = null;
  let currentLinkEl = null;
  function showLinkPopup(a) {
    if (popupHideTimer) { clearTimeout(popupHideTimer); popupHideTimer = null; }
    currentLinkEl = a;
    const href = a.getAttribute('href') || '';
    const display = href.length > 60 ? href.slice(0,57) + '…' : href;
    linkPopup.innerHTML = '<a href="' + href.replace(/"/g, '&quot;') + '" target="_blank" rel="noopener noreferrer" style="color:#7cc5ff;text-decoration:none;margin-right:8px">↗ Open</a><span style="color:#bbb">' + display.replace(/</g,'&lt;') + '</span>';
    const r = a.getBoundingClientRect();
    linkPopup.style.display = 'block';
    const popupH = 32;
    const top = r.top - popupH - 6;
    linkPopup.style.top = (top > 4 ? top : r.bottom + 6) + 'px';
    linkPopup.style.left = Math.max(8, Math.min(r.left, window.innerWidth - linkPopup.offsetWidth - 8)) + 'px';
  }
  function scheduleHide() {
    if (popupHideTimer) clearTimeout(popupHideTimer);
    popupHideTimer = setTimeout(() => {
      linkPopup.style.display = 'none';
      currentLinkEl = null;
    }, 220);
  }
  article.addEventListener('mouseover', (e) => {
    const a = e.target.closest('a[href]');
    if (a) showLinkPopup(a);
  });
  article.addEventListener('mouseout', (e) => {
    const a = e.target.closest('a[href]');
    if (!a) return;
    const rt = e.relatedTarget;
    if (rt && (rt === linkPopup || linkPopup.contains(rt))) return;
    scheduleHide();
  });
  linkPopup.addEventListener('mouseenter', () => {
    if (popupHideTimer) { clearTimeout(popupHideTimer); popupHideTimer = null; }
  });
  linkPopup.addEventListener('mouseleave', () => scheduleHide());
  const linkStyle = document.createElement('style');
  linkStyle.textContent = '#content a[href]{cursor:text}#content a[href]:hover{background:rgba(26,137,23,.08);border-radius:2px}';
  document.head.appendChild(linkStyle);

  // === Image upload (drag-drop + paste) ===
  const toast = document.createElement('div');
  toast.id = 'imgUploadToast';
  toast.style.cssText = 'position:fixed;bottom:20px;right:20px;background:#222;color:#fff;font-family:system-ui,sans-serif;font-size:13px;padding:10px 14px;border-radius:8px;box-shadow:0 4px 14px rgba(0,0,0,.18);z-index:400;display:none;max-width:380px;line-height:1.4';
  document.body.appendChild(toast);
  let toastTimer = null;
  function showToast(msg, kind) {
    toast.textContent = msg;
    toast.style.background = kind === 'error' ? '#a32626' : kind === 'success' ? '#1a8917' : '#222';
    toast.style.display = 'block';
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.style.display = 'none'; }, 3500);
  }
  const dropStyle = document.createElement('style');
  dropStyle.textContent = '#content.drag-over{outline:2px dashed #1a8917;outline-offset:6px;background:rgba(26,137,23,.04)}';
  document.head.appendChild(dropStyle);
  const ALLOWED_TYPES = ['image/png','image/jpeg','image/jpg','image/gif','image/webp'];
  async function uploadImageBlob(blob, sourceFilename) {
    if (!ALLOWED_TYPES.includes(blob.type)) { showToast('Unsupported image type', 'error'); return null; }
    if (blob.size > 10 * 1024 * 1024) { showToast('Image too large (>10MB)', 'error'); return null; }
    showToast('Uploading image…');
    const headers = { 'Content-Type': blob.type };
    if (sourceFilename) headers['X-Image-Filename'] = sourceFilename;
    try {
      const r = await fetch('/__upload-image', { method: 'POST', headers, body: blob });
      const data = await r.json();
      if (!data.ok) { showToast('Upload failed: ' + (data.error || 'unknown'), 'error'); return null; }
      showToast('✓ Saved ' + data.path, 'success');
      return data.path;
    } catch (e) { showToast('Upload failed: ' + e.message, 'error'); return null; }
  }
  function insertImageAtSelection(srcPath, altText) {
    const img = document.createElement('img');
    let displaySrc = srcPath;
    if (srcPath && srcPath.startsWith('/') && !srcPath.startsWith('/__local') && !srcPath.startsWith('/images/') && !srcPath.startsWith('images/')) {
      displaySrc = '/__local?path=' + encodeURIComponent(srcPath);
    }
    img.src = displaySrc;
    img.alt = altText || '';
    img.style.maxWidth = '100%';
    img.style.display = 'block';
    img.style.margin = '24px auto';
    const sel = window.getSelection();
    let range;
    if (sel && sel.rangeCount && article.contains(sel.anchorNode)) {
      range = sel.getRangeAt(0);
      range.deleteContents();
    } else {
      range = document.createRange();
      range.selectNodeContents(article);
      range.collapse(false);
    }
    const p = document.createElement('p');
    p.appendChild(img);
    range.insertNode(p);
    range.setStartAfter(p);
    range.setEndAfter(p);
    sel.removeAllRanges();
    sel.addRange(range);
    article.dispatchEvent(new Event('input', { bubbles: true }));
  }
  function moveCaretToDropPoint(e) {
    let range = null;
    if (document.caretRangeFromPoint) {
      range = document.caretRangeFromPoint(e.clientX, e.clientY);
    } else if (document.caretPositionFromPoint) {
      const pos = document.caretPositionFromPoint(e.clientX, e.clientY);
      if (pos) { range = document.createRange(); range.setStart(pos.offsetNode, pos.offset); range.collapse(true); }
    }
    if (range && article.contains(range.startContainer)) {
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
  }
  let dragDepth = 0;
  article.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer || !Array.from(e.dataTransfer.types).includes('Files')) return;
    dragDepth++;
    article.classList.add('drag-over');
  });
  article.addEventListener('dragover', (e) => {
    if (!e.dataTransfer) return;
    if (Array.from(e.dataTransfer.types).includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }
  });
  article.addEventListener('dragleave', (e) => {
    dragDepth--;
    if (dragDepth <= 0) { dragDepth = 0; article.classList.remove('drag-over'); }
  });
  article.addEventListener('drop', async (e) => {
    if (!e.dataTransfer) return;
    const files = Array.from(e.dataTransfer.files || []).filter(f => f.type.startsWith('image/'));
    if (!files.length) return;
    e.preventDefault(); e.stopPropagation();
    dragDepth = 0; article.classList.remove('drag-over');
    moveCaretToDropPoint(e);
    if (e.altKey) {
      const uriList = e.dataTransfer.getData('text/uri-list') || '';
      const uris = uriList.split(/\\r?\\n/).filter(u => u && !u.startsWith('#') && u.startsWith('file://'));
      if (uris.length) {
        for (const uri of uris) {
          const absPath = decodeURIComponent(uri.replace(/^file:\\/\\//, ''));
          const ext = (absPath.match(/\\.([a-z0-9]+)$/i) || [])[1] || '';
          if (!/^(png|jpe?g|gif|webp|svg)$/i.test(ext)) { showToast('Skipped: ' + absPath, 'error'); continue; }
          const alt = absPath.split('/').pop().replace(/\\.[^.]+$/, '').replace(/[-_]+/g, ' ');
          insertImageAtSelection(absPath, alt);
          showToast('Linked: ' + absPath, 'success');
        }
        return;
      }
    }
    for (const f of files) {
      const path = await uploadImageBlob(f, f.name);
      if (path) {
        const alt = (f.name || '').replace(/\\.[^.]+$/, '').replace(/[-_]+/g, ' ');
        insertImageAtSelection(path, alt);
      }
    }
  });
  article.addEventListener('paste', async (e) => {
    if (!e.clipboardData) return;
    const items = Array.from(e.clipboardData.items || []);
    const imgItems = items.filter(i => i.kind === 'file' && i.type.startsWith('image/'));
    if (!imgItems.length) return;
    e.preventDefault();
    for (const item of imgItems) {
      const blob = item.getAsFile();
      if (!blob) continue;
      const path = await uploadImageBlob(blob, blob.name || '');
      if (path) insertImageAtSelection(path, '');
    }
  });

  // === File switcher ===
  (function initFileSwitcher(){
    const sel = document.getElementById('fileSwitcher');
    if (!sel) return;
    let filesList;
    try { filesList = JSON.parse(sel.dataset.files || '[]'); } catch (e) { return; }
    if (!Array.isArray(filesList) || filesList.length < 2) return;
    const current = parseInt(sel.dataset.current || '0', 10);
    sel.innerHTML = '';
    filesList.forEach(f => {
      const opt = document.createElement('option');
      opt.value = String(f.index);
      opt.textContent = f.title + '.md';
      if (f.index === current) opt.selected = true;
      sel.appendChild(opt);
    });
    sel.addEventListener('change', () => {
      window.location.search = '?f=' + encodeURIComponent(sel.value);
    });
  })();
})();
</script>`;
}

// --- Annotation layer script: inline text-selection based ---
function annotationScript() {
  return `
<script>
(function(){
  const article = document.getElementById('content');
  const reviewToggle = document.getElementById('reviewToggle');
  const commentPopover = document.getElementById('commentPopover');
  const commentText = document.getElementById('commentText');
  const annSummary = document.getElementById('annSummary');
  let reviewMode = true; // always on
  let annotations = [];
  let pendingRange = null;
  let pendingReaction = null;
  let annIdCounter = 0;
  let tooltip = null;

  // === Generate unique ID ===
  function nextId() { return 'ann-' + (++annIdCounter) + '-' + Date.now().toString(36); }

  // === Load annotations from server ===
  // Pass ?f=N so the server knows which file's annotations to read/write
  const _annFileParam = new URLSearchParams(location.search).get('f') ?? '0';
  const _annEndpoint = '/__annotations?f=' + encodeURIComponent(_annFileParam);

  async function loadAnnotations() {
    try {
      const r = await fetch(_annEndpoint);
      const d = await r.json();
      if (d.ok && Array.isArray(d.annotations)) {
        annotations = d.annotations;
        annIdCounter = annotations.reduce((m, a) => {
          const n = parseInt((a.id||'').split('-')[1] || '0');
          return n > m ? n : m;
        }, 0);
        reapplyMarks();
      }
    } catch(e) { console.log('No annotations yet'); }
  }

  // === Save annotations to server ===
  async function saveAnnotations() {
    try {
      await fetch(_annEndpoint, {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify(annotations)
      });
    } catch(e) { console.error('Save annotations failed:', e); }
    updateSummary();
  }

  // === Wrap current selection in a <mark> ===
  function wrapSelection(reaction, comment) {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !article.contains(sel.anchorNode)) return null;
    const range = sel.getRangeAt(0);
    const text = range.toString().trim();
    if (!text) return null;

    // Gather context (20 chars before/after)
    const fullText = article.textContent;
    const tempRange = document.createRange();
    tempRange.setStart(article, 0);
    tempRange.setEnd(range.startContainer, range.startOffset);
    const beforeOffset = tempRange.toString().length;
    const contextBefore = fullText.slice(Math.max(0, beforeOffset - 20), beforeOffset);
    const contextAfter = fullText.slice(beforeOffset + text.length, beforeOffset + text.length + 20);

    const id = nextId();
    const cls = reaction === 'like' ? 'ann-like' : reaction === 'dislike' ? 'ann-dislike' : 'ann-comment';

    // Wrap in <mark>
    const mark = document.createElement('mark');
    mark.className = cls;
    mark.dataset.annId = id;
    if (comment) mark.dataset.comment = comment;
    try {
      range.surroundContents(mark);
    } catch(e) {
      const fragment = range.extractContents();
      mark.appendChild(fragment);
      range.insertNode(mark);
    }

    sel.removeAllRanges();

    const ann = { id, text, reaction: reaction || 'comment', comment: comment || '', contextBefore, contextAfter };
    annotations.push(ann);
    saveAnnotations();
    return id;
  }

  // === Remove an annotation ===
  function removeAnnotation(id) {
    const mark = article.querySelector('mark[data-ann-id="' + id + '"]');
    if (mark) {
      const parent = mark.parentNode;
      while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
      parent.removeChild(mark);
      parent.normalize(); // merge adjacent text nodes
    }
    annotations = annotations.filter(a => a.id !== id);
    saveAnnotations();
  }

  // === Reapply marks from saved annotations (on page load/reload) ===
  function reapplyMarks() {
    // Remove existing marks first
    article.querySelectorAll('mark[data-ann-id]').forEach(m => {
      const parent = m.parentNode;
      while (m.firstChild) parent.insertBefore(m.firstChild, m);
      parent.removeChild(m);
    });
    article.normalize();

    const fullText = article.textContent;
    for (const ann of annotations) {
      // Find the text in the document using context
      const searchStr = ann.text;
      if (!searchStr) continue;

      // Try to find by context
      let bestOffset = -1;
      let startIdx = 0;
      while (true) {
        const idx = fullText.indexOf(searchStr, startIdx);
        if (idx === -1) break;
        // Score by context match
        const before = fullText.slice(Math.max(0, idx - 20), idx);
        const after = fullText.slice(idx + searchStr.length, idx + searchStr.length + 20);
        if (ann.contextBefore && before.endsWith(ann.contextBefore.slice(-10))) {
          bestOffset = idx;
          break;
        }
        if (bestOffset === -1) bestOffset = idx; // first occurrence as fallback
        startIdx = idx + 1;
      }
      if (bestOffset === -1) continue; // text no longer exists — orphaned

      // Convert text offset to DOM range
      const range = textOffsetToRange(article, bestOffset, bestOffset + searchStr.length);
      if (!range) continue;

      const cls = ann.reaction === 'like' ? 'ann-like' : ann.reaction === 'dislike' ? 'ann-dislike' : 'ann-comment';
      const mark = document.createElement('mark');
      mark.className = cls;
      mark.dataset.annId = ann.id;
      if (ann.comment) mark.dataset.comment = ann.comment;
      try {
        range.surroundContents(mark);
      } catch(e) {
        const fragment = range.extractContents();
        mark.appendChild(fragment);
        range.insertNode(mark);
      }
    }
    article.normalize();
    updateSummary();
  }

  // === Convert text offset to DOM Range ===
  function textOffsetToRange(root, startOffset, endOffset) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let charCount = 0;
    let startNode = null, startOff = 0, endNode = null, endOff = 0;
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const len = node.textContent.length;
      if (!startNode && charCount + len > startOffset) {
        startNode = node;
        startOff = startOffset - charCount;
      }
      if (!endNode && charCount + len >= endOffset) {
        endNode = node;
        endOff = endOffset - charCount;
        break;
      }
      charCount += len;
    }
    if (!startNode || !endNode) return null;
    const range = document.createRange();
    range.setStart(startNode, startOff);
    range.setEnd(endNode, endOff);
    return range;
  }

  // === Update summary bar ===
  function updateSummary() {
    const likes = annotations.filter(a => a.reaction === 'like').length;
    const dislikes = annotations.filter(a => a.reaction === 'dislike').length;
    const comments = annotations.filter(a => a.comment).length;
    document.getElementById('cntLike').textContent = likes;
    document.getElementById('cntDislike').textContent = dislikes;
    document.getElementById('cntComment').textContent = comments;
    annSummary.classList.toggle('visible', likes + dislikes + comments > 0);
  }

  // === Handle 👍👎💬 click from the main toolbar ===
  window._annHandleToolbarClick = function(action) {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !article.contains(sel.anchorNode)) return;
    pendingRange = sel.getRangeAt(0).cloneRange();
    pendingReaction = action; // 'like', 'dislike', or 'comment'

    const cpHeader = document.getElementById('cpHeader');
    if (action === 'like') {
      cpHeader.innerHTML = '👍 <span style="color:var(--like-color)">Like</span> — add a comment?';
      commentText.placeholder = 'Why do you like this? (optional)';
    } else if (action === 'dislike') {
      cpHeader.innerHTML = '👎 <span style="color:var(--dislike-color)">Dislike</span> — add a comment?';
      commentText.placeholder = 'What should change? (optional)';
    } else {
      cpHeader.innerHTML = '💬 <span style="color:#b45309">Comment</span>';
      commentText.placeholder = 'Your comment...';
    }

    const rect = pendingRange.getBoundingClientRect();
    commentPopover.style.top = (rect.bottom + window.scrollY + 8) + 'px';
    commentPopover.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - 300)) + 'px';
    commentText.value = '';
    commentPopover.classList.add('visible');
    document.getElementById('toolbar').classList.remove('visible');
    commentText.focus();
  };

  // === Comment popover actions ===
  commentPopover.querySelector('.cp-save').addEventListener('click', () => {
    const comment = commentText.value.trim();
    const editingId = commentPopover._editingId;

    if (editingId) {
      // Editing existing annotation — just update the comment
      const ann = annotations.find(a => a.id === editingId);
      if (ann) {
        ann.comment = comment;
        const mark = article.querySelector('mark[data-ann-id="' + editingId + '"]');
        if (mark && comment) mark.dataset.comment = comment;
        saveAnnotations();
      }
      commentPopover._editingId = null;
    } else if (pendingRange && pendingReaction) {
      // New annotation
      if (pendingReaction === 'comment' && !comment) {
        commentText.focus();
        commentText.style.borderColor = 'var(--dislike-color)';
        setTimeout(() => { commentText.style.borderColor = ''; }, 1500);
        return;
      }
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(pendingRange);
      wrapSelection(pendingReaction, comment);
    }
    commentPopover.classList.remove('visible');
    pendingRange = null;
    pendingReaction = null;
  });
  commentPopover.querySelector('.cp-cancel').addEventListener('click', () => {
    commentPopover.classList.remove('visible');
    commentPopover._editingId = null;
    pendingRange = null;
    pendingReaction = null;
  });

  // === Tooltip on hover over annotated text ===
  function createTooltip() {
    if (tooltip) return tooltip;
    tooltip = document.createElement('div');
    tooltip.className = 'ann-tooltip';
    document.body.appendChild(tooltip);
    return tooltip;
  }

  let tooltipTimer = null;
  let tooltipMarkId = null;
  article.addEventListener('mouseover', (e) => {
    const mark = e.target.closest('mark[data-ann-id]');
    if (!mark) return;
    const ann = annotations.find(a => a.id === mark.dataset.annId);
    if (!ann) return;
    clearTimeout(tooltipTimer);
    const tip = createTooltip();
    tooltipMarkId = ann.id;
    const icon = ann.reaction === 'like' ? '👍' : ann.reaction === 'dislike' ? '👎' : '💬';
    let label = ann.reaction === 'like' ? 'Liked' : ann.reaction === 'dislike' ? 'Disliked' : 'Comment';
    let html = icon + ' ' + label;
    if (ann.comment) html += ': ' + ann.comment.replace(/</g,'&lt;');
    html += ' <span class="tip-remove" data-ann-id="' + ann.id + '" title="Remove annotation">✕</span>';
    tip.innerHTML = html;
    const rect = mark.getBoundingClientRect();
    tip.style.top = (rect.bottom + window.scrollY + 8) + 'px';
    tip.style.left = Math.max(8, rect.left) + 'px';
    tip.style.display = 'block';
  });

  article.addEventListener('mouseout', (e) => {
    const mark = e.target.closest('mark[data-ann-id]');
    if (!mark) return;
    tooltipTimer = setTimeout(() => {
      if (tooltip) tooltip.style.display = 'none';
      tooltipMarkId = null;
    }, 300);
  });

  // Keep tooltip alive when hovering over it, and handle remove click
  document.addEventListener('mouseover', (e) => {
    if (tooltip && tooltip.contains(e.target)) {
      clearTimeout(tooltipTimer);
    }
  });
  document.addEventListener('mouseout', (e) => {
    if (tooltip && tooltip.contains(e.target) && !tooltip.contains(e.relatedTarget)) {
      tooltipTimer = setTimeout(() => {
        if (tooltip) tooltip.style.display = 'none';
        tooltipMarkId = null;
      }, 200);
    }
  });

  document.addEventListener('click', (e) => {
    const removeBtn = e.target.closest('.tip-remove[data-ann-id]');
    if (removeBtn) {
      e.preventDefault();
      e.stopPropagation();
      removeAnnotation(removeBtn.dataset.annId);
      if (tooltip) tooltip.style.display = 'none';
      tooltipMarkId = null;
      return;
    }
  });

  // === Click on annotated text to edit ===
  article.addEventListener('click', (e) => {
    const mark = e.target.closest('mark[data-ann-id]');
    if (!mark) return;
    e.preventDefault();
    e.stopPropagation();
    if (tooltip) tooltip.style.display = 'none';

    const ann = annotations.find(a => a.id === mark.dataset.annId);
    if (!ann) return;

    // Open edit popover pre-filled
    pendingRange = null; // not a new selection
    pendingReaction = ann.reaction;
    const editingId = ann.id;

    const cpHeader = document.getElementById('cpHeader');
    const icon = ann.reaction === 'like' ? '👍' : ann.reaction === 'dislike' ? '👎' : '💬';
    const color = ann.reaction === 'like' ? 'var(--like-color)' : ann.reaction === 'dislike' ? 'var(--dislike-color)' : '#b45309';
    const label = ann.reaction === 'like' ? 'Like' : ann.reaction === 'dislike' ? 'Dislike' : 'Comment';
    cpHeader.innerHTML = icon + ' <span style="color:' + color + '">' + label + '</span> — edit';
    commentText.value = ann.comment || '';
    commentText.placeholder = 'Update your comment...';

    const rect = mark.getBoundingClientRect();
    commentPopover.style.top = (rect.bottom + window.scrollY + 8) + 'px';
    commentPopover.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - 300)) + 'px';
    commentPopover.classList.add('visible');

    // Override save to update existing annotation
    commentPopover._editingId = editingId;
    commentText.focus();
  });

  // === Init ===
  document.body.classList.add('review-mode');
  loadAnnotations();
})();
</script>`;
}

// --- Reuse an already-running preview server on the requested port ---
function registerWithExistingServer(paths, listenPort) {
  return new Promise((resolveRegistration, rejectRegistration) => {
    let pos = 0;
    let lastIndex = 0;
    const addNext = () => {
      if (pos >= paths.length) {
        resolveRegistration(lastIndex);
        return;
      }
      const payload = JSON.stringify({ path: paths[pos++] });
      const req = httpRequest({
        hostname: '127.0.0.1',
        port: listenPort,
        path: '/__open',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout: 1500,
      }, res => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            if (!parsed.ok || typeof parsed.index !== 'number') throw new Error(parsed.error || 'Not a markdown-preview server');
            lastIndex = parsed.index;
            addNext();
          } catch (e) { rejectRegistration(e); }
        });
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', rejectRegistration);
      req.end(payload);
    };
    addNext();
  });
}

// --- Server with editing, saving, live reload, local images, and annotations ---
function servePreview(files, listenPort, compareOnStart = false) {
  const states = [];

  function rebuild(state) {
    state.cachedHTML = buildPage(state.path, state.title, state.index, files);
  }

  function rebuildAll() {
    states.forEach(rebuild);
  }

  function addFile(filePath) {
    const resolved = resolve(filePath);
    const existing = states.find(s => s.path === resolved);
    if (existing) return existing;
    if (!resolved.endsWith('.md') || !existsSync(resolved)) {
      throw new Error('Markdown file not found: ' + resolved);
    }
    const f = {
      path: resolved,
      dir: dirname(resolved),
      title: basename(resolved, '.md'),
      annotationsPath: resolved.replace(/\.md$/, '.annotations.json'),
    };
    files.push(f);
    const rawFull = readFileSync(f.path, 'utf-8');
    const state = {
      index: states.length,
      path: f.path,
      dir: f.dir,
      title: f.title,
      annotationsPath: f.annotationsPath,
      frontmatter: extractFrontmatter(rawFull).frontmatter,
      cachedHTML: '',
      externalChange: false,
      lastSaveFromEditor: 0,
    };
    states.push(state);
    watchFile(state.path, { interval: 2000 }, () => {
      if (Date.now() - state.lastSaveFromEditor < 5000) return;
      try {
        const raw = readFileSync(state.path, 'utf-8');
        state.frontmatter = extractFrontmatter(raw).frontmatter;
      } catch(_) {}
      rebuild(state);
      state.externalChange = true;
      console.log(`  ↻ External change in ${state.title}.md — rebuilt at ${new Date().toLocaleTimeString()}`);
    });
    rebuildAll();
    return state;
  }

  const initialFiles = files.splice(0);
  initialFiles.forEach(f => addFile(f.path));

  function pickState(url) {
    const raw = url.searchParams.get('f');
    if (raw === null) return states[0];
    const n = parseInt(raw, 10);
    if (Number.isNaN(n) || n < 0 || n >= states.length) return states[0];
    return states[n];
  }

  const mimeTypes = {
    '.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png',
    '.gif':'image/gif','.webp':'image/webp','.svg':'image/svg+xml',
    '.ico':'image/x-icon','.css':'text/css','.js':'text/javascript',
  };

  const server = createServer((req, res) => {
    // Local-only editing: refuse DNS rebinding and foreign-origin browser writes.
    const hosts = new Set(['localhost:' + listenPort, '127.0.0.1:' + listenPort]);
    if (!hosts.has(req.headers.host)) {
      res.writeHead(403); res.end('Invalid host'); return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const origins = new Set(['http://localhost:' + listenPort, 'http://127.0.0.1:' + listenPort]);
      const origin = req.headers.origin;
      const site = req.headers['sec-fetch-site'];
      if ((origin && !origins.has(origin)) || (site && !['same-origin','none'].includes(site))) {
        res.writeHead(403); res.end('Cross-origin write blocked'); return;
      }
    }

    const url = new URL(req.url, `http://localhost:${listenPort}`);
    const state = pickState(url);

    // --- Editable three-pane comparison; the outer panes are the original editors ---
    if (url.pathname === '/__compare' && req.method === 'GET') {
      if (states.length < 2) { res.writeHead(400); res.end('Two Markdown files required'); return; }
      try {
        res.writeHead(200, {'Content-Type':'text/html; charset=utf-8', 'Cache-Control':'no-store'});
        res.end(buildComparePage(states[0].path, states[1].path));
      } catch(e) { res.writeHead(500); res.end(e.message); }
      return;
    }
    if (url.pathname === '/__compare-diff' && req.method === 'GET') {
      if (states.length < 2) { res.writeHead(400); res.end('Two Markdown files required'); return; }
      try {
        res.writeHead(200, {'Content-Type':'application/json', 'Cache-Control':'no-store'});
        res.end(JSON.stringify(buildCompareDiff(states[0].path, states[1].path)));
      } catch(e) { res.writeHead(500); res.end(e.message); }
      return;
    }

    // --- Add/open a file in this running preview server ---
    if (url.pathname === '/__open' && req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        try {
          const payload = JSON.parse(body || '{}');
          const added = addFile(payload.path);
          res.writeHead(200, {'Content-Type':'application/json'});
          res.end(JSON.stringify({ok:true, index:added.index, title:added.title}));
          console.log(`  ＋ Added ${added.title}.md to preview history`);
        } catch(e) {
          res.writeHead(400, {'Content-Type':'application/json'});
          res.end(JSON.stringify({ok:false, error:e.message}));
        }
      });
      return;
    }

    // --- Save endpoint ---
    if (url.pathname === '/__save' && req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        try {
          const fullContent = state.frontmatter
            ? state.frontmatter + '\n\n' + body
            : body;
          state.lastSaveFromEditor = Date.now();
          writeFileSync(state.path, fullContent, 'utf-8');
          rebuild(state);
          res.writeHead(200, {'Content-Type':'application/json'});
          res.end(JSON.stringify({ok: true}));
          console.log(`  💾 Saved ${state.title}.md at ${new Date().toLocaleTimeString()}`);
        } catch(e) {
          res.writeHead(500, {'Content-Type':'application/json'});
          res.end(JSON.stringify({ok: false, error: e.message}));
        }
      });
      return;
    }

    // --- Annotations GET ---
    if (url.pathname === '/__annotations' && req.method === 'GET') {
      try {
        if (existsSync(state.annotationsPath)) {
          const data = readFileSync(state.annotationsPath, 'utf-8');
          const parsed = JSON.parse(data);
          res.writeHead(200, {'Content-Type':'application/json'});
          res.end(JSON.stringify({ok: true, annotations: parsed}));
        } else {
          res.writeHead(200, {'Content-Type':'application/json'});
          res.end(JSON.stringify({ok: true, annotations: []}));
        }
      } catch(e) {
        res.writeHead(200, {'Content-Type':'application/json'});
        res.end(JSON.stringify({ok: true, annotations: []}));
      }
      return;
    }

    // --- Annotations POST ---
    if (url.pathname === '/__annotations' && req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        try {
          const annotations = JSON.parse(body);
          writeFileSync(state.annotationsPath, JSON.stringify(annotations, null, 2), 'utf-8');
          res.writeHead(200, {'Content-Type':'application/json'});
          res.end(JSON.stringify({ok: true}));
          const counts = {
            like: annotations.filter(a => a.reaction === 'like').length,
            dislike: annotations.filter(a => a.reaction === 'dislike').length,
            edited: annotations.filter(a => a.reaction === 'edited').length,
            comments: annotations.filter(a => a.comment).length,
          };
          console.log(`  📝 Annotations saved for ${state.title}.md: ${JSON.stringify(counts)}`);
        } catch(e) {
          res.writeHead(500, {'Content-Type':'application/json'});
          res.end(JSON.stringify({ok: false, error: e.message}));
        }
      });
      return;
    }

    // --- Changed check ---
    if (url.pathname === '/__changed') {
      res.writeHead(200, {'Content-Type':'application/json'});
      const wasChanged = state.externalChange;
      state.externalChange = false;
      res.end(JSON.stringify({changed: wasChanged}));
      return;
    }

    // --- Local image passthrough ---
    if (url.pathname === '/__local' && req.method === 'GET') {
      const p = url.searchParams.get('path');
      if (!p) { res.writeHead(400); res.end('missing path'); return; }
      const abs = decodeURIComponent(p);
      const ext = extname(abs).toLowerCase();
      const okExts = { '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.gif':'image/gif', '.webp':'image/webp', '.svg':'image/svg+xml' };
      const mime = okExts[ext];
      if (!mime) { res.writeHead(415); res.end('not an image'); return; }
      try {
        const data = readFileSync(abs);
        res.writeHead(200, {'Content-Type': mime, 'Cache-Control':'no-store'});
        res.end(data);
      } catch (e) {
        res.writeHead(404, {'Content-Type':'text/plain'});
        res.end('not found: ' + e.message);
      }
      return;
    }

    // --- Image upload endpoint ---
    if (url.pathname === '/__upload-image' && req.method === 'POST') {
      const ct = (req.headers['content-type'] || '').toLowerCase();
      const allowed = {
        'image/png': '.png', 'image/jpeg': '.jpg', 'image/jpg': '.jpg',
        'image/gif': '.gif', 'image/webp': '.webp',
      };
      const extFromMime = allowed[ct];
      if (!extFromMime) {
        res.writeHead(415, {'Content-Type':'application/json'});
        res.end(JSON.stringify({ok:false, error:`Unsupported: ${ct}`}));
        return;
      }
      const MAX_BYTES = 10 * 1024 * 1024;
      const chunks = [];
      let total = 0;
      let aborted = false;
      req.on('data', c => {
        if (aborted) return;
        total += c.length;
        if (total > MAX_BYTES) {
          aborted = true;
          res.writeHead(413, {'Content-Type':'application/json'});
          res.end(JSON.stringify({ok:false, error:'Too large'}));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        if (aborted) return;
        try {
          const srcName = req.headers['x-image-filename'] || '';
          const ts = new Date().toISOString().replace(/[:.]/g,'-').replace('T','_').slice(0,19);
          let baseName;
          if (srcName) {
            const safe = String(srcName).replace(/[^a-zA-Z0-9._-]/g,'-').replace(/-+/g,'-').slice(0,80);
            baseName = `${ts}-${safe.replace(/\.[^.]+$/, '')}`;
          } else {
            baseName = `pasted-${ts}`;
          }
          const finalName = `${baseName}${extFromMime}`;
          const imagesDir = join(state.dir, 'images');
          try { mkdirSync(imagesDir, { recursive: true }); } catch(_) {}
          writeFileSync(join(imagesDir, finalName), Buffer.concat(chunks));
          res.writeHead(200, {'Content-Type':'application/json'});
          res.end(JSON.stringify({ok:true, path: `images/${finalName}`, bytes: total}));
        } catch(e) {
          res.writeHead(500, {'Content-Type':'application/json'});
          res.end(JSON.stringify({ok:false, error: e.message}));
        }
      });
      return;
    }

    // --- Serve local assets ---
    if (url.pathname !== '/' && url.pathname !== '/index.html') {
      const ext = extname(url.pathname).toLowerCase();
      const mime = mimeTypes[ext];
      if (mime) {
        try {
          const data = readFileSync(join(state.dir, decodeURIComponent(url.pathname)));
          res.writeHead(200, {'Content-Type': mime});
          res.end(data);
          return;
        } catch(e) { res.writeHead(404); res.end('Not found'); return; }
      }
    }

    // --- Serve editor page ---
    res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'});
    res.end(state.cachedHTML);
  });

  server.listen(listenPort, '127.0.0.1', () => {
    const baseUrl = `http://localhost:${listenPort}`;
    const landingUrl = compareOnStart ? baseUrl + '/__compare' : baseUrl;
    console.log(`\\n  📝 Markdown Editor + Preview + Annotations`);
    console.log(`  ─────────────────────────────`);
    if (states.length === 1) {
      console.log(`  File:  ${states[0].path}`);
      console.log(`  URL:   ${baseUrl}`);
    } else {
      console.log(`  Files (${states.length}):`);
      states.forEach(s => console.log(`    [${s.index}] ${s.title}.md  →  ${baseUrl}/?f=${s.index}`));
    }
    console.log(`  ─────────────────────────────`);
    console.log(`  Click text to edit · Select text for toolbar · Auto-saves to .md`);
    console.log(`  📝 Review mode: Cmd+Shift+R or click Review button`);
    console.log(`  Annotations saved to: <filename>.annotations.json\\n`);
    try { execSync(`open -a "Google Chrome" "${landingUrl}"`, {stdio:'ignore'}); }
    catch(e) { try { execSync(`open "${landingUrl}"`, {stdio:'ignore'}); } catch(e2){} }
  });

  server.on('error', async (err) => {
    if (err.code === 'EADDRINUSE') {
      if (compareOnStart) { servePreview(files, listenPort + 1, true); return; }
      try {
        const index = await registerWithExistingServer(mdPaths, listenPort);
        const url = `http://localhost:${listenPort}/?f=${index}`;
        console.log(`  ↪ Reusing preview server on port ${listenPort}`);
        console.log(`  Added ${mdPaths.length} file(s) · ${url}`);
        try { execSync(`open -a "Google Chrome" "${url}"`, {stdio:'ignore'}); }
        catch(e) { try { execSync(`open "${url}"`, {stdio:'ignore'}); } catch(e2){} }
        process.exit(0);
      } catch (_) {
        console.log(`  Port ${listenPort} is not a markdown-preview server. Trying ${listenPort+1}...`);
        servePreview(files, listenPort+1);
      }
    } else { console.error('Server error:', err); process.exit(1); }
  });
}

// --- Run ---
if (compareMode && (mdPaths.length !== 2 || mdPaths.some(p => !existsSync(p)))) {
  console.error('Usage: node render-preview.mjs --compare original.md revised.md [--port 3456]');
  process.exit(1);
}
servePreview(files, port, compareMode);
