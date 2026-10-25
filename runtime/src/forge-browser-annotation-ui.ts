// Runs only in a new, empty Chrome review context. Captured website markup is
// never injected here: the browser sees pixels and escaped text metadata.
export const annotationReviewHtml=String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; object-src 'none'; frame-src 'none'; form-action 'none'">
<title>Forge screenshot review</title>
<style>
:root{color-scheme:dark;font:14px/1.45 system-ui,Segoe UI,sans-serif;color:#e9edf6;background:#101625}
*{box-sizing:border-box}body{margin:0;height:100vh;display:grid;grid-template-rows:auto minmax(0,1fr)}
header{display:flex;gap:12px;align-items:center;padding:14px 20px;background:#192238;border-bottom:1px solid #34415c}
header strong{font-size:19px;color:#fff}header small{color:#a0b1cf}button,select,input,textarea{font:inherit}
button{background:#263754;border:1px solid #4a6082;color:#eff5ff;padding:8px 11px;border-radius:7px;cursor:pointer}
button:hover:enabled{background:#344c74}button:disabled{opacity:.4;cursor:default}
button.selected{background:#2169a1;border-color:#5cb8fd}button.primary{background:#137b55;border-color:#2ba978}
main{display:grid;grid-template-columns:230px minmax(0,1fr) 250px;min-height:0}
aside{overflow:auto;background:#151d30;padding:15px;border-right:1px solid #34415c}
aside:last-child{border-left:1px solid #34415c;border-right:0}h2{font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#b4c4df;margin:0 0 12px}
#frames{display:grid;gap:10px;margin:14px 0}#frames button{width:100%;text-align:left;padding:7px;min-width:0}
#frames img{display:block;width:100%;max-height:90px;object-fit:contain;margin-bottom:5px;background:#0b1120}
#frames span{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}
#stage{min-width:0;overflow:auto;padding:24px;display:flex;flex-direction:column;align-items:center;gap:13px;background:#0b1220}
#viewport{position:relative;display:inline-block;max-width:100%;box-shadow:0 10px 35px #0009;border:1px solid #465675}
#shot{display:block;max-width:100%;height:auto}#markup{position:absolute;inset:0;width:100%;height:100%;touch-action:none;cursor:crosshair}
#url{color:#a7b8d5;overflow-wrap:anywhere;max-width:880px;font-size:12px}#tools{display:flex;flex-wrap:wrap;gap:7px;margin-bottom:13px}
label{display:block;margin:14px 0 6px;color:#b4c4df;font-weight:600}
input,textarea{background:#0e172b;color:#eaf2ff;border:1px solid #405474;padding:9px;width:100%;border-radius:6px}
textarea{height:115px;resize:vertical}#message{font-size:12px;margin:10px 0;color:#a8e6c9;white-space:pre-wrap}
footer{padding-top:16px;display:flex;gap:8px;flex-wrap:wrap}p{font-size:12px;color:#b2c2de}
@media(max-width:880px){main{grid-template-columns:160px minmax(0,1fr)}aside:last-child{grid-column:1 / 3;border-top:1px solid #34415c}}
</style></head><body>
<header><strong>Forge · Screenshot review</strong><small>Draw on a captured copy; the website is unchanged.</small></header>
<main><aside><h2>Screenshots</h2><button id="capture">+ Take screenshot</button><div id="frames"></div><button id="remove">Remove selected</button><p>Up to 8 screenshots. Each preserves its accessibility snapshot.</p></aside>
<section id="stage"><div id="viewport"><img id="shot" alt="Captured screenshot" draggable="false"><canvas id="markup" aria-label="Draw annotations on screenshot"></canvas></div><div id="url"></div></section>
<aside><h2>Drawing tools</h2><div id="tools"><button class="selected" data-tool="rect">Rectangle</button><button data-tool="arrow">Arrow</button><button data-tool="pen">Pen</button><button data-tool="text">Text</button></div>
<label for="label">Label (optional for shapes)</label><input id="label" maxlength="300" placeholder="What needs attention?">
<button id="undo" style="margin-top:12px">Undo last annotation</button><p>Draw directly on the screenshot, or select Text and click a location. The label becomes part of the export.</p>
<label for="feedback">Overall feedback</label><textarea id="feedback" maxlength="3000" placeholder="Notes about these screenshots"></textarea>
<div id="message" role="status">Choose a drawing tool to begin.</div>
<footer><button id="submit" class="primary">Submit review</button><button id="edit" hidden>Edit again</button><button id="cancel">Cancel review</button></footer></aside></main>
<script>
(()=>{'use strict';
  const byId=id=>document.getElementById(id),frames=[],mode={tool:'rect',selected:null,submitted:false,working:false,pending:null};
  const canvas=byId('markup'),ctx=canvas.getContext('2d'),img=byId('shot');
  const current=()=>frames.find(f=>f.id===mode.selected);
  const message=value=>byId('message').textContent=value;
  const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
  const point=e=>{const r=canvas.getBoundingClientRect();return {x:Math.round(clamp((e.clientX-r.left)*canvas.width/r.width,0,canvas.width)),y:Math.round(clamp((e.clientY-r.top)*canvas.height/r.height,0,canvas.height))};};
  const labelText=()=>byId('label').value.slice(0,300).trim();
  const arrow=(g,a,b)=>{g.moveTo(a.x,a.y);g.lineTo(b.x,b.y);const theta=Math.atan2(b.y-a.y,b.x-a.x),length=17;g.moveTo(b.x,b.y);g.lineTo(b.x-length*Math.cos(theta-.48),b.y-length*Math.sin(theta-.48));g.moveTo(b.x,b.y);g.lineTo(b.x-length*Math.cos(theta+.48),b.y-length*Math.sin(theta+.48));};
  function paint(g,annotations){
    g.lineWidth=4;g.strokeStyle='#ff625d';g.fillStyle='#ff625d';g.lineCap='round';g.lineJoin='round';
    for(const a of annotations){g.beginPath();
      if(a.kind==='rect')g.rect(a.x,a.y,a.width,a.height);
      if(a.kind==='arrow')arrow(g,{x:a.x,y:a.y},{x:a.x+a.width,y:a.y+a.height});
      if(a.kind==='pen'&&a.points.length){g.moveTo(a.points[0].x,a.points[0].y);for(const p of a.points.slice(1))g.lineTo(p.x,p.y);}
      g.stroke();
      if(a.text){g.font='bold 17px Segoe UI, sans-serif';const x=clamp(a.x,2,g.canvas.width-20),y=clamp(a.y-5,20,g.canvas.height-4),width=Math.min(g.measureText(a.text).width+12,g.canvas.width-x);
        g.fillStyle='#18253c';g.fillRect(x,y-21,width,26);g.fillStyle='#fff';g.fillText(a.text,x+5,y-3,Math.max(1,width-10));g.fillStyle='#ff625d';}
    }
  }
  function redraw(){ctx.clearRect(0,0,canvas.width,canvas.height);const f=current();if(f)paint(ctx,[...f.annotations,...(mode.pending?[mode.pending]:[])]);}
  function show(){
    const frame=current();mode.pending=null;
    if(!frame){img.removeAttribute('src');byId('url').textContent='No screenshots.';ctx.clearRect(0,0,canvas.width,canvas.height);return;}
    byId('url').textContent=frame.url+' · '+frame.width+' × '+frame.height;
    img.onload=()=>{canvas.width=img.naturalWidth;canvas.height=img.naturalHeight;redraw();};
    img.src=frame.image;
  }
  function sidebar(){const holder=byId('frames');holder.replaceChildren();
    for(const f of frames){const b=document.createElement('button');b.className=f.id===mode.selected?'selected':'';b.disabled=mode.submitted;
      const thumb=document.createElement('img');thumb.src=f.image;thumb.alt='Screenshot preview';b.appendChild(thumb);
      const title=document.createElement('span');title.textContent=f.title||'Screenshot';b.appendChild(title);
      const count=document.createElement('span');count.textContent=f.annotations.length+' annotation(s)';b.appendChild(count);
      b.addEventListener('click',()=>{mode.selected=f.id;sidebar();show();});holder.appendChild(b);}
    byId('remove').disabled=mode.submitted||!current();byId('capture').disabled=mode.submitted||mode.working||frames.length>=8;
    byId('undo').disabled=mode.submitted||!current()||!current().annotations.length;
    byId('submit').hidden=mode.submitted;byId('edit').hidden=!mode.submitted;
    byId('label').disabled=mode.submitted;byId('feedback').disabled=mode.submitted;
    for(const b of document.querySelectorAll('[data-tool]'))b.disabled=mode.submitted;
  }
  window.__forgeAddShot=async data=>{
    if(mode.submitted||frames.length>=8)return false;
    const f={id:data.id,url:data.url,title:data.title,width:data.width,height:data.height,image:'data:image/png;base64,'+data.png,annotations:[]};
    frames.push(f);mode.selected=f.id;sidebar();show();message('Captured screenshot '+frames.length+'.');return true;
  };
  window.__forgeState=()=>({submitted:mode.submitted,frame_ids:frames.map(f=>f.id),annotations:frames.map(f=>({id:f.id,annotations:f.annotations})),feedback:byId('feedback').value});
  window.__forgeRender=async()=>{
    const result=[];
    for(const f of frames){const bitmap=new Image();bitmap.src=f.image;await bitmap.decode();const out=document.createElement('canvas');out.width=f.width;out.height=f.height;
      const g=out.getContext('2d');g.drawImage(bitmap,0,0);paint(g,f.annotations);
      result.push({id:f.id,data:out.toDataURL('image/png').slice(22)});}
    return result;
  };
  canvas.addEventListener('pointerdown',e=>{
    if(mode.submitted||!current()||e.button!==0)return;
    const f=current();if(f.annotations.length>=64){message('Limit: 64 annotations per screenshot.');return;}
    const p=point(e),text=labelText();
    if(mode.tool==='text'){if(!text){message('Enter a label before placing text.');return;}f.annotations.push({kind:'text',x:p.x,y:p.y,width:0,height:0,text});sidebar();redraw();return;}
    mode.pending={kind:mode.tool,x:p.x,y:p.y,width:0,height:0,text,points:mode.tool==='pen'?[p]:[]};
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove',e=>{
    if(!mode.pending||mode.submitted)return;const p=point(e),a=mode.pending;
    a.width=p.x-a.x;a.height=p.y-a.y;
    if(a.kind==='pen'&&a.points.length<256){const last=a.points[a.points.length-1];if(Math.hypot(p.x-last.x,p.y-last.y)>3)a.points.push(p);}
    redraw();
  });
  function finish(e){if(!mode.pending)return;const a=mode.pending;mode.pending=null;
    if(a.kind==='pen'&&a.points.length===1)a.points.push(point(e));
    if(a.kind==='pen'||Math.abs(a.width)+Math.abs(a.height)>3){current().annotations.push(a);sidebar();}redraw();}
  canvas.addEventListener('pointerup',finish);canvas.addEventListener('pointercancel',()=>{mode.pending=null;redraw();});
  for(const b of document.querySelectorAll('[data-tool]'))b.addEventListener('click',()=>{
    mode.tool=b.dataset.tool;for(const other of document.querySelectorAll('[data-tool]'))other.classList.toggle('selected',other===b);
  });
  byId('undo').addEventListener('click',()=>{current()?.annotations.pop();sidebar();redraw();});
  byId('capture').addEventListener('click',async()=>{
    if(mode.working||mode.submitted)return;mode.working=true;sidebar();message('Capturing current browser tab…');
    try{const r=await window.__forgeCapture();if(!r.ok)message(r.error||'Capture failed.');}catch(e){message(String(e));}
    finally{mode.working=false;sidebar();}
  });
  byId('remove').addEventListener('click',async()=>{
    if(mode.submitted||!current())return;const i=frames.findIndex(f=>f.id===mode.selected);frames.splice(i,1);
    if(!frames.length){await window.__forgeTransition({state:'cancelled'});message('Review cancelled.');return;}
    mode.selected=frames[Math.max(0,i-1)].id;sidebar();show();
  });
  byId('submit').addEventListener('click',async()=>{
    if(mode.submitted||!frames.length)return;
    try{const result=await window.__forgeTransition({state:'submitted',value:window.__forgeState()});
      if(!result.ok){message(result.error||'Submit failed.');return;}mode.submitted=true;sidebar();message('Review submitted. Use annotate_export(path.json) to save annotated PNGs, ARIA snapshots and the JSON manifest.');}
    catch(e){message(String(e));}
  });
  byId('edit').addEventListener('click',async()=>{
    const result=await window.__forgeTransition({state:'editing'});
    if(result.ok){mode.submitted=false;sidebar();message('Review reopened for editing.');}else message(result.error||'Cannot edit.');
  });
  byId('cancel').addEventListener('click',()=>window.__forgeTransition({state:'cancelled'}));
  sidebar();show();
})();
</script></body></html>`;
