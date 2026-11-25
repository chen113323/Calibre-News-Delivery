/* 推送小信使 · 互动桌宠（零外部资源；与 console.js 状态联动） */
(function(){
'use strict';
if(!document.body){ return; }

var KV='wml_pet_visible', KR='wml_pet_roam';
function pget(k){ try{ return localStorage.getItem(k); }catch(e){ return null; } }
function pset(k,v){ try{ localStorage.setItem(k,v); }catch(e){} }
var reduced=window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches;
var small=window.matchMedia&&matchMedia('(max-width:899px)').matches;
var visStored=pget(KV);
var visible=visStored===null?!small:visStored!=='0';
var roam=pget(KR)!=='0'&&!reduced&&!small;
var GROUND=small?16:22, SIZE=small?64:88;
var LINES={
  happy:['今天的新书已送到 Kindle 啦','推送成功，我去歇一会儿'],
  working:['正在搬书，稍等一下…','这一本比较厚，马上好'],
  sad:['上次推送没成功，看看日志？','咦，好像哪里卡住了'],
  sleep:['自动推送休息中，手动随时可用','我在打盹，点推送我就醒'],
  idle:['早安，要现在推一本吗？','点配置页可以改书名和源','乖乖待命中'],
  guest:['先去配置页验证令牌吧','等令牌就位我就能说话啦']
};

var svg=''
+'<svg viewBox="0 0 100 100" aria-hidden="true">'
+'<ellipse class="pet-shadow" cx="50" cy="93" rx="27" ry="4" fill="rgba(15,23,42,.13)"/>'
+'<g class="pet-body">'
+'<ellipse cx="36" cy="84" rx="8" ry="5" fill="#0c2a6b"/>'
+'<ellipse cx="64" cy="84" rx="8" ry="5" fill="#0c2a6b"/>'
+'<rect x="16" y="26" width="68" height="56" rx="10" fill="#1d4ed8" stroke="#0c2a6b" stroke-width="2"/>'
+'<rect x="16" y="26" width="10" height="56" rx="5" fill="#0c2a6b"/>'
+'<rect x="28" y="33" width="52" height="42" rx="6" fill="#f8fafc"/>'
+'<g class="eyes-open"><circle cx="43" cy="50" r="4.2" fill="#0f172a"/>'
+'<circle cx="63" cy="50" r="4.2" fill="#0f172a"/>'
+'<circle cx="44.5" cy="48.5" r="1.4" fill="#fff"/>'
+'<circle cx="64.5" cy="48.5" r="1.4" fill="#fff"/></g>'
+'<g class="eyes-happy">'
+'<path d="M38 51 Q43 45 48 51" stroke="#0f172a" stroke-width="2.4" fill="none" stroke-linecap="round"/>'
+'<path d="M58 51 Q63 45 68 51" stroke="#0f172a" stroke-width="2.4" fill="none" stroke-linecap="round"/>'
+'</g>'
+'<ellipse cx="34" cy="59" rx="5" ry="2.6" fill="#f9a8d4" opacity=".65"/>'
+'<ellipse cx="72" cy="59" rx="5" ry="2.6" fill="#f9a8d4" opacity=".65"/>'
+'<path class="mouth-smile" d="M46 62 Q53 68 60 62" stroke="#0f172a" stroke-width="2" fill="none" stroke-linecap="round"/>'
+'<path class="mouth-sad" d="M46 67 Q53 61 60 67" stroke="#0f172a" stroke-width="2" fill="none" stroke-linecap="round"/>'
+'<path class="mouth-o" d="M53 62 a3.2 3.2 0 1 0 0.1 0" stroke="#0f172a" stroke-width="2" fill="none"/>'
+'<path class="mouth-flat" d="M47 64 L59 64" stroke="#0f172a" stroke-width="2" fill="none" stroke-linecap="round"/>'
+'<path d="M36 26 L50 15 L64 26 Z" fill="#f59e0b"/>'
+'<rect x="36" y="21" width="28" height="6" rx="2" fill="#fbbf24"/>'
+'<g class="pet-arm"><circle cx="85" cy="55" r="6" fill="#f8fafc" stroke="#1d4ed8" stroke-width="2"/></g>'
+'</g></svg>';

var el=document.createElement('div');
el.className='wml-pet mood-idle'; el.id='wml-pet';
el.setAttribute('role','button'); el.setAttribute('tabindex','0');
el.setAttribute('aria-label','推送小信使，点击互动，可拖拽');
el.innerHTML='<div class="pet-bubble" id="wml-pet-bubble"></div>'+svg;
document.body.appendChild(el);

var tools=document.createElement('div');
tools.className='pet-tools';
tools.innerHTML='<button type="button" id="wml-pet-roam"></button><button type="button" id="wml-pet-hide">隐藏</button>';
document.body.appendChild(tools);

var recall=document.createElement('button');
recall.className='pet-recall'; recall.id='wml-pet-recall'; recall.type='button';
recall.title='召唤推送小信使'; recall.setAttribute('aria-label','召唤推送小信使');
recall.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>';
document.body.appendChild(recall);

var bubble=document.getElementById('wml-pet-bubble');
var roamBtn=document.getElementById('wml-pet-roam'), hideBtn=document.getElementById('wml-pet-hide');
var x=small?12:24, y=GROUND, vx=0, vy=0;
var dragging=false, flying=false, moved=false, dir=0, roamUntil=0;
var sx=0, sy=0, lx=0, ly=0, lastTs=0, raf=null, running=false;
var mood='idle', bubbleTimer=null;

function clamp(v,a,b){ return Math.max(a,Math.min(b,v)); }
function maxX(){ return Math.max(40,Math.min(window.innerWidth*0.34,460)-SIZE); }
function apply(){ el.style.left=x+'px'; el.style.bottom=y+'px'; }

function say(text){
  bubble.textContent=text;
  bubble.classList.add('show');
  clearTimeout(bubbleTimer);
  bubbleTimer=setTimeout(function(){ bubble.classList.remove('show'); },3300);
}
function pickLine(){ var a=LINES[mood]||LINES.idle; return a[Math.floor(Math.random()*a.length)]; }
function readMood(){
  var st=window.WML&&window.WML.state;
  if(!st||!st.verified){ return 'guest'; }
  if(st.runningRun){ return 'working'; }
  var r=st.runs&&st.runs[0];
  if(r&&r.conclusion==='failure'){ return 'sad'; }
  if(st.schedule&&st.schedule.paused){ return 'sleep'; }
  if(r&&r.conclusion==='success'){ return 'happy'; }
  return 'idle';
}
function syncMood(){
  var m=readMood();
  if(m===mood){ return; }
  el.classList.remove('mood-'+mood); el.classList.add('mood-'+m); mood=m;
}
function interact(){
  el.classList.remove('waving');
  void el.offsetWidth;
  el.classList.add('waving');
  setTimeout(function(){ el.classList.remove('waving'); },1100);
  say(pickLine());
}

function tick(ts){
  if(!running){ return; }
  var dt=Math.min(34,ts-(lastTs||ts)); lastTs=ts;
  var step=dt/16.67;
  if(!dragging){
    if(flying){
      vy-=0.55*step; y+=vy*step; x+=vx*step; vx*=Math.pow(0.985,step);
      x=clamp(x,12,maxX());
      if(y<=GROUND){ y=GROUND; flying=false; vy=0; vx=0; el.classList.remove('flying'); }
      apply();
    }else if(roam){
      if(ts>roamUntil){
        dir=Math.random()<0.3?0:(Math.random()<0.5?-1:1);
        roamUntil=ts+1600+Math.random()*3200;
      }
      if(dir!==0){
        x=clamp(x+dir*0.34*step,12,maxX());
        if(x<=12||x>=maxX()){ dir=-dir; }
        el.classList.add('walking');
        el.style.setProperty('--pet-dir',dir<0?-1:1);
      }else{
        el.classList.remove('walking');
      }
      y=GROUND+(el.classList.contains('walking')?Math.abs(Math.sin(ts/170))*2:0);
      apply();
    }else{
      el.classList.remove('walking');
    }
  }
  raf=requestAnimationFrame(tick);
}
function start(){
  if(running||!visible){ return; }
  running=true; lastTs=0; raf=requestAnimationFrame(tick);
}
function stop(){
  running=false;
  if(raf){ cancelAnimationFrame(raf); raf=null; }
}

el.addEventListener('pointerdown',function(e){
  if(e.button!==undefined&&e.button!==0){ return; }
  dragging=true; moved=false; flying=false; vx=0; vy=0;
  sx=e.clientX; sy=e.clientY; lx=e.clientX; ly=e.clientY;
  el.classList.add('dragging'); el.classList.remove('walking','flying');
  try{ el.setPointerCapture(e.pointerId); }catch(err){}
});
el.addEventListener('pointermove',function(e){
  if(!dragging){ return; }
  var dx=e.clientX-lx, dy=e.clientY-ly;
  if(Math.abs(e.clientX-sx)+Math.abs(e.clientY-sy)>6){ moved=true; }
  x=clamp(x+dx,12,maxX());
  y=clamp(y-dy,GROUND,Math.max(GROUND,window.innerHeight-110));
  vx=dx*0.55; vy=-dy*0.55;
  lx=e.clientX; ly=e.clientY;
  apply();
});
function endDrag(){
  if(!dragging){ return; }
  dragging=false; el.classList.remove('dragging');
  if(moved){
    if(Math.abs(vx)+Math.abs(vy)>2.2){ flying=true; el.classList.add('flying'); }
    else{ y=GROUND; apply(); }
  }else{
    interact();
  }
}
el.addEventListener('pointerup',endDrag);
el.addEventListener('pointercancel',endDrag);
el.addEventListener('keydown',function(e){
  if(e.key==='Enter'||e.key===' '){ e.preventDefault(); interact(); }
});

function syncButtons(){
  roamBtn.textContent=roam?'漫游：开':'漫游：关';
  roamBtn.classList.toggle('off',!roam);
  roamBtn.disabled=!!(reduced||small);
  roamBtn.title=reduced?'系统已启用减少动效':(small?'小屏默认静止':'切换自动漫游');
}
roamBtn.addEventListener('click',function(){
  if(reduced||small){ return; }
  roam=!roam; pset(KR,roam?'1':'0');
  if(!roam){ el.classList.remove('walking'); y=GROUND; apply(); }
  syncButtons();
});
hideBtn.addEventListener('click',function(){ setVisible(false); });
recall.addEventListener('click',function(){ setVisible(true); });
function setVisible(v){
  visible=v; pset(KV,v?'1':'0');
  el.classList.toggle('hidden',!v);
  tools.classList.toggle('hidden',!v);
  recall.hidden=v;
  if(v){ syncMood(); start(); }else{ stop(); }
}

document.addEventListener('visibilitychange',function(){
  if(document.hidden){ stop(); }else if(visible){ start(); }
});
window.addEventListener('resize',function(){ x=clamp(x,12,maxX()); apply(); });
setInterval(syncMood,4000);
setInterval(function(){
  if(!visible||reduced||dragging){ return; }
  el.classList.add('blinking');
  setTimeout(function(){ el.classList.remove('blinking'); },150);
},4600);

syncButtons(); apply(); setVisible(visible);
if(visible){
  setTimeout(function(){ if(visible){ say('嗨，我是推送小信使，点我或拖我试试'); } },1600);
}
})();
