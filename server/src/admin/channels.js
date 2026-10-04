/* Channel workspace: credentials above, only the selected channel's models below. */
let CH_SELECTED='', CH_MODEL_FILTER='all', CH_QUERY='';
const CH_SELECTED_MODELS=new Map();
const CH_PARAM_DRAFTS=new Map();
const CH_ROUTE_DRAFTS=new Map(),CH_SHARE_BUSY=new Set();
function chShareFields(m){
  const groups=AGROUPS?.items||[],scope=m.shareScope||'all';
  return `<div style="display:flex;align-items:center;flex-wrap:wrap;gap:10px;margin-left:14px" role="group" aria-label="开放范围"><span class="mut">开放范围</span>${groups.map(g=>`<label style="display:flex;align-items:center;gap:4px"><input type="checkbox" ${CH_SHARE_BUSY.has(m.id)?'disabled':''} ${scope==='all'||scope==='select'&&(m.shareGroupIds||[]).includes(g.id)?'checked':''} onchange="chShareGroup(${esc(JSON.stringify(m.id))},${esc(JSON.stringify(g.id))},this.checked)"/>${esc(g.name)}</label>`).join('')||'<span class="faint">暂无分组</span>'}</div>`;
}
async function chShareGroup(id,gid,on){
  if(CH_SHARE_BUSY.has(id))return;
  CH_SHARE_BUSY.add(id);SHARE_GROUPS=AGROUPS?.items||[];
  const m=(window.__models||[]).find(m=>m.id===id);if(!m){CH_SHARE_BUSY.delete(id);return;}
  const groups=SHARE_GROUPS.map(g=>g.id),selected=new Set((m.shareScope||'all')==='all'?groups:m.shareScope==='select'?m.shareGroupIds||[]:[]);
  if(on)selected.add(gid);else selected.delete(gid);
  renderChannelModels();
  try{await shareSave(id,{shareScope:selected.size===0?'none':groups.every(g=>selected.has(g))?'all':'select',shareGroupIds:[...selected],shareAgentIds:[]});}
  finally{CH_SHARE_BUSY.delete(id);renderChannelModels();}
}
function chRouteDraft(id){
  const model=(window.__models||[]).find(m=>m.id===id),base=JSON.stringify(model?.routes||[]);
  let d=CH_ROUTE_DRAFTS.get(id);
  if(!d||!d.saving&&JSON.stringify(d.routes)===d.base&&base!==d.base){d={base,routes:resolutionRouteDefaults(model,JSON.parse(base)),saving:false};CH_ROUTE_DRAFTS.set(id,d);}
  return d;
}
function chRenderRoutes(id){
  const host=document.getElementById('channel-route-editor');if(!host||host.dataset.modelId!==id)return;
  const d=chRouteDraft(id);
  host.innerHTML=`<fieldset ${d.saving?'disabled':''} style="border:0;padding:0;margin:0;min-width:0">${routeEditorHtml(id,d.routes,{reference:`chRouteDraft('${id}').routes`,redraw:`chRenderRoutes('${id}')`,save:`chSaveRoutes('${id}')`,price:'chRoutePerUnitChanged'})}</fieldset>`;
}
function chRoutePerUnitChanged(id,i,value){
  const r=chRouteDraft(id).routes[i],m=(window.__models||[]).find(m=>m.id===id);if(!r)return;
  r.costPerUnit=value===''?undefined:Number(value);
  if(value!==''&&m?.costField)r.cost=Math.round(Number(value)*maxDurOf(m));chRenderRoutes(id);
}
async function chSaveRoutes(id){
  const d=chRouteDraft(id);if(d.saving)return;
  if(d.routes.some(r=>!r.upstreamModel?.trim())){toast('请填写每条规则的上游模型名','bad');return;}
  const m=(window.__models||[]).find(m=>m.id===id);
  const routes=d.routes.map(r=>({...r,when:r.when||{},upstreamModel:r.upstreamModel.trim(),...(r.cost==null&&r.costPerUnit!=null&&m?.costField?{cost:Math.round(r.costPerUnit*maxDurOf(m))}:{})}));
  d.saving=true;chRenderRoutes(id);
  try{await api('/admin-api/models/'+encodeURIComponent(id),{method:'PUT',body:JSON.stringify({routes})});if(m)m.routes=routes;d.base=JSON.stringify(routes);d.routes=JSON.parse(d.base);toast('重定向已保存');}
  catch(e){toast(e.message,'bad');}
  finally{d.saving=false;chRenderRoutes(id);}
}
function chLocation(){
  if(!location.hash.startsWith('#channels/'))return {};
  try{const parts=location.hash.slice(10).split('/');return {channel:decodeURIComponent(parts[0]),model:parts[1]==='model'&&parts[2]?decodeURIComponent(parts[2]):undefined};}catch{return {};}
}
function chModelUrl(id){return '#channels/'+encodeURIComponent(CH_SELECTED)+(id?'/model/'+encodeURIComponent(id):'');}
function chModelPage(id){
  if(!chFilteredModels().some(m=>m.id===id))return;
  CH_SELECTED_MODELS.set(CH_SELECTED,id);history.pushState(null,'',chModelUrl(id));renderChannelModels();
}

async function loadChannels(){
  const el=document.getElementById('tab-channels');
  el.innerHTML='<p class="mut">读取渠道与模型…</p>';
  try {
    const [channels,models]=await Promise.all([api('/admin-api/channels'),api('/admin-api/models'),refreshModelRoutingState()]);
    CHANNELS=channels.items;window.__models=models.items;
    await Promise.all([ensureFams(true),fetchProtocols(),ensureScopeAgents()]);
    try{AGROUPS=await api('/admin-api/agent-groups');}catch{}
    const route=chLocation(),requested=route.channel??CH_SELECTED;
    if(route.channel&&route.model)CH_SELECTED_MODELS.set(route.channel,route.model);
    const available=id=>CHANNELS.some(c=>c.id===id)||id==='__unassigned';
    CH_SELECTED=available(requested)?requested:available(CH_SELECTED)?CH_SELECTED:CHANNELS[0]?.id||'__unassigned';
    document.getElementById('cnt-channels').textContent=CHANNELS.length;
    renderChannelCards();
  }catch(e){el.textContent=e.message;}
}
function chPage(id){CH_SELECTED=id;CH_QUERY='';CH_MODEL_FILTER='all';MF_DRAFT.ch=false;history.pushState(null,'','#channels/'+encodeURIComponent(id));renderChannelCards();}
window.addEventListener('popstate',()=>{if(location.hash.startsWith('#channels/')){const route=chLocation();CH_SELECTED=route.channel||'';if(route.model)CH_SELECTED_MODELS.set(CH_SELECTED,route.model);CH_QUERY='';CH_MODEL_FILTER='all';if(CUR_TAB==='channels')loadChannels();else switchTab('channels');}});
function renderChannelNav(){
  const el=document.getElementById('channel-nav');if(!el)return;
  const current=CHANNELS.find(c=>c.id===CH_SELECTED);
  if(current){document.getElementById('pageTitle').textContent='渠道管理 · '+current.name;const heading=document.getElementById('channel-current-name');if(heading)heading.textContent=current.name;}
  el.innerHTML=CHANNELS.map(c=>`<button ${CH_SELECTED===c.id?'class="pri" aria-current="page"':''} onclick="chPage('${esc(c.id)}')">${esc(c.name)} <span class="faint">${(window.__models||[]).filter(m=>m.channelId===c.id).length}${c.enabled?'':' · 停用'}</span></button>`).join('')+
    ((window.__models||[]).some(m=>!m.channelId)||!CHANNELS.length?`<button ${CH_SELECTED==='__unassigned'?'class="pri" aria-current="page"':''} onclick="chPage('__unassigned')">默认网关</button>`:'');
}
function chNewChannelButton(){
  return `<button class="pri" onclick="openDraft('ch')">＋ 新增渠道</button>`;
}
function renderChannelCards(){
  if(CUR_TAB!=='channels')return;
  const el=document.getElementById('tab-channels'),c=CHANNELS.find(c=>c.id===CH_SELECTED);
  document.getElementById('pageTitle').textContent='渠道管理 · '+(c?.name||'默认网关');
  el.innerHTML=`<div class="toolbar">${chNewChannelButton()}</div><nav id="channel-nav" aria-label="渠道分页" class="toolbar page-sticky"></nav>
    ${MF_DRAFT.ch?`<div class="card"><div class="hd"><h3>新增渠道</h3></div><div class="bd">${draftCard('ch')}</div></div>`:''}
    ${c?chSettings(c):'<div class="card"><div class="bd">未指定渠道的模型使用默认网关或模型自身的连接设置。</div></div>'}
    <div class="toolbar"><h2 style="font-size:18px;margin:0">渠道模型与参数</h2><span class="sp"></span><input aria-label="搜索渠道模型" type="search" placeholder="搜索模型名称或 ID" value="${esc(CH_QUERY)}" oninput="CH_QUERY=this.value;renderChannelModels()"/></div>
    <nav id="channel-model-nav" aria-label="模型分页" class="toolbar"></nav><div id="channel-models"></div>`;
  renderChannelNav();renderChannelModels();
}
function chSettings(c){
  const field=(label,key,type='text',placeholder='')=>{
    const hiddenAddress=key==='baseUrl';
    const input=`<input aria-label="${label}" type="${hiddenAddress?'password':type}" value="${type==='password'?'':esc(c[key]||'')}" placeholder="${esc(placeholder)}" style="min-width:0;width:100%;box-sizing:border-box" ${hiddenAddress?'autocomplete="off" spellcheck="false"':''} onchange="updChannel('${esc(c.id)}','${key}',this.value)"/>`;
    return `<label class="fld" style="flex:${key==='note'?'1 1':'0 1'} 190px;min-width:0"><span>${label}</span>${hiddenAddress?`<span style="display:flex;align-items:center;gap:6px">${input}<button type="button" aria-label="显示上游地址" aria-pressed="false" title="显示上游地址" onclick="chToggleAddress(this)" style="flex:none;padding:6px"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg></button></span>`:input}</label>`;
  };
  const i=CHANNELS.findIndex(x=>x.id===c.id);
  return `<div class="card"><div class="hd"><h3 id="channel-current-name">${esc(c.name)}</h3><span class="badge ${c.enabled?'ok':'plain'}">${c.enabled?'已启用':'已停用'}</span><span class="sp"></span><label><input aria-label="渠道启用" type="checkbox" ${c.enabled?'checked':''} onchange="toggleChannelEnabled('${esc(c.id)}',this.checked)"/> 渠道启用</label><button ${i===0?'disabled':''} onclick="chMove(-1)">前移</button><button ${i===CHANNELS.length-1?'disabled':''} onclick="chMove(1)">后移</button><button class="danger" onclick="chDeleteCurrent()">删除渠道</button></div><div class="bd"><div class="fgrid" style="display:flex;flex-wrap:wrap">${field('渠道名称','name')}${field('上游地址','baseUrl','text','默认网关')}${field('渠道密钥','apiKey','password',c.apiKeySet?'已设置 · 留空不修改':'未设置 · 使用环境默认值')}${field('渠道备注','note')}</div></div></div>`;
}
function chDeleteCurrent(){const c=CHANNELS.find(c=>c.id===CH_SELECTED);if(c)delChannel(c.id,c.name);}
function chToggleAddress(button){
  const input=button.previousElementSibling,show=input.type==='password';
  input.type=show?'text':'password';
  button.setAttribute('aria-pressed',String(show));
  button.setAttribute('aria-label',show?'隐藏上游地址':'显示上游地址');
  button.title=show?'隐藏上游地址':'显示上游地址';
}
function chMove(offset){const ids=CHANNELS.map(c=>c.id),i=ids.indexOf(CH_SELECTED),j=i+offset;if(i<0||j<0||j>=ids.length)return;[ids[i],ids[j]]=[ids[j],ids[i]];saveChannelOrder(ids);}
function chFilteredModels(){
  const query=CH_QUERY.trim().toLowerCase();
  return (window.__models||[]).filter(m=>(CH_SELECTED==='__unassigned'?!m.channelId:m.channelId===CH_SELECTED)&&(!query||`${m.label} ${m.id}`.toLowerCase().includes(query))).sort((a,b)=>(a.order??Number.MAX_SAFE_INTEGER)-(b.order??Number.MAX_SAFE_INTEGER));
}
function renderChannelModelNav(models=chFilteredModels()){
  const nav=document.getElementById('channel-model-nav');if(!nav)return;
  nav.innerHTML=models.map(m=>`<button ${m.id===CH_SELECTED_MODELS.get(CH_SELECTED)?'class="pri" aria-current="page"':''} title="${esc(m.id)}" onclick="chModelPage(${esc(JSON.stringify(m.id))})">${esc(m.label)}</button>`).join('');
}
function renderChannelModels(){
  const el=document.getElementById('channel-models');if(!el||CUR_TAB!=='channels')return;
  const all=(window.__models||[]).filter(m=>CH_SELECTED==='__unassigned'?!m.channelId:m.channelId===CH_SELECTED);
  const models=chFilteredModels();
  const selected=models.find(m=>m.id===CH_SELECTED_MODELS.get(CH_SELECTED))??models[0];
  if(selected)CH_SELECTED_MODELS.set(CH_SELECTED,selected.id);
  else if(!all.some(m=>m.id===CH_SELECTED_MODELS.get(CH_SELECTED)))CH_SELECTED_MODELS.delete(CH_SELECTED);
  renderChannelModelNav(models);
  history.replaceState(null,'',chModelUrl(selected?.id));
  el.innerHTML=(selected?[selected]:[]).map(m=>`<article class="card" data-model-id="${esc(m.id)}"><div class="hd"><h3>${esc(m.label)}</h3>${chShareFields(m)}<span class="sp"></span></div><div class="bd">
    ${modelSettingsFields(m)}
    <h4 style="margin:18px 0 10px">模型参数</h4>
    <div id="channel-param-editor" data-model-id="${esc(m.id)}"></div>
    <h4 style="margin:18px 0 10px">重定向规则</h4><div id="channel-route-editor" data-model-id="${esc(m.id)}"></div>
    <div class="toolbar" style="margin:12px 0 0"><button onclick="cloneModelDlg(${esc(JSON.stringify(m.id))})">克隆模型</button><span class="sp"></span><button class="danger" onclick="delModel(${esc(JSON.stringify(m.id))})">删除模型</button></div></div></article>`).join('')||`<div class="card"><div class="bd mut">${all.length?'没有匹配的模型。':'该渠道暂无模型配置。'}</div></div>`;
  if(selected){chRenderParams(selected.id);chRenderRoutes(selected.id);}
}

function chUpdateModelHeading(id){
  const model=(window.__models||[]).find(m=>m.id===id);
  const card=[...document.querySelectorAll('#channel-models article')].find(el=>el.dataset.modelId===id);
  if(model&&card)card.querySelector('h3').textContent=model.label;
  renderChannelModelNav();
}

// Each model owns its draft; metadata saves and model navigation must not discard edits.
function chParamDraft(id){
  const model=(window.__models||[]).find(m=>m.id===id);
  const snapshot=JSON.stringify(model?.params||[]);
  let draft=CH_PARAM_DRAFTS.get(id);
  if(!draft||(!draft.saving&&JSON.stringify(draft.params)===draft.base&&snapshot!==draft.base)){
    draft={params:JSON.parse(snapshot),base:snapshot,saving:false};CH_PARAM_DRAFTS.set(id,draft);
  }
  return draft;
}
function chRenderParams(id){
  const host=document.getElementById('channel-param-editor');
  if(!host||host.dataset.modelId!==id)return;
  const draft=chParamDraft(id),arg=JSON.stringify(id);
  host.innerHTML=paramEditorHtml(id,draft.params,{reference:`chParamDraft(${arg}).params`,redraw:`chRenderParams(${arg})`,save:`chSaveParams(${arg})`,reset:`chResetParams(${arg})`,saving:draft.saving});
}
function chResetParams(id){
  if(chParamDraft(id).saving)return;
  CH_PARAM_DRAFTS.delete(id);chRenderParams(id);
}
async function chSaveParams(id){
  const draft=chParamDraft(id);if(draft.saving)return;
  const clean=cleanModelParams(draft.params);
  draft.saving=true;chRenderParams(id);
  try{
    await api('/admin-api/models/'+encodeURIComponent(id),{method:'PUT',body:JSON.stringify({params:clean})});
    const model=(window.__models||[]).find(m=>m.id===id);if(model)model.params=clean;
    const routeDraft=chRouteDraft(id);if(!routeDraft.saving)routeDraft.routes=resolutionRouteDefaults(model,routeDraft.routes);
    draft.base=JSON.stringify(clean);draft.params=JSON.parse(draft.base);
    toast('参数已保存');
  }catch(e){toast(e.message,'bad');}
  finally{draft.saving=false;renderChannelModels();}
}
