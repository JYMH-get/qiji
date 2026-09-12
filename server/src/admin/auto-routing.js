/* Loaded in the admin page's existing authenticated session. All drafts save atomically. */
let AR = null, AR_MODELS = [], AR_HEALTH = {}, AR_PREVIEWS = [], AR_AVAILABILITY = [], AR_FAMILIES = [], AR_BASE = null, AR_FAMILY = "";
const AR_PRICE_OPEN = new Set();
async function loadRouting(){
  const el = document.getElementById('tab-routing');
  if(AR&&(AR_PENDING.size||AR_SAVING)){renderRouting();return;}
  el.innerHTML = '<p class="mut">读取线路配置…</p>';
  try {
    const data = await api('/admin-api/auto-routing');
    AR = data.initial; AR_BASE = structuredClone(data.config); AR_FAMILIES=data.families;
    const requested=decodeURIComponent(location.hash.replace(/^#routing\//,""));
    AR_FAMILY=AR_FAMILIES.some(f=>f.id===requested)?requested:AR_FAMILIES.some(f=>f.id===AR_FAMILY)?AR_FAMILY:AR_FAMILIES[0]?.id||"";
    AR_MODELS = data.models; AR_HEALTH = data.health; AR_PREVIEWS = data.previews; AR_AVAILABILITY = data.availability;
    renderRouting();
  } catch(e){ el.textContent = e.message; }
}
function arField(label, html){ return `<label class="fld"><span>${label}</span>${html}</label>`; }
function arNumber(label, value, handler, min=0, max=1000000){ return arField(label, `<input type="number" min="${min}" max="${max}" step="1" value="${value}" oninput="${handler}"/>`); }
function arModelOptions(line, current){
  return AR_MODELS.filter(m => m.familyId === line.familyId).map(m => `<option value="${esc(m.id)}" ${m.id===current?'selected':''}>${esc(m.channelName || m.channelId)} · ${esc(m.label)}${m.enabled?'':'（模型已停用）'}</option>`).join('');
}
function arPage(id){ AR_FAMILY=id; history.pushState(null,'','#routing/'+encodeURIComponent(id)); renderRouting(); }
function arAddLine(){
  document.getElementById('dlgTitle').textContent='新增线路';
  document.getElementById('dlgBody').innerHTML=`<div class="fgrid">${arField('所属家族',`<select id="ar-new-line-family">${AR_FAMILIES.map(f=>`<option value="${esc(f.id)}" ${f.id===AR_FAMILY?'selected':''}>${esc(f.name)}</option>`).join('')}</select>`)}${arField('线路名称',`<input id="ar-new-line-name" type="text" maxlength="30" placeholder="例如：临时线路、周末优惠"/>`)}</div><p class="mut">新线路默认未开放，创建和后续修改均会自动保存。配置渠道和价格后可对用户开放。</p><p id="ar-create-error" role="status" class="bad-t"></p><div class="toolbar"><span class="sp"></span><button onclick="dlg.close()">取消</button><button class="pri" onclick="arCreateLine()">创建线路</button></div>`;
  dlg.classList.remove('wide');dlg.showModal();document.getElementById('ar-new-line-name').focus();
}
function arCreateLine(){
  const family=AR_FAMILIES.find(f=>f.id===document.getElementById('ar-new-line-family').value),name=document.getElementById('ar-new-line-name').value.trim();
  if(!family||!name){document.getElementById('ar-create-error').textContent='请选择家族并填写线路名称';return;}
  if(AR.lines.some(l=>l.familyId===family.id&&l.name===name)){document.getElementById('ar-create-error').textContent='该家族已有同名线路，请使用其他名称';return;}
  const bytes=crypto.getRandomValues(new Uint8Array(16)),id='line-'+Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
  AR.lines.push({id,name,familyId:family.id,modelVersion:family.modelVersion,capability:family.capability,enabled:false,cost:0,members:[]});
  arChanged(family.id);dlg.close();arPage(family.id);document.querySelector('#tab-routing .card:last-child input[type="text"]')?.focus();
}
function arAddFamily(){
  document.getElementById('dlgTitle').textContent='新增家族';
  document.getElementById('dlgBody').innerHTML=`<div class="fgrid">${arField('家族名称','<input id="ar-new-family-name" type="text" maxlength="60" placeholder="例如：新视频模型"/>')}${arField('生成类型','<select id="ar-new-family-cap"><option value="video">视频</option><option value="image">图片</option></select>')}</div><p class="mut">创建后可为该家族添加线路。渠道模型的家族归属在“模型设置”中指定。</p><p id="ar-create-error" role="status" class="bad-t"></p><div class="toolbar"><span class="sp"></span><button onclick="dlg.close()">取消</button><button id="ar-family-submit" class="pri" onclick="arCreateFamily()">创建家族</button></div>`;
  dlg.classList.remove('wide');dlg.showModal();document.getElementById('ar-new-family-name').focus();
}
async function arCreateFamily(){
  const name=document.getElementById('ar-new-family-name').value.trim(),capability=document.getElementById('ar-new-family-cap').value,button=document.getElementById('ar-family-submit');
  if(!name){document.getElementById('ar-create-error').textContent='请填写家族名称';return;}
  button.disabled=true;
  try{
    const created=await api('/admin-api/families',{method:'POST',body:JSON.stringify({name,capability})});
    const family=created;
    FAMS=null;
    AR_FAMILIES.push({id:family.id,name:family.name,capability:family.capability,modelVersion:family.id});
    dlg.close();arPage(family.id);toast('家族已创建，可继续新增线路');
  }catch(e){document.getElementById('ar-create-error').textContent=e.message;button.disabled=false;}
}
function arEnabled(i,j,enabled){ AR.lines[i].members[j].enabled=enabled; renderRouting(); }
function arVipEnabled(i,j,enabled){ AR.lines[i].members[j].vipEnabled=enabled; renderRouting(); }
window.addEventListener('popstate',()=>{ if(location.hash.startsWith('#routing/')&&AR){ AR_FAMILY=decodeURIComponent(location.hash.slice(9)); if(CUR_TAB==='routing')renderRouting();else switchTab('routing'); } });
const arPublicKeys = i => AR.lines[i].capability==='image'?['aspect_ratio','resolution','quality']:['duration','resolution','aspect_ratio'];
function renderRouting(){
  const family=AR_FAMILIES.find(f=>f.id===AR_FAMILY) ?? AR_FAMILIES[0];
  if(!family)return;
  document.getElementById('pageTitle').textContent='自动路由 · '+family.name;
  document.getElementById('tab-routing').innerHTML = `
    <div class="card"><div class="hd"><h3>自动路由</h3><span class="sp"></span><span id="ar-save-status" role="status" class="mut"></span><button id="ar-save-retry" onclick="arRetrySave()" style="display:none">重试保存</button><button onclick="arReloadRouting()">重新加载</button></div>
    <div class="bd"><label><input data-ar-global="true" type="checkbox" ${AR.enabled?'checked':''} onchange="AR.enabled=this.checked"/> 启用线路选择</label>
    <p class="mut">用户选择家族 → 线路 → 参数。每个家族独立配置；图片分为低价、优惠、稳定线路；未开放或未绑定的渠道模型不能直接调用。</p>
    <p class="faint">同优先级按“在途生成数 ÷ 当前并发权重”选择负载最低的渠道，负载相同时轮换。同权重尽量保持相同并发，权重2约承担权重1的两倍；0不参与。按家族、线路分别统计，从选中渠道开始占用，任务结束释放；没有固定并发上限。生成慢的渠道因占用较多自然少接新单，不再按超时降频。明确渠道故障达到阈值后临时降低并发权重，处罚结束自动恢复；审核、用户参数错误、超时及结果未知不处罚。优先级数字越小越优先。</p>
    <p id="ar-message" role="status" class="mut">修改后自动保存；统一参数预览显示最近保存的配置。</p></div></div>
    <nav aria-label="路由家族" class="toolbar" style="flex-wrap:wrap">${AR_FAMILIES.map(f=>`<button ${f.id===family.id?'class="pri" aria-current="page"':''} onclick="arPage('${esc(f.id)}')">${esc(f.name)}</button>`).join('')}<button onclick="arAddFamily()">＋ 新增家族</button><button class="pri" onclick="arAddLine()">＋ 新增线路</button></nav>
    <div class="toolbar" style="margin:18px 0"><h2 style="font-size:18px">${esc(family.name)}</h2></div>
    <p class="faint">可为当前家族添加活动线路。填写名称、添加渠道并设置统一价格后开放，修改会自动保存。</p>
    ${AR.lines.map((l,i)=>l.familyId===family.id?arLine(l,i):'').join('')}
    ${AR.lines.some(l=>l.familyId===family.id)?'':'<div class="card"><div class="bd mut">该家族暂无线路，请点击上方“＋ 新增线路”创建。</div></div>'}`;
  arSaveStatus();
}
function arLine(l,i){
  const preview = AR_PREVIEWS.find(p=>p.id===l.id)?.model;
  const hasEnabledMember=l.members.some(r=>r.enabled&&r.concurrencyWeight>0);
  return `<div class="card" data-ar-family="${esc(l.familyId)}" data-ar-line="${esc(l.id)}"><div class="hd"><h3 data-ar-title>${esc(l.name.endsWith('线路')?l.name:l.name+'线路')}</h3><span data-ar-open class="badge ${l.enabled&&hasEnabledMember?'ok':'plain'}">${!l.enabled?'未开放':hasEnabledMember?'开放':'暂无启用渠道'}</span><span class="sp"></span>

    <label><input type="checkbox" ${l.enabled?'checked':''} onchange="AR.lines[${i}].enabled=this.checked"/> 对用户开放</label></div>
    <div class="bd"><div class="fgrid">
      ${arField('线路名称',`<input type="text" value="${esc(l.name)}" maxlength="30" oninput="AR.lines[${i}].name=this.value"/>`)}
      ${arField('统一计费方式',`<select onchange="arBilling(${i},this.value)">${l.capability!=='image'?`<option value="tiers" ${l.prices?'selected':''}>自定义档位价（时长 × 分辨率）</option>`:''}<option value="fixed" ${!l.prices && l.costPerUnit===undefined?'selected':''}>按次</option>${l.capability!=='image'?`<option value="second" ${l.costPerUnit!==undefined?'selected':''}>按秒</option>`:''}</select>`)}
      ${l.prices ? `<div class="fld"><span>价格填充</span><button onclick="arHighest(${i})">${l.members.filter(r=>r.enabled&&r.concurrencyWeight>0).length===1?'按当前模型价格填充':'按候选渠道最高价填充'}</button></div><div class="fld"><span aria-hidden="true">&nbsp;</span><button onclick="arCustomPrices(${i})">补齐当前档位</button></div>` : arNumber(l.costPerUnit===undefined?'统一价格（积分/次）':'统一价格（积分/秒）',l.costPerUnit ?? l.cost,`arPrice(${i},Number(this.value))`)}
    </div>
    ${l.prices ? arPriceTable(l,i) : ''}
    <p class="faint" data-ar-preview>${preview ? preview.params.map(p=>esc(p.label)+': '+(p.options||[]).map(esc).join(' / ')).join('　｜　')+(preview.methods?.length?'　｜　方法: '+preview.methods.map(esc).join(' / '):'') : '保存后显示可用参数；无候选渠道的线路保持未开放。'}</p>
    <p class="faint">渠道开关仅控制本线路的新请求，保存后生效；禁用不删除配置、不影响已在途任务。全部渠道禁用时，用户端隐藏该线路。VIP开关为预留配置，默认关闭，目前仅保存设置，不改变现有用户路由。</p>
    <div class="tblwrap"><table><thead><tr><th>渠道模型</th><th>渠道启用 / 禁用</th><th>VIP用户（预留）</th><th>优先级</th><th>并发权重</th><th>失败次数阈值</th><th>统计窗口（秒）</th><th>处罚时长（秒）</th><th>故障保留并发（%）</th><th>运行状态</th><th></th></tr></thead>
    <tbody>${l.members.map((r,j)=>arMember(l,i,r,j)).join('')}</tbody></table></div>
    <button onclick="arAdd(${i})">＋ 添加渠道</button>
    ${l.members.map((r,j)=>arDefaults(i,r,j)).join('')}
    </div></div>`;
}
function arMember(l,i,r,j){
  const model = AR_MODELS.find(m=>m.id===r.modelId), h = AR_HEALTH[l.id+'/'+model?.channelId];
  const live = AR_AVAILABILITY.find(x=>x.lineId===l.id && x.modelId===r.modelId);
  const seconds = Math.max(0, Math.ceil(((live?.penaltyUntil||0)-Date.now())/1000));
  const number = (key,min,max)=>`<input style="width:76px" type="number" min="${min}" max="${max}" step="${key==='concurrencyWeight'?0.01:1}" aria-label="${key}" value="${r[key]}" oninput="AR.lines[${i}].members[${j}].${key}=Number(this.value)"/>`;
  return `<tr><td><select aria-label="渠道模型" style="max-width:260px" onchange="arChoose(${i},${j},this.value)">${arModelOptions(l,r.modelId)}</select></td>
    <td><label style="white-space:nowrap"><input aria-label="渠道启用" type="checkbox" ${r.enabled?'checked':''} onchange="arEnabled(${i},${j},this.checked)"/> ${r.enabled?'启用':'禁用'}</label></td>
    <td><label style="white-space:nowrap"><input aria-label="VIP用户启用（预留）" type="checkbox" ${r.vipEnabled?'checked':''} onchange="arVipEnabled(${i},${j},this.checked)"/> ${r.vipEnabled?'启用':'禁用'}</label></td>
    <td>${number('priority',0,1000)}</td><td>${number('concurrencyWeight',0,100)}</td><td>${number('failureThreshold',1,1000)}</td><td>${number('failureWindowSec',1,86400)}</td><td>${number('cooldownSec',1,86400)}</td><td>${number('failureRetainPercent',0,100)}</td>
    <td><span class="badge ${!r.enabled?'plain':seconds?'run':'ok'}">${!r.enabled?'渠道已禁用':live?.status==='disabled'?'未参与':seconds?(live?.status==='cooling'?'暂停 ':'并发减少 ')+seconds+' 秒':'正常'}</span><div class="sub">在途 ${live?.active||0} · 分配 ${h?.selected||0} · 成功 ${h?.succeeded||0} · 渠道失败 ${h?.failed||0}</div></td>
    <td><button onclick="arReset(${i},${j})">恢复路由</button> <button onclick="arRemove(${i},${j})">移除</button></td></tr>`;
}
function arDefaults(i,r,j){
  const m = AR_MODELS.find(m=>m.id===r.modelId);
  const fields = (m?.params||[]).filter(p=>!arPublicKeys(i).includes(p.key));
  if (!fields.length) return '';
  return `<details style="margin-top:12px"><summary style="cursor:pointer">${esc(m.channelName || m.channelId)} · 特殊字段默认值</summary><div class="fgrid" style="margin-top:12px">${fields.map((p,k)=>{
    const v = r.defaults[p.key] ?? p.default;
    const change = `arDefault(${i},${j},${k},this.value)`;
    let control;
    if (p.type==='enum' || p.type==='boolean') {
      const options = p.type==='boolean'?['true','false']:p.options||[];
      control = `<select onchange="${change}">${options.map(x=>`<option value="${esc(x)}" ${String(v)===x?'selected':''}>${esc(x)}</option>`).join('')}</select>`;
    } else control = `<input type="${p.type==='number'?'number':'text'}" value="${esc(String(v??''))}" oninput="${change}"/>`;
    return arField(esc(p.label)+' · '+esc(p.key),control);
  }).join('')}</div><p class="faint">留用模型默认值，或在此显式覆盖。用户的时长、比例、分辨率始终按统一参数原样传递。</p></details>`;
}
function arDefault(i,j,k,value){
  const r = AR.lines[i].members[j], m = AR_MODELS.find(m=>m.id===r.modelId);
  const p = m.params.filter(p=>!arPublicKeys(i).includes(p.key))[k];
  r.defaults[p.key] = p.type==='boolean'?value==='true':p.type==='number'?Number(value):value;
}
function arChoose(i,j,id){ AR.lines[i].members[j].modelId=id; AR.lines[i].members[j].defaults={}; renderRouting(); }
function arAdd(i){
  const l = AR.lines[i], used = new Set(l.members.map(r=>AR_MODELS.find(m=>m.id===r.modelId)?.channelId));
  const m = AR_MODELS.find(m=>m.familyId===l.familyId && !used.has(m.channelId));
  if (!m) { toast('没有可添加的同家族渠道','bad'); return; }
  l.members.push({modelId:m.id,enabled:false,vipEnabled:false,priority:0,concurrencyWeight:1,failureThreshold:3,failureWindowSec:300,cooldownSec:300,failureRetainPercent:50,defaults:{}}); arChanged(l.familyId);renderRouting();
}
function arBilling(i,kind){ const l=AR.lines[i]; if(kind==='tiers'){arCustomPrices(i);return;} delete l.prices; if(kind==='second') l.costPerUnit=l.cost; else {l.cost=l.costPerUnit??l.cost;delete l.costPerUnit;} arChanged(l.familyId);renderRouting(); }
function arCustomPrices(i){
  const l=AR.lines[i],models=l.members.filter(r=>r.enabled&&r.concurrencyWeight>0).map(r=>AR_MODELS.find(m=>m.id===r.modelId)).filter(m=>m&&m.enabled!==false);
  const accepts=(p,v)=>p?.type==='enum'?p.options?.includes(String(v)):p?.type==='number'&&Number(v)>=(p.min??-Infinity)&&Number(v)<=(p.max??Infinity)&&(!p.step||Math.abs((Number(v)-(p.min??0))/p.step-Math.round((Number(v)-(p.min??0))/p.step))<1e-7);
  const durations=Array.from({length:120},(_,k)=>String(k+1)).filter(v=>models.length&&models.some(m=>accepts(m?.params.find(p=>p.key==='duration'),v)));
  const resolutions=[...new Set(models.flatMap(m=>m.params.find(p=>p.key==='resolution')?.options||[]))];
  if(!durations.length||!resolutions.length){toast('请先启用具有可用参数的渠道模型','bad');renderRouting();return;}
  const previous=l.prices||[];
  const generated=durations.flatMap(duration=>resolutions.filter(resolution=>models.some(m=>accepts(m.params.find(p=>p.key==='duration'),duration)&&accepts(m.params.find(p=>p.key==='resolution'),resolution))).map(resolution=>({when:{duration,resolution},cost:previous.find(p=>Object.entries(p.when).every(([k,v])=>({duration,resolution})[k]===v))?.cost??(l.costPerUnit===undefined?l.cost:Math.round(l.costPerUnit*Number(duration)))})));
  l.prices=[...previous,...generated.filter(p=>!previous.some(old=>old.when.duration===p.when.duration&&old.when.resolution===p.when.resolution))];
  delete l.costPerUnit;arSyncFallback(l);arChanged(l.familyId);renderRouting();
}
function arSyncFallback(l){if(l.prices?.length)l.cost=Math.max(...l.prices.map(p=>p.cost));}
function arTierPrice(i,k,input){
  const n=Number(input.value);if(input.value.trim()===''||!Number.isFinite(n)||n<0){input.setCustomValidity('请输入非负价格');return;}
  input.setCustomValidity('');AR.lines[i].prices[k].cost=n;arSyncFallback(AR.lines[i]);
}
function arBulkPrice(i,column){
  const l=AR.lines[i],resolution=[...new Set(l.prices.map(p=>p.when.resolution))][column];
  const input=document.getElementById(`ar-rate-${i}-${column}`),unit=document.getElementById(`ar-rate-unit-${i}-${column}`).value,n=Number(input.value);
  if(input.value.trim()===''||!Number.isFinite(n)||n<0){toast('请输入非负单价','bad');return;}
  for(const p of l.prices)if(p.when.resolution===resolution)p.cost=unit==='second'?Math.round(n*Number(p.when.duration)):n;
  arSyncFallback(l);arChanged(l.familyId);renderRouting();
}
function arPriceTable(l,i){
  const durations=[...new Set(l.prices.map(p=>p.when.duration))],resolutions=[...new Set(l.prices.map(p=>p.when.resolution))];
  return `<details style="margin-top:16px" ${AR_PRICE_OPEN.has(l.id)?'open':''} ontoggle="if(!this.isConnected)return;if(this.open)AR_PRICE_OPEN.add(AR.lines[${i}].id);else AR_PRICE_OPEN.delete(AR.lines[${i}].id)"><summary style="cursor:pointer">自定义档位价格（${l.prices.length} 档，积分/次）</summary><p class="faint">直接修改每个格子的价格，修改后自动保存。也可按分辨率批量填入每秒或每次单价。</p>
    <div class="tblwrap"><table><thead><tr><th scope="col">时长</th>${resolutions.map(r=>`<th scope="col">${esc(r)}</th>`).join('')}</tr>
    <tr><th scope="row">批量设置</th>${resolutions.map((r,k)=>`<td><input id="ar-rate-${i}-${k}" aria-label="${esc(l.name+' '+r)} 批量单价" type="number" min="0" step="any" placeholder="输入单价" style="width:100px"/><select id="ar-rate-unit-${i}-${k}" aria-label="${esc(l.name+' '+r)} 单价单位"><option value="second">积分/秒</option><option value="fixed">积分/次</option></select><button onclick="arBulkPrice(${i},${k})">应用</button></td>`).join('')}</tr></thead>
    <tbody>${durations.map(d=>`<tr><th scope="row">${esc(d)} 秒</th>${resolutions.map(r=>{const k=l.prices.findIndex(p=>p.when.duration===d&&p.when.resolution===r);return k<0?'<td>—</td>':`<td><input aria-label="${esc(l.name+' '+d+'秒 '+r)} 价格" type="number" min="0" step="any" value="${l.prices[k].cost}" style="width:110px" oninput="arTierPrice(${i},${k},this)"/></td>`;}).join('')}</tr>`).join('')}</tbody></table></div></details>`;
}
async function arHighest(i){ const line=AR.lines[i],snapshot=JSON.stringify(line);try { const prices=await api('/admin-api/auto-routing/prices',{method:'POST',body:snapshot});if(!AR.lines.includes(line))return;if(JSON.stringify(line)!==snapshot){toast('线路已修改，本次填充未覆盖新修改，请重试','bad');return;}delete line.costPerUnit;delete line.prices;Object.assign(line,prices);arChanged(line.familyId);renderRouting(); } catch(e){toast(e.message,'bad');} }
function arPrice(i,n){ const l=AR.lines[i]; if(l.costPerUnit===undefined) l.cost=n; else l.costPerUnit=n; }
// Debounce per family, serialize versioned writes, and keep newer edits during an in-flight save.
const AR_PENDING=new Map();
let AR_SAVE_TIMER=null, AR_SAVING=false, AR_REVISION=0;
function arChanged(familyId){
  AR_PENDING.set(familyId,{revision:++AR_REVISION,readyAt:Date.now()+800,error:''});
  arSaveStatus();arScheduleSave();
}
function arSaveStatus(){
  const errors=[...AR_PENDING].filter(([,s])=>s.error);
  const label=document.getElementById('ar-save-status'),message=document.getElementById('ar-message'),retry=document.getElementById('ar-save-retry');
  if(label)label.textContent=errors.length?'保存失败':AR_SAVING?'保存中…':AR_PENDING.size?'等待自动保存…':'已保存';
  if(retry)retry.style.display=errors.length?'':'none';
  if(message)message.textContent=errors.length?errors.map(([id,s])=>(id==='__global'?'线路总开关':AR_FAMILIES.find(f=>f.id===id)?.name||id)+'：'+s.error).join('；')+'。修改已保留，可修正后自动保存或点击重试。':'修改后自动保存；切换家族保留待保存修改，统一参数预览显示最近保存的配置。';
}
function arScheduleSave(){
  clearTimeout(AR_SAVE_TIMER);if(AR_SAVING)return;
  const pending=[...AR_PENDING.values()].filter(s=>!s.error);
  if(pending.length)AR_SAVE_TIMER=setTimeout(arFlushSave,Math.max(0,Math.min(...pending.map(s=>s.readyAt))-Date.now()));
}
async function arFlushSave(){
  if(AR_SAVING)return;
  const next=[...AR_PENDING].find(([,s])=>!s.error&&s.readyAt<=Date.now());
  if(!next){arScheduleSave();return;}
  const [familyId,state]=next,revision=state.revision;
  const current=structuredClone(AR.lines.filter(l=>l.familyId===familyId)),existing=new Set(AR_BASE.lines.map(l=>l.id));
  const payload=structuredClone(AR_BASE);
  if(familyId==='__global')payload.enabled=AR.enabled;
  else payload.lines=[...payload.lines.map(l=>l.familyId===familyId?current.find(c=>c.id===l.id):l).filter(Boolean),...current.filter(l=>!existing.has(l.id))];
  AR_SAVING=true;arSaveStatus();
  try{
    const result=await api('/admin-api/auto-routing',{method:'PUT',body:JSON.stringify(payload)});
    AR_BASE=structuredClone(result.config);AR.version=AR_BASE.version;MODES=null;
    if(AR_PENDING.get(familyId)?.revision===revision)AR_PENDING.delete(familyId);
    // Refresh derived data without rebuilding inputs or losing keyboard focus.
    try{const data=await api('/admin-api/auto-routing');AR_PREVIEWS=data.previews;AR_AVAILABILITY=data.availability;AR_HEALTH=data.health;arRefreshLineSummaries();}catch{}
  }catch(e){
    const pending=AR_PENDING.get(familyId);
    if(pending?.revision===revision)pending.error=e.message;
  }finally{AR_SAVING=false;arSaveStatus();arScheduleSave();}
}
function arRetrySave(){for(const state of AR_PENDING.values()){state.error='';state.readyAt=0;}arSaveStatus();arScheduleSave();}
function arReloadRouting(){
  if(AR_SAVING){toast('正在保存，请稍后重新加载');return;}
  if(AR_PENDING.size){confirmDo({title:'重新加载路由配置',text:'仍有未保存的修改。重新加载将放弃这些修改，读取服务端配置。',okLabel:'放弃修改并重新加载',onOk:()=>{if(AR_SAVING){toast('正在保存，请稍后重试');return;}clearTimeout(AR_SAVE_TIMER);AR_PENDING.clear();loadRouting();}});return;}
  loadRouting();
}
function arRemove(i,j){const line=AR.lines[i];line.members.splice(j,1);arChanged(line.familyId);renderRouting();}
function arRefreshLineSummaries(){
  for(const card of document.querySelectorAll('#tab-routing [data-ar-line]')){
    const line=AR.lines.find(l=>l.id===card.dataset.arLine);if(!line)continue;
    const title=card.querySelector('[data-ar-title]');if(title)title.textContent=line.name.endsWith('线路')?line.name:line.name+'线路';
    const badge=card.querySelector('[data-ar-open]'),available=line.members.some(r=>r.enabled&&r.concurrencyWeight>0);
    if(badge){badge.className='badge '+(line.enabled&&available?'ok':'plain');badge.textContent=!line.enabled?'未开放':available?'开放':'暂无启用渠道';}
    const preview=AR_PREVIEWS.find(p=>p.id===line.id)?.model,host=card.querySelector('[data-ar-preview]');
    if(host)host.textContent=preview?preview.params.map(p=>p.label+': '+(p.options||[]).join(' / ')).join('　｜　')+(preview.methods?.length?'　｜　方法: '+preview.methods.join(' / '):''):'自动保存后显示可用参数；无候选渠道的线路保持未开放。';
  }
}
for(const event of ['input','change'])document.addEventListener(event,e=>{
  const field=e.target;if(!field.matches('input,select,textarea'))return;
  const familyId=field.hasAttribute('data-ar-global')?'__global':field.closest('[data-ar-family]')?.dataset.arFamily;
  if(familyId){arChanged(familyId);arRefreshLineSummaries();}
});
window.addEventListener('beforeunload',e=>{if(AR_PENDING.size||AR_SAVING){e.preventDefault();e.returnValue='';}});

async function arReset(i,j){
  const l=AR.lines[i], m=AR_MODELS.find(m=>m.id===l.members[j].modelId);
  try { await api('/admin-api/auto-routing/reset',{method:'POST',body:JSON.stringify({lineId:l.id,channelId:m.channelId})}); const data=await api('/admin-api/auto-routing'); AR_HEALTH=data.health; AR_AVAILABILITY=data.availability; renderRouting(); toast('已恢复路由'); }
  catch(e){ toast(e.message,'bad'); }
}

let AV=null,AV_CAP='image',AV_FAMILIES={},AV_PAGE=0,AV_NEXT=0,AV_BUSY=false;
const AV_LABELS={image:'图像模型',video:'视频模型',text:'文本模型',audio:'音频模型'};
const AV_STATES={available:['可用','ok'],unavailable:['异常','bad'],attention:['需观察','warn'],unknown:['暂无样本','plain'],disabled:['已停用','plain']};
const avWeight=values=>!values.length?'—':values.length===1?String(Number(values[0].toFixed(2))):Number(values[0].toFixed(2))+'–'+Number(values.at(-1).toFixed(2));
async function loadAvailability(){
 if(AV_BUSY)return;AV_BUSY=true;
 const el=document.getElementById('tab-availability');if(!AV)el.innerHTML='<p class="mut">读取渠道可用性…</p>';
 try{const data=await api('/admin-api/channel-availability');AV=data;AV_NEXT=Date.now()+60000;if(CUR_TAB==='availability')renderAvailability();}
 catch(e){if(!AV)el.textContent=e.message;else toast('可用性刷新失败：'+e.message,'bad');AV_NEXT=Date.now()+60000;}
 finally{AV_BUSY=false;}
}
function avCapability(value){AV_CAP=value;AV_PAGE=0;renderAvailability();}
function avFamily(value){AV_FAMILIES[AV_CAP]=value;AV_PAGE=0;renderAvailability();}
function renderAvailability(){
 if(!AV)return;
 const all=AV.rows.filter(r=>r.capability===AV_CAP),families=[...new Map(all.map(r=>[r.familyId,r.familyName])).entries()];
 if(!families.some(([id])=>id===AV_FAMILIES[AV_CAP]))AV_FAMILIES[AV_CAP]=families[0]?.[0]??'';
 const filtered=all.filter(r=>r.familyId===AV_FAMILIES[AV_CAP]),pages=Math.max(1,Math.ceil(filtered.length/12));AV_PAGE=Math.min(AV_PAGE,pages-1);
 const arg=value=>esc(JSON.stringify(value));
 const cards=filtered.slice(AV_PAGE*12,(AV_PAGE+1)*12).map(r=>{
  const [status,tone]=AV_STATES[r.status]||AV_STATES.unknown;
  const percent=r.successRate==null?'—':(r.successRate*100).toFixed(1)+'%';
  const color=r.successRate==null?'var(--faint)':r.successRate>=.95?'var(--ok)':r.successRate>=.6?'var(--warn)':'var(--bad)';
  const empty=Array.from({length:60-r.history.length},()=>'<span aria-hidden="true" class="av-bar empty" title="暂无记录"></span>').join('');
  const bars=r.history.map(h=>{
   const label=h.status==='success'?'成功':h.status==='running'?'在途':h.failureKind==='user'?'用户原因失败':h.failureKind==='channel'?'渠道故障':'失败，原因待确认';
   const kind=h.status==='success'?'ok':h.status==='running'?'running':h.failureKind==='user'?'warn':'bad';
   return `<span aria-hidden="true" class="av-bar ${kind}" title="${esc(new Date(h.at).toLocaleString())} · ${label}${h.durationMs==null?'':' · '+Math.round(h.durationMs/1000)+'秒'}"></span>`;
  }).join('');
  return `<article class="av-card" aria-label="${esc(r.channelName+' · '+r.modelName)}">
   <header class="av-card-head"><span class="av-symbol" aria-hidden="true">${esc(r.familyName.slice(0,2))}</span><div class="av-name"><h3>${esc(r.modelName)}</h3><div class="mut">${esc(r.channelName)} <span class="av-family">${esc(r.familyName)}</span></div></div><span class="badge ${tone}">${status}</span></header>
   <div class="av-metrics"><div><span>近1小时请求</span><strong>${r.requests}<small>次</small></strong></div><div><span>当前在途</span><strong>${r.active}<small>个</small></strong></div></div>
   <div class="av-rate"><span>近1小时成功率<small>成功 ${r.success} · 失败 ${r.failed}</small></span><strong style="color:${color}">${percent}</strong></div>
   <div class="av-weight"><span>权重 <b>${avWeight(r.configuredWeights)}</b></span><span>当前权重 <b>${avWeight(r.effectiveWeights)}</b></span></div>
   <div class="av-history-title"><span>最近60次记录</span><span>7天内 · ${r.history.length} 次</span></div><div class="av-bars" role="img" aria-label="最近${r.history.length}次请求结果，按时间从旧到新">${empty}${bars}</div><div class="av-history-axis"><span>较早</span><span>最近</span></div>
  </article>`;
 }).join('');
 document.getElementById('tab-availability').innerHTML=`
 <style>
 .av-nav{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 16px}.av-nav button[aria-selected=true]{background:var(--acc-dim);border-color:var(--acc);color:var(--text)}
 .av-top{display:flex;align-items:center;gap:12px;margin-bottom:18px;flex-wrap:wrap}.av-top .mut{margin-left:auto}.av-family-nav{padding:12px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}
 .av-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px}.av-card{padding:24px;background:var(--panel);border:1px solid var(--line2);border-radius:var(--r-lg);min-width:0}
 .av-card-head{display:flex;align-items:center;gap:12px;margin-bottom:22px}.av-symbol{display:grid;place-items:center;width:44px;height:44px;flex-shrink:0;border:1px solid var(--line2);border-radius:12px;background:var(--acc-dim);color:var(--acc);font-weight:700}
 .av-name{min-width:0;flex:1}.av-name h3{margin:0 0 4px;font-size:18px;overflow-wrap:anywhere}.av-name .mut{font-size:12px;overflow-wrap:anywhere}.av-family{display:inline-block;color:var(--acc);margin-left:8px}.av-card-head>.badge{flex-shrink:0}
 .av-metrics{display:grid;grid-template-columns:1fr 1fr;gap:12px}.av-metrics>div{padding:14px 16px;border:1px solid var(--line);border-radius:var(--r-md);background:var(--panel2)}.av-metrics span{display:block;color:var(--mut);font-size:12px}.av-metrics strong{display:block;font-size:25px;margin-top:8px;font-variant-numeric:tabular-nums}.av-metrics small{font-size:12px;font-weight:400;color:var(--mut);margin-left:5px}
 .av-rate{display:flex;justify-content:space-between;align-items:center;gap:12px;border-bottom:1px solid var(--line);padding:20px 0 16px}.av-rate>span{color:var(--mut);font-size:13px}.av-rate small{display:block;font-size:11px;color:var(--faint);margin-top:4px}.av-rate strong{font-size:34px;font-variant-numeric:tabular-nums;white-space:nowrap}
 .av-weight{display:flex;justify-content:space-between;padding:14px 0;color:var(--mut);font-size:12px}.av-weight b{color:var(--text);margin-left:8px}.av-history-title,.av-history-axis{display:flex;justify-content:space-between;color:var(--mut);font-size:11px}.av-history-title{margin-top:4px}.av-history-axis{color:var(--faint);font-size:10px;margin-top:5px}
 .av-bars{display:flex;gap:3px;align-items:end;height:32px;margin-top:8px}.av-bar{flex:1;min-width:0;border-radius:2px;height:20px;background:var(--line2)}.av-bar.empty{height:4px}.av-bar.ok{background:var(--ok);height:24px}.av-bar.bad{background:var(--bad);height:14px}.av-bar.warn{background:var(--warn);height:14px}.av-bar.running{background:var(--info);height:18px}
 .av-bottom{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-top:18px}.av-legend{display:flex;gap:14px;color:var(--mut);font-size:12px;flex-wrap:wrap}.av-legend i{display:inline-block;width:7px;height:7px;border-radius:2px;margin-right:5px}.av-note{color:var(--faint);font-size:12px;margin-top:12px}
 @media(max-width:1050px){.av-grid{grid-template-columns:1fr}}@media(max-width:520px){.av-card{padding:16px}.av-rate strong{font-size:28px}}
 </style>
 <div class="av-top"><nav class="av-nav" role="tablist" aria-label="模型用途" style="margin:0">${Object.entries(AV_LABELS).map(([id,label])=>`<button role="tab" aria-selected="${id===AV_CAP}" onclick="avCapability(${arg(id)})">${label}</button>`).join('')}</nav><span class="mut" id="av-countdown">60秒后刷新</span><button onclick="loadAvailability()">刷新</button></div>
 <nav class="av-nav av-family-nav" role="tablist" aria-label="模型家族">${families.map(([id,name])=>`<button role="tab" aria-selected="${id===AV_FAMILIES[AV_CAP]}" onclick="avFamily(${arg(id)})">${esc(name)} <span class="faint">${all.filter(r=>r.familyId===id).length}</span></button>`).join('')||'<span class="mut">暂无家族</span>'}</nav>
 <div class="av-grid">${cards||'<p class="mut">该用途暂无渠道模型</p>'}</div>
 <div class="av-bottom"><div class="av-legend"><span><i style="background:var(--ok)"></i>成功</span><span><i style="background:var(--bad)"></i>失败</span><span><i style="background:var(--warn)"></i>用户原因</span><span><i style="background:var(--info)"></i>在途</span></div><div><button onclick="AV_PAGE--;renderAvailability()" ${AV_PAGE===0?'disabled':''}>上一页</button> <span>${AV_PAGE+1} / ${pages}</span> <button onclick="AV_PAGE++;renderAvailability()" ${AV_PAGE>=pages-1?'disabled':''}>下一页</button></div></div>
 <p class="av-note">成功率按近60分钟已结束请求计算；在途包含更早提交的请求。权重显示现有配置范围，未配置为 —。更新时间 ${esc(new Date(AV.until).toLocaleTimeString())}</p>`;
}
setInterval(()=>{if(CUR_TAB!=='availability'||document.hidden||!AV)return;const seconds=Math.max(0,Math.ceil((AV_NEXT-Date.now())/1000));const label=document.getElementById('av-countdown');if(label)label.textContent=AV_BUSY?'刷新中…':seconds+'秒后刷新';if(!seconds&&!AV_BUSY)loadAvailability();},1000);
