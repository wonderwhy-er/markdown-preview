#!/usr/bin/env python3
"""Generate an offline, read-only 3-panel Markdown comparison.

Original and Revised are clean prose. Middle Changes displays additions and deletions.
Usage: python3 compare-markdown.py original.md revised.md [--out comparison.html]
Never modifies the source Markdown files.
"""
from __future__ import annotations
import argparse
import difflib
import html
import re
from pathlib import Path

CSS = """
:root{color-scheme:light;--ink:#222;--muted:#777;--paper:#fff;--background:#f5f5f1;--border:#e3e3df;--add:#d9f2df;--del:#fbe0df}
*{box-sizing:border-box}body{margin:0;background:var(--background);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif}
.topbar{padding:15px 26px;border-bottom:1px solid var(--border);background:#fff;display:flex;justify-content:space-between;align-items:center;gap:20px;position:sticky;top:0;z-index:5}
.topbar strong{font-size:16px}.topbar small{font-size:12px;color:var(--muted)}
.legend{font-size:12px;color:var(--muted);display:flex;gap:12px;flex-wrap:wrap}
.chip{padding:4px 7px;border-radius:4px;color:#303030}.chip.add{background:var(--add)}.chip.del{background:var(--del)}
.layout{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr) minmax(0,1fr);gap:12px;padding:15px;max-width:2200px;margin:0 auto}
.pane{min-width:0;background:var(--paper);border:1px solid var(--border);border-radius:11px;overflow:hidden}
.pane-heading{padding:13px 20px;border-bottom:1px solid var(--border);position:sticky;top:61px;background:#fff;z-index:2}
.pane-heading b{display:block;font-size:14px}.pane-heading span{display:block;font-size:11px;color:var(--muted);margin-top:5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.article{padding:18px 24px 55px;font:17px/1.73 Georgia,"Times New Roman",serif;overflow-wrap:anywhere}
.article p{margin:0 0 1.15em}.article ul{margin:0 0 1.2em;padding-left:23px}.article li{padding:2px 0}.article h1,.article h2,.article h3{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;line-height:1.3;margin:1.25em 0 .6em}
.article h1{font-size:26px}.article h2{font-size:22px}.article h3{font-size:19px}.article a{color:#1c7698}
.diff-list{padding:14px 19px 45px;font:15px/1.65 Georgia,"Times New Roman",serif;overflow-wrap:anywhere}
.diff-item{border-bottom:1px solid #e9e9e6;padding:13px 0}.diff-item:last-child{border:0}
.diff-num{display:block;font:11px -apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;color:var(--muted);letter-spacing:.04em;text-transform:uppercase;margin-bottom:8px}
.diff-item p{margin:0 0 .55em}.diff-item p:last-child{margin-bottom:0}
.diff-item .before{border-left:3px solid #e2a5a2;padding-left:9px;margin-bottom:7px}
.diff-item .after{border-left:3px solid #8cc99a;padding-left:9px}
.diff-item .before:before,.diff-item .after:before{font:10px -apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;color:var(--muted);display:block;letter-spacing:.06em;margin:0 0 3px}
.diff-item .before:before{content:'BEFORE'}.diff-item .after:before{content:'AFTER'}
mark{border-radius:2px;padding:1px 2px;color:inherit}mark.add{background:var(--add)}mark.del{background:var(--del);text-decoration:line-through;text-decoration-color:#ba7772}
.emptydiff{color:var(--muted);font-style:italic;padding:25px 0}
@media(max-width:1200px){.layout{grid-template-columns:1fr 1fr}.pane.diff-pane{grid-column:1/-1;grid-row:2}.pane-heading{position:static}}
@media(max-width:720px){.layout{grid-template-columns:1fr}.pane.diff-pane{grid-column:auto;grid-row:auto}.topbar{position:static;display:block}.legend{margin-top:8px}.article{font-size:16px}}
"""

def paragraphs(source: str) -> list[str]:
    source = re.sub(r"^---\s*\n.*?\n---\s*\n", "", source, count=1, flags=re.S)
    return [s.strip() for s in re.split(r"\n\s*\n", source.strip()) if s.strip()]

def inline(src: str) -> str:
    x = html.escape(src)
    x = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", x, flags=re.S)
    x = re.sub(r"(?<!\*)\*([^*\n]+)\*(?!\*)", r"<em>\1</em>", x)
    x = re.sub(r"`([^`]+)`", r"<code>\1</code>", x)
    x = re.sub(r"\[([^\]]+)\]\((https?://[^)]+)\)", r'<a href="\2">\1</a>', x)
    return x

def render_paragraph(s: str) -> str:
    lines = s.splitlines()
    if lines and all(re.match(r"^\s*[-*] ",line) for line in lines):
        return "<ul>"+"".join("<li>"+inline(re.sub(r"^\s*[-*] ", "", line))+"</li>" for line in lines)+"</ul>"
    heading = re.match(r"^(#{1,3})\s+(.+)$", s)
    if heading:
        level=len(heading.group(1))
        return f"<h{level}>"+inline(heading.group(2))+f"</h{level}>"
    return "<p>"+inline(s).replace("\n","<br>")+"</p>"

def render_article(blocks: list[str]) -> str:
    return "".join(render_paragraph(p) for p in blocks)

def mark_delta(old: str, new: str) -> tuple[str,str]:
    aa=re.findall(r"\s+|\w+|[^\w\s]", old)
    bb=re.findall(r"\s+|\w+|[^\w\s]", new)
    sm=difflib.SequenceMatcher(None,aa,bb,autojunk=False)
    out=[[],[]]
    for op,a1,a2,b1,b2 in sm.get_opcodes():
        for side,tokens,lo,hi in [(0,aa,a1,a2),(1,bb,b1,b2)]:
            if lo == hi:continue
            chunk=html.escape("".join(tokens[lo:hi])).replace("\n","<br>")
            if op != "equal": chunk=f'<mark class="{"del" if side==0 else "add"}">{chunk}</mark>'
            out[side].append(chunk)
    return "".join(out[0]),"".join(out[1])

def changes(before: list[str], after: list[str]) -> tuple[str,int]:
    matched=difflib.SequenceMatcher(None,before,after,autojunk=False)
    sections=[]
    counter=0
    for op,i1,i2,j1,j2 in matched.get_opcodes():
        if op=="equal":continue
        left=before[i1:i2];right=after[j1:j2]
        for idx in range(max(len(left),len(right))):
            b=left[idx] if idx<len(left) else ""
            r=right[idx] if idx<len(right) else ""
            counter+=1
            old_mark,new_mark=mark_delta(b,r)
            body=""
            if b:body+=f'<div class="before"><p>{old_mark}</p></div>'
            if r:body+=f'<div class="after"><p>{new_mark}</p></div>'
            sections.append(f'<section class="diff-item"><span class="diff-num">Change {counter}</span>{body}</section>')
    return "".join(sections) if sections else '<div class="emptydiff">No differences found.</div>',counter

def main():
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument("original",type=Path)
    ap.add_argument("revised",type=Path)
    ap.add_argument("--out",type=Path)
    args=ap.parse_args()
    for p in [args.original,args.revised]:
        if not p.is_file() or p.suffix.lower()!=".md":ap.error(f"Markdown file not found: {p}")
    old=paragraphs(args.original.read_text(encoding="utf-8"))
    new=paragraphs(args.revised.read_text(encoding="utf-8"))
    diff,count=changes(old,new)
    output=args.out or args.revised.with_name(args.revised.stem+"-comparison.html")
    output.parent.mkdir(parents=True,exist_ok=True)
    page=f"""<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Three-way Markdown review</title><style>{CSS}</style></head><body>
<header class="topbar"><div><strong>Markdown review</strong><br><small>{count} change blocks · original and revised are unmarked · read only</small></div>
<div class="legend"><span class="chip del">Removed</span><span class="chip add">Added</span></div></header>
<div class="layout">
<section class="pane original-pane"><div class="pane-heading"><b>Original</b><span>{html.escape(args.original.name)}</span></div><article class="article">{render_article(old)}</article></section>
<section class="pane diff-pane"><div class="pane-heading"><b>Changes</b><span>Suggested edits · red = removed, green = added</span></div><div class="diff-list">{diff}</div></section>
<section class="pane revised-pane"><div class="pane-heading"><b>Revised</b><span>{html.escape(args.revised.name)}</span></div><article class="article">{render_article(new)}</article></section>
</div></body></html>"""
    output.write_text(page,encoding="utf-8")
    print(f"Created {output} ({count} change blocks, 3 panels)")

if __name__=="__main__":
    main()
