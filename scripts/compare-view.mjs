import {readFileSync} from 'node:fs';
import {basename} from 'node:path';
const escape=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
function body(s){let i=s.startsWith('---\n')?s.indexOf('\n---',4):-1;return (i<0?s:s.slice(i+4)).trim();}
const paras=s=>body(s).split(/\n\s*\n/).map(x=>x.trim()).filter(Boolean);
function clean(s){return s.replace(/!\[([^\]]*)\]\([^)]+\)/g,'$1').replace(/\[([^\]]+)\]\([^)]+\)/g,'$1').replace(/^#{1,6}\s+/gm,'').replace(/\*\*|__/g,'').split(String.fromCharCode(96)).join('').replace(/^\s*[-*] /gm,'• ');}
function toks(s){return s.match(/\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu)||[];}
function wordDelta(a,b){
 const x=toks(clean(a)),y=toks(clean(b)),n=x.length,m=y.length;
 if(n*m>160000)return ['<mark class="removed">'+escape(x.join(''))+'</mark>','<mark class="added">'+escape(y.join(''))+'</mark>'];
 const dp=Array.from({length:n+1},()=>new Uint16Array(m+1));
 for(let i=n-1;i>=0;i--)for(let j=m-1;j>=0;j--)dp[i][j]=x[i]===y[j]?1+dp[i+1][j+1]:Math.max(dp[i+1][j],dp[i][j+1]);
 let i=0,j=0;const out=[[],[]];
 function push(k,token,kind){const last=out[k].at(-1);if(last&&last.kind===kind)last.txt+=escape(token);else out[k].push({kind,txt:escape(token)});}
 while(i<n||j<m){
  if(i<n&&j<m&&x[i]===y[j]){push(0,x[i],null);push(1,y[j],null);i++;j++;}
  else if(j<m&&(i===n||dp[i][j+1]>dp[i+1][j]))push(1,y[j++],'added');
  else push(0,x[i++],'removed');
 }
 return out.map(arr=>arr.map(v=>v.kind?'<mark class="'+v.kind+'">'+v.txt+'</mark>':v.txt).join('').replace(/\n/g,'<br>'));
}
function similarity(a,b){
 const x=new Set(clean(a).toLowerCase().match(/[\p{L}\p{N}]{2,}/gu)||[]);
 const y=new Set(clean(b).toLowerCase().match(/[\p{L}\p{N}]{2,}/gu)||[]);
 let n=0;for(const t of x)if(y.has(t))n++;
 return x.size+y.size?2*n/(x.size+y.size):0;
}
function align(a,b){
 const n=a.length,m=b.length,dp=Array.from({length:n+1},()=>Array(m+1).fill(0)),ops=Array.from({length:n+1},()=>Array(m+1).fill(''));
 for(let i=n;i>=0;i--)for(let j=m;j>=0;j--){
  if(i===n&&j===m)continue;
  const v=[];if(i<n)v.push([1+dp[i+1][j],'del']);if(j<m)v.push([1+dp[i][j+1],'add']);
  if(i<n&&j<m){const same=a[i]===b[j],sim=same?1:similarity(a[i],b[j]);if(same||sim>=.24)v.push([(same?0:1.45-sim)+dp[i+1][j+1],same?'same':'replace']);}
  v.sort((x,y)=>x[0]-y[0]);dp[i][j]=v[0][0];ops[i][j]=v[0][1];
 }
 const result=[];let i=0,j=0;
 while(i<n||j<m){const op=ops[i][j];if(op==='same'){i++;j++;}else if(op==='replace'){result.push([a[i++],b[j++]]);}else if(op==='del'){result.push([a[i++],'']);}else if(op==='add'){result.push(['',b[j++]]);}else break;}
 return result;
}
const css=[
':root{--text:#242424;--border:#e6e6e3;--muted:#777;--serif:"Source Serif 4",Georgia,serif;--sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif}',
'*{box-sizing:border-box}body{background:#f5f5f3;color:var(--text);font-family:var(--sans);margin:0}',
'.top{background:#fff;border-bottom:1px solid var(--border);padding:13px 23px;display:flex;justify-content:space-between;align-items:center;gap:15px}',
'.top strong{font-size:16px}.top small{display:block;color:var(--muted);margin-top:4px}.legend{display:flex;gap:12px;font-size:12px}',
'.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;padding:12px;max-width:2200px;margin:auto;align-items:start}',
'.pane{min-width:0;background:#fff;border:1px solid var(--border);border-radius:10px;overflow:hidden}',
'.heading{padding:13px 20px;font-size:14px;font-weight:650;border-bottom:1px solid var(--border)}',
'.heading small{display:block;color:var(--muted);font-size:11px;font-weight:400;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:4px}',
'.article{padding:24px 25px 60px;font:18px/1.72 var(--serif);overflow-wrap:anywhere}.article p{margin:0 0 1.2em}.article strong{font-weight:700}',
'.article h1,.article h2,.article h3{font-family:var(--sans)}.article ul{padding-left:1.5em}.article li{margin-bottom:.35em}',
'.diff{padding:5px 19px 50px;font:16px/1.65 var(--serif);overflow-wrap:anywhere}.change{padding:14px 0;border-bottom:1px solid var(--border)}',
'.number,.label{font:11px var(--sans);color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:7px}.number{font-weight:650;margin-bottom:11px}',
'.before{border-left:3px solid #da9793;padding-left:10px;margin-bottom:12px}.after{border-left:3px solid #88c498;padding-left:10px}.change p{margin:0}',
'mark{color:inherit;padding:1px 2px;border-radius:2px}mark.removed{background:#f9e0de;text-decoration:line-through;text-decoration-color:#b86b67}mark.added{background:#dcf3e2}',
'@media(max-width:1050px){.grid{grid-template-columns:1fr 1fr}.pane:nth-child(2){grid-column:1/-1;grid-row:2}}',
'@media(max-width:700px){.grid{display:block}.pane{margin-bottom:12px}.top{display:block}.legend{margin-top:9px}}'
].join('\n');
export function buildCompareDiff(a,b){
 const edits=align(paras(readFileSync(a,'utf8')),paras(readFileSync(b,'utf8')));
 const html=edits.map(([x,y],i)=>{
  const [old,newer]=wordDelta(x,y);
  return '<section class="change"><div class="number">Change '+(i+1)+'</div>'+
   (x?'<div class="before"><div class="label">Before</div><p>'+old+'</p></div>':'')+
   (y?'<div class="after"><div class="label">After</div><p>'+newer+'</p></div>':'')+'</section>';
 }).join('')||'<p>No changes.</p>';
 return {html,count:edits.length};
}
export function buildComparePage(a,b){
 const {html,count}=buildCompareDiff(a,b);
 const heading=(name,path)=>'<div class="heading">'+name+'<small>'+escape(basename(path))+'</small></div>';
 const editStyle='.grid{height:calc(100vh - 72px);align-items:stretch}.pane{display:flex;flex-direction:column}.pane iframe{flex:1;min-height:340px;width:100%;border:0;background:#fff}.pane .diff{flex:1;overflow:auto}.heading{flex:none}.top{min-height:60px}@media(max-width:1050px){.grid{height:auto}.pane iframe{height:68vh;flex:auto}.pane .diff{max-height:60vh}}';
 return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'+
 '<title>Markdown Preview · Compare</title><style>'+css+editStyle+'</style></head><body>'+
 '<header class="top"><div><strong>Markdown Preview · Compare</strong><small id="change-count">'+count+' changes · editing either pane autosaves to its Markdown file</small></div>'+
 '<div class="legend"><mark class="removed">Removed</mark><mark class="added">Added</mark></div></header><div class="grid">'+
 '<section class="pane">'+heading('Original · Editable',a)+'<iframe title="Original editor" src="/?f=0"></iframe></section>'+
 '<section class="pane">'+heading('Changes · Live',b)+'<div class="diff" id="live-diff">'+html+'</div></section>'+
 '<section class="pane">'+heading('Revised · Editable',b)+'<iframe title="Revised editor" src="/?f=1"></iframe></section>'+
 '</div>'+
 '<script>let lastHTML=null;async function updateDiff(){try{const r=await fetch("/__compare-diff",{cache:"no-store"});if(!r.ok)return;const d=await r.json();if(d.html!==lastHTML){const el=document.getElementById("live-diff");const scroll=el.scrollTop;el.innerHTML=d.html;el.scrollTop=scroll;lastHTML=d.html;}document.getElementById("change-count").textContent=d.count+" changes · editing either pane autosaves to its Markdown file";}catch(e){}}setInterval(updateDiff,1800);</script>'+
 '</body></html>';
}
