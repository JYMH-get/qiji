/* Channel workspace: credentials above, only the selected channel's models below. */
let CH_SELECTED='', CH_MODEL_FILTER='all', CH_QUERY='';
const CH_SELECTED_MODELS=new Map();
const CH_PARAM_DRAFTS=new Map();
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
    const [channels,models]=await Promise.all([api('/admin-api/channels'),api('/admin-api/models')]);
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
function renderChannelCards(){
  if(CUR_TAB!=='channels')return;
  const el=document.getElementById('tab-channels'),c=CHANNELS.find(c=>c.id===CH_SELECTED);
  document.getElementById('pageTitle').textContent='渠道管理 · '+(c?.name||'默认网关');
  el.innerHTML=`<div class="card"><div class="hd"><h3>渠道管理</h3><span class="sp"></span><button onclick="loadChannels()">重新加载</button><button class="pri" onclick="openDraft('ch')">＋ 新增渠道</button></div><div class="bd"><p class="mut">先选渠道，再选模型，下方查看和配置该模型的设置及参数。渠道连接设置修改后自动保存；密钥留空保持不变。用户线路在自动路由中配置。</p></div></div>
    <nav id="channel-nav" aria-label="渠道分页" class="toolbar"></nav>
    ${MF_DRAFT.ch?`<div class="card"><div class="hd"><h3>新增渠道</h3></div><div class="bd">${draftCard('ch')}</div></div>`:''}
    ${c?chSettings(c):'<div class="card"><div class="bd">未指定渠道的模型使用默认网关或模型自身的连接设置。</div></div>'}
    <div class="toolbar"><h2 style="font-size:18px;margin:0">渠道模型与参数</h2><span class="sp"></span><label>状态 <select aria-label="模型状态" onchange="CH_MODEL_FILTER=this.value;renderChannelModels()"><option value="all" ${CH_MODEL_FILTER==='all'?'selected':''}>全部</option><option value="on" ${CH_MODEL_FILTER==='on'?'selected':''}>已启用</option><option value="off" ${CH_MODEL_FILTER==='off'?'selected':''}>已禁用</option></select></label><input aria-label="搜索渠道模型" type="search" placeholder="搜索模型名称或 ID" value="${esc(CH_QUERY)}" oninput="CH_QUERY=this.value;renderChannelModels()"/><button onclick="chNewModel()">＋ 新增模型</button></div>
    <nav id="channel-model-nav" aria-label="模型分页" class="toolbar"></nav><div id="channel-models"></div>`;
  renderChannelNav();renderChannelModels();
}
function chSettings(c){
  const field=(label,key,type='text',placeholder='')=>`<label class="fld"><span>${label}</span><input aria-label="${label}" type="${type}" value="${type==='password'?'':esc(c[key]||'')}" placeholder="${esc(placeholder)}" onchange="updChannel('${esc(c.id)}','${key}',this.value)"/></label>`;
  const i=CHANNELS.findIndex(x=>x.id===c.id);
  return `<div class="card"><div class="hd"><h3 id="channel-current-name">${esc(c.name)}</h3><span class="badge ${c.enabled?'ok':'plain'}">${c.enabled?'已启用':'已停用'}</span><span class="sp"></span><label><input aria-label="渠道启用" type="checkbox" ${c.enabled?'checked':''} onchange="toggleChannelEnabled('${esc(c.id)}',this.checked)"/> 渠道启用</label><button ${i===0?'disabled':''} onclick="chMove(-1)">前移</button><button ${i===CHANNELS.length-1?'disabled':''} onclick="chMove(1)">后移</button><button class="danger" onclick="chDeleteCurrent()">删除渠道</button></div><div class="bd"><div class="fgrid">${field('渠道名称','name')}${field('上游地址','baseUrl','text','默认网关')}${field('渠道密钥','apiKey','password',c.apiKeySet?'已设置 · 留空不修改':'未设置 · 使用环境默认值')}${field('渠道备注','note')}</div></div></div>`;
}
function chDeleteCurrent(){const c=CHANNELS.find(c=>c.id===CH_SELECTED);if(c)delChannel(c.id,c.name);}
function chMove(offset){const ids=CHANNELS.map(c=>c.id),i=ids.indexOf(CH_SELECTED),j=i+offset;if(i<0||j<0||j>=ids.length)return;[ids[i],ids[j]]=[ids[j],ids[i]];saveChannelOrder(ids);}
async function chNewModel(){const channel=CH_SELECTED;await switchTab('models');document.getElementById('nm_channel').value=channel==='__unassigned'?'':channel;document.getElementById('nm_id').focus();}
function chFilteredModels(){
  const query=CH_QUERY.trim().toLowerCase();
  return (window.__models||[]).filter(m=>(CH_SELECTED==='__unassigned'?!m.channelId:m.channelId===CH_SELECTED)&&(CH_MODEL_FILTER==='all'||m.enabled===(CH_MODEL_FILTER==='on'))&&(!query||`${m.label} ${m.id}`.toLowerCase().includes(query))).sort((a,b)=>(a.order??Number.MAX_SAFE_INTEGER)-(b.order??Number.MAX_SAFE_INTEGER));
}
function renderChannelModelNav(models=chFilteredModels()){
  const nav=document.getElementById('channel-model-nav');if(!nav)return;
  nav.innerHTML=models.map(m=>`<button ${m.id===CH_SELECTED_MODELS.get(CH_SELECTED)?'class="pri" aria-current="page"':''} title="${esc(m.id)}" onclick="chModelPage(${esc(JSON.stringify(m.id))})">${esc(m.label)}${m.enabled?'':' · 禁用'}</button>`).join('');
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
  el.innerHTML=(selected?[selected]:[]).map(m=>`<article class="card" data-model-id="${esc(m.id)}"><div class="hd"><h3>${esc(m.label)}</h3><span class="badge ${m.enabled?'ok':'plain'}">${m.enabled?'启用':'禁用'}</span><span class="sp"></span></div><div class="bd">
    ${modelSettingsFields(m)}
    <h4 style="margin:18px 0 10px">模型参数</h4>
    <div id="channel-param-editor" data-model-id="${esc(m.id)}"></div>
    <div class="toolbar" style="margin:12px 0 0"><button onclick="editRoutes(${esc(JSON.stringify(m.id))})">重定向规则 ${(m.routes||[]).length}</button><button onclick="openShareMenu(${esc(JSON.stringify(m.id))},this)">开放范围</button><button onclick="cloneModelDlg(${esc(JSON.stringify(m.id))})">克隆模型</button><span class="sp"></span><button class="danger" onclick="delModel(${esc(JSON.stringify(m.id))})">删除模型</button></div></div></article>`).join('')||`<div class="card"><div class="bd mut">${all.length?'没有匹配的模型。':'该渠道暂无模型，可点击“新增模型”添加。'}</div></div>`;
  if(selected)chRenderParams(selected.id);
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
    draft.base=JSON.stringify(clean);draft.params=JSON.parse(draft.base);
    toast('参数已保存');
  }catch(e){toast(e.message,'bad');}
  finally{draft.saving=false;chRenderParams(id);}
}
