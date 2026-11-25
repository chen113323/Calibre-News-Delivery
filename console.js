/* Kindle 推送控制台 · 共享逻辑（操作台与配置页共用，无外部依赖） */
window.WML=(function(){
'use strict';

/* ========== 常量与状态 ========== */
var OWNER='chen113323', REPO='Calibre-News-Delivery', WF='calibre-news.yml', BR='master';
var TK_KEY='wml_console_token';
var WEEK=['日','一','二','三','四','五','六'];
var RANGES={'1':'最近 24 小时','3':'最近 3 天','7':'最近 7 天','30':'最近 30 天','0':'全部记录'};
var REPO_API='/repos/'+OWNER+'/'+REPO;
var RUNS_ALL=REPO_API+'/actions/workflows/'+WF+'/runs?per_page=100';
var RUNS_ONE=REPO_API+'/actions/workflows/'+WF+'/runs?per_page=1';
var WF_API=REPO_API+'/actions/workflows/'+WF;
var ALERT_WF='alert.yml';
var DEFAULT_TITLE='人民日报与半月谈';
var DEFAULT_FEEDS=[
 ['人民日报电子版','https://rsshub.ktachibana.party/people/paper'],
 ['半月谈·今日谈','https://rsshub.ktachibana.party/banyuetan/jinritan'],
 ['半月谈·时政讲解','https://rsshub.ktachibana.party/banyuetan/shizhengjiangjie'],
 ['半月谈·评论','https://rsshub.ktachibana.party/banyuetan/banyuetanpinglun'],
 ['半月谈·基层治理','https://rsshub.ktachibana.party/banyuetan/jicengzhili'],
 ['半月谈·文化','https://rsshub.ktachibana.party/banyuetan/wenhua'],
 ['半月谈·教育','https://rsshub.ktachibana.party/banyuetan/jiaoyu']
];
var state={
  token:'', persist:false, verified:false, page:'home',
  runs:[], range:'7', runningRun:null, runsLoaded:false, loadErrors:[],
  email:'', title:DEFAULT_TITLE, feeds:[], schedule:null, workflowState:'unknown',
  alertCfg:{to:'',hours:26,enabled:'1'}
};
/* schedule 块：开启态 / 暂停态（cron 行整体注释，保留表达式） */
var RE_ON=/^  schedule:[^\n]*\n(?:    - cron:[^\n]*\n?)+/m;
var RE_OFF=/^  # schedule:[^\n]*\n(?:  #   - cron:[^\n]*\n?)+/m;
var RE_CRON=/([ \t]*)- cron: '[^']*'[^\n]*/;

/* ========== 基础工具 ========== */
function $(id){ return document.getElementById(id); }
function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g,function(c){
  return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
function pad(n){ return String(n).padStart(2,'0'); }
function sleep(ms){ return new Promise(function(r){ setTimeout(r,ms); }); }
function toast(text,type){
  var t=document.createElement('div'); t.className='toast t-'+(type||'');
  t.textContent=text; document.body.appendChild(t);
  requestAnimationFrame(function(){ t.classList.add('show'); });
  setTimeout(function(){ t.classList.remove('show'); setTimeout(function(){ t.remove(); },320); },3800);
}
function setMsg(id,text,cls){ var el=$(id); if(el){ el.textContent=text||''; el.className='msg '+(cls||''); } }
function busy(btn,txt){ if(!btn) return; btn.disabled=true; btn.dataset.old=btn.textContent; btn.textContent=txt; }
function unbusy(btn){ if(!btn) return; btn.disabled=false; if(btn.dataset.old) btn.textContent=btn.dataset.old; }
function fmtTime(s){ return new Date(s).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}); }
function bjNow(){
  var d=new Date(Date.now()+8*3600*1000);
  return {y:d.getUTCFullYear(),m:d.getUTCMonth(),day:d.getUTCDate(),dow:d.getUTCDay()};
}
function b64encode(str){
  var bytes=new TextEncoder().encode(str), bin='', i;
  for(i=0;i<bytes.length;i++){ bin+=String.fromCharCode(bytes[i]); }
  return btoa(bin);
}
function b64decode(b64){
  var bin=atob(String(b64).replace(/\s/g,''));
  var bytes=Uint8Array.from(bin,function(c){ return c.charCodeAt(0); });
  return new TextDecoder().decode(bytes);
}
/* 隐私模式下存储访问可能抛异常，统一降级为「无存储」而不阻断页面 */
function lsGet(k){ try{ return localStorage.getItem(k); }catch(e){ return null; } }
function lsSet(k,v){ try{ localStorage.setItem(k,v); }catch(e){} }
function lsDel(k){ try{ localStorage.removeItem(k); }catch(e){} }
function ssGet(k){ try{ return sessionStorage.getItem(k); }catch(e){ return null; } }
function ssSet(k,v){ try{ sessionStorage.setItem(k,v); }catch(e){} }
function ssDel(k){ try{ sessionStorage.removeItem(k); }catch(e){} }
function applyTheme(t){ document.documentElement.dataset.theme=t; lsSet('wml_theme',t); }

/* ========== 令牌存储（不落 DOM、不回显） ========== */
function readStoredToken(){
  var s=ssGet(TK_KEY), l=lsGet(TK_KEY);
  state.persist=!!l;
  return s||l||'';
}
function storeToken(t,persist){
  if(persist){ lsSet(TK_KEY,t); ssDel(TK_KEY); }
  else{ ssSet(TK_KEY,t); lsDel(TK_KEY); }
  state.persist=persist;
}
function wipeToken(){ ssDel(TK_KEY); lsDel(TK_KEY); }

/* ========== GitHub API 封装 ========== */
async function api(path,opts,allow404){
  opts=opts||{};
  var headers=Object.assign({'Accept':'application/vnd.github+json'},opts.headers||{});
  if(state.token){ headers['Authorization']='Bearer '+state.token; }
  var r=await fetch('https://api.github.com'+path,Object.assign({},opts,{headers:headers,cache:'no-store'}));
  if(r.status===401) throw new Error('令牌无效或已过期');
  if(r.status===404){
    if(allow404) return null;
    throw new Error('资源不存在或 PAT 缺少对应权限（HTTP 404）');
  }
  if(r.status===403) throw new Error('权限不足或被限流：请核对 PAT 的 Actions/Variables/Contents/Workflows 权限（HTTP 403）');
  if(!r.ok) throw new Error('GitHub API 错误 HTTP '+r.status);
  return r.status===204?null:r.json();
}
function getVar(name){ return api('/repos/'+OWNER+'/'+REPO+'/actions/variables/'+name,{},true); }
async function putVar(name,value){
  var exist=await api(REPO_API+'/actions/variables/'+name,{},true);
  var path=exist?(REPO_API+'/actions/variables/'+name):(REPO_API+'/actions/variables');
  var method=exist?'PATCH':'POST';
  return api(path,{method:method,headers:{'Content-Type':'application/json'},
    body:JSON.stringify({name:name,value:value})});
}
function delVar(name){ return api('/repos/'+OWNER+'/'+REPO+'/actions/variables/'+name,{method:'DELETE'},true); }
async function getWorkflow(){
  var d=await api('/repos/'+OWNER+'/'+REPO+'/contents/.github/workflows/'+WF+'?ref='+BR);
  return {sha:d.sha,text:b64decode(d.content)};
}
function putWorkflow(text,sha,message){
  return api('/repos/'+OWNER+'/'+REPO+'/contents/.github/workflows/'+WF,{
    method:'PUT',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({message:message,content:b64encode(text),sha:sha})
  });
}
function permHint(){
  return '若提示权限不足，请为 PAT 补勾 Contents(读写) 与 Workflows(读写) 后重试；原文件未被修改。';
}

/* ========== 折叠控制器 ========== */
var COLLAPSE={};
function registerCollapsible(id,opts){
  var card=$(id); if(!card) return;
  COLLAPSE[id]=opts||{};
  var head=card.querySelector('.collapse-head'), btn=card.querySelector('[data-btn]');
  if(head){ head.addEventListener('click',function(e){
    if(e.target.closest('button')) return;
    setCollapsed(id,!card.classList.contains('collapsed'));
  }); }
  if(btn){ btn.addEventListener('click',function(e){
    e.stopPropagation();
    setCollapsed(id,!card.classList.contains('collapsed'));
  }); }
}
function setCollapsed(id,on){
  var card=$(id); if(!card) return;
  card.classList.toggle('collapsed',on);
  var btn=card.querySelector('[data-btn]'), o=COLLAPSE[id]||{};
  if(btn){ btn.textContent=on?(o.closedText||'展开'):(o.openText||'收起'); }
  requestAnimationFrame(updateNavActive);
}

/* ========== 定时配置：cron 与暂停状态 ========== */
function scheduleText(sch,short){
  if(!sch) return '未读取';
  if(sch.freq==='every3') return (short?'每3天 ':'每 3 天（每月 1/4/7/10… 日）')+sch.time;
  if(sch.freq==='every7') return (short?'每7天 ':'每 7 天（每周'+WEEK[sch.bjDow]+'）')+sch.time;
  return '每天 '+sch.time;
}
function parseCron(expr){
  var p=String(expr).trim().split(/\s+/);
  if(p.length!==5) return null;
  var um=parseInt(p[0],10), uh=parseInt(p[1],10);
  if(isNaN(um)||isNaN(uh)||uh>23||um>59) return null;
  var sch={freq:'daily',time:pad((uh+8)%24)+':'+pad(um),bjDow:null};
  if(p[2]==='*/3'){ sch.freq='every3'; }
  else if(p[4]!=='*'){
    var dow=parseInt(p[4],10);
    if(!isNaN(dow)){ sch.freq='every7'; sch.bjDow=(dow+((uh+8)>=24?1:0))%7; }
  }
  return sch;
}
function buildCron(freq,time){
  var parts=time.split(':'), h=parseInt(parts[0],10), m=parseInt(parts[1],10), bj=bjNow();
  var target=new Date(Date.UTC(bj.y,bj.m,bj.day,h,m)-8*3600*1000);
  var um=target.getUTCMinutes(), uh=target.getUTCHours(), udow=target.getUTCDay();
  var expr,desc;
  if(freq==='every3'){ expr=um+' '+uh+' */3 * *'; desc='每3天（每月1/4/7/10…日）'; }
  else if(freq==='every7'){ expr=um+' '+uh+' * * '+udow; desc='每7天（每周'+WEEK[bj.dow]+'，北京时间）'; }
  else{ expr=um+' '+uh+' * * *'; desc='每天'; }
  return {expr:expr,desc:desc,utcText:'UTC '+pad(uh)+':'+pad(um)};
}
/* 从 workflow 文本识别开启/暂停，并取出 cron 表达式 */
function parseScheduleState(text){
  var block, m;
  if(RE_ON.test(text)){
    block=text.match(RE_ON)[0]; m=block.match(/- cron: '([^']*)'/);
    if(!m) throw new Error('schedule 块中未找到 cron 表达式');
    return {paused:false,cronExpr:m[1]};
  }
  if(RE_OFF.test(text)){
    block=text.match(RE_OFF)[0]; m=block.match(/- cron: '([^']*)'/);
    if(!m) throw new Error('已暂停的 schedule 块中未找到 cron 表达式');
    return {paused:true,cronExpr:m[1]};
  }
  throw new Error('未识别 workflow 中的 schedule 配置块');
}
/* paused=true 表示执行「暂停」（注释），false 表示「恢复」（取消注释） */
function toggleScheduleBlock(text,paused){
  if(paused){
    if(!RE_ON.test(text)) throw new Error('当前不是开启状态，无法暂停');
    return text.replace(RE_ON,function(block){
      return block.split('\n').map(function(l){ return l?l.replace(/^  /,'  # '):l; }).join('\n');
    });
  }
  if(!RE_OFF.test(text)) throw new Error('当前不是暂停状态，无法恢复');
  return text.replace(RE_OFF,function(block){
    return block.split('\n').map(function(l){ return l.replace(/^  # /,'  '); }).join('\n');
  });
}
function renderSchedule(){
  var sch=state.schedule; if(!sch) return;
  if($('sched-freq')){ $('sched-freq').value=sch.freq; }
  if($('sched-time')){ $('sched-time').value=sch.time; }
  if($('sched-cur')){
    $('sched-cur').textContent='当前定时：'+scheduleText(sch,false)+'（北京时间）'+(sch.paused?' · 自动推送已暂停':' · 自动推送已开启');
  }
  if($('auto-state-text')){
    $('auto-state-text').textContent=sch.paused?'当前已暂停自动推送，可用上方按钮恢复':'当前自动推送已开启，可用上方按钮暂停';
  }
  if($('chip-sched')){
    $('chip-sched').textContent=state.page==='home'
      ? (sch.paused?'自动：已暂停':'自动：'+scheduleText(sch,true))
      : ('定时：'+scheduleText(sch,true)+(sch.paused?'（已暂停）':''));
  }
  if($('auto-line')){
    $('auto-line').innerHTML=sch.paused
      ? '自动推送：<b>已暂停</b> · 定时 '+esc(scheduleText(sch,true))+' 已保留，恢复后继续按此时间推送'
      : '自动推送：<b>已开启</b> · '+esc(scheduleText(sch,true))+'（北京时间）';
  }
  if($('auto-row')){ $('auto-row').className='switch-row '+(sch.paused?'off':'on'); }
  if($('btn-auto')){
    $('btn-auto').textContent=sch.paused?'恢复自动推送':'暂停自动推送';
    $('btn-auto').className=sch.paused?'':'danger';
  }
  if(state.page==='settings'&&state.verified&&$('hero-status')){
    $('hero-status').textContent=sch.paused?'自动推送已暂停':'定时 '+scheduleText(sch,true);
    var hd=$('hero-dot');
    if(hd){ hd.className=sch.paused?'dot pause':'dot ok'; }
  }
  if(state.page==='home'&&$('hero-dot')&&sch.paused&&state.verified){ $('hero-dot').className='dot pause'; }
}
async function loadSchedule(){
  var f=await getWorkflow(), st=parseScheduleState(f.text), sch=parseCron(st.cronExpr);
  if(!sch) throw new Error('cron 表达式无法解析：'+st.cronExpr);
  sch.paused=st.paused;
  state.schedule=sch;
  renderSchedule();
  return sch;
}
async function toggleAuto(){
  if(!state.verified){ setMsg('auto-msg','请先在上方「1 · 访问令牌」保存并验证令牌','bad'); return; }
  if(!state.schedule){ setMsg('auto-msg','定时状态未读取，请先刷新','bad'); return; }
  var pause=!state.schedule.paused, btn=$('btn-auto');
  if(!confirm(pause
    ? '确定暂停自动推送吗？\n定时触发器会被注释（推送时间保留），之后不会再自动推送；手动推送照常可用，随时可恢复。'
    : '确定恢复自动推送吗？\n将按 '+scheduleText(state.schedule,true)+'（北京时间）恢复定时推送。')) return;
  busy(btn,pause?'暂停中…':'恢复中…'); setMsg('auto-msg','正在更新 workflow …');
  try{
    var f=await getWorkflow(), updated=toggleScheduleBlock(f.text,pause);
    await putWorkflow(updated,f.sha,(pause?'控制台：暂停自动推送':'控制台：恢复自动推送'));
    await loadSchedule();
    setMsg('auto-msg',pause
      ? '已暂停 ✓ 定时触发已停止，不会再自动推送；手动推送不受影响，可随时恢复。'
      : '已恢复 ✓ 自动推送已开启，仍按 '+scheduleText(state.schedule,true)+'（北京时间）触发。','ok');
    toast(pause?'已暂停自动推送':'已恢复自动推送',pause?'warn':'ok');
    if(!pause){
      try{
        var reEnabled=await ensureWorkflowEnabled();
        if(reEnabled){
          setMsg('auto-msg','已恢复 ✓ 并重新启用了被 GitHub 停用的定时任务（public 仓库 60 天无提交会自动禁用）。','ok');
        }
      }catch(e){
        setMsg('auto-msg','已恢复 ✓ 但检查 GitHub 定时任务状态失败：'+e.message,'warn');
      }
    }
  }catch(e){
    setMsg('auto-msg','操作失败：'+e.message+'。'+permHint(),'bad');
    toast('自动推送状态修改失败','bad');
  }
  unbusy(btn);
  renderSchedule();
}
async function saveSchedule(){
  if(!state.verified){ setMsg('sched-msg','请先在上方「1 · 访问令牌」保存并验证令牌','bad'); return; }
  var freq=$('sched-freq').value, time=$('sched-time').value;
  if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)){
    setMsg('sched-msg','请输入有效时间（HH:MM，24 小时制）','bad'); return;
  }
  var btn=$('save-sched'); busy(btn,'保存中…'); setMsg('sched-msg','');
  try{
    var built=buildCron(freq,time), f=await getWorkflow();
    var match=f.text.match(RE_CRON);
    if(!match) throw new Error('未在 workflow 中定位到 cron 行，未做任何修改');
    var newline=match[1]+"- cron: '"+built.expr+"'   # "+built.utcText+' = 北京 '+time+'（'+built.desc+'）';
    var updated=f.text.replace(RE_CRON,newline);
    if(updated===f.text){
      setMsg('sched-msg','当前已是「'+built.desc+' '+time+'（北京时间）」，配置未变化，无需重复保存','ok');
      toast('配置未变化','ok');
      unbusy(btn);
      return;
    }
    await putWorkflow(updated,f.sha,'更新推送时间：'+built.desc+' 北京 '+time);
    await loadSchedule();
    setMsg('sched-msg','已保存 ✓ '+built.desc+' '+time+'（北京时间），cron 已同步为 '+built.expr
      +(state.schedule&&state.schedule.paused?'；当前自动推送仍处于暂停状态，恢复后生效':'')+'。','ok');
    toast('推送时间已更新','ok');
  }catch(e){
    setMsg('sched-msg','保存失败：'+e.message+'。'+permHint(),'bad');
    toast('推送时间保存失败','bad');
  }
  unbusy(btn);
}

/* ========== 60 天自动禁用防护 ========== */
function renderWorkflowState(){
  var bad=/^disabled/.test(state.workflowState||'');
  var w=$('workflow-state-warn');
  if(w){
    w.classList.toggle('show',bad);
    var t=$('workflow-state-text');
    if(t){
      t.textContent=bad
        ? 'GitHub 已停用该定时任务（'+state.workflowState+'）：public 仓库连续 60 天无提交会自动禁用定时触发器。点右侧按钮重新启用，手动推送不受影响。'
        : '';
    }
  }
  var btn=$('btn-enable-workflow');
  if(btn){ btn.style.display=bad?'inline-block':'none'; }
  var hw=$('home-workflow-warn');
  if(hw){ hw.classList.toggle('show',bad); }
  renderAlerts();
}
async function loadWorkflowState(){
  var d=await api(WF_API);
  state.workflowState=d.state||'unknown';
  clearError('定时任务状态');
  renderWorkflowState();
  return state.workflowState;
}
/* 只启用业务主工作流；仓库保活由独立工作流自行维护，不在本控制台逻辑中出现 */
async function enableMainWorkflow(){
  await api(WF_API+'/enable',{method:'PUT'});
}
async function ensureWorkflowEnabled(){
  var d=await api(WF_API);
  if(d.state!=='active'){
    await enableMainWorkflow();
    state.workflowState='active';
    renderWorkflowState();
    return true;
  }
  state.workflowState='active';
  renderWorkflowState();
  return false;
}
async function enableWorkflow(){
  if(!state.verified){ setMsg('workflow-msg','请先在上方「1 · 访问令牌」保存并验证令牌','bad'); return; }
  var btn=$('btn-enable-workflow'); busy(btn,'启用中…');
  try{
    await enableMainWorkflow();
    await loadWorkflowState();
    setMsg('workflow-msg','已重新启用 ✓ 定时推送恢复。手动推送始终可用，与本开关无关。','ok');
    toast('定时任务已重新启用','ok');
  }catch(e){
    setMsg('workflow-msg','启用失败：'+e.message+'（需要 PAT 具备 Actions 写权限）','bad');
    toast('启用失败','bad');
  }
  unbusy(btn);
}

/* ========== 告警中心（页面侧，不依赖 SMTP） ========== */
function recordError(label,e){
  state.runsLoaded=true;
  var msg=label+'：'+(e&&e.message?e.message:'读取失败');
  if(state.loadErrors.indexOf(msg)<0) state.loadErrors.push(msg);
  renderAlerts();
}
function clearError(label){
  state.loadErrors=state.loadErrors.filter(function(x){ return x.indexOf(label+'：')!==0; });
}
function renderAlerts(){
  var box=state.page==='home'?$('home-alert'):$('settings-alert');
  if(!box) return;
  var items=[];
  state.loadErrors.forEach(function(m){ items.push({bad:true,text:'数据读取失败 · '+m}); });
  if(/^disabled/.test(state.workflowState||'')){
    items.push({bad:true,text:'GitHub 已停用定时工作流（'+state.workflowState+'）。请到配置页「重新启用定时任务」，手动推送不受影响。'});
  }
  var latest=state.runs[0];
  var lastFailed=latest&&latest.status==='completed'&&
     ['failure','timed_out','startup_failure','stale','action_required'].indexOf(latest.conclusion)>=0;
  if(lastFailed){
    items.push({bad:true,text:'最近一次推送失败（'+fmtTime(latest.created_at)+'），请查看日志后手动补推。',
      url:latest.html_url,link:'查看日志'});
  }
  /* 已明确失败时不再叠加「漏推」，避免同一故障报两条 */
  if(!lastFailed&&state.verified&&state.runsLoaded&&state.loadErrors.length===0&&
     !(state.schedule&&state.schedule.paused)&&!/^disabled/.test(state.workflowState||'')){
    var lastOk=state.runs.filter(function(r){ return r.conclusion==='success'; })[0];
    var hours=parseInt(state.alertCfg.hours,10)||26;
    if(!lastOk||Date.now()-new Date(lastOk.created_at).getTime()>hours*3600000){
      items.push({bad:false,text:lastOk
        ? '距最近一次成功推送已超过 '+hours+' 小时，疑似漏推（定时可能被 GitHub 跳过）'
        : '尚无成功推送记录，疑似漏推；可点「立即推送」验证链路'});
    }
  }
  if(!items.length){ box.className='alertbar'; box.innerHTML=''; return; }
  var hasBad=items.some(function(x){ return x.bad; });
  box.className='alertbar show'+(hasBad?'':' mild');
  var head=document.createElement('div'); head.className='ab-head';
  head.textContent='⚠ 告警 · '+items.length+' 项';
  var ul=document.createElement('ul');
  items.forEach(function(it){
    var li=document.createElement('li'); li.textContent=it.text;
    if(it.url&&it.url.indexOf('https://')===0){
      var a=document.createElement('a'); a.href=it.url; a.target='_blank'; a.rel='noopener';
      a.textContent=' '+(it.link||'详情'); li.appendChild(a);
    }
    ul.appendChild(li);
  });
  box.innerHTML=''; box.appendChild(head); box.appendChild(ul);
}
async function loadAlertCfg(){
  var to=await getVar('ALERT_TO'), h=await getVar('ALERT_HOURS'), en=await getVar('ALERT_ENABLED');
  var hv=h?parseInt(h.value,10):26;
  state.alertCfg={to:to?to.value:'', hours:(hv>=2&&hv<=168)?hv:26, enabled:(en&&en.value==='0')?'0':'1'};
  clearError('告警设置'); renderAlertCfg(); renderAlerts();
}
function renderAlertCfg(){
  if($('alert-to')) $('alert-to').value=state.alertCfg.to;
  if($('alert-hours')) $('alert-hours').value=state.alertCfg.hours;
  if($('alert-enabled')) $('alert-enabled').value=state.alertCfg.enabled;
  if($('cur-alert-to')) $('cur-alert-to').textContent='当前：'+(state.alertCfg.to||'未设置（发给发件邮箱）');
  if($('cur-alert-hours')) $('cur-alert-hours').textContent='当前：'+state.alertCfg.hours+' 小时';
}
async function saveAlertCfg(){
  if(!state.verified){ setMsg('alert-msg','请先在上方「1 · 访问令牌」保存并验证令牌','bad'); return; }
  var to=$('alert-to').value.trim(), h=parseInt($('alert-hours').value,10), en=$('alert-enabled').value;
  if(to&&!/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(to)){ setMsg('alert-msg','告警邮箱格式不正确','bad'); return; }
  if(isNaN(h)||h<2||h>168){ setMsg('alert-msg','漏推阈值需在 2–168 小时之间','bad'); return; }
  var btn=$('save-alert'); busy(btn,'保存中…');
  try{
    if(to) await putVar('ALERT_TO',to); else await delVar('ALERT_TO');
    await putVar('ALERT_HOURS',String(h));
    await putVar('ALERT_ENABLED',en);
    await loadAlertCfg();
    setMsg('alert-msg','已保存 ✓ 告警设置已生效','ok'); toast('告警设置已保存','ok');
  }catch(e){ setMsg('alert-msg','保存失败：'+e.message,'bad'); }
  finally{ unbusy(btn); }
}
async function testAlert(){
  if(!state.verified){ setMsg('alert-test-msg','请先在上方「1 · 访问令牌」保存并验证令牌','bad'); return; }
  var btn=$('send-test-alert'); busy(btn,'发送中…');
  try{
    await api('/repos/'+OWNER+'/'+REPO+'/actions/workflows/'+ALERT_WF+'/dispatches',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({ref:BR,inputs:{subject:'【测试】Kindle 推送告警'}})
    });
    setMsg('alert-test-msg','已触发 ✓ 测试告警正在发送，稍后查看收件箱或 Actions → Alert Test 日志','ok');
    toast('测试告警已触发','ok');
  }catch(e){ setMsg('alert-test-msg','触发失败：'+e.message,'bad'); toast('测试告警触发失败','bad'); }
  finally{ unbusy(btn); }
}

/* ========== 邮箱、书名、RSS 源 ========== */
async function loadEmail(){
  var v=await getVar('TO');
  state.email=v?v.value:'';
  if($('cur-email')){ $('cur-email').textContent=v?('当前邮箱：'+v.value):'当前邮箱：未设置（回退到 secrets.TO）'; }
}
async function loadTitle(){
  var v=await getVar('BOOK_TITLE'), t=v?v.value:DEFAULT_TITLE;
  state.title=t;
  if($('cur-title')){ $('cur-title').textContent=v?('当前书名：'+t):('当前书名：'+t+'（未自定义）'); }
  if($('chip-title')){ $('chip-title').textContent='书名：'+t; }
}
function feedRow(t,u){
  var div=document.createElement('div'); div.className='feedrow';
  div.innerHTML='<input class="ft" placeholder="栏目名"><input class="fu" placeholder="RSS 地址 https://…"><button class="fx" title="删除该行">×</button>';
  div.querySelector('.ft').value=t||'';
  div.querySelector('.fu').value=u||'';
  div.querySelector('.fx').addEventListener('click',function(){
    var box=$('feed-rows');
    if(box&&box.children.length>1){ div.remove(); } else{ setMsg('feeds-msg','至少保留一行','warn'); }
  });
  return div;
}
function renderFeeds(arr,custom){
  state.feeds=arr;
  var box=$('feed-rows'); if(!box) return;
  box.innerHTML='';
  arr.forEach(function(p){ box.appendChild(feedRow(p[0],p[1])); });
  if($('feed-status')){ $('feed-status').textContent=custom?('自定义源 · '+arr.length+' 个'):('内置默认源 · '+arr.length+' 个'); }
}
async function loadFeeds(){
  if(!state.verified){ renderFeeds(DEFAULT_FEEDS,false); return; }
  try{
    var v=await getVar('FEEDS');
    if(v){
      var parsed=JSON.parse(v.value);
      if(Array.isArray(parsed)&&parsed.length){
        renderFeeds(parsed.map(function(x){ return [x.title||'',x.url||'']; }),true);
        return;
      }
    }
    renderFeeds(DEFAULT_FEEDS,false);
  }catch(e){
    renderFeeds(DEFAULT_FEEDS,false);
    if($('feed-status')){ $('feed-status').textContent='读取自定义源失败（'+e.message+'），已载入默认源'; }
  }
}
async function saveFeeds(){
  if(!state.verified){ setMsg('feeds-msg','请先在上方「1 · 访问令牌」保存并验证令牌','bad'); return; }
  var rows=Array.prototype.slice.call(document.querySelectorAll('#feed-rows .feedrow')), arr=[], i;
  for(i=0;i<rows.length;i++){
    var t=rows[i].querySelector('.ft').value.trim(), u=rows[i].querySelector('.fu').value.trim();
    if(!t&&!u) continue;
    if(!t){ setMsg('feeds-msg','存在未填写栏目名的行','bad'); return; }
    if(!/^https?:\/\//.test(u)){ setMsg('feeds-msg','RSS 地址必须以 http(s):// 开头：'+u,'bad'); return; }
    arr.push({title:t,url:u});
  }
  if(!arr.length){ setMsg('feeds-msg','至少保留一个有效的 RSS 源','bad'); return; }
  var btn=$('save-feeds'); busy(btn,'保存中…');
  try{
    await putVar('FEEDS',JSON.stringify(arr));
    setMsg('feeds-msg','已保存 ✓ 共 '+arr.length+' 个源，下一次推送生效','ok');
    toast('RSS 源已保存（'+arr.length+' 个）','ok');
    renderFeeds(arr.map(function(x){ return [x.title,x.url]; }),true);
  }catch(e){ setMsg('feeds-msg','保存失败：'+e.message,'bad'); }
  unbusy(btn);
}
async function resetFeeds(){
  if(!state.verified){ setMsg('feeds-msg','请先在上方「1 · 访问令牌」保存并验证令牌','bad'); return; }
  if(!confirm('确定恢复内置默认源吗？将清除你在网页上保存的自定义源列表。')) return;
  try{
    await delVar('FEEDS');
    setMsg('feeds-msg','已恢复内置默认源，下一次推送生效','ok');
    toast('已恢复默认源','warn');
  }catch(e){ setMsg('feeds-msg','清除失败：'+e.message,'bad'); }
  renderFeeds(DEFAULT_FEEDS,false);
}

/* ========== 运行记录 ========== */
function badge(st,con){
  if(con==='success') return '<span class="badge b-ok">成功</span>';
  if(con==='failure'||con==='timed_out') return '<span class="badge b-bad">失败</span>';
  if(con==='cancelled'||con==='skipped') return '<span class="badge b-skip">'+(con==='cancelled'?'已取消':'跳过')+'</span>';
  if(st==='in_progress') return '<span class="badge b-run">运行中</span>';
  return '<span class="badge b-wait">排队中</span>';
}
function evName(e){ return e==='schedule'?'定时':'手动'; }
function filteredRuns(){
  if(state.range==='0') return state.runs;
  var cutoff=Date.now()-parseInt(state.range,10)*86400000;
  return state.runs.filter(function(r){ return new Date(r.created_at).getTime()>=cutoff; });
}
function renderRuns(){
  var list=$('runs'); if(!list) return;
  var arr=filteredRuns();
  list.innerHTML='';
  if(!state.verified){
    list.innerHTML='<li class="empty" style="border:0;">输入并验证令牌后加载运行记录</li>';
  }else if(!arr.length){
    list.innerHTML='<li class="empty" style="border:0;">该时间范围内没有运行记录，可切换更大的时间范围</li>';
  }else{
    arr.forEach(function(r){
      var li=document.createElement('li');
      li.innerHTML=badge(r.status,r.conclusion)
        +'<span>'+evName(r.event)+'</span>'
        +'<span class="r-time">'+esc(fmtTime(r.created_at))+'</span>'
        +'<a href="'+esc(r.html_url)+'" target="_blank" rel="noopener">详情</a>'
        +(r.status!=='completed'?'<button class="danger mini" data-stop="'+r.id+'">取消本次</button>':'')
        +'<div class="r-name"></div>';
      li.querySelector('.r-name').textContent=r.display_title||r.name||'';
      list.appendChild(li);
    });
  }
  if($('run-scope')){
    if(!state.verified){ $('run-scope').textContent='时间范围：未验证令牌'; }
    else if(!arr.length){ $('run-scope').textContent='时间范围：'+RANGES[state.range]+' · 0 条（北京时间）'; }
    else{
      $('run-scope').textContent='时间范围：'+RANGES[state.range]+' · 共 '+arr.length+' 条 · 覆盖 '
        +fmtTime(arr[arr.length-1].created_at)+' 至 '+fmtTime(arr[0].created_at)+'（北京时间）';
    }
  }
  var latest=state.runs[0], sum=RANGES[state.range]+' · '+arr.length+' 次';
  if(latest){
    sum+=' · 最近'+(latest.conclusion==='success'?'成功':latest.conclusion==='failure'?'失败':latest.status==='completed'?'结束':'进行中')+' '+fmtTime(latest.created_at);
  }
  if($('runs-summary')){ $('runs-summary').textContent=' · '+sum; }
  renderStopbar(); updateHero(); renderAlerts();
}
async function loadRuns(){
  if(!state.verified){ state.runs=[]; state.runningRun=null; renderRuns(); return; }
  var data=await api(RUNS_ALL);
  state.runs=data.workflow_runs||[];
  state.runningRun=state.runs.filter(function(r){ return r.status!=='completed'; })[0]||null;
  clearError('运行记录');
  renderRuns();
}
function updateHero(){
  var dot=$('hero-dot'), st=$('hero-status'); if(!dot||!st) return;
  var latest=state.runs[0];
  if(!state.verified){ dot.className='dot'; st.textContent='未验证令牌'; return; }
  if(state.schedule&&state.schedule.paused){ dot.className='dot pause'; }
  if(!latest){ st.textContent=state.schedule&&state.schedule.paused?'自动推送已暂停 · 暂无运行记录':'暂无运行记录'; return; }
  if(latest.status==='in_progress'){ dot.className='dot run'; st.textContent='正在推送…'; }
  else if(latest.conclusion==='success'){ if(!state.schedule||!state.schedule.paused) dot.className='dot ok'; st.textContent='最近推送成功 · '+fmtTime(latest.created_at); }
  else if(latest.conclusion==='cancelled'){ if(!state.schedule||!state.schedule.paused) dot.className='dot'; st.textContent='最近一次已取消 · '+fmtTime(latest.created_at); }
  else if(latest.conclusion){ if(!state.schedule||!state.schedule.paused) dot.className='dot bad'; st.textContent='最近推送'+(latest.conclusion==='failure'?'失败':'异常')+' · '+fmtTime(latest.created_at); }
}
function renderStopbar(){
  var bar=$('stopbar'); if(!bar) return;
  var r=state.runningRun;
  if(!r){ bar.classList.remove('show'); return; }
  bar.classList.add('show');
  var mins=Math.max(0,Math.round((Date.now()-new Date(r.created_at).getTime())/60000));
  if($('stopbar-text')){
    $('stopbar-text').textContent='有'+evName(r.event)+'推送 #'+r.id+' 正在运行（约 '+mins+' 分钟）。'
      +'如需中止这一次，可点右侧「取消本次运行」；这不会改变自动推送开关。';
  }
}

/* ========== 手动推送与取消单次运行 ========== */
async function dispatch(){
  if(!state.verified){ setMsg('dispatch-msg','请先到「配置」页保存并验证令牌','bad'); return; }
  var btn=$('btn-dispatch'); busy(btn,'触发中…'); setMsg('dispatch-msg','');
  var temp=$('temp-email')?$('temp-email').value.trim():'';
  if(temp&&temp.indexOf('@')<1){ setMsg('dispatch-msg','临时邮箱格式不正确','bad'); unbusy(btn); return; }
  try{
    await api('/repos/'+OWNER+'/'+REPO+'/actions/workflows/'+WF+'/dispatches',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({ref:BR,inputs:{to_email:temp}})
    });
    setMsg('dispatch-msg','已触发 ✓ 正在监控运行状态…'+(temp?'（本次发送到 '+temp+'）':''),'ok');
    toast('推送已触发，约 2–5 分钟完成','ok');
    pollNewRun(Date.now());
  }catch(e){ setMsg('dispatch-msg','触发失败：'+e.message,'bad'); toast('触发失败','bad'); }
  unbusy(btn);
}
function pollNewRun(start){
  var n=0;
  var timer=setInterval(async function(){
    n++;
    try{
      var data=await api(RUNS_ONE);
      var r=(data.workflow_runs||[])[0];
      if(r&&new Date(r.created_at).getTime()>start-60000){
        setMsg('dispatch-msg','运行 '+r.id+' · '+(r.conclusion||(r.status==='in_progress'?'运行中':'排队中')),'ok');
        loadRuns().catch(function(){});
        if(r.status==='completed'){
          clearInterval(timer);
          if(r.conclusion==='success'){ setMsg('dispatch-msg','推送完成 ✓ 请查收 Kindle','ok'); toast('推送完成，请查收 Kindle','ok'); }
          else if(r.conclusion==='cancelled'){ setMsg('dispatch-msg','该次运行已取消','warn'); }
          else{ setMsg('dispatch-msg','运行失败：点「详情」查看日志，修复后可再次推送','warn'); toast('推送失败，请查看日志','bad'); }
        }
      }
    }catch(e){ /* 忽略单次轮询错误 */ }
    if(n>40){ clearInterval(timer); }
  },15000);
}
async function cancelRun(id,srcBtn){
  if(!state.verified){ setMsg('dispatch-msg','请先到「配置」页保存并验证令牌','bad'); return; }
  if(!confirm('确定取消 run #'+id+' 这「一次」运行吗？\n这不会暂停自动推送；若已进入发送步骤，邮件可能已发出。')) return;
  var btn=srcBtn||$('btn-stop'); busy(btn,'取消中…');
  setMsg('dispatch-msg','正在请求取消 run #'+id+' …','warn');
  try{
    await api('/repos/'+OWNER+'/'+REPO+'/actions/runs/'+id+'/cancel',{method:'POST'});
    var i,r;
    for(i=0;i<12;i++){
      await sleep(4000);
      r=await api('/repos/'+OWNER+'/'+REPO+'/actions/runs/'+id);
      if(r.status==='completed'){
        if(r.conclusion==='cancelled'){
          setMsg('dispatch-msg','已取消 ✓ run #'+id+' 已终止（自动推送开关不受影响）','ok');
          toast('本次运行已取消','ok');
        }else{ setMsg('dispatch-msg','该次运行已结束，结果：'+r.conclusion,'warn'); }
        await loadRuns().catch(function(){});
        unbusy(btn); return;
      }
    }
    setMsg('dispatch-msg','取消请求已提交，GitHub 尚未确认结束，请稍后点「刷新状态」查看','warn');
  }catch(e){ setMsg('dispatch-msg','取消失败：'+e.message,'bad'); toast('取消失败','bad'); }
  unbusy(btn);
  loadRuns().catch(function(){});
}

/* ========== 令牌验证与界面刷新 ========== */
function setAuthenticated(ok){
  state.verified=ok;
  state.loadErrors=[]; state.runsLoaded=false;
  state.alertCfg={to:'',hours:26,enabled:'1'}; renderAlertCfg();
  var warn=$('settings-auth-warn'); if(warn){ warn.classList.toggle('show',!ok); }
  var hw=$('home-auth-warn'); if(hw){ hw.classList.toggle('show',!ok); }
  if($('btn-auto')){ $('btn-auto').disabled=!ok; }
  if(!ok){
    state.runs=[]; state.runningRun=null; state.schedule=null; state.email=''; state.title=DEFAULT_TITLE;
    if($('cur-email')){ $('cur-email').textContent='当前邮箱：需验证令牌'; }
    if($('cur-title')){ $('cur-title').textContent='当前书名：需验证令牌'; }
    if($('chip-title')){ $('chip-title').textContent='书名：—'; }
    if($('chip-sched')){ $('chip-sched').textContent=state.page==='home'?'自动：—':'定时：—'; }
    if($('sched-cur')){ $('sched-cur').textContent='当前定时：需验证令牌'; }
    if($('auto-line')){ $('auto-line').textContent='自动推送：未验证令牌'; }
    if($('feed-status')){ $('feed-status').textContent='验证令牌后可读取与保存自定义源（已载入默认源）'; }
    renderFeeds(DEFAULT_FEEDS,false);
    state.workflowState='unknown'; renderWorkflowState();
  }
  if(state.page==='home'){ renderRuns(); }
  else if($('hero-status')){ $('hero-status').textContent=ok?'配置已加载':'未验证令牌'; }
}
async function refreshAll(){
  var jobs=[];
  if(state.page==='home'){
    jobs.push(loadRuns().catch(function(e){ recordError('运行记录',e); }));
    jobs.push(loadWorkflowState().catch(function(e){ recordError('定时任务状态',e); }));
    jobs.push(loadTitle().catch(function(e){ if($('chip-title')) $('chip-title').textContent='书名：读取失败'; }));
    jobs.push(loadSchedule().catch(function(e){
      if($('sched-cur')) $('sched-cur').textContent='当前定时：读取失败（'+e.message+'）';
      if($('auto-line')) $('auto-line').textContent='自动推送状态读取失败：'+e.message;
      if($('chip-sched')) $('chip-sched').textContent=state.page==='home'?'自动：未读取':'定时：未读取';
    }));
  }else{
    jobs.push(loadRuns().catch(function(e){ recordError('运行记录',e); }));
    jobs.push(loadWorkflowState().catch(function(e){ recordError('定时任务状态',e); }));
    jobs.push(loadAlertCfg().catch(function(e){ recordError('告警设置',e); }));
    jobs.push(loadEmail().catch(function(e){ if($('cur-email')) $('cur-email').textContent='当前邮箱：读取失败（'+e.message+'）'; }));
    jobs.push(loadTitle().catch(function(e){ if($('cur-title')) $('cur-title').textContent='当前书名：读取失败（'+e.message+'）'; }));
    jobs.push(loadSchedule().catch(function(e){
      if($('sched-cur')) $('sched-cur').textContent='当前定时：读取失败（'+e.message+'）· '+permHint();
    }));
    jobs.push(loadFeeds().catch(function(){}));
  }
  await Promise.all(jobs);
  state.runsLoaded=true; renderAlerts();
}
async function verifyToken(silent){
  if(!state.token){ setAuthenticated(false); return false; }
  try{
    await api('/repos/'+OWNER+'/'+REPO);
    setAuthenticated(true);
    if($('auth-summary')){ $('auth-summary').textContent=' · 有效'+(state.persist?'（长期记住）':'（仅本次会话）'); }
    if($('auth-msg')){ setMsg('auth-msg','令牌有效','ok'); }
    if($('token')){ $('token').value=''; $('token').placeholder='已保存令牌（不回显），点「管理」可更换或清除'; }
    setCollapsed('sec-auth',true);
    await refreshAll();
    return true;
  }catch(e){
    setAuthenticated(false);
    if($('auth-summary')){ $('auth-summary').textContent=' · '+(silent?'已失效，请重新输入':'验证失败'); }
    if($('auth-msg')){ setMsg('auth-msg',(silent?'已保存的令牌不可用：':'')+e.message,'bad'); }
    setCollapsed('sec-auth',false);
    if(!silent){ toast(e.message,'bad'); }
    return false;
  }
}

/* ========== 锚点导航（仅操作台） ========== */
var NAV_IDS=['sec-dispatch','sec-runs'];
function navHeight(){ var n=document.querySelector('.quicknav'); return n?n.offsetHeight:0; }
function setNavActive(id){
  document.querySelectorAll('.quicknav a').forEach(function(a){
    var h=a.getAttribute('href');
    a.classList.toggle('active',h==='#'+id);
  });
}
function updateNavActive(){
  var nav=document.querySelector('.quicknav'); if(!nav) return;
  var pos=window.scrollY+navHeight()+24, current=NAV_IDS[0], i;
  for(i=0;i<NAV_IDS.length;i++){
    var el=$(NAV_IDS[i]);
    if(el&&el.offsetTop<=pos){ current=NAV_IDS[i]; }
  }
  var doc=document.documentElement;
  if(doc.scrollHeight>window.innerHeight+40&&window.scrollY+window.innerHeight>=doc.scrollHeight-8){
    current=NAV_IDS[NAV_IDS.length-1];
  }
  setNavActive(current);
}
function initNav(){
  document.querySelectorAll('.quicknav a').forEach(function(a){
    var href=a.getAttribute('href');
    if(href.charAt(0)!=='#') return;
    a.addEventListener('click',function(e){
      e.preventDefault();
      var id=href.slice(1), el=$(id); if(!el) return;
      setCollapsed(id,false);
      var y=el.getBoundingClientRect().top+window.scrollY-navHeight()-10;
      window.scrollTo({top:Math.max(0,y),behavior:'smooth'});
      setNavActive(id);
    });
  });
  var ticking=false;
  window.addEventListener('scroll',function(){
    if(ticking) return;
    ticking=true;
    requestAnimationFrame(function(){ updateNavActive(); ticking=false; });
  },{passive:true});
  window.addEventListener('resize',updateNavActive);
  updateNavActive();
}

/* ========== 公共初始化 ========== */
function initCommon(){
  applyTheme(lsGet('wml_theme')||(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'));
  if($('theme-toggle')){
    $('theme-toggle').addEventListener('click',function(){
      applyTheme(document.documentElement.dataset.theme==='dark'?'light':'dark');
    });
  }
}
async function bootstrapAuth(){
  state.token=readStoredToken();
  if($('remember-token')){ $('remember-token').checked=state.persist; }
  if(state.token){
    if($('auth-summary')){ $('auth-summary').textContent=' · 验证中…'; }
    setCollapsed('sec-auth',true);
    if($('auth-msg')){ setMsg('auth-msg','已从本机读取令牌，正在验证…'); }
    await verifyToken(true);
  }else{
    setAuthenticated(false);
    setCollapsed('sec-auth',false);
  }
  if(state.page==='home'){
    setInterval(function(){ if(state.verified){ loadRuns().catch(function(e){ recordError('运行记录',e); }); } },20000);
  }
}
function bindTokenEvents(){
  if($('save-token')){
    $('save-token').addEventListener('click',async function(){
      var t=$('token').value.trim();
      if(!t){ setMsg('auth-msg','请输入令牌（已保存的令牌不会回显，如需更换请直接粘贴新令牌）','bad'); return; }
      state.token=t; storeToken(t,$('remember-token').checked);
      var btn=$('save-token'); busy(btn,'验证中…'); setMsg('auth-msg','验证中…');
      await verifyToken(false); unbusy(btn);
    });
  }
  if($('clear-token')){
    $('clear-token').addEventListener('click',function(){
      if(!confirm('确定清除本机保存的令牌吗？清除后需要重新输入才能操作。')) return;
      wipeToken(); state.token=''; state.persist=false;
      if($('token')){ $('token').value=''; $('token').placeholder='github_pat_…'; }
      if($('remember-token')){ $('remember-token').checked=false; }
      setAuthenticated(false);
      if($('auth-summary')){ $('auth-summary').textContent=' · 未设置'; }
      setMsg('auth-msg','已清除本机保存的令牌','warn');
      setCollapsed('sec-auth',false);
      toast('令牌已清除','warn');
    });
  }
}

/* ========== 操作台初始化 ========== */
async function initHome(){
  state.page='home'; initCommon();
  registerCollapsible('sec-runs',{openText:'收起',closedText:'展开'});
  initNav();
  if($('btn-dispatch')){ $('btn-dispatch').addEventListener('click',dispatch); }
  if($('btn-stop')){
    $('btn-stop').addEventListener('click',function(){
      if(state.runningRun){ cancelRun(state.runningRun.id,$('btn-stop')); }
      else{ setMsg('dispatch-msg','当前没有正在进行的推送','warn'); }
    });
  }
  if($('btn-refresh')){
    $('btn-refresh').addEventListener('click',function(){
      if(!state.verified){ setMsg('dispatch-msg','请先到「配置」页保存并验证令牌','bad'); return; }
      Promise.all([loadRuns(),loadSchedule()]).then(function(){ toast('状态已刷新','ok'); })
        .catch(function(e){ setMsg('dispatch-msg','刷新失败：'+e.message,'bad'); });
    });
  }
  if($('runs')){
    $('runs').addEventListener('click',function(e){
      var b=e.target.closest('[data-stop]');
      if(b){ cancelRun(parseInt(b.getAttribute('data-stop'),10),b); }
    });
  }
  if($('run-range')){
    $('run-range').addEventListener('change',function(){ state.range=$('run-range').value; renderRuns(); });
  }
  if($('runs-refresh')){
    $('runs-refresh').addEventListener('click',function(){
      if(!state.verified){ toast('请先到「配置」页验证令牌','warn'); return; }
      loadRuns().catch(function(e){ toast('刷新失败：'+e.message,'bad'); });
    });
  }
  if($('runs')){
    $('runs').innerHTML='<li style="border:0;display:block;"><div class="skeleton"></div><div class="skeleton" style="width:75%;"></div><div class="skeleton" style="width:50%;"></div></li>';
  }
  await bootstrapAuth();
}

/* ========== 配置页初始化 ========== */
async function initSettings(){
  state.page='settings'; initCommon();
  registerCollapsible('sec-auth',{openText:'收起',closedText:'管理'});
  bindTokenEvents();
  if($('btn-auto')){ $('btn-auto').addEventListener('click',toggleAuto); }
  if($('btn-enable-workflow')){ $('btn-enable-workflow').addEventListener('click',enableWorkflow); }
  if($('save-email')){
    $('save-email').addEventListener('click',async function(){
      if(!state.verified){ setMsg('email-msg','请先在上方「1 · 访问令牌」保存并验证令牌','bad'); return; }
      var v=$('new-email').value.trim();
      if(!v||v.indexOf('@')<1){ setMsg('email-msg','请输入有效邮箱','bad'); return; }
      var btn=$('save-email'); busy(btn,'保存中…');
      try{
        await putVar('TO',v);
        setMsg('email-msg','已保存 ✓ 之后每次推送将发送到 '+v,'ok');
        toast('收件邮箱已更新','ok');
        $('new-email').value=''; await loadEmail();
      }catch(e){ setMsg('email-msg','保存失败：'+e.message,'bad'); }
      unbusy(btn);
    });
  }
  if($('save-title')){
    $('save-title').addEventListener('click',async function(){
      if(!state.verified){ setMsg('title-msg','请先在上方「1 · 访问令牌」保存并验证令牌','bad'); return; }
      var v=$('new-title').value.trim(), btn=$('save-title'); busy(btn,'保存中…');
      try{
        if(v){ await putVar('BOOK_TITLE',v); setMsg('title-msg','已保存 ✓ 下一次推送书名为《'+v+'》','ok'); }
        else{ await delVar('BOOK_TITLE'); setMsg('title-msg','已清除自定义书名，下一次推送恢复默认','ok'); }
        toast('书名已更新','ok');
        $('new-title').value=''; await loadTitle();
      }catch(e){ setMsg('title-msg','保存失败：'+e.message,'bad'); }
      unbusy(btn);
    });
  }
  if($('save-sched')){ $('save-sched').addEventListener('click',saveSchedule); }
  if($('add-feed')){ $('add-feed').addEventListener('click',function(){ if($('feed-rows')) $('feed-rows').appendChild(feedRow('','')); }); }
  if($('save-feeds')){ $('save-feeds').addEventListener('click',saveFeeds); }
  if($('reset-feeds')){ $('reset-feeds').addEventListener('click',resetFeeds); }
  if($('save-alert')){ $('save-alert').addEventListener('click',saveAlertCfg); }
  if($('send-test-alert')){ $('send-test-alert').addEventListener('click',testAlert); }
  await bootstrapAuth();
}

return {
  initHome:initHome, initSettings:initSettings, state:state,
  _test:{parseScheduleState:parseScheduleState,toggleScheduleBlock:toggleScheduleBlock,
    parseCron:parseCron,buildCron:buildCron,renderSchedule:renderSchedule,
    renderRuns:renderRuns,setAuthenticated:setAuthenticated,loadSchedule:loadSchedule,
    renderWorkflowState:renderWorkflowState,loadWorkflowState:loadWorkflowState,
    renderAlerts:renderAlerts,recordError:recordError,loadAlertCfg:loadAlertCfg,renderAlertCfg:renderAlertCfg}
};
})();
