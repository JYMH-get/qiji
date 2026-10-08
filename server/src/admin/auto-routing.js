/* Loaded in the admin page's existing authenticated session. All drafts save atomically. */
let AR = null, AR_MODELS = [], AR_HEALTH = {}, AR_PREVIEWS = [], AR_AVAILABILITY = [], AR_FAMILIES = [], AR_BASE = null, AR_FAMILY = "";
const AR_PRICE_OPEN = new Set();
const AR_PANEL_OPEN = new Set();
let AR_DRAG = null;
let AR_SCROLL_OBSERVER = null;
function arSetupScroll() {
  AR_SCROLL_OBSERVER?.disconnect();
  const board = document.querySelector('#tab-routing .ar-board'), bar = document.querySelector('#tab-routing .ar-scroll-top');
  if (!board || !bar) return;
  const update = () => { bar.firstElementChild.style.width = board.scrollWidth + 'px'; bar.hidden = board.scrollWidth <= board.clientWidth + 1; bar.scrollLeft = board.scrollLeft; };
  bar.onscroll = () => { board.scrollLeft = bar.scrollLeft; };
  board.onscroll = () => { bar.scrollLeft = board.scrollLeft; };
  AR_SCROLL_OBSERVER = new ResizeObserver(update); AR_SCROLL_OBSERVER.observe(board); update();
}
function arSwitch(label, on, handler, extra = '') {
  return `<span class="ar-switch"><span>${label}</span><label class="sw"><input role="switch" aria-label="${label}" type="checkbox" ${on ? 'checked' : ''} ${extra} onchange="${handler}"/><i></i></label></span>`;
}
function arPanel(key, label, body) {
  return `<div id="${esc('ar-panel-' + key)}" class="ar-settings-panel" aria-label="${label}" ${AR_PANEL_OPEN.has(key) ? '' : 'hidden'}>${body}</div>`;
}
function arPanelButton(key, label) {
  return `<button aria-expanded="${AR_PANEL_OPEN.has(key)}" aria-controls="${esc('ar-panel-' + key)}" onclick="arTogglePanel(${esc(JSON.stringify(key))},this)">${label}</button>`;
}
function arTogglePanel(key, button) {
  const open = !AR_PANEL_OPEN.has(key); if (open) AR_PANEL_OPEN.add(key); else AR_PANEL_OPEN.delete(key);
  const panel = document.getElementById('ar-panel-' + key); if (panel) panel.hidden = !open;
  button.setAttribute('aria-expanded', String(open));
}
function arDragStart(event, lineId, modelId) { AR_DRAG = { lineId, modelId }; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', JSON.stringify(AR_DRAG)); }
function arDragEnd() { AR_DRAG = null; document.querySelectorAll('.ar-drop-active').forEach(el => el.classList.remove('ar-drop-active')); }
function arDrop(event, targetId) { event.preventDefault(); const drag = AR_DRAG; arDragEnd(); if (drag) arMoveMember(drag.lineId, drag.modelId, targetId); }
function arMoveMember(sourceId, modelId, targetId) {
  const source = AR.lines.find(l => l.id === sourceId), target = AR.lines.find(l => l.id === targetId);
  if (!source || !target || source === target) return;
  if (source.familyId !== target.familyId || source.capability !== target.capability) { toast('只能在同一家族的线路间移动', 'bad'); return; }
  const index = source.members.findIndex(m => m.modelId === modelId), model = AR_MODELS.find(m => m.id === modelId); if (index < 0 || !model) return;
  if (target.members.some(m => m.modelId === modelId || AR_MODELS.find(x => x.id === m.modelId)?.channelId === model.channelId)) { toast('目标线路已有该渠道，请先移除重复渠道', 'bad'); return; }
  target.members.push(source.members.splice(index, 1)[0]); arChanged(source.familyId); renderRouting();
}
function arReorderMember(lineId, modelId, offset) {
  const line = AR.lines.find(l => l.id === lineId); if (!line) return;
  const from = line.members.findIndex(m => m.modelId === modelId), to = from + offset;
  if (from < 0 || to < 0 || to >= line.members.length) return;
  [line.members[from], line.members[to]] = [line.members[to], line.members[from]];
  arChanged(line.familyId); renderRouting();
}
const arCapabilityGroup = cap => !cap ? cap : ['text', 'image', 'video', 'audio'].includes(cap) ? cap : 'other';
const AR_CAPS = [{ id: 'text', name: '文本' }, { id: 'image', name: '图片' }, { id: 'video', name: '视频' }, { id: 'audio', name: '音频' }, { id: 'other', name: '其他' }];
let AR_CAP = 'video';
// 新家族可在渠道页创建；已有未保存草稿时只合并新家族，不覆盖当前线路编辑或基准版本。
function arMergeNewFamilies(data) {
  const known = new Set(AR_FAMILIES.map(f => f.id));
  const added = data.families.filter(f => !known.has(f.id));
  AR_FAMILIES.push(...added);
  AR_MODELS = data.models;
  for (const family of added) {
    const lines = data.initial.lines.filter(l => l.familyId === family.id && !AR.lines.some(old => old.id === l.id));
    AR.lines.push(...structuredClone(lines));
    if (lines.some(l => !AR_BASE.lines.some(old => old.id === l.id))) arChanged(family.id);
  }
}
async function loadRouting() {
  const el = document.getElementById('tab-routing');
  if (AR && (AR_PENDING.size || AR_SAVING)) {
    try { arMergeNewFamilies(await api('/admin-api/auto-routing')); }
    catch (e) { toast('读取新增家族失败：' + e.message, 'bad'); }
    renderRouting(); return;
  }
  el.innerHTML = '<p class="mut">读取线路配置…</p>';
  try {
    const data = await api('/admin-api/auto-routing');
    AR = data.initial; AR_BASE = structuredClone(data.config); AR_FAMILIES = data.families;
    const requested = decodeURIComponent(location.hash.replace(/^#routing\//, ""));
    AR_FAMILY = AR_FAMILIES.some(f => f.id === requested) ? requested : AR_FAMILIES.some(f => f.id === AR_FAMILY) ? AR_FAMILY : AR_FAMILIES[0]?.id || "";
    AR_CAP = arCapabilityGroup(AR_FAMILIES.find(f => f.id === AR_FAMILY)?.capability) || AR_CAP;
    if (AR_CAPS.some(c => 'cap-' + c.id === requested)) { AR_CAP = requested.slice(4); AR_FAMILY = AR_FAMILIES.find(f => arCapabilityGroup(f.capability) === AR_CAP)?.id || ''; }
    AR_MODELS = data.models; AR_HEALTH = data.health; AR_PREVIEWS = data.previews; AR_AVAILABILITY = data.availability;
    renderRouting();
    for (const f of AR_FAMILIES) if (AR.lines.some(l => l.familyId === f.id && !AR_BASE.lines.some(b => b.id === l.id))) arChanged(f.id);
  } catch (e) { el.textContent = e.message; }
}
function arField(label, html) { return `<label class="fld"><span>${label}</span>${html}</label>`; }
function arNumber(label, value, handler, min = 0, max = 1000000) { return arField(label, `<input type="number" min="${min}" max="${max}" step="1" value="${value}" oninput="${handler}"/>`); }
function arModelOptions(line, current) {
  return AR_MODELS.filter(m => m.familyId === line.familyId).map(m => `<option value="${esc(m.id)}" ${m.id === current ? 'selected' : ''}>${esc(m.channelName || m.channelId)} · ${esc(m.label)}</option>`).join('');
}
function arPage(id) { AR_FAMILY = id; AR_CAP = arCapabilityGroup(AR_FAMILIES.find(f => f.id === id)?.capability) || AR_CAP; history.pushState(null, '', '#routing/' + encodeURIComponent(id)); renderRouting(); }
function arCapability(id) { AR_CAP = id; AR_FAMILY = AR_FAMILIES.find(f => arCapabilityGroup(f.capability) === id)?.id || ''; history.pushState(null, '', '#routing/' + encodeURIComponent(AR_FAMILY || 'cap-' + id)); renderRouting(); }
let AR_FAMILY_SYNC_ERROR = false;
async function arSyncClientFamilyOrder(){
  const routes=await api('/admin-api/auto-routing');
  const ids=[...new Set(routes.config.lines.map(l=>l.familyId))];
  let registry=(await api('/admin-api/families')).items;
  for(const id of ids){
    if(registry.some(f=>f.id===id))continue;
    const family=routes.families.find(f=>f.id===id);
    if(!family)throw Error('找不到家族：'+id);
    await api('/admin-api/families',{method:'POST',body:JSON.stringify({id,name:family.name,capability:family.capability})});
  }
  registry=(await api('/admin-api/families')).items;
  const positions=new Map(ids.map((id,index)=>[id,index]));
  const ordered=registry.filter(f=>positions.has(f.id)).sort((a,b)=>positions.get(a.id)-positions.get(b.id));
  let cursor=0;
  const desired=registry.map(f=>positions.has(f.id)?ordered[cursor++].id:f.id);
  if(desired.some((id,index)=>id!==registry[index].id))await api('/admin-api/families/reorder',{method:'POST',body:JSON.stringify({ids:desired})});
  FAMS=null;AR_FAMILY_SYNC_ERROR=false;
}
async function arRetryClientFamilyOrder(){
  if(AR_SAVING||AR_PENDING.size)return;
  AR_SAVING=true;
  try{await arSyncClientFamilyOrder();toast('客户端家族排序已同步');}
  catch(e){AR_FAMILY_SYNC_ERROR=true;toast('客户端排序同步失败：'+e.message,'bad');}
  finally{AR_SAVING=false;renderRouting();}
}
function arFamilyMoveButtons(families,family){
  const index=families.findIndex(f=>f.id===family.id);
  return `<button aria-label="家族前移" ${AR_SAVING||AR_PENDING.size||index<=0?'disabled':''} onclick="arMoveFamily(-1)">前移</button><button aria-label="家族后移" ${AR_SAVING||AR_PENDING.size||index<0||index>=families.length-1?'disabled':''} onclick="arMoveFamily(1)">后移</button>${AR_FAMILY_SYNC_ERROR?`<button ${AR_SAVING||AR_PENDING.size?'disabled':''} onclick="arRetryClientFamilyOrder()">重试同步客户端</button>`:''}`;
}
async function arMoveFamily(offset){
  if(AR_SAVING||AR_PENDING.size){toast('请先等待当前修改保存成功','bad');return;}
  const families=AR_FAMILIES.filter(f=>arCapabilityGroup(f.capability)===AR_CAP),index=families.findIndex(f=>f.id===AR_FAMILY),other=families[index+offset];
  if(index<0||!other||![-1,1].includes(offset))return;
  const first=offset<0?AR_FAMILY:other.id,second=offset<0?other.id:AR_FAMILY;
  const payload=structuredClone(AR_BASE),selected=payload.lines.filter(l=>l.familyId===first||l.familyId===second);
  if(!selected.some(l=>l.familyId===first)||!selected.some(l=>l.familyId===second)){toast('请先为这两个家族保存至少一条线路，再调整路由家族排序','bad');return;}
  const ordered=[...selected.filter(l=>l.familyId===first),...selected.filter(l=>l.familyId===second)];let cursor=0;
  payload.lines=payload.lines.map(l=>l.familyId===first||l.familyId===second?ordered[cursor++]:l);
  const panel=document.getElementById('tab-routing');AR_SAVING=true;panel.inert=true;arSaveStatus();
  try{
    const result=await api('/admin-api/auto-routing',{method:'PUT',body:JSON.stringify(payload)});
    AR_BASE=structuredClone(result.config);AR=structuredClone(result.config);MODES=null;
    const ids=[...new Set(AR.lines.map(l=>l.familyId))];
    AR_FAMILIES.sort((a,b)=>(ids.includes(a.id)?ids.indexOf(a.id):ids.length)-(ids.includes(b.id)?ids.indexOf(b.id):ids.length));
    try{await arSyncClientFamilyOrder();toast('家族排序已保存并同步客户端');}
    catch(e){AR_FAMILY_SYNC_ERROR=true;toast('管理端排序已保存，客户端同步失败，请点击重试同步客户端：'+e.message,'bad');}
  }catch(e){toast('排序未保存：'+e.message,'bad');}
  finally{AR_SAVING=false;panel.inert=false;renderRouting();arScheduleSave();}
}
function arDeleteFamily() {
  const family = AR_FAMILIES.find(f => f.id === AR_FAMILY); if (!family) return;
  if (AR_SAVING || AR_PENDING.size) { toast('请等待修改保存成功后再删除家族', 'bad'); return; }
  confirmDo({
    title: '删除家族 · ' + family.name, text: '删除该家族及其线路。模型配置保留，其他家族不受影响。', okLabel: '删除家族', onOk: async () => {
      if (AR_SAVING || AR_PENDING.size) { toast('配置正在修改，请保存后重试', 'bad'); return; }
      try { await api('/admin-api/auto-routing/families/' + encodeURIComponent(family.id), { method: 'DELETE', body: JSON.stringify({ version: AR_BASE.version }) }); FAMS = null; MODES = null; AR_FAMILY = ''; history.replaceState(null, '', '#routing/cap-' + AR_CAP); await loadRouting(); toast('家族已删除'); } catch (e) { toast(e.message, 'bad'); }
    }
  });
}
function arAddLine() {
  document.getElementById('dlgTitle').textContent = '新增线路';
  document.getElementById('dlgBody').innerHTML = `<div class="fgrid">${arField('所属家族', `<select id="ar-new-line-family">${AR_FAMILIES.map(f => `<option value="${esc(f.id)}" ${f.id === AR_FAMILY ? 'selected' : ''}>${esc(f.name)}</option>`).join('')}</select>`)}${arField('线路名称', `<input id="ar-new-line-name" type="text" maxlength="30" placeholder="例如：临时线路、周末优惠"/>`)}</div><p class="mut">新线路默认未开放，创建和后续修改均会自动保存。配置渠道和价格后可对用户开放。</p><p id="ar-create-error" role="status" class="bad-t"></p><div class="toolbar"><span class="sp"></span><button onclick="dlg.close()">取消</button><button class="pri" onclick="arCreateLine()">创建线路</button></div>`;
  dlg.classList.remove('wide'); dlg.showModal(); document.getElementById('ar-new-line-name').focus();
}
function arCreateLine() {
  const family = AR_FAMILIES.find(f => f.id === document.getElementById('ar-new-line-family').value), name = document.getElementById('ar-new-line-name').value.trim();
  if (!family || !name) { document.getElementById('ar-create-error').textContent = '请选择家族并填写线路名称'; return; }
  if (AR.lines.some(l => l.familyId === family.id && l.name === name)) { document.getElementById('ar-create-error').textContent = '该家族已有同名线路，请使用其他名称'; return; }
  const bytes = crypto.getRandomValues(new Uint8Array(16)), id = 'line-' + Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  AR.lines.push({ id, name, familyId: family.id, modelVersion: family.modelVersion, capability: family.capability, enabled: false, cost: 0, members: [] });
  arChanged(family.id); dlg.close(); arPage(family.id); document.querySelector('#tab-routing .card:last-child input[type="text"]')?.focus();
}
function arAddFamily() {
  document.getElementById('dlgTitle').textContent = '新增家族';
  const capability = AR_CAP === 'other' ? (AR_FAMILIES.find(f => f.id === AR_FAMILY)?.capability || 'image-enhance') : AR_CAP;
  document.getElementById('dlgBody').innerHTML = `<div class="fgrid">${arField('家族名称', '<input id="ar-new-family-name" type="text" maxlength="60" placeholder="例如：新模型家族"/>')}${arField('模型能力', `<select id="ar-new-family-cap">${adminCapabilityOptions(capability)}</select>`)}</div><p class="mut">创建后可为该家族添加线路。渠道模型的家族归属在“模型设置”中指定。</p><p id="ar-create-error" role="status" class="bad-t"></p><div class="toolbar"><span class="sp"></span><button onclick="dlg.close()">取消</button><button id="ar-family-submit" class="pri" onclick="arCreateFamily()">创建家族</button></div>`;
  dlg.classList.remove('wide'); dlg.showModal(); document.getElementById('ar-new-family-name').focus();
}
async function arCreateFamily() {
  const name = document.getElementById('ar-new-family-name').value.trim(), capability = document.getElementById('ar-new-family-cap').value, button = document.getElementById('ar-family-submit');
  if (!name) { document.getElementById('ar-create-error').textContent = '请填写家族名称'; return; }
  button.disabled = true;
  try {
    const created = await api('/admin-api/families', { method: 'POST', body: JSON.stringify({ name, capability }) });
    const family = created;
    FAMS = null;
    AR_FAMILIES.push({ id: family.id, name: family.name, capability: family.capability, modelVersion: family.id });
    if (arCapabilityGroup(family.capability) !== 'other') {
      for (const name of ['低价', '优惠', '稳定', '官方']) AR.lines.push({ id: 'line-' + crypto.randomUUID(), name, familyId: family.id, familyName: family.name, capability: family.capability, modelVersion: family.id, enabled: false, cost: 0, members: [] });
      arChanged(family.id);
    }
    dlg.close(); arPage(family.id); toast('家族已创建，可继续新增线路');
  } catch (e) { document.getElementById('ar-create-error').textContent = e.message; button.disabled = false; }
}
function arEnabled(i, j, enabled) { AR.lines[i].members[j].enabled = enabled; arChanged(AR.lines[i].familyId); renderRouting(); }
function arVipEnabled(i, j, enabled) { AR.lines[i].members[j].vipEnabled = enabled; arChanged(AR.lines[i].familyId); renderRouting(); }
function arGlobalEnabled(enabled) {
  AR.enabled = enabled; arChanged('__global');
  const note = document.getElementById('ar-global-note'); if (note) note.hidden = enabled;
}
window.addEventListener('popstate', () => { if (location.hash.startsWith('#routing/') && AR) { const id = decodeURIComponent(location.hash.slice(9)); AR_FAMILY = AR_FAMILIES.find(f => f.id === id)?.id || ''; AR_CAP = arCapabilityGroup(AR_FAMILIES.find(f => f.id === id)?.capability) || (id.startsWith('cap-') ? id.slice(4) : AR_CAP); if (CUR_TAB === 'routing') renderRouting(); else switchTab('routing'); } });
function renderRouting() {
  const families = AR_FAMILIES.filter(f => arCapabilityGroup(f.capability) === AR_CAP);
  const family = families.find(f => f.id === AR_FAMILY) ?? families[0];
  AR_FAMILY = family?.id || '';
  document.getElementById('pageTitle').textContent = '自动路由 · ' + (family?.name || AR_CAPS.find(c => c.id === AR_CAP)?.name || '');
  document.getElementById('tab-routing').innerHTML = `
    <style>
    .ar-scroll-top{overflow-x:auto;overflow-y:hidden;height:16px;margin-bottom:10px}.ar-scroll-top>div{height:1px}.ar-scroll-top[hidden]{display:none}
    .ar-board{display:grid;grid-auto-flow:column;grid-auto-columns:calc((100% - 36px)/4);gap:12px;overflow-x:auto;align-items:start;padding-bottom:16px;scrollbar-width:none}.ar-board::-webkit-scrollbar{display:none}
    .ar-board>.ar-line{min-width:0;margin:0;background:var(--panel2);border:1px solid var(--line2);border-radius:var(--r-md)}
    .ar-line>.hd{padding:12px 10px;gap:6px;flex-wrap:nowrap}.ar-line>.hd h3{font-size:14px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.ar-line>.hd>button{padding:6px 8px;flex-shrink:0;white-space:nowrap}.ar-line>.hd>.ar-switch{flex-shrink:0;gap:5px;white-space:nowrap}.ar-line>.hd>.badge{font-size:10px;padding:3px 6px;flex-shrink:0}.ar-line>.hd>.sp{min-width:0}.ar-line>.bd{padding:12px}.ar-line .fgrid{grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.ar-line .fld{min-width:0}.ar-line input,.ar-line select{max-width:100%;min-width:0}
    .ar-switch{display:inline-flex;align-items:center;gap:8px;font-size:12px}.ar-switch .sw{flex-shrink:0}
    .ar-settings-panel:not([hidden]){border-top:1px solid var(--line);padding-top:12px;margin-top:10px}.ar-settings-panel[hidden]{display:none}.ar-model-actions button:last-child{margin-left:auto}.ar-line details{border-top:1px solid var(--line);padding:10px 0}.ar-line summary{cursor:pointer;color:var(--mut);font-size:12px}.ar-line details .fgrid{margin-top:12px}
    .ar-price-summary{display:flex;flex-wrap:wrap;gap:6px 14px;color:var(--mut);font-size:11px;line-height:1.6}.ar-price-summary strong{color:var(--text);font-weight:600}.ar-price-summary>span{white-space:nowrap}.ar-model-list{display:flex;flex-direction:column;gap:10px;min-height:70px;margin:12px 0}
    .ar-model{padding:14px;background:var(--panel);border:1px solid var(--line2);border-radius:var(--r-md);min-width:0}
    .ar-model-head{display:flex;align-items:center;gap:8px;margin-bottom:12px}.ar-model-head h3{font-size:14px;margin:0;overflow-wrap:anywhere}.ar-model-head .mut{font-size:11px}.ar-model-name{flex:1;min-width:0}.ar-drag{cursor:grab;padding:4px 7px;touch-action:none}.ar-drag:active{cursor:grabbing}
    .ar-model-controls{display:flex;justify-content:space-between;gap:10px;margin-bottom:12px}.ar-model-stats{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:10px 0}.ar-model-stats>div{padding:8px 10px;background:var(--panel2);border:1px solid var(--line);border-radius:8px;color:var(--mut);font-size:11px}.ar-model-stats strong{display:block;color:var(--text);font-size:20px}.ar-model .sub{font-size:11px;margin:8px 0}.ar-model-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:10px}.ar-drop-active{outline:2px solid var(--acc);outline-offset:-2px}.ar-empty{padding:20px;text-align:center;color:var(--mut);border:1px dashed var(--line2);border-radius:8px;font-size:12px}
    </style>
    <div class="card"><div class="hd" style="flex-wrap:wrap"><h3>自动路由</h3>${arSwitch('启用自动路由', AR.enabled, 'arGlobalEnabled(this.checked)', 'id="ar-global-enabled"')}<span class="sp"></span><span id="ar-save-status" role="status" class="mut"></span><button id="ar-save-retry" onclick="arRetrySave()" style="display:none">重试保存</button><button onclick="arReloadRouting()">重新加载</button></div><p id="ar-global-note" class="mut" style="margin:12px 18px" ${AR.enabled ? 'hidden' : ''}>关闭保存成功后，请在客户端刷新模型目录，选择原渠道模型测试。</p><p id="ar-message" role="status" class="bad-t" style="display:none;margin:12px 18px"></p></div>
    <nav aria-label="生成类型" class="toolbar">${AR_CAPS.map(c => `<button ${c.id === AR_CAP ? 'class="pri" aria-current="page"' : ''} onclick="arCapability('${c.id}')">${c.name}</button>`).join('')}</nav>
    <nav aria-label="路由家族" class="toolbar" style="flex-wrap:wrap">${families.map(f => `<button ${f.id === family?.id ? 'class="pri" aria-current="page"' : ''} onclick="arPage('${esc(f.id)}')">${esc(f.name)}</button>`).join('')}${AR_CAPS.some(c => c.id === AR_CAP) ? '<button onclick="arAddFamily()">＋ 新增家族</button>' : ''}${family ? '<button class="pri" onclick="arAddLine()">＋ 新增线路</button>' : ''}</nav>
    ${family ? `<div class="toolbar" style="margin:12px 0"><h2 style="font-size:18px">${esc(family.name)}</h2><span class="sp"></span>${arFamilyMoveButtons(families,family)}<button onclick="arDeleteFamily()">删除家族</button></div><div class="ar-scroll-top" tabindex="0" aria-label="线路横向滚动"><div></div></div><div class="ar-board">${AR.lines.map((l, i) => l.familyId === family.id ? arLine(l, i) : '').join('')}</div>${AR.lines.some(l => l.familyId === family.id) ? '' : '<div class="card"><div class="bd mut">该家族暂无线路，请点击上方“＋ 新增线路”创建。</div></div>'}` : '<div class="card"><div class="bd mut">暂无可配置的路由家族</div></div>'}`;
  arSaveStatus(); arSetupScroll();
}
function arPriceSummary(l) {
  const ref = l.refVideoSecondsWeight > 0 ? `<span>输入视频 <strong>×${esc(l.refVideoSecondsWeight)}</strong></span>` : '';
  const money = n => n.toLocaleString('en-US', { maximumFractionDigits: 4, useGrouping: false });
  const item = (label, values, unit, currency = '积分') => {
    const valid = values.filter(n => Number.isFinite(n) && n >= 0); if (!valid.length) return '';
    const low = Math.min(...valid), high = Math.max(...valid);
    return `<span>${esc(label)} <strong>${money(low)}${Math.abs(high - low) > 1e-8 ? '–' + money(high) : ''}${currency}/${unit}</strong></span>`;
  };
  if (l.tokenPricing?.enabled) {
    const p = l.tokenPricing, multiplier = p.multiplier ?? 1;
    const rates = (label,r) => item(label+'输入',[r.input*multiplier],'百万token','元') + item(label+'输出',[r.output*multiplier],'百万token','元') + (p.cacheEnabled ? item(label+'缓存输入',[r.cachedInput*multiplier],'百万token','元') : '');
    return rates(p.peak?.enabled || p.longContext?.enabled ? '普通' : '',p.rates)
      + (p.peak?.enabled ? rates('高峰',p.peak.rates) : '')
      + (p.longContext?.enabled ? rates('长上下文',p.longContext.rates) : '')
      + (p.peak?.enabled && p.longContext?.enabled ? rates('长上下文高峰',p.longContext.peakRates) : '');
  }
  if (l.capability === 'text') {
    const raw = l.cost * (l.tokenPricing?.multiplier ?? 1);
    return item('统一价格',[Math.ceil(raw - Number.EPSILON*Math.max(1,raw)*4)/100],'次','元');
  }
  if (l.prices?.length) {
    const groups = new Map();
    for (const p of l.prices) {
      const duration = Number(p.when.duration), perSecond = (!l.capability || l.capability === 'video') && duration > 0;
      const label = p.when.resolution || '统一价格', unit = perSecond ? '秒' : '次', key = label + '/' + unit;
      const group = groups.get(key) || { label, unit, values: [] }; group.values.push(p.cost / (perSecond ? duration : 1)); groups.set(key, group);
    }
    return [...groups.values()].sort((a, b) => (parseFloat(a.label) || 0) - (parseFloat(b.label) || 0)).map(g => item(g.label, g.values, g.unit)).join('') + ref;
  }
  const resolutions = AR_PREVIEWS.find(p => p.id === l.id)?.model?.params?.find(p => p.key === 'resolution')?.options || [];
  return (resolutions.length ? resolutions : ['统一价格']).map(label => item(label, [l.costPerUnit ?? l.cost], l.costPerUnit !== undefined ? '秒' : '次')).join('') + ref;
}
function arLine(l, i) {
  const preview = AR_PREVIEWS.find(p => p.id === l.id)?.model;
  const hasEnabledMember = l.members.some(r => r.enabled && r.concurrencyWeight > 0);
  return `<div class="card ar-line" ondragover="if(AR_DRAG){event.preventDefault();event.dataTransfer.dropEffect='move';this.classList.add('ar-drop-active')}" ondragleave="if(!this.contains(event.relatedTarget))this.classList.remove('ar-drop-active')" ondrop="arDrop(event,${esc(JSON.stringify(l.id))})" data-ar-family="${esc(l.familyId)}" data-ar-line="${esc(l.id)}"><div class="hd"><h3 data-ar-title>${esc(l.name.endsWith('线路') ? l.name : l.name + '线路')}</h3><span data-ar-open class="badge ${l.enabled && hasEnabledMember ? 'ok' : 'plain'}">${!l.enabled ? '未开放' : hasEnabledMember ? '开放' : '暂无启用渠道'}</span><span class="sp"></span>

    ${arSwitch('对用户开放', l.enabled, `AR.lines[${i}].enabled=this.checked`)}${arPanelButton(l.id + '/settings', '设置')}<button onclick="arDeleteLine(${esc(JSON.stringify(l.id))})">删除</button></div>
    <div class="bd"><div class="ar-price-summary" data-ar-price-summary>${arPriceSummary(l)}</div>${arPanel(l.id + '/settings', '线路设置', `<div class="fgrid">
      ${arField('线路名称', `<input type="text" value="${esc(l.name)}" maxlength="30" oninput="AR.lines[${i}].name=this.value"/>`)}
      ${arField('统一计费方式', `<select onchange="arBilling(${i},this.value)">${(!l.capability || ['video', 'image'].includes(l.capability)) ? `<option value="tiers" ${l.prices ? 'selected' : ''}>${l.capability === 'image' ? '按分辨率规格' : '自定义档位价（时长 × 分辨率）'}</option>` : ''}${l.capability === 'text' ? `<option value="tokens" ${l.tokenPricing?.enabled ? 'selected' : ''}>按 token</option>` : ''}<option value="fixed" ${!l.prices && !l.tokenPricing?.enabled && l.costPerUnit === undefined ? 'selected' : ''}>按次</option>${(!l.capability || l.capability === 'video') ? `<option value="second" ${l.costPerUnit !== undefined ? 'selected' : ''}>按秒</option>` : ''}</select>`)}
      ${l.tokenPricing?.enabled ? arTokenFields(l, i) : l.prices ? `<div class="fld"><span>价格填充</span><button onclick="arHighest(${i})">${l.members.filter(r => r.enabled && r.concurrencyWeight > 0).length === 1 ? '按当前模型价格填充' : '按候选渠道最高价填充'}</button></div><div class="fld"><span aria-hidden="true">&nbsp;</span><button onclick="arCustomPrices(${i})">补齐当前档位</button></div>` : arNumber(l.costPerUnit === undefined ? '统一价格（积分/次）' : '统一价格（积分/秒）', l.costPerUnit ?? l.cost, `arPrice(${i},Number(this.value))`)}
    </div>
    ${(!l.capability || l.capability === 'video') && (l.prices || l.costPerUnit !== undefined) ? `<div class="fld"><span>输入视频折算系数</span><input type="number" aria-label="输入视频折算系数" min="0" max="100" step="0.1" value="${l.refVideoSecondsWeight ?? 0}" oninput="AR.lines[${i}].refVideoSecondsWeight=Number(this.value)"/><p class="faint">0 不收输入视频费用；1 与输出每秒同价。输入视频逐条向上取整后合计，乘以系数计费；档位价按输出时长折算每秒价格。</p></div>` : ''}
    ${l.prices ? arPriceTable(l, i) : ''}
    <p class="faint" data-ar-preview>${preview ? preview.params.map(p => esc(p.label) + ': ' + (p.options || []).map(esc).join(' / ')).join('　｜　') + (preview.methods?.length ? '　｜　方法: ' + preview.methods.map(esc).join(' / ') : '') : '保存后显示可用参数；无候选渠道的线路保持未开放。'}</p>
    `)}
    <div class="ar-model-list">${l.members.map((r, j) => arMember(l, i, r, j)).join('') || '<div class="ar-empty">拖动模型到此线路，或添加渠道</div>'}</div>
    <button onclick="arAdd(${i})">＋ 添加渠道</button>
    </div></div>`;
}
function arMember(l, i, r, j) {
  const model = AR_MODELS.find(m => m.id === r.modelId), h = AR_HEALTH[l.id + '/' + model?.channelId];
  const live = AR_AVAILABILITY.find(x => x.lineId === l.id && x.modelId === r.modelId);
  const seconds = Math.max(0, Math.ceil(((live?.penaltyUntil || 0) - Date.now()) / 1000));
  const first = l.members.findIndex(m => m.enabled && m.concurrencyWeight > 0) === j;
  const policy = model?.materialPolicy, requestLabel = model?.capability === 'image' ? (model.imageMaterialMode === 'direct' ? '直传' : model.imageMaterialMode === 'url' ? '普通 URL' : '未配置') : policy?.kind === 'official-assets' ? ({ sd: '官方1 · sd 素材库', me: '官方2 · me 素材库', we: '官方3 · we 素材库' }[policy.library] || '官方素材库') : policy?.kind === 'nyxen' ? '加速桶' : '普通 URL';
  const number = (key, min, max) => `<input style="width:100%" type="number" min="${min}" max="${max}" step="${key === 'concurrencyWeight' ? 0.01 : 1}" aria-label="${key}" value="${r[key]}" oninput="AR.lines[${i}].members[${j}].${key}=Number(this.value)"/>`;
  return `<article class="ar-model" data-ar-model="${esc(r.modelId)}">
   <header class="ar-model-head"><button class="ar-drag" draggable="true" aria-label="拖动 ${esc(model?.label || r.modelId)}" title="拖动到其他线路" ondragstart="arDragStart(event,${esc(JSON.stringify(l.id))},${esc(JSON.stringify(r.modelId))})" ondragend="arDragEnd()">⠿</button><div class="ar-model-name"><h3>${esc(model?.label || r.modelId)}</h3><div class="mut">${esc(model?.channelName || model?.channelId || '')}</div></div><span class="badge ${!r.enabled ? 'plain' : seconds ? 'run' : 'ok'}">${!r.enabled ? '已禁用' : live?.status === 'disabled' ? '未参与' : seconds ? '降频中' : '正常'}</span></header>
   <div class="ar-model-controls">${arSwitch('渠道启用', r.enabled, `arEnabled(${i},${j},this.checked)`)}${arSwitch('VIP用户（预留）', r.vipEnabled, `arVipEnabled(${i},${j},this.checked)`)}</div>
   <div class="ar-model-stats"><div>当前在途<strong>${live?.active || 0}</strong></div><div>并发权重<strong>${r.concurrencyWeight}</strong></div></div>
   <div class="sub">优先级 ${r.priority} · 成功 ${h?.succeeded || 0} · 渠道失败 ${h?.failed || 0}${seconds ? ' · 剩余 ' + seconds + ' 秒' : ''}</div>
   <div class="sub">${model?.capability === 'image' ? '上游素材请求方式：' : first ? '首位请求方式：' : ''}${esc(requestLabel)}</div>
   <div class="ar-model-actions"><button ${j === 0 ? 'disabled' : ''} onclick="arReorderMember(${esc(JSON.stringify(l.id))},${esc(JSON.stringify(r.modelId))},-1)">前移</button><button ${j === l.members.length - 1 ? 'disabled' : ''} onclick="arReorderMember(${esc(JSON.stringify(l.id))},${esc(JSON.stringify(r.modelId))},1)">后移</button></div>
   <div class="ar-model-actions"><button onclick="arReset(${i},${j})">恢复路由</button><button onclick="arRemove(${i},${j})">移除</button>${arPanelButton(l.id + '/' + r.modelId + '/advanced', '调度设置')}</div>
   ${arPanel(l.id + '/' + r.modelId + '/advanced', '调度设置', `<div class="fgrid">${arField('渠道模型', `<select aria-label="渠道模型" onchange="arChoose(${i},${j},this.value)">${arModelOptions(l, r.modelId)}</select>`)}${arField('优先级', number('priority', 0, 1000))}${arField('并发权重', number('concurrencyWeight', 0, 100))}${arField('失败次数阈值', number('failureThreshold', 1, 1000))}${arField('统计窗口（秒）', number('failureWindowSec', 1, 86400))}${arField('处罚时长（秒）', number('cooldownSec', 1, 86400))}${arField('故障保留并发（%）', number('failureRetainPercent', 0, 100))}</div>`)}
  </article>`;
}
function arChoose(i, j, id) { AR.lines[i].members[j].modelId = id; AR.lines[i].members[j].defaults = {}; arChanged(AR.lines[i].familyId); renderRouting(); }
function arAdd(i) {
  const l = AR.lines[i], used = new Set(l.members.map(r => AR_MODELS.find(m => m.id === r.modelId)?.channelId));
  const m = AR_MODELS.find(m => m.familyId === l.familyId && !used.has(m.channelId));
  if (!m) { toast('没有可添加的同家族渠道', 'bad'); return; }
  l.members.push({ modelId: m.id, enabled: false, vipEnabled: false, priority: 0, concurrencyWeight: 1, failureThreshold: 3, failureWindowSec: 300, cooldownSec: 300, failureRetainPercent: 50, defaults: {} }); arChanged(l.familyId); renderRouting();
}
function arBilling(i, kind) { const l = AR.lines[i]; if (kind === 'tokens') { l.tokenPricing = structuredClone(l.tokenPricing || { enabled: true, multiplier: 1, rates: { input: 0, output: 0, cachedInput: 0 }, cacheEnabled: false, peak: { enabled: false, rates: { input: 0, output: 0, cachedInput: 0 } }, longContext: { enabled: false, threshold: 128000, rates: { input: 0, output: 0, cachedInput: 0 }, peakRates: { input: 0, output: 0, cachedInput: 0 } } }); l.tokenPricing.enabled = true; delete l.costPerUnit; delete l.prices; arChanged(l.familyId); renderRouting(); return; } delete l.tokenPricing; if (kind === 'tiers') { arCustomPrices(i); return; } delete l.prices; if (kind === 'second') l.costPerUnit = l.cost; else { l.cost = l.costPerUnit ?? l.cost; delete l.costPerUnit; delete l.refVideoSecondsWeight; } arChanged(l.familyId); renderRouting(); }
function arTokenFields(l, i) {
  const p = l.tokenPricing;
  const rate = (path, title) => arField(title, `<input type="number" min="0" step="any" value="${path.split('.').reduce((v, k) => v[k], p) ?? (path === 'multiplier' ? 1 : 0)}" oninput="AR.lines[${i}].tokenPricing.${path}=Number(this.value)"/>`);
  const rates = (path) => ['input', 'output', 'cachedInput'].map((k, n) => rate(path + '.' + k, ['输入', '输出', '缓存输入'][n] + '（元/百万token）')).join('');
  return `${rates('rates')}${rate('multiplier', '倍率')}${arSwitch('缓存计价', p.cacheEnabled, `AR.lines[${i}].tokenPricing.cacheEnabled=this.checked`)}
 <div class="fld"><button onclick="arCopyTokenPrice(${i})">复制首个候选模型价格</button></div>
 <div style="grid-column:1/-1">${arPanel('token-' + l.id, '高级计价', `${arSwitch('高峰计价', p.peak.enabled, `AR.lines[${i}].tokenPricing.peak.enabled=this.checked`)}<div class="fgrid">${rates('peak.rates')}</div>${arSwitch('长上下文计价', p.longContext.enabled, `AR.lines[${i}].tokenPricing.longContext.enabled=this.checked`)}<div class="fgrid">${rate('longContext.threshold', '长上下文阈值')}${rates('longContext.rates')}${rates('longContext.peakRates')}</div>`)}${arPanelButton('token-' + l.id, '高级计价')}</div>`;
}
function arCopyTokenPrice(i) {
  const l = AR.lines[i], m = l.members.map(r => AR_MODELS.find(m => m.id === r.modelId)).find(m => m?.tokenPricing?.enabled);
  if (!m) { toast('候选模型尚未配置 token 价格', 'bad'); return; }
  l.tokenPricing = structuredClone(m.tokenPricing); arChanged(l.familyId); renderRouting();
}
function arCustomPrices(i) {
  const l = AR.lines[i], models = l.members.filter(r => r.enabled && r.concurrencyWeight > 0).map(r => AR_MODELS.find(m => m.id === r.modelId)).filter(Boolean);
  const accepts = (p, v) => p?.type === 'enum' ? p.options?.includes(String(v)) : p?.type === 'number' && Number(v) >= (p.min ?? -Infinity) && Number(v) <= (p.max ?? Infinity) && (!p.step || Math.abs((Number(v) - (p.min ?? 0)) / p.step - Math.round((Number(v) - (p.min ?? 0)) / p.step)) < 1e-7);
  const durations = Array.from({ length: 120 }, (_, k) => String(k + 1)).filter(v => models.length && models.some(m => accepts(m?.params.find(p => p.key === 'duration'), v)));
  const resolutions = [...new Set(models.flatMap(m => m.params.find(p => p.key === 'resolution')?.options || []))];
  if (l.capability === 'image') {
    const options = AR_PREVIEWS.find(p => p.id === l.id)?.model?.params?.find(p => p.key === 'resolution')?.options || resolutions;
    if (!options.length) { toast('请先启用具有可用参数的渠道模型', 'bad'); return; }
    const previous = l.prices || [];
    l.prices = [...previous, ...options.filter(resolution => !previous.some(p => p.when.resolution === resolution && Object.keys(p.when).length === 1)).map(resolution => ({ when: { resolution }, cost: l.cost }))];
    delete l.costPerUnit; arSyncFallback(l); arChanged(l.familyId); renderRouting(); return;
  }
  if (!durations.length || !resolutions.length) { toast('请先启用具有可用参数的渠道模型', 'bad'); renderRouting(); return; }
  const previous = l.prices || [];
  const generated = durations.flatMap(duration => resolutions.filter(resolution => models.some(m => accepts(m.params.find(p => p.key === 'duration'), duration) && accepts(m.params.find(p => p.key === 'resolution'), resolution))).map(resolution => ({ when: { duration, resolution }, cost: previous.find(p => Object.entries(p.when).every(([k, v]) => ({ duration, resolution })[k] === v))?.cost ?? (l.costPerUnit === undefined ? l.cost : Math.round(l.costPerUnit * Number(duration))) })));
  l.prices = [...previous, ...generated.filter(p => !previous.some(old => old.when.duration === p.when.duration && old.when.resolution === p.when.resolution))];
  delete l.costPerUnit; arSyncFallback(l); arChanged(l.familyId); renderRouting();
}
function arSyncFallback(l) { if (l.prices?.length) l.cost = Math.max(...l.prices.map(p => p.cost)); }
function arTierPrice(i, k, input) {
  const n = Number(input.value); if (input.value.trim() === '' || !Number.isFinite(n) || n < 0) { input.setCustomValidity('请输入非负价格'); return; }
  input.setCustomValidity(''); AR.lines[i].prices[k].cost = n; arSyncFallback(AR.lines[i]);
}
function arBulkPrice(i, column) {
  const l = AR.lines[i], resolution = [...new Set(l.prices.map(p => p.when.resolution))][column];
  const input = document.getElementById(`ar-rate-${i}-${column}`), unit = document.getElementById(`ar-rate-unit-${i}-${column}`).value, n = Number(input.value);
  if (input.value.trim() === '' || !Number.isFinite(n) || n < 0) { toast('请输入非负单价', 'bad'); return; }
  for (const p of l.prices) if (p.when.resolution === resolution) p.cost = unit === 'second' ? Math.round(n * Number(p.when.duration)) : n;
  arSyncFallback(l); arChanged(l.familyId); renderRouting();
}
function arPriceTable(l, i) {
  if (l.capability === 'image') return `<div class="tblwrap" style="margin-top:16px"><table><thead><tr><th>分辨率规格</th><th>价格（积分/次）</th></tr></thead><tbody>${l.prices.map((p, k) => `<tr><td>${esc(Object.entries(p.when).map(([key, value]) => key === 'resolution' ? value : key + '=' + value).join(' / '))}</td><td><input aria-label="${esc(l.name + ' ' + Object.values(p.when).join(' '))} 价格" type="number" min="0" step="any" value="${p.cost}" oninput="arTierPrice(${i},${k},this)"/></td></tr>`).join('')}</tbody></table></div>`;
  const durations = [...new Set(l.prices.map(p => p.when.duration))], resolutions = [...new Set(l.prices.map(p => p.when.resolution))];
  return `<details style="margin-top:16px" ${AR_PRICE_OPEN.has(l.id) ? 'open' : ''} ontoggle="if(!this.isConnected)return;if(this.open)AR_PRICE_OPEN.add(AR.lines[${i}].id);else AR_PRICE_OPEN.delete(AR.lines[${i}].id)"><summary style="cursor:pointer">自定义档位价格（${l.prices.length} 档，积分/次）</summary><p class="faint">直接修改每个格子的价格，修改后自动保存。也可按分辨率批量填入每秒或每次单价。</p>
    <div class="tblwrap"><table><thead><tr><th scope="col">时长</th>${resolutions.map(r => `<th scope="col">${esc(r)}</th>`).join('')}</tr>
    <tr><th scope="row">批量设置</th>${resolutions.map((r, k) => `<td><input id="ar-rate-${i}-${k}" aria-label="${esc(l.name + ' ' + r)} 批量单价" type="number" min="0" step="any" placeholder="输入单价" style="width:100px"/><select id="ar-rate-unit-${i}-${k}" aria-label="${esc(l.name + ' ' + r)} 单价单位"><option value="second">积分/秒</option><option value="fixed">积分/次</option></select><button onclick="arBulkPrice(${i},${k})">应用</button></td>`).join('')}</tr></thead>
    <tbody>${durations.map(d => `<tr><th scope="row">${esc(d)} 秒</th>${resolutions.map(r => { const k = l.prices.findIndex(p => p.when.duration === d && p.when.resolution === r); return k < 0 ? '<td>—</td>' : `<td><input aria-label="${esc(l.name + ' ' + d + '秒 ' + r)} 价格" type="number" min="0" step="any" value="${l.prices[k].cost}" style="width:110px" oninput="arTierPrice(${i},${k},this)"/></td>`; }).join('')}</tr>`).join('')}</tbody></table></div></details>`;
}
async function arHighest(i) { const line = AR.lines[i], snapshot = JSON.stringify(line); try { const prices = await api('/admin-api/auto-routing/prices', { method: 'POST', body: snapshot }); if (!AR.lines.includes(line)) return; if (JSON.stringify(line) !== snapshot) { toast('线路已修改，本次填充未覆盖新修改，请重试', 'bad'); return; } delete line.costPerUnit; delete line.prices; Object.assign(line, prices); arChanged(line.familyId); renderRouting(); } catch (e) { toast(e.message, 'bad'); } }
function arPrice(i, n) { const l = AR.lines[i]; if (l.costPerUnit === undefined) l.cost = n; else l.costPerUnit = n; }
// Debounce per family, serialize versioned writes, and keep newer edits during an in-flight save.
const AR_PENDING = new Map();
let AR_SAVE_TIMER = null, AR_SAVING = false, AR_REVISION = 0;
function arChanged(familyId) {
  AR_PENDING.set(familyId, { revision: ++AR_REVISION, readyAt: Date.now() + 800, error: '' });
  arSaveStatus(); arScheduleSave();
}
function arSaveStatus() {
  const errors = [...AR_PENDING].filter(([, s]) => s.error);
  const label = document.getElementById('ar-save-status'), message = document.getElementById('ar-message'), retry = document.getElementById('ar-save-retry');
  if (label) label.textContent = errors.length ? '保存失败' : AR_SAVING ? '保存中…' : AR_PENDING.size ? '等待自动保存…' : '已保存';
  if (retry) retry.style.display = errors.length ? '' : 'none';
  if (message) { message.style.display = errors.length ? '' : 'none'; message.textContent = errors.length ? errors.map(([id, s]) => (id === '__global' ? '线路总开关' : AR_FAMILIES.find(f => f.id === id)?.name || id) + '：' + s.error).join('；') + '。修改已保留，可修正后自动保存或点击重试。' : ''; }
}
function arScheduleSave() {
  clearTimeout(AR_SAVE_TIMER); if (AR_SAVING) return;
  const pending = [...AR_PENDING.values()].filter(s => !s.error);
  if (pending.length) AR_SAVE_TIMER = setTimeout(arFlushSave, Math.max(0, Math.min(...pending.map(s => s.readyAt)) - Date.now()));
}
async function arFlushSave() {
  if (AR_SAVING) return;
  const next = [...AR_PENDING].find(([, s]) => !s.error && s.readyAt <= Date.now());
  if (!next) { arScheduleSave(); return; }
  const [familyId, state] = next, revision = state.revision;
  const current = structuredClone(AR.lines.filter(l => l.familyId === familyId)), existing = new Set(AR_BASE.lines.map(l => l.id));
  const payload = structuredClone(AR_BASE);
  if (familyId === '__global') payload.enabled = AR.enabled;
  if (familyId !== '__global') { payload.defaultLineFamilyIds = [...new Set([...(AR_BASE.defaultLineFamilyIds || []), familyId])]; payload.lines = [...payload.lines.map(l => l.familyId === familyId ? current.find(c => c.id === l.id) : l).filter(Boolean), ...current.filter(l => !existing.has(l.id))]; }
  AR_SAVING = true; arSaveStatus();
  try {
    const result = await api('/admin-api/auto-routing', { method: 'PUT', body: JSON.stringify(payload) });
    AR_BASE = structuredClone(result.config); AR.version = AR_BASE.version; MODES = null;
    if (AR_PENDING.get(familyId)?.revision === revision) AR_PENDING.delete(familyId);
    // Refresh derived data without rebuilding inputs or losing keyboard focus.
    try { const data = await api('/admin-api/auto-routing'); AR_PREVIEWS = data.previews; AR_AVAILABILITY = data.availability; AR_HEALTH = data.health; arRefreshLineSummaries(); } catch { }
  } catch (e) {
    const pending = AR_PENDING.get(familyId);
    if (pending?.revision === revision) pending.error = e.message;
  } finally { AR_SAVING = false; arSaveStatus(); arScheduleSave(); }
}
function arRetrySave() { for (const state of AR_PENDING.values()) { state.error = ''; state.readyAt = 0; } arSaveStatus(); arScheduleSave(); }
function arReloadRouting() {
  if (AR_SAVING) { toast('正在保存，请稍后重新加载'); return; }
  if (AR_PENDING.size) { confirmDo({ title: '重新加载路由配置', text: '仍有未保存的修改。重新加载将放弃这些修改，读取服务端配置。', okLabel: '放弃修改并重新加载', onOk: () => { if (AR_SAVING) { toast('正在保存，请稍后重试'); return; } clearTimeout(AR_SAVE_TIMER); AR_PENDING.clear(); loadRouting(); } }); return; }
  loadRouting();
}
function arDeleteLine(id) {
  const line = AR.lines.find(l => l.id === id); if (!line) return;
  confirmDo({
    title: '删除线路 · ' + line.name, text: '删除此线路及其候选配置，模型和其他线路保留。', okLabel: '删除线路', onOk: () => {
      const index = AR.lines.findIndex(l => l.id === id); if (index < 0) return;
      const [removed] = AR.lines.splice(index, 1); arChanged(removed.familyId); renderRouting();
    }
  });
}
function arRemove(i, j) { const line = AR.lines[i]; line.members.splice(j, 1); arChanged(line.familyId); renderRouting(); }
function arRefreshLineSummaries() {
  for (const card of document.querySelectorAll('#tab-routing [data-ar-line]')) {
    const line = AR.lines.find(l => l.id === card.dataset.arLine); if (!line) continue;
    const price = card.querySelector('[data-ar-price-summary]'); if (price) price.innerHTML = arPriceSummary(line);
    const title = card.querySelector('[data-ar-title]'); if (title) title.textContent = line.name.endsWith('线路') ? line.name : line.name + '线路';
    const badge = card.querySelector('[data-ar-open]'), available = line.members.some(r => r.enabled && r.concurrencyWeight > 0);
    if (badge) { badge.className = 'badge ' + (line.enabled && available ? 'ok' : 'plain'); badge.textContent = !line.enabled ? '未开放' : available ? '开放' : '暂无启用渠道'; }
    const preview = AR_PREVIEWS.find(p => p.id === line.id)?.model, host = card.querySelector('[data-ar-preview]');
    if (host) host.textContent = preview ? preview.params.map(p => p.label + ': ' + (p.options || []).join(' / ')).join('　｜　') + (preview.methods?.length ? '　｜　方法: ' + preview.methods.join(' / ') : '') : '自动保存后显示可用参数；无候选渠道的线路保持未开放。';
  }
}
for (const event of ['input', 'change']) document.addEventListener(event, e => {
  const field = e.target; if (!field.matches('input,select,textarea')) return;
  const familyId = field.hasAttribute('data-ar-global') ? '__global' : field.closest('[data-ar-family]')?.dataset.arFamily;
  if (familyId) { arChanged(familyId); arRefreshLineSummaries(); }
});
window.addEventListener('beforeunload', e => { if (AR_PENDING.size || AR_SAVING) { e.preventDefault(); e.returnValue = ''; } });

async function arReset(i, j) {
  const l = AR.lines[i], m = AR_MODELS.find(m => m.id === l.members[j].modelId);
  try { await api('/admin-api/auto-routing/reset', { method: 'POST', body: JSON.stringify({ lineId: l.id, channelId: m.channelId }) }); const data = await api('/admin-api/auto-routing'); AR_HEALTH = data.health; AR_AVAILABILITY = data.availability; renderRouting(); toast('已恢复路由'); }
  catch (e) { toast(e.message, 'bad'); }
}

let AV = null, AV_CAP = 'all', AV_FAMILIES = {}, AV_PAGE = 0, AV_NEXT = 0, AV_BUSY = false, AV_SORT = 'channel', AV_CHANNEL = 'all', AV_QUERY = '', AV_CONFIG_BUSY = null;
let AV_WINDOW = '1h', AV_RANGE = null, AV_RANGE_DRAFT = { since: '', until: '' }, AV_LOAD = 0;
const AV_WINDOWS = { '1h': '1H', '5h': '5H', '24h': '24H', '3d': '3天', '7d': '7天' };
const AV_LABELS = { all: '总览', text: '文本模型', image: '图像模型', video: '视频模型', audio: '音频模型', other: '其他' };
const AV_STATES = { available: ['可用', 'ok'], unavailable: ['异常', 'bad'], attention: ['需观察', 'warn'], unknown: ['暂无样本', 'plain'], disabled: ['已停用', 'plain'] };
const AV_RATE_BANDS = [
  { min: .9, kind: 'rate-green', label: '≥90%', color: '#22c55e' },
  { min: .8, kind: 'rate-light-green', label: '80%–<90%', color: '#86efac' },
  { min: .6, kind: 'rate-yellow', label: '60%–<80%', color: '#eab308' },
  { min: .2, kind: 'rate-orange', label: '20%–<60%', color: '#f97316' },
  { min: 0, kind: 'rate-red', label: '<20%', color: '#ef4444' },
  { min: null, kind: 'rate-blue', label: '样本不足', color: '#60a5fa' }
];
const avRateBand = rate => rate == null ? AV_RATE_BANDS[5] : AV_RATE_BANDS.find(b => b.min !== null && rate >= b.min);
const avWeight = values => !values.length ? '—' : values.length === 1 ? String(Number(values[0].toFixed(2))) : Number(values[0].toFixed(2)) + '–' + Number(values.at(-1).toFixed(2));
function openAvailability() {
  AV_CAP = 'all'; AV_PAGE = 0; AV_SORT = 'channel'; AV_CHANNEL = 'all'; AV_QUERY = '';
  if (AV) renderAvailability();
  loadModelConfigurations().catch(e => toast('模型配置读取失败：' + e.message, 'bad'));
  return loadAvailability();
}
function loadModelConfigurations() {
  if (AV_CONFIG_BUSY) return AV_CONFIG_BUSY;
  AV_CONFIG_BUSY = (async () => {
    const [models, channels] = await Promise.all([api('/admin-api/models?agentId=__all'), api('/admin-api/channels'), ensureFams(true), fetchProtocols()]);
    window.__models = models.items; CHANNELS = channels.items;
    const count = document.getElementById('cnt-models'); if (count) count.textContent = models.items.length;
    try { AGROUPS = await api('/admin-api/agent-groups'); } catch { }
    if (CUR_TAB === 'availability') renderAvailability();
  })().finally(() => { AV_CONFIG_BUSY = null; }); return AV_CONFIG_BUSY;
}
async function avModelAction(id, action) {
  try {
    if (!(window.__models || []).some(m => m.id === id)) await loadModelConfigurations();
    if (!(window.__models || []).some(m => m.id === id)) { toast('该模型只保留历史观测', 'bad'); return; }
    ({ settings: openModelSettings, params: editParams, clone: cloneModelDlg, adjust: openRateAdjustment, reset: openRateReset })[action]?.(id);
  } catch (e) { toast(e.message, 'bad'); }
}
async function loadAvailability(force = false) {
  if (!force && AV && Date.now() < AV_NEXT) return;
  if (AV_BUSY && !force) return; const load = ++AV_LOAD; AV_BUSY = true;
  const el = document.getElementById('tab-availability'); if (!AV) el.innerHTML = '<p class="mut">读取渠道可用性…</p>';
  const query = new URLSearchParams(AV_RANGE ?? { window: AV_WINDOW });
  try { const data = await api('/admin-api/channel-availability?' + query); if (load !== AV_LOAD) return; AV = data; AV_NEXT = Date.now() + (data.refreshing || data.backfilling ? 1000 : 60000); }
  catch (e) { if (load !== AV_LOAD) return; if (!AV) el.textContent = e.message; else toast('可用性刷新失败：' + e.message, 'bad'); AV_NEXT = Date.now() + 60000; }
  finally { if (load === AV_LOAD) { AV_BUSY = false; if (AV && CUR_TAB === 'availability') renderAvailability(); } }
}
function avWindow(value) { AV_WINDOW = value; AV_RANGE = null; AV_PAGE = 0; loadAvailability(true); renderAvailability(); }
function avApplyRange() {
  const since = Date.parse(AV_RANGE_DRAFT.since), until = Date.parse(AV_RANGE_DRAFT.until);
  if (!Number.isFinite(since) || !Number.isFinite(until) || since >= until || until > Date.now() || since < Date.now() - 60 * 86400000) { toast('请选择近60天内有效的起止时间', 'bad'); return; }
  AV_RANGE = { since: new Date(since).toISOString(), until: new Date(until).toISOString() }; AV_PAGE = 0; loadAvailability(true); renderAvailability();
}
function avCapability(value) { AV_CAP = value; AV_PAGE = 0; renderAvailability(); }
function avFamily(value) { AV_FAMILIES[AV_CAP] = value; AV_PAGE = 0; renderAvailability(); }
function avSort(value) { AV_SORT = ['requests', 'successRate'].includes(value) ? value : 'channel'; AV_PAGE = 0; renderAvailability(); }
function avChannel(value) { AV_CHANNEL = value; AV_PAGE = 0; renderAvailability(); }
function avCompare(a, b) {
  const requests = (b.requests || 0) - (a.requests || 0);
  const rate = (b.successRate ?? -1) - (a.successRate ?? -1);
  const order = (a.channelOrder ?? Number.MAX_SAFE_INTEGER) - (b.channelOrder ?? Number.MAX_SAFE_INTEGER) || (a.modelOrder ?? Number.MAX_SAFE_INTEGER) - (b.modelOrder ?? Number.MAX_SAFE_INTEGER) || String(a.id).localeCompare(String(b.id));
  return (AV_SORT === 'successRate' ? rate || requests : AV_SORT === 'requests' ? requests || rate : 0) || order;
}
function renderAvailability() {
  if (!AV) return;
  const channelRows = [...AV.rows].sort((a, b) => (a.channelOrder ?? Number.MAX_SAFE_INTEGER) - (b.channelOrder ?? Number.MAX_SAFE_INTEGER));
  const channels = [...new Map(channelRows.map(r => [r.channelId, r.channelName])).entries()];
  if (AV_CHANNEL !== 'all' && !channels.some(([id]) => id === AV_CHANNEL)) AV_CHANNEL = 'all';
  const query = AV_QUERY.trim().toLowerCase();
  const all = AV.rows.filter(r => (AV_CAP === 'all' || arCapabilityGroup(r.modelCapability || r.capability) === AV_CAP) && (AV_CHANNEL === 'all' || r.channelId === AV_CHANNEL) && (!query || `${r.modelId} ${r.modelName}`.toLowerCase().includes(query))), families = [...new Map(all.map(r => [r.familyId, r.familyName])).entries()];
  if (!families.some(([id]) => id === AV_FAMILIES[AV_CAP])) AV_FAMILIES[AV_CAP] = families[0]?.[0] ?? '';
  const filtered = all.filter(r => AV_CAP === 'all' || r.familyId === AV_FAMILIES[AV_CAP]).sort(avCompare), pages = Math.max(1, Math.ceil(filtered.length / 12)); AV_PAGE = Math.min(AV_PAGE, pages - 1);
  const arg = value => esc(JSON.stringify(value));
  const statLabel = esc(AV.statsLabel || '近1小时');
  const cards = filtered.slice(AV_PAGE * 12, (AV_PAGE + 1) * 12).map(r => {
    const [status, tone] = AV_STATES[r.status] || AV_STATES.unknown;
    const percent = r.success + r.failed < 10 ? '样本不足' : r.successRate == null ? '—' : (r.successRate * 100).toFixed(1) + '%';
    const color = r.successRate == null ? 'var(--faint)' : r.successRate >= .95 ? 'var(--ok)' : r.successRate >= .6 ? 'var(--warn)' : 'var(--bad)';
    const slots = new Map(r.history.map(h => [Math.floor(h.until / 600000), h])), end = Math.floor(AV.until / 600000);
    const bars = Array.from({ length: 60 }, (_, i) => slots.get(end - 59 + i)).map(h => {
      if (!h) return '<span aria-hidden="true" class="av-bar empty" title="尚未形成快照"></span>';
      const band = avRateBand(h.insufficientSamples ? null : h.successRate);
      const label = h.source ? `${h.source === 'self-test' ? '自测补录' : '人工修正'} ${(h.successRate * 100).toFixed(2)}%` : h.insufficientSamples || h.successRate == null ? '样本不足' : h.method === 'interval' ? `区间成功率 ${(h.successRate * 100).toFixed(2)}% · 已结束 ${h.completedRequests} 条` : `平均成功率 ${(h.successRate * 100).toFixed(2)}% · 有效采样 ${h.validSamples}/10`;
      return `<span aria-hidden="true" class="av-bar ${band.kind}${h.source ? ' adjusted' : ''}" title="${esc(new Date(h.since).toLocaleString())} — ${esc(new Date(h.until).toLocaleString())} · ${label}"></span>`;
    }).join('');
    return `<article class="av-card" aria-label="${esc(r.channelName + ' · ' + r.modelName)}">
   <header class="av-card-head"><span class="av-symbol" aria-hidden="true">${esc(r.familyName.slice(0, 2))}</span><div class="av-name"><h3>${esc((window.__models || []).find(m => m.id === r.modelId)?.label || r.modelName)}</h3><div class="mut">${esc(r.channelName)} <span class="av-family">${esc(r.familyName)}</span></div></div><span class="badge ${tone}">${status}</span></header>
   <div class="av-metrics"><div><span>${statLabel}请求</span><strong>${r.requests}<small>次</small></strong></div><div><span>当前在途</span><strong>${r.active}<small>个</small></strong></div></div>
   <div class="av-rate"><span>${statLabel}成功率<small>成功 ${r.success} · 失败 ${r.failed}${typeof r.excluded === 'number' ? ' · 排除 ' + r.excluded : ''}</small></span><strong style="color:${color}">${percent}</strong></div>
   <div class="av-weight"><span>权重 <b>${avWeight(r.configuredWeights)}</b></span><span>当前权重 <b>${avWeight(r.effectiveWeights)}</b></span></div>
   <div class="av-history-title" title="${r.trackingSince ? '本次统计起点：' + esc(new Date(r.trackingSince).toLocaleString()) : '仅统计路由中启用的模型'}"><span>近10小时成功率快照</span><span>约10分钟/点 · ${r.history.length}/60</span></div><div class="av-bars" role="img" aria-label="近10小时成功率，已有${r.history.length}个快照，按时间从旧到新">${bars}</div><div class="av-history-axis"><span>较早</span><span>最近</span></div>
   ${r.history.some(h => h.source) ? '<div class="mut" style="font-size:10px;margin-top:5px">斜纹点含自测补录 / 人工修正</div>' : ''}
   <div class="av-actions">${r.configured ? `<button class="sm" onclick="avModelAction(${arg(r.modelId)},'settings')">配置</button><button class="sm" onclick="avModelAction(${arg(r.modelId)},'params')">参数</button><button class="sm" onclick="avModelAction(${arg(r.modelId)},'clone')">克隆</button><button class="sm" onclick="avModelAction(${arg(r.modelId)},'adjust')">调节</button><button class="sm" onclick="avModelAction(${arg(r.modelId)},'reset')">重置</button>${r.hidden ? '<span class="faint">内部配置</span>' : ''}` : '<span class="faint">历史模型</span>'}</div>
  </article>`;
  }).join('');
  document.getElementById('tab-availability').innerHTML = `
 <style>
 .av-nav{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 16px}.av-nav button[aria-selected=true]{background:var(--acc-dim);border-color:var(--acc);color:var(--text)}
 .av-top{display:flex;align-items:center;gap:12px;margin-bottom:18px;flex-wrap:wrap}.av-top .mut{margin-left:auto}.av-family-nav{padding:12px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}
 .av-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}.av-card{padding:14px;background:var(--panel);border:1px solid var(--line2);border-radius:var(--r-md);min-width:0}.av-actions{display:flex;align-items:center;gap:6px;border-top:1px solid var(--line);padding-top:10px;margin-top:10px}.av-actions .faint{font-size:11px;margin-left:auto}
 .av-card-head{display:flex;align-items:center;gap:8px;margin-bottom:12px}.av-symbol{display:grid;place-items:center;width:28px;height:28px;flex-shrink:0;border:1px solid var(--line2);border-radius:8px;background:var(--acc-dim);color:var(--acc);font-size:11px;font-weight:700}
 .av-name{min-width:0;flex:1}.av-name h3{margin:0 0 3px;font-size:14px;overflow-wrap:anywhere}.av-name .mut{font-size:11px;overflow-wrap:anywhere}.av-family{display:inline-block;color:var(--acc);margin-left:5px}.av-card-head>.badge{flex-shrink:0;font-size:10px;padding:3px 6px}
 .av-metrics{display:grid;grid-template-columns:1fr 1fr;gap:8px}.av-metrics>div{padding:8px 10px;border:1px solid var(--line);border-radius:var(--r-md);background:var(--panel2)}.av-metrics span{display:block;color:var(--mut);font-size:11px}.av-metrics strong{display:block;font-size:20px;margin-top:4px;font-variant-numeric:tabular-nums}.av-metrics small{font-size:11px;font-weight:400;color:var(--mut);margin-left:4px}
 .av-rate{display:flex;justify-content:space-between;align-items:center;gap:8px;border-bottom:1px solid var(--line);padding:10px 0}.av-rate>span{color:var(--mut);font-size:11px}.av-rate small{display:block;font-size:10px;color:var(--faint);margin-top:3px}.av-rate strong{font-size:24px;font-variant-numeric:tabular-nums;white-space:nowrap}
 .av-weight{display:flex;justify-content:space-between;gap:8px;padding:9px 0;color:var(--mut);font-size:11px}.av-weight b{color:var(--text);margin-left:4px}.av-history-title,.av-history-axis{display:flex;justify-content:space-between;color:var(--mut);font-size:10px}.av-history-title{margin-top:3px}.av-history-axis{color:var(--faint);font-size:10px;margin-top:3px}
 .av-bars{display:flex;gap:2px;align-items:end;height:24px;margin-top:6px}.av-bar{flex:1;min-width:0;border-radius:1px;height:16px;background:var(--line2)}.av-bar.empty{height:4px}.av-bar.rate-green{height:24px}.av-bar.rate-light-green{height:20px}.av-bar.rate-yellow{height:16px}.av-bar.rate-orange{height:12px}.av-bar.rate-red{height:8px}.av-bar.rate-blue{height:16px}.av-bar.rate-insufficient{height:8px;background:#94a3b8}
 ${AV_RATE_BANDS.map(b => `.av-bar.${b.kind}{background:${b.color}}`).join('')}
 .av-bar.adjusted{background-image:repeating-linear-gradient(135deg,transparent 0 3px,#0006 3px 5px)}.av-actions{flex-wrap:wrap}
 .av-bottom{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-top:18px}.av-legend{display:flex;gap:14px;color:var(--mut);font-size:12px;flex-wrap:wrap}.av-legend i{display:inline-block;width:7px;height:7px;border-radius:2px;margin-right:5px}.av-note{color:var(--faint);font-size:12px;margin-top:12px}
 @media(max-width:1250px){.av-grid{grid-template-columns:repeat(3,minmax(0,1fr))}}@media(max-width:1000px){.av-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:640px){.av-grid{grid-template-columns:1fr}}
 </style>
 <div class="page-sticky" aria-label="模型管理筛选">
 <div class="av-top"><nav class="av-nav" role="tablist" aria-label="模型用途" style="margin:0">${Object.entries(AV_LABELS).map(([id, label]) => `<button role="tab" aria-selected="${id === AV_CAP}" onclick="avCapability(${arg(id)})">${label}</button>`).join('')}</nav><select aria-label="渠道筛选" onchange="avChannel(this.value)"><option value="all">全部渠道</option>${channels.map(([id, name]) => `<option value="${esc(id)}" ${AV_CHANNEL === id ? 'selected' : ''}>${esc(name)}</option>`).join('')}</select><select aria-label="排序方式" onchange="avSort(this.value)"><option value="channel" ${AV_SORT === 'channel' ? 'selected' : ''}>按渠道管理顺序</option><option value="requests" ${AV_SORT === 'requests' ? 'selected' : ''}>按请求最多</option><option value="successRate" ${AV_SORT === 'successRate' ? 'selected' : ''}>按成功率最高</option></select><span class="mut" id="av-countdown">${AV_BUSY ? '刷新中…' : Math.max(0, Math.ceil((AV_NEXT - Date.now()) / 1000)) + '秒后刷新'}</span><button onclick="loadAvailability(true)">刷新</button></div>
 <div class="av-range toolbar" aria-label="成功率统计时段"><span>数值时段</span>${Object.entries(AV_WINDOWS).map(([key, label]) => `<button aria-pressed="${!AV_RANGE && AV_WINDOW === key}" class="${!AV_RANGE && AV_WINDOW === key ? 'pri' : ''}" onclick="avWindow(${arg(key)})">${label}</button>`).join('')}<label>从 <input type="datetime-local" aria-label="统计开始时间" value="${esc(AV_RANGE_DRAFT.since)}" oninput="AV_RANGE_DRAFT.since=this.value"/></label><label>至 <input type="datetime-local" aria-label="统计结束时间" value="${esc(AV_RANGE_DRAFT.until)}" oninput="AV_RANGE_DRAFT.until=this.value"/></label><button onclick="avApplyRange()" class="${AV_RANGE ? 'pri' : ''}">应用时段</button><span class="mut">仅影响数值 · 波形固定10H</span></div>
 <p class="mut" style="font-size:12px" aria-live="polite">${AV_BUSY ? '正在读取所选时段，以下暂显示上次结果 · ' : ''}当前数值：${statLabel} · ${esc(new Date(AV.statsSince ?? AV.since).toLocaleString())} — ${esc(new Date(AV.statsUntil ?? AV.until).toLocaleString())}</p>
 <div class="toolbar"><input aria-label="搜索模型" type="search" value="${esc(AV_QUERY)}" placeholder="搜索模型名称或 ID" onchange="AV_QUERY=this.value;AV_PAGE=0;renderAvailability()"/></div>
 <nav class="av-nav av-family-nav" style="${AV_CAP === 'all' ? 'display:none' : ''}" role="tablist" aria-label="模型家族">${families.map(([id, name]) => `<button role="tab" aria-selected="${id === AV_FAMILIES[AV_CAP]}" onclick="avFamily(${arg(id)})">${esc(name)} <span class="faint">${all.filter(r => r.familyId === id).length}</span></button>`).join('') || '<span class="mut">暂无家族</span>'}</nav>
 </div>
 <div class="av-grid">${cards || '<p class="mut">该用途暂无渠道模型</p>'}</div>
 <div class="av-bottom"><div class="av-legend">${AV_RATE_BANDS.map(b => `<span><i style="background:${b.color}"></i>${b.label}</span>`).join('')}</div><div><button onclick="AV_PAGE--;renderAvailability()" ${AV_PAGE === 0 ? 'disabled' : ''}>上一页</button> <span>${AV_PAGE + 1} / ${pages}</span> <button onclick="AV_PAGE++;renderAvailability()" ${AV_PAGE >= pages - 1 ? 'disabled' : ''}>下一页</button></div></div>
 <p class="av-note">启用时采样，停用保留历史；可手动重置，删除模型会清理快照。快照保存60天，波形固定展示最近10小时。上方按所选时段内提交请求的当前结束结果统计；下方每点独立统计10分钟内完成的请求；不足10条（含零请求）显示蓝色样本不足，统计按80%代入。更新时间 ${esc(new Date(AV.until).toLocaleTimeString())}${AV.backfilling ? ' · 正在补齐历史观测' : ''}</p>`;
}
setInterval(() => { if (CUR_TAB !== 'availability' || document.hidden || !AV) return; const seconds = Math.max(0, Math.ceil((AV_NEXT - Date.now()) / 1000)); const label = document.getElementById('av-countdown'); if (label) label.textContent = AV_BUSY ? '刷新中…' : seconds + '秒后刷新'; if (!seconds && !AV_BUSY) loadAvailability(); }, 1000);

let AV_EDIT = null, AV_EDIT_LOAD = 0;
let AV_ADJUST = null;
const AV_STATISTICS_DRAFTS = new Map();
const AV_RULE_FIELDS = { error: '错误文本', durationSec: '请求耗时（秒）', status: '原始结果' };
const AV_RULE_OPERATORS = { error: { contains: '包含', notContains: '不包含', equals: '完全等于' }, durationSec: { lt: '小于', lte: '小于或等于', eq: '等于', gte: '大于或等于', gt: '大于' }, status: { equals: '等于' } };
const AV_RULE_ACTIONS = { exclude: '排除统计', success: '记为成功', failed: '记为失败' };
const AV_RULE_MATCH_STATUS = { all: '全部结果', failed: '仅失败', success: '仅成功' };
const AV_RULE_EXAMPLES = [
  { label: '排除内容审核报错', field: 'error', operator: 'contains', value: '内容不符合平台规范', action: 'exclude', matchStatus: 'failed' },
  { label: '排除耗时小于10秒的失败', field: 'durationSec', operator: 'lt', value: 10, action: 'exclude', matchStatus: 'failed' },
  { label: '排除指定英文报错', field: 'error', operator: 'contains', value: 'the request must be less than or equal to 15.2 for model doubao-seedance-2-0 in r2v.', action: 'exclude', matchStatus: 'failed' },
];
function avStatisticsDraft(id) {
  if (!AV_STATISTICS_DRAFTS.has(id)) AV_STATISTICS_DRAFTS.set(id, { version: 0, rules: [], baseRules: [], updatedAt: null, loaded: false, loading: false, saving: false, revision: 0, conflict: false, latest: null, error: '', notice: '' });
  return AV_STATISTICS_DRAFTS.get(id);
}
function avStatisticsDirty(draft) { return JSON.stringify(draft.rules) !== JSON.stringify(draft.baseRules); }
function avStatisticsVisible(id) { return AV_ADJUST?.id === id && !!document.getElementById('av-statistics-content'); }

async function openRateAdjustment(id, target) {
  AV_ADJUST = { id, tab: target ? 'history' : 'rules' }; AV_EDIT = null;
  document.getElementById('dlgTitle').textContent = '调节 · ' + ((window.__models || []).find(m => m.id === id)?.label || id);
  document.getElementById('dlgBody').innerHTML = `
 <style>
 .av-adjust-tabs{display:flex;gap:8px;margin-bottom:12px;padding-bottom:8px;border-bottom:1px solid var(--line)}.av-adjust-tabs button[aria-selected=true]{background:var(--acc-dim);border-color:var(--acc);color:var(--text)}
 .av-rule-scope{padding:8px 12px;background:var(--panel2);border:1px solid var(--line);border-radius:8px;margin:0 0 8px;line-height:1.5;font-size:12px}.av-rule-scope strong{color:var(--text)}.av-rule-note,.av-rule-help{margin:6px 0;font-size:12px;line-height:1.6;color:var(--mut)}.av-rule-help summary{cursor:pointer;width:fit-content}.av-rule-help p{margin:6px 0}
 .av-rule-presets{display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin:12px 0}.av-rule-list{display:grid;gap:10px;margin:12px 0;max-height:48vh;overflow:auto;padding:2px}.av-rule{border:1px solid var(--line);border-radius:9px;padding:12px;background:var(--panel2)}.av-rule.is-disabled{opacity:.65}
 .av-rule-head{display:flex;gap:8px;align-items:center;margin-bottom:10px;flex-wrap:wrap}.av-rule-head>strong{font-size:12px}.av-rule-toggle{display:flex;align-items:center;gap:5px;font-size:12px}.av-rule-toggle input{width:auto}.av-rule-fields{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}.av-rule label:not(.av-rule-toggle){display:grid;gap:5px;font-size:12px;color:var(--mut)}.av-rule select,.av-rule textarea,.av-rule input[type=number]{width:100%;min-width:0;box-sizing:border-box}.av-rule-value{margin-top:10px}.av-rule textarea{min-height:64px;resize:vertical;white-space:pre-wrap}.av-rule-footer{display:flex;align-items:center;gap:8px;flex-wrap:wrap;border-top:1px solid var(--line);padding-top:12px}.av-rule-footer [role=status]{flex:1;min-width:180px;font-size:12px;line-height:1.6}.av-rule-conflict{border:1px solid var(--warn);padding:12px;border-radius:8px;margin:12px 0;font-size:12px;line-height:1.7}.av-rule-conflict pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:160px;overflow:auto}.av-rule-empty{padding:22px;text-align:center;border:1px dashed var(--line);border-radius:8px;color:var(--mut);font-size:12px}
 @media(max-width:650px){.av-rule-fields{grid-template-columns:1fr}.av-rule-head .sp{display:none}}
 </style>
 <nav class="av-adjust-tabs" role="tablist" aria-label="调节方式"><button id="av-adjust-rules-tab" role="tab" aria-controls="av-statistics-panel" onclick="avAdjustmentTab('rules')">统计规则</button><button id="av-adjust-history-tab" role="tab" aria-controls="av-history-panel" onclick="avAdjustmentTab('history')">历史快照</button></nav>
 <section id="av-statistics-panel" role="tabpanel" aria-labelledby="av-adjust-rules-tab"><div id="av-statistics-content"></div></section>
 <section id="av-history-panel" role="tabpanel" aria-labelledby="av-adjust-history-tab"><div id="av-history-content"><p class="mut">读取历史快照…</p></div></section>`;
  dlg.classList.add('wide'); if (!dlg.open) dlg.showModal();
  avAdjustmentTab(AV_ADJUST.tab); renderStatisticsRules(id);
  await Promise.all([loadRateAdjustmentHistory(id, target), loadStatisticsRules(id)]);
}
function avAdjustmentTab(tab) {
  if (!AV_ADJUST || !['rules', 'history'].includes(tab)) return;
  AV_ADJUST.tab = tab;
  document.getElementById('av-statistics-panel').hidden = tab !== 'rules';
  document.getElementById('av-history-panel').hidden = tab !== 'history';
  document.getElementById('av-adjust-rules-tab').setAttribute('aria-selected', String(tab === 'rules'));
  document.getElementById('av-adjust-history-tab').setAttribute('aria-selected', String(tab === 'history'));
}
async function loadRateAdjustmentHistory(id, target) {
  const load = ++AV_EDIT_LOAD;
  const host = document.getElementById('av-history-content'); if (!host || AV_ADJUST?.id !== id) return;
  host.innerHTML = '<p id="av-edit-loading" class="mut">读取历史快照…</p>';
  try {
    const data = await api('/admin-api/models/' + encodeURIComponent(id) + '/rate-history' + (target ? '?target=' + encodeURIComponent(target) : ''));
    if (load !== AV_EDIT_LOAD || AV_ADJUST?.id !== id || !document.getElementById('av-edit-loading')) return;
    AV_EDIT = { id, ...data }; renderRateAdjustment();
  } catch (e) { if (load === AV_EDIT_LOAD && AV_ADJUST?.id === id && document.getElementById('av-edit-loading')) document.getElementById('av-edit-loading').textContent = '读取历史快照失败：' + e.message; }
}
const avHistoryPercent = p => p?.insufficientSamples ? '样本不足' : p?.successRate == null ? '—' : (p.successRate * 100).toFixed(1) + '%';
const avHistoryCurrentPoint = p => p.display || p.edit || p.original;
function avHistoryPointSource(p) {
  const current = avHistoryCurrentPoint(p);
  return current?.source === 'self-test' ? '自测补录' : current?.source === 'correction' ? '人工修正' : current?.rulesApplied ? '统计规则调整' : current ? '生产实测' : '尚未形成快照';
}
async function refreshRateAdjustmentDisplay(id) {
  const data = AV_EDIT, load = AV_EDIT_LOAD;
  if (!data || data.id !== id || AV_ADJUST?.id !== id || !dlg.open) return;
  const isCurrent = () => AV_EDIT === data && AV_EDIT_LOAD === load && AV_ADJUST?.id === id && dlg.open;
  try {
    const result = await api('/admin-api/models/' + encodeURIComponent(id) + '/rate-history?target=' + encodeURIComponent(data.key));
    if (!isCurrent()) return;
    const byTime = new Map(result.slots.map(point => [point.until, point]));
    data.slots.forEach((point, index) => {
      const latest = byTime.get(point.until); if (!latest) return;
      // Update display cells only: keep manual inputs, selection and edit conflict tokens intact.
      point.display = avHistoryCurrentPoint(latest);
      const value = document.getElementById('av-edit-current-' + index), source = document.getElementById('av-edit-source-' + index);
      if (value) value.textContent = avHistoryPercent(avHistoryCurrentPoint(point));
      if (source) source.textContent = avHistoryPointSource(point);
    });
  } catch (e) {
    const error = document.getElementById('av-edit-error');
    if (isCurrent() && error) error.textContent = '规则已保存，历史统计刷新失败：' + e.message;
  }
}
function renderRateAdjustment() {
  const data = AV_EDIT, host = document.getElementById('av-history-content'); if (!data || !host || AV_ADJUST?.id !== data.id) return;
  const pct = avHistoryPercent;
  host.innerHTML = `
 <style>.av-edit-grid{max-height:280px;overflow:auto;margin:12px 0;border:1px solid var(--line);border-radius:8px}.av-edit-grid table{width:100%;font-size:12px}.av-edit-grid th{position:sticky;top:0;background:var(--panel);z-index:1}.av-edit-grid td,.av-edit-grid th{padding:8px;text-align:left}.av-edit-controls{display:flex;gap:10px;flex-wrap:wrap;align-items:end}.av-edit-controls label{display:grid;gap:5px;font-size:12px}.av-edit-grid input{width:16px;height:16px}.av-edit-audit{max-height:140px;overflow:auto;font-size:11px;line-height:1.7}.av-edit-audit p{padding:5px 0;border-bottom:1px solid var(--line)}</style>
 <label>调整对象 <select id="av-edit-target" onchange="loadRateAdjustmentHistory(AV_EDIT.id,this.value)">${data.targets.map(t => `<option value="${esc(t.key)}" ${t.key === data.key ? 'selected' : ''}>${esc(t.label)}</option>`).join('')}</select></label>
 <p class="mut">客户端显示所选线路的一条历史波形；自测补录和人工修正会标注来源。近 1H 实测成功率保持独立，原始快照保留，可随时撤销。选择“仅此底层模型”只调整管理端图表。</p>
 ${!data.active ? '<p class="warn-t">当前对象未在路由中启用，请启用后重新读取。</p>' : ''}
 <div class="toolbar"><span>选择时间范围</span><select id="av-edit-hours" aria-label="选择最近几小时">${[1, 2, 3, 6, 10].map(h => `<option value="${h}">${h} 小时</option>`).join('')}</select><button onclick="selectRateAdjustment(true)">选中范围</button><button onclick="selectRateAdjustment(false)">取消全选</button><span class="mut">可单独勾选任意历史点</span></div>
 <div class="av-edit-grid"><table><thead><tr><th>选择</th><th>快照时间</th><th>生产实测原值</th><th>当前展示值</th><th>来源</th></tr></thead><tbody>${data.slots.map((p, i) => `<tr><td><input type="checkbox" data-rate-slot="${i}" aria-label="选择 ${esc(new Date(p.until).toLocaleTimeString())}" ${!data.active ? 'disabled' : ''}/></td><td>${esc(new Date(p.until).toLocaleString())}</td><td>${pct(p.original)}</td><td id="av-edit-current-${i}">${pct(avHistoryCurrentPoint(p))}</td><td id="av-edit-source-${i}">${avHistoryPointSource(p)}</td></tr>`).join('')}</tbody></table></div>
 <div class="av-edit-controls"><label>成功率（%）<input id="av-edit-rate" type="number" min="0" max="100" step="0.1" placeholder="如 95"/></label><label>数据来源<select id="av-edit-source"><option value="self-test">自测补录</option><option value="correction">人工修正</option></select></label><label style="flex:1;min-width:220px">来源 / 修正依据（仅后台留档）<input id="av-edit-reason" type="text" maxlength="300" placeholder="如：9月14日自测记录；或排除用户参数错误的依据"/></label></div>
 <p id="av-edit-error" role="status" class="bad-t"></p>
 <div class="toolbar" style="margin-top:14px"><button onclick="saveRateAdjustment(true)" ${!data.active ? 'disabled' : ''}>撤销所选调整</button><span class="sp"></span><button onclick="dlg.close()">关闭</button><button class="pri" onclick="saveRateAdjustment(false)" ${!data.active ? 'disabled' : ''}>保存所选快照</button></div>
 <details><summary>最近修改记录（${data.audit.length}）</summary><div class="av-edit-audit">${data.audit.map(a => `<p>${esc(new Date(a.at).toLocaleString())} · ${a.action === 'reset' ? '重置快照' : a.action === 'restore' ? '撤销调整' : '修改'} · ${esc(new Date(a.until).toLocaleTimeString())} · ${pct(a.before || a.original)} → ${pct(a.after || a.original)}${a.after ? ' · ' + esc(a.after.reason) : ''}</p>`).join('') || '<p class="mut">暂无修改记录</p>'}</div></details>`;
}
function avValidateStatisticsRules(rules) {
  if (!Array.isArray(rules) || rules.length > 50) throw Error('最多保存 50 条统计规则');
  const ids = new Set();
  return rules.map((rule, index) => {
    const fail = message => { throw Error(`第 ${index + 1} 条：${message}`); };
    if (!rule || typeof rule.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(rule.id) || ids.has(rule.id)) fail('规则编号无效或重复');
    ids.add(rule.id);
    if (typeof rule.enabled !== 'boolean') fail('启停状态无效');
    if (!Object.hasOwn(AV_RULE_FIELDS, rule.field) || !Object.hasOwn(AV_RULE_OPERATORS[rule.field], rule.operator)) fail('条件与比较方式不匹配');
    if (!Object.hasOwn(AV_RULE_ACTIONS, rule.action)) fail('请选择统计处理方式');
    const matchStatus = rule.matchStatus ?? 'all';
    if (!Object.hasOwn(AV_RULE_MATCH_STATUS, matchStatus)) fail('请选择有效的适用结果');
    let value = rule.value;
    if (rule.field === 'error') {
      if (typeof value !== 'string' || !value.trim() || value.trim().length > 2000) fail('错误文本须为 1–2000 字符');
      value = value.trim();
    } else if (rule.field === 'durationSec') {
      if (value === '' || value === null || typeof value === 'boolean' || !Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > 604800) fail('请求耗时须为 0–604800 秒');
      value = Number(value);
    } else {
      if (!['success', 'failed'].includes(value)) fail('原始结果须为成功或失败');
      if (matchStatus !== 'all' && matchStatus !== value) fail('适用结果与原始结果条件冲突');
    }
    return { id: rule.id, enabled: rule.enabled, field: rule.field, operator: rule.operator, value, action: rule.action, ...(rule.matchStatus === undefined ? {} : { matchStatus }) };
  });
}
function avStatisticsSnapshot(data) {
  if (!data || !Number.isInteger(data.version) || data.version < 0 || !Array.isArray(data.rules)) throw Error('统计规则响应格式异常');
  return { version: data.version, rules: avValidateStatisticsRules(data.rules), updatedAt: data.updatedAt ?? null };
}
function avStatisticsAdopt(draft, snapshot, keepDraft = false) {
  draft.version = snapshot.version; draft.baseRules = structuredClone(snapshot.rules); draft.updatedAt = snapshot.updatedAt;
  if (!keepDraft) draft.rules = structuredClone(snapshot.rules);
  draft.loaded = true; draft.conflict = false; draft.latest = null; draft.error = '';
}
async function loadStatisticsRules(id, force = false) {
  const draft = avStatisticsDraft(id);
  if (draft.loading || draft.saving || (!force && draft.loaded && avStatisticsDirty(draft))) return;
  const revision = draft.revision; draft.loading = true; draft.error = ''; renderStatisticsRules(id);
  try {
    const snapshot = avStatisticsSnapshot(await api('/admin-api/models/' + encodeURIComponent(id) + '/statistics-rules'));
    if (!draft.loaded || (!avStatisticsDirty(draft) && draft.revision === revision)) {
      avStatisticsAdopt(draft, snapshot); draft.notice = '已读取服务器规则';
    } else {
      draft.latest = snapshot;
      draft.conflict = snapshot.version !== draft.version;
      draft.notice = draft.conflict ? '服务器已有新版本，当前草稿已保留' : '服务器版本未变化，当前草稿已保留';
    }
  } catch (e) { draft.error = '读取统计规则失败：' + e.message; }
  finally { draft.loading = false; renderStatisticsRules(id); }
}
function avStatisticsDescription(rule, index) {
  const value = rule.field === 'status' ? (rule.value === 'success' ? '成功' : '失败') : String(rule.value) + (rule.field === 'durationSec' ? ' 秒' : '');
  return `${index + 1}. ${rule.enabled ? '启用' : '停用'} · ${AV_RULE_MATCH_STATUS[rule.matchStatus ?? 'all']} · ${AV_RULE_FIELDS[rule.field]} ${AV_RULE_OPERATORS[rule.field]?.[rule.operator] || rule.operator} ${value} → ${AV_RULE_ACTIONS[rule.action]}`;
}
function renderStatisticsRules(id) {
  if (!avStatisticsVisible(id)) return;
  const draft = avStatisticsDraft(id), arg = value => esc(JSON.stringify(value)), locked = draft.saving;
  const options = (items, selected) => Object.entries(items).map(([value, label]) => `<option value="${esc(value)}" ${value === selected ? 'selected' : ''}>${esc(label)}</option>`).join('');
  const model = (window.__models || []).find(m => m.id === id);
  const ruleCards = draft.rules.map((rule, index) => {
    const change = field => `avStatisticsRuleChange(${arg(id)},${arg(rule.id)},${arg(field)},this.${field === 'enabled' ? 'checked' : 'value'})`;
    const value = rule.field === 'error' ? `<textarea aria-label="第${index + 1}条错误文本" maxlength="2000" rows="2" placeholder="输入要匹配的错误原文" oninput="${change('value')}" ${locked ? 'disabled' : ''}>${esc(rule.value)}</textarea>`
      : rule.field === 'durationSec' ? `<input aria-label="第${index + 1}条请求耗时（秒）" type="number" min="0" max="604800" step="any" value="${esc(rule.value)}" oninput="${change('value')}" ${locked ? 'disabled' : ''}/>`
      : `<select aria-label="第${index + 1}条原始结果" onchange="${change('value')}" ${locked ? 'disabled' : ''}>${options({ success: '成功', failed: '失败' }, rule.value)}</select>`;
    return `<article class="av-rule${rule.enabled ? '' : ' is-disabled'}" data-statistics-rule="${esc(rule.id)}"><div class="av-rule-head"><strong>规则 ${index + 1}</strong><label class="av-rule-toggle"><input aria-label="启用规则${index + 1}" type="checkbox" ${rule.enabled ? 'checked' : ''} onchange="${change('enabled')}" ${locked ? 'disabled' : ''}/>启用</label><span class="sp"></span><button class="sm" aria-label="上移规则${index + 1}" onclick="avStatisticsRuleMove(${arg(id)},${arg(rule.id)},-1)" ${locked || index === 0 ? 'disabled' : ''}>上移</button><button class="sm" aria-label="下移规则${index + 1}" onclick="avStatisticsRuleMove(${arg(id)},${arg(rule.id)},1)" ${locked || index === draft.rules.length - 1 ? 'disabled' : ''}>下移</button><button class="sm" aria-label="删除规则${index + 1}" onclick="avStatisticsRuleDelete(${arg(id)},${arg(rule.id)})" ${locked ? 'disabled' : ''}>删除</button></div>
 <div class="av-rule-fields"><label>适用结果<select aria-label="第${index + 1}条适用结果" title="${rule.field === 'status' ? '由原始结果条件指定，避免重复或冲突' : '先筛选原始请求结果，再判断本条条件'}" onchange="${change('matchStatus')}" ${locked || rule.field === 'status' ? 'disabled' : ''}>${options(AV_RULE_MATCH_STATUS, rule.matchStatus ?? 'all')}</select></label><label>判断字段<select aria-label="第${index + 1}条判断字段" onchange="${change('field')}" ${locked ? 'disabled' : ''}>${options(AV_RULE_FIELDS, rule.field)}</select></label><label>比较方式<select aria-label="第${index + 1}条比较方式" onchange="${change('operator')}" ${locked ? 'disabled' : ''}>${options(AV_RULE_OPERATORS[rule.field], rule.operator)}</select></label><label>命中后<select aria-label="第${index + 1}条统计处理" onchange="${change('action')}" ${locked ? 'disabled' : ''}>${options(AV_RULE_ACTIONS, rule.action)}</select></label></div>
 <label class="av-rule-value">${rule.field === 'error' ? '错误文本（区分大小写）' : rule.field === 'durationSec' ? '从提交到报错或完成的耗时（秒）' : '请求原始结果'}${value}</label></article>`;
  }).join('');
  document.getElementById('av-statistics-content').innerHTML = `
 <h3 style="margin:0 0 8px;font-size:15px">错误白名单与统计规则</h3>
 <p class="av-rule-scope">作用模型：<strong>${esc(model?.label || id)}</strong> <span class="mut">${esc(id)}</span></p>
 <p class="av-rule-note">从上到下首条启用且匹配的规则生效；仅调整统计，不改请求结果或积分结算。</p>
 <details class="av-rule-help"><summary>统计说明</summary>
 <p>仅调整此底层模型及经过它的线路统计；历史快照页的“调整对象”不改变这里的作用范围。未命中按原始结果统计，排除后不计入成功率和有效样本数。</p>
 <p>错误条件只匹配已有报错信息的终态请求，空错误也不匹配“不包含”。</p>
 <p>保存后，按现存请求证据重算当前统计和已有实测区间的显示；原始请求、原始快照及人工调节点保留。历史错误原文缺失时，仅应用有证据的匹配。</p>
 </details>
 <div class="av-rule-presets"><span class="mut">快速添加</span>${AV_RULE_EXAMPLES.map((example, index) => `<button class="sm" title="${esc((example.field === 'error' ? example.value : '请求耗时小于10秒') + ' · 仅失败，可修改适用结果')}" onclick="avStatisticsRuleAdd(${arg(id)},${index})" ${locked || !draft.loaded || draft.rules.length >= 50 ? 'disabled' : ''}>${example.label}</button>`).join('')}<span class="mut">添加后需保存</span></div>
 ${draft.loaded ? `<div class="av-rule-list">${ruleCards || '<div class="av-rule-empty">暂无统计规则，按请求原始结果统计</div>'}</div>` : `<p class="mut">${draft.loading ? '正在读取统计规则…' : '尚未读取统计规则'}</p>`}
 ${draft.conflict ? `<div class="av-rule-conflict" role="alert"><strong>服务器版本已变化，草稿未被覆盖。</strong>${draft.latest ? `<details open><summary>服务器最新规则（版本 ${draft.latest.version}）</summary><pre>${esc(draft.latest.rules.map(avStatisticsDescription).join('\n') || '暂无规则')}</pre></details><div class="toolbar"><button onclick="avStatisticsResolve(${arg(id)},false)" ${locked ? 'disabled' : ''}>放弃草稿，使用服务器版本</button><button onclick="avStatisticsResolve(${arg(id)},true)" title="保留当前整份草稿，下一次保存将替换这里展示的服务器版本" ${locked ? 'disabled' : ''}>保留草稿，准备覆盖最新版本</button></div>` : '<p>请刷新服务器版本，再选择处理方式。</p>'}</div>` : ''}
 <div class="av-rule-footer"><button onclick="avStatisticsRuleAdd(${arg(id)})" ${locked || !draft.loaded || draft.rules.length >= 50 ? 'disabled' : ''}>新增规则</button><button onclick="loadStatisticsRules(${arg(id)},true)" ${locked || draft.loading ? 'disabled' : ''}>${draft.loading ? '读取中…' : '刷新服务器版本'}</button><span id="av-statistics-status" role="status"></span><button id="av-statistics-save" class="pri" onclick="saveStatisticsRules(${arg(id)})" ${locked || !draft.loaded || draft.conflict || !avStatisticsDirty(draft) ? 'disabled' : ''}>${locked ? '保存中…' : '保存统计规则'}</button><button onclick="dlg.close()">关闭</button></div>`;
  avStatisticsUpdateStatus(id);
}
function avStatisticsUpdateStatus(id) {
  if (!avStatisticsVisible(id)) return;
  const draft = avStatisticsDraft(id), status = document.getElementById('av-statistics-status'), save = document.getElementById('av-statistics-save');
  if (status) {
    status.className = draft.error ? 'bad-t' : draft.conflict ? 'warn-t' : 'mut';
    status.textContent = draft.error || (draft.saving ? '正在保存…' : draft.notice || (avStatisticsDirty(draft) ? '有未保存的修改' : `版本 ${draft.version}${draft.updatedAt ? ' · 保存于 ' + new Date(draft.updatedAt).toLocaleString() : ''}`));
  }
  if (save) save.disabled = draft.saving || !draft.loaded || draft.conflict || !avStatisticsDirty(draft);
}
function avStatisticsEdited(id, redraw = true) {
  const draft = avStatisticsDraft(id); draft.revision++; draft.error = ''; draft.notice = '';
  if (redraw) renderStatisticsRules(id); else avStatisticsUpdateStatus(id);
}
function avStatisticsRuleAdd(id, exampleIndex) {
  const draft = avStatisticsDraft(id); if (!draft.loaded || draft.saving) return;
  if (draft.rules.length >= 50) { draft.error = '最多保存 50 条统计规则'; avStatisticsUpdateStatus(id); return; }
  const example = AV_RULE_EXAMPLES[exampleIndex] || { field: 'error', operator: 'contains', value: '', action: 'exclude' };
  const uid = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `rule-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  draft.rules = [...draft.rules, { id: uid, enabled: true, field: example.field, operator: example.operator, value: example.value, action: example.action, matchStatus: example.matchStatus ?? 'all' }];
  avStatisticsEdited(id);
  const list = avStatisticsVisible(id) ? document.querySelector('#av-statistics-content .av-rule-list') : null; if (list) list.scrollTop = list.scrollHeight;
}
function avStatisticsRuleChange(id, ruleId, field, value) {
  const draft = avStatisticsDraft(id), rule = draft.rules.find(rule => rule.id === ruleId); if (!rule || draft.saving) return;
  if (field === 'field') {
    if (!Object.hasOwn(AV_RULE_FIELDS, value)) return;
    Object.assign(rule, { field: value, operator: value === 'error' ? 'contains' : value === 'durationSec' ? 'lt' : 'equals', value: value === 'durationSec' ? 10 : value === 'status' ? 'failed' : '', ...(value === 'status' ? { matchStatus: 'all' } : {}) });
  } else if (field === 'enabled') rule.enabled = !!value;
  else if (field === 'value') { rule.value = value; if (rule.field === 'status') rule.matchStatus = 'all'; }
  else if (field === 'matchStatus' && rule.field !== 'status' && Object.hasOwn(AV_RULE_MATCH_STATUS, value)) rule.matchStatus = value;
  else if (field === 'operator' && Object.hasOwn(AV_RULE_OPERATORS[rule.field], value)) rule.operator = value;
  else if (field === 'action' && Object.hasOwn(AV_RULE_ACTIONS, value)) rule.action = value;
  else return;
  avStatisticsEdited(id, field === 'field' || field === 'enabled' || (field === 'value' && rule.field === 'status'));
}
function avStatisticsRuleMove(id, ruleId, offset) {
  const draft = avStatisticsDraft(id), index = draft.rules.findIndex(rule => rule.id === ruleId), next = index + offset;
  if (draft.saving || index < 0 || next < 0 || next >= draft.rules.length) return;
  [draft.rules[index], draft.rules[next]] = [draft.rules[next], draft.rules[index]]; avStatisticsEdited(id);
}
function avStatisticsRuleDelete(id, ruleId) {
  const draft = avStatisticsDraft(id); if (draft.saving) return;
  draft.rules = draft.rules.filter(rule => rule.id !== ruleId); avStatisticsEdited(id);
}
function avStatisticsResolve(id, keepDraft) {
  const draft = avStatisticsDraft(id); if (!draft.latest || draft.saving) return;
  avStatisticsAdopt(draft, draft.latest, keepDraft); draft.revision++;
  draft.notice = keepDraft ? '草稿已保留，请核对后再次保存；将以当前整份草稿替换服务器规则' : '已使用服务器最新规则';
  renderStatisticsRules(id);
}
async function saveStatisticsRules(id) {
  const draft = avStatisticsDraft(id); if (!draft.loaded || draft.saving || draft.conflict || !avStatisticsDirty(draft)) return;
  let rules;
  try { rules = avValidateStatisticsRules(draft.rules); }
  catch (e) { draft.error = e.message; avStatisticsUpdateStatus(id); return; }
  draft.saving = true; draft.error = ''; draft.notice = ''; renderStatisticsRules(id);
  try {
    const saved = avStatisticsSnapshot(await api('/admin-api/models/' + encodeURIComponent(id) + '/statistics-rules', { method: 'PUT', body: JSON.stringify({ version: draft.version, rules }) }));
    avStatisticsAdopt(draft, saved); draft.notice = '统计规则已保存';
    toast('统计规则已保存'); loadAvailability(true);
    await refreshRateAdjustmentDisplay(id);
  } catch (e) {
    draft.error = '保存失败：' + e.message;
    if (e.status === 409) {
      draft.conflict = true; draft.error = '服务器规则已被修改，当前草稿已保留。请核对最新版本后处理冲突。';
      try { draft.latest = avStatisticsSnapshot(await api('/admin-api/models/' + encodeURIComponent(id) + '/statistics-rules')); }
      catch (readError) { draft.latest = null; draft.error += ' 读取最新版本失败：' + readError.message; }
    }
  } finally { draft.saving = false; renderStatisticsRules(id); }
}
window.addEventListener('beforeunload', event => {
  if ([...AV_STATISTICS_DRAFTS.values()].some(draft => draft.saving || avStatisticsDirty(draft))) { event.preventDefault(); event.returnValue = ''; }
});
function selectRateAdjustment(selected) {
  const end = AV_EDIT.slots.at(-1)?.until || Date.now(), hours = Number(document.getElementById('av-edit-hours').value);
  document.querySelectorAll('[data-rate-slot]').forEach(el => el.checked = selected && !el.disabled && AV_EDIT.slots[Number(el.dataset.rateSlot)].until > end - hours * 3600000);
}
let AV_RESET = null, AV_RESET_LOAD = 0;
async function openRateReset(id, target = 'model') {
  const load = ++AV_RESET_LOAD;
  document.getElementById('dlgTitle').textContent = '重置成功率快照 · ' + ((window.__models || []).find(m => m.id === id)?.label || id);
  document.getElementById('dlgBody').innerHTML = '<p id="av-reset-loading" class="mut">读取重置对象…</p>';
  dlg.classList.remove('wide'); if (!dlg.open) dlg.showModal();
  try {
    const data = await api('/admin-api/models/' + encodeURIComponent(id) + '/rate-history?target=' + encodeURIComponent(target));
    if (load !== AV_RESET_LOAD || !document.getElementById('av-reset-loading')) return;
    AV_RESET = { id, ...data };
    document.getElementById('dlgBody').innerHTML = `<label>重置对象 <select id="av-reset-target" onchange="openRateReset(AV_RESET.id,this.value)">${data.targets.map(t => `<option value="${esc(t.key)}" ${t.key === data.key ? 'selected' : ''}>${esc(t.label)}</option>`).join('')}</select></label>
  <p>将清除所选对象保存的全部成功率快照（最多60天）、未完成采样和当前补录 / 修正数据。此操作不可撤销。</p><p class="mut">请求记录和按时段统计的实测数值保留；启用时从下一次采样重新形成快照。选择线路会重置该线路的客户端波形。</p>
  <p id="av-reset-error" role="status" class="bad-t"></p><div class="toolbar"><button onclick="dlg.close()">取消</button><span class="sp"></span><button class="danger" onclick="saveRateReset()">确认重置</button></div>`;
  } catch (e) { if (load === AV_RESET_LOAD && document.getElementById('av-reset-loading')) document.getElementById('av-reset-loading').textContent = e.message; }
}
async function saveRateReset() {
  const data = AV_RESET, error = document.getElementById('av-reset-error'), controls = [...document.querySelectorAll('#dlgBody button,#dlgBody select')]; controls.forEach(el => el.disabled = true); error.textContent = '重置中…';
  try {
    await api('/admin-api/models/' + encodeURIComponent(data.id) + '/rate-history/reset', { method: 'POST', body: JSON.stringify({ target: data.key, epoch: data.epoch }) });
    if (AV_RESET === data && document.getElementById('av-reset-target')) dlg.close(); toast('快照已重置，实测请求统计保留'); loadAvailability(true);
  } catch (e) { if (AV_RESET === data && document.getElementById('av-reset-error')) { error.textContent = e.message; controls.forEach(el => el.disabled = false); } }
}
async function saveRateAdjustment(restore) {
  const data = AV_EDIT, error = document.getElementById('av-edit-error');
  const selected = [...document.querySelectorAll('[data-rate-slot]:checked')].map(el => data.slots[Number(el.dataset.rateSlot)]);
  if (!selected.length) { error.textContent = '请先选择要调整的历史点'; return; }
  const raw = document.getElementById('av-edit-rate').value, rate = Number(raw), source = document.getElementById('av-edit-source').value, reason = document.getElementById('av-edit-reason').value.trim();
  if (!restore && (raw === '' || !Number.isFinite(rate) || rate < 0 || rate > 100 || reason.length < 3)) { error.textContent = '请填写 0–100 的成功率和至少 3 字的数据依据'; return; }
  const buttons = [...document.querySelectorAll('#av-history-content button,#av-history-content input,#av-history-content select')]; buttons.forEach(b => b.disabled = true); error.textContent = '保存中…';
  try {
    const result = await api('/admin-api/models/' + encodeURIComponent(data.id) + '/rate-history', { method: 'PUT', body: JSON.stringify({ target: data.key, epoch: data.epoch, edits: selected.map(p => ({ until: p.until, expectedId: p.edit?.id ?? null, ...(restore ? { restore: true } : { successRate: rate / 100, source, reason }) })) }) });
    if (AV_EDIT === data && document.getElementById('av-edit-target')) { AV_EDIT = { id: data.id, ...result }; renderRateAdjustment(); }
    toast(restore ? '已恢复原始快照' : '历史快照已保存，客户端显示来源标注'); loadAvailability(true);
  } catch (e) { if (AV_EDIT === data && document.getElementById('av-edit-error')) { buttons.forEach(b => b.disabled = false); error.textContent = e.message; } }
}
