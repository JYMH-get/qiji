/* 源站统一维护分组价格；草稿以分组+线路隔离，冲突时保留输入。 */
const groupPriceUI={groupId:'',data:null,groups:[],category:'video',query:'',epoch:0,drafts:new Map(),saving:new Set()};
const signedOffset=n=>(n>=0?'+':'')+Number(n||0);
function openNewPriceGroupDlg(){
  $('#dlgTitle').textContent='新增分组';
  $('#dlgBody').innerHTML='<label class="fld"><span>分组名称</span><input type="text" id="new-price-group" aria-label="分组名称" maxlength="60"></label><div class="toolbar" style="margin-top:16px"><span class="mut">进货价和用户售价默认沿用源站价格（+0）。</span><span class="sp"></span><button class="pri" onclick="createPriceGroup()">创建分组</button></div>';
  dlg.classList.remove('wide');if(!dlg.open)dlg.showModal();
}
async function createPriceGroup(){
  const name=$('#new-price-group').value.trim();if(!name){toast('请填写分组名称','bad');return;}
  try{const result=await api('/admin-api/agent-groups',{method:'POST',body:JSON.stringify({name})});void loadAgents();await openGroupPriceSettings(result.id);}catch(e){toast(e.message,'bad');}
}
async function openGroupPriceSettings(id){
  const epoch=++groupPriceUI.epoch;
  $('#dlgTitle').textContent='分组设置';dlg.classList.add('wide');if(!dlg.open)dlg.showModal();
  $('#dlgBody').innerHTML='<p class="mut">正在读取分组价格…</p>';
  try{
    const groups=await api('/admin-api/agent-groups');
    const groupId=id||groupPriceUI.groupId||groups.defaultGroupId;
    const chosen=groups.items.some(g=>g.id===groupId)?groupId:groups.defaultGroupId;
    const data=await api('/admin-api/agent-groups/'+encodeURIComponent(chosen)+'/prices');
    if(epoch!==groupPriceUI.epoch||!dlg.open)return;
    Object.assign(groupPriceUI,{groupId:chosen,groups:groups.items,data});renderGroupPrices();
  }catch(e){if(epoch===groupPriceUI.epoch&&dlg.open)$('#dlgBody').innerHTML=`<p class="bad-t">${esc(e.message)}</p><button onclick="openGroupPriceSettings()">重试</button>`;}
}
function renderGroupPrices(){
  const s=groupPriceUI,g=s.groups.find(g=>g.id===s.groupId),cats=[['text','文本'],['image','图像'],['video','视频'],['audio','音频'],['other','其他']];
  const kind=r=>cats.some(([k])=>k===r.capability)?r.capability:'other';
  const rows=s.data.rows.filter(r=>kind(r)===s.category&&(!s.query||(r.name+' '+r.familyName).toLowerCase().includes(s.query.toLowerCase())));
  $('#dlgBody').innerHTML=`<div class="gp-head"><select aria-label="价格分组" onchange="openGroupPriceSettings(this.value)">${s.groups.map(g=>`<option value="${esc(g.id)}" ${g.id===s.groupId?'selected':''}>${esc(g.name)}</option>`).join('')}</select><input type="text" id="gp-name" aria-label="修改分组名称" value="${esc(g.name)}"><button onclick="savePriceGroupName()">保存名称</button><span class="mut">${g.memberCount} 个成员${g.platformIn?' · 含源站':''}</span><span class="sp"></span><button onclick="openGroupPriceSettings()">刷新价格</button></div>
    <p class="mut gp-rule">实际价格 = 源站基准价 + 分组偏移量。+0 沿用源站，负偏移最低减至 0；按秒、按次和文本计价分别使用下方单位。</p>
    <div class="gp-head"><nav>${cats.map(([k,n])=>`<button aria-pressed="${s.category===k}" data-gp-category="${k}">${n} ${s.data.rows.filter(r=>kind(r)===k).length}</button>`).join('')}</nav><input type="text" aria-label="搜索分组线路" placeholder="搜索线路或家族" value="${esc(s.query)}" onchange="groupPriceUI.query=this.value;renderGroupPrices()"></div>
    <div class="gp-lines">${rows.map(r=>{
      const key=s.groupId+':'+r.id,d=s.drafts.get(key),busy=s.saving.has(key);
      return `<article class="gp-line" data-gp-line="${esc(r.id)}"><h3>${esc(r.name)} <small>${esc(r.familyName)}</small></h3><div class="gp-table"><table><thead><tr><th>计价档位</th><th>源站基准价</th><th>进货价偏移</th><th>用户售价偏移</th><th>当前生效价格<br><small>进货 / 售价</small></th></tr></thead><tbody>${r.fields.map(f=>`<tr><td>${esc(f.label)}<small>${esc(f.unit)}</small></td><td>${esc(f.value??f.range??'—')}</td>${['purchase','retail'].map(layer=>`<td><input type="text" inputmode="decimal" aria-label="${esc(r.name+' '+f.label+' '+(layer==='purchase'?'进货价偏移':'用户售价偏移'))}" data-gp-layer="${layer}" data-gp-field="${esc(f.key)}" value="${esc(d?.[layer]?.[f.key]??signedOffset(f[layer+'Offset']))}" ${busy?'disabled':''}></td>`).join('')}<td>${esc(f.purchase??f.purchaseRange??'—')} / ${esc(f.retail??f.retailRange??'—')}</td></tr>`).join('')}</tbody></table></div><div class="gp-actions"><span class="mut" role="status">${esc(d?.error||(d?'有未保存修改':''))}</span><button data-gp-action="discard" ${!d||busy?'disabled':''}>撤销输入</button><button class="pri" data-gp-action="save" ${!d||busy?'disabled':''}>${busy?'保存中…':'保存本线路'}</button></div></article>`;
    }).join('')||'<p class="mut">暂无匹配线路</p>'}</div>`;
  const host=$('#dlgBody');
  host.oninput=e=>{const input=e.target,layer=input.dataset.gpLayer;if(!layer)return;const id=input.closest('[data-gp-line]').dataset.gpLine,row=s.data.rows.find(r=>r.id===id),key=s.groupId+':'+id;
    let d=s.drafts.get(key);if(!d){d={revision:row.revision,purchase:{},retail:{},error:''};s.drafts.set(key,d);}d[layer][input.dataset.gpField]=input.value;d.error='';
    input.closest('article').querySelectorAll('[data-gp-action]').forEach(b=>b.disabled=false);input.closest('article').querySelector('[role=status]').textContent='有未保存修改';};
  host.onclick=e=>{const b=e.target.closest('button');if(!b||b.disabled)return;if(b.dataset.gpCategory){s.category=b.dataset.gpCategory;renderGroupPrices();return;}const action=b.dataset.gpAction;if(!action)return;const id=b.closest('[data-gp-line]').dataset.gpLine;if(action==='discard'){s.drafts.delete(s.groupId+':'+id);renderGroupPrices();}else void saveGroupPriceLine(id);};
}
async function saveGroupPriceLine(id){
  const s=groupPriceUI,groupId=s.groupId,key=groupId+':'+id,d=s.drafts.get(key);if(!d||s.saving.has(key))return;
  const body={revision:d.revision,purchase:{},retail:{}};
  for(const layer of ['purchase','retail'])for(const [field,raw] of Object.entries(d[layer])){const n=Number(raw);if(String(raw).trim()===''||!Number.isFinite(n)||Math.abs(n)>1e6){d.error='请填写有效的偏移量，如 +10、-2 或 0';renderGroupPrices();return;}body[layer][field]=n;}
  s.saving.add(key);renderGroupPrices();
  try{const result=await api('/admin-api/agent-groups/'+encodeURIComponent(groupId)+'/prices/'+encodeURIComponent(id),{method:'PUT',body:JSON.stringify(body)});s.drafts.delete(key);if(s.groupId===groupId)s.data.rows=s.data.rows.map(r=>r.id===id?result.row:r);toast('分组价格已保存');}
  catch(e){d.error=e.message;}
  finally{s.saving.delete(key);if(s.groupId===groupId&&$('#dlgBody').querySelector('.gp-head'))renderGroupPrices();}
}
async function savePriceGroupName(){
  const s=groupPriceUI,name=$('#gp-name').value.trim();if(!name){toast('请填写分组名称','bad');return;}
  try{await api('/admin-api/agent-groups/'+encodeURIComponent(s.groupId),{method:'PUT',body:JSON.stringify({name})});void loadAgents();toast('分组名称已保存');await openGroupPriceSettings(s.groupId);}catch(e){toast(e.message,'bad');}
}
openGroupsDlg=()=>openGroupPriceSettings();
window.addEventListener('beforeunload',e=>{if(groupPriceUI.drafts.size){e.preventDefault();e.returnValue='';}});
const gpStyle=document.createElement('style');gpStyle.textContent='.gp-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:12px}.gp-head nav{display:flex;gap:6px;flex-wrap:wrap}.gp-head [aria-pressed=true]{background:var(--acc-deep);color:white}.gp-rule{font-size:12px;line-height:1.7}.gp-lines{display:grid;gap:16px}.gp-line{border:1px solid var(--line);border-radius:10px;padding:16px}.gp-line h3{font-size:14px;margin:0 0 12px}.gp-line small{font-size:11px;color:var(--mut);display:block}.gp-table{overflow-x:auto}.gp-table table{width:100%;font-size:12px}.gp-table input{width:100px}.gp-actions{display:flex;align-items:center;gap:8px;margin-top:12px}.gp-actions [role=status]{flex:1;font-size:12px}';document.head.append(gpStyle);
