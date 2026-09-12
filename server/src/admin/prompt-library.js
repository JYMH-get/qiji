/* 统一提示词库：按步骤分页，复用原模板/预设编辑器及访问范围，逐项自动保存。 */
const PROMPT_PAGES = ['拆分提示词','推理提示词','画风提示词','输出提示词','图片预设','视频预设','用户预设','其他提示词'];
let promptPage = '推理提示词';
const promptDrafts = new Map();
const promptSelection = new Map();
const originalTplEditor = renderTplEditor;
const originalPresetEditor = renderPresetEditor;
const originalTplGroups = tplGroups;
const originalPresetGroups = presetGroupsList;
const inferPurposes = new Set(['storyboard.toVideoPrompt','storyboard.singleShot','storyboard.unified','storyboard.unifiedShot']);
const isCreative = t => inferPurposes.has(t.purpose) && t.category !== '输出提示词';
function promptCategory(t, preset=false){
  if(preset) return t.category === '画风' ? '画风提示词' : t.category === '视频预设方案' ? '视频预设' : '图片预设';
  if(t.category === '输出提示词' || t.id.startsWith('output.')) return '输出提示词';
  if(t.purpose === 'storyboard.split' || t.purpose === 'script.analyze' && t.category !== '内部') return '拆分提示词';
  if(isCreative(t)) return '推理提示词';
  if(t.category === '画风' || t.category === '画风提示词') return '画风提示词';
  return '其他提示词';
}
const promptIsPresetPage = () => ['画风提示词','图片预设','视频预设'].includes(promptPage);
function promptItems(preset=false){ return (preset ? PRESETS : TPLS).filter(t=>promptCategory(t,preset)===promptPage); }
function promptSaveStatus(key){
  const d=promptDrafts.get(key);
  return !d || d.saved===d.rev ? '已保存' : d.error ? '保存失败 · 点击重试' : d.running ? '保存中…' : '等待保存…';
}
function renderPromptStatus(){
  document.querySelectorAll('[data-prompt-save]').forEach(el=>{ el.textContent=promptSaveStatus(el.dataset.promptSave); });
  const el=$('#prompt_pending'); if(el) el.textContent=[...promptDrafts.values()].some(d=>d.error) ? '有内容保存失败，请重试' : [...promptDrafts.values()].some(d=>d.saved!==d.rev) ? '有修改正在保存' : '所有修改已保存';
}
function promptRecord(kind,id,patch){
  const key=kind+':'+id;
  let d=promptDrafts.get(key);
  if(!d){ d={kind,id,patch:{},rev:0,saved:0,running:false,error:'',timer:null};promptDrafts.set(key,d); }
  if(JSON.stringify(d.patch)===JSON.stringify(patch)) return;
  d.patch=structuredClone(patch);d.rev++;d.error='';
  clearTimeout(d.timer);d.timer=setTimeout(()=>flushPrompt(key),800);renderPromptStatus();
}
async function flushPrompt(key){
  const d=promptDrafts.get(key);if(!d || d.running || d.saved===d.rev) return;
  clearTimeout(d.timer);d.running=true;d.error='';renderPromptStatus();
  const revision=d.rev, patch=structuredClone(d.patch);
  try{
    await api('/admin-api/'+d.kind+'/'+encodeURIComponent(d.id),{method:'PUT',body:JSON.stringify(patch)});
    const item=(d.kind==='templates'?TPLS:PRESETS).find(t=>t.id===d.id);if(item) Object.assign(item,patch);
    d.saved=revision;
  }catch(e){d.error=e.message||String(e);}
  finally{d.running=false;renderPromptStatus();}
  if(!d.error && d.saved!==d.rev) void flushPrompt(key);
}
function promptReadForm(kind,id){
  const val=(id)=>$(id)?.value;
  if(kind==='presets') return {
    name:val('#pe_name')?.trim()||id,category:val('#pe_cat')?.trim()||'',position:val('#pe_pos'),group:val('#pe_group')?.trim()||null,
    order:Number(val('#pe_order'))||0,enabled:$('#pe_enabled').checked,body:val('#pe_body'),
    autoAttach:Array.from(document.querySelectorAll('#pre_editor [data-attach]')).filter(c=>c.checked).map(c=>c.dataset.attach),
  };
  return {
    name:val('#te_name')?.trim()||id,category:val('#te_cat')?.trim()||'',capability:val('#te_cap'),purpose:val('#te_purpose')||null,
    schemaId:val('#te_schema')?.trim()||null,nodeTypes:parseList(val('#te_nodes')),variables:parseList(val('#te_vars')),
    chainNextId:val('#te_chain')?.trim()||null,chainPipeVar:val('#te_pipe')?.trim()||null,order:Number(val('#te_order'))||0,
    isDefault:$('#te_default').checked,enabled:$('#te_enabled').checked,
    body:val('#te_body'),...(tplSharePatch()||{}),
  };
}
function bindPromptAutosave(kind,id){
  const host=$(kind==='templates'?'#tpl_editor':'#pre_editor'); if(!host) return;
  host.oninput=null;host.onchange=null;host.oncompositionend=null;host.onclick=null;
  if(kind==='templates' && (isAgentScope(tplScope) || TPLS.find(t=>t.id===id)?.agentId)){
    host.querySelectorAll('input,textarea,select,button').forEach(el=>el.disabled=true);return;
  }
  const key=kind+':'+id;
  const old=host.querySelector('button[onclick^="save"]');
  if(old){old.removeAttribute('onclick');old.dataset.promptSave=key;old.textContent=promptSaveStatus(key);old.onclick=()=>flushPrompt(key);}
  const capture=e=>{
    if(e?.isComposing || e?.target?.type==='file') return;
    promptRecord(kind,id,promptReadForm(kind,id));
  };
  host.oninput=capture;host.onchange=capture;host.oncompositionend=capture;
  // 开放范围使用按钮，需要等它更新分组集合之后再抓取。
  host.onclick=e=>{if(e.target.closest('[onclick*="TplGroup"]')) queueMicrotask(capture);};
  renderPromptStatus();
}
renderTplEditor=function(){
  const t=TPLS.find(t=>t.id===tplSel);const draft=promptDrafts.get('templates:'+tplSel);
  if(t && draft && draft.saved!==draft.rev) Object.assign(t,draft.patch);
  originalTplEditor();
  if(!t || !$('#te_body')) return;
  if(isCreative(t)){
    $('#te_body').value=t.body??'';
    $('#te_body').previousElementSibling.textContent='推理提示词原文';
    const selected=$('#te_purpose').selectedOptions[0];if(selected) selected.textContent='推理方案';
  }
  if(promptCategory(t)==='输出提示词'){
    ['#te_purpose','#te_cat','#te_cap','#te_default'].forEach(sel=>$(sel).disabled=true);
    $('#te_body').previousElementSibling.textContent='输出格式正文';
  }
  bindPromptAutosave('templates',t.id);
};
renderPresetEditor=function(){
  const p=PRESETS.find(p=>p.id===preSel);const draft=promptDrafts.get('presets:'+preSel);
  if(p && draft && draft.saved!==draft.rev) Object.assign(p,draft.patch);
  originalPresetEditor();if(p) bindPromptAutosave('presets',p.id);
};
tplGroups=function(){
  const groups=originalTplGroups().map(g=>({...g,items:g.items.filter(t=>promptCategory(t)===promptPage)})).filter(g=>g.items.length);
  if(promptPage==='拆分提示词'){
    const items=groups.flatMap(g=>g.items);
    return [
      {key:'asset-split',label:'资产拆分提示词',items:items.filter(t=>t.purpose==='script.analyze')},
      {key:'script-split',label:'剧本分镜仅拆分提示词',items:items.filter(t=>t.purpose==='storyboard.split')},
    ].filter(g=>g.items.length);
  }
  if(promptPage!=='推理提示词') return groups;
  return [{key:'inference',label:'推理方案',items:groups.flatMap(g=>g.items)}];
};
presetGroupsList=function(){ return originalPresetGroups().map(g=>({...g,items:g.items.filter(t=>promptCategory(t,true)===promptPage)})).filter(g=>g.items.length); };
function setPromptPage(page){
  promptSelection.set(promptPage,{tplSel,preSel});promptPage=page;
  const saved=promptSelection.get(page);tplSel=saved?.tplSel||'';preSel=saved?.preSel||'';
  renderPromptLibrary();
}
function renderPromptLibrary(){
  const host=$('#tab-templates');
  if(promptPage==='用户预设'){renderUserPromptBackups();return;}
  const preset=promptIsPresetPage();
  if(preset && !promptItems(true).some(t=>t.id===preSel)) preSel=promptItems(true)[0]?.id||'';
  if(!preset && !promptItems().some(t=>t.id===tplSel)) tplSel=promptItems()[0]?.id||'';
  host.innerHTML=`
    <div class="toolbar" style="gap:8px;flex-wrap:wrap;margin-bottom:14px">${PROMPT_PAGES.map(p=>`<button class="${p===promptPage?'pri':''}" onclick="setPromptPage('${p}')">${p}${p==='用户预设'?'':` <span class="faint">${TPLS.filter(t=>promptCategory(t)===p).length+PRESETS.filter(t=>promptCategory(t,true)===p).length}</span>`}</button>`).join('')}</div>
    <div class="toolbar" style="margin-bottom:12px">
      ${preset?'<span class="mut">内置预设</span>':scopeSelect('tpl_scope',tplScope,'setTplViewScope','开放范围')}
      <span id="prompt_pending" class="mut" style="font-size:12px"></span><span class="sp"></span>
      <button class="pri" onclick="${preset?'openNewPresetDlg()':'openNewTplDlg()'}">＋ 新建${preset?'预设':'提示词'}</button>
    </div>
    <datalist id="cat_list">${CATEGORIES.concat(PROMPT_PAGES).map(c=>`<option value="${esc(c)}">`).join('')}</datalist>
    <datalist id="pcat_list">${PRESET_CATS.map(c=>`<option value="${esc(c)}">`).join('')}</datalist>
    <div class="tpl"><div class="tpllist"><div class="lh"><input aria-label="搜索提示词" placeholder="搜索名称…" value="${esc(preset?preSearch:tplSearch)}" oninput="${preset?'preSearch':'tplSearch'}=this.value;${preset?'renderPresetList':'renderTplList'}()" /></div><div class="lbody" id="${preset?'pre_list':'tpl_list'}"></div></div><div class="tpled" id="${preset?'pre_editor':'tpl_editor'}"></div></div>`;
  if(preset){renderPresetList();renderPresetEditor();}else{renderTplList();renderTplEditor();}
  renderPromptStatus();
}
loadTemplates=async function(){
  await ensureScopeAgents();
  try{
    const results=await Promise.all([api('/admin-api/templates?agentId='+encodeURIComponent(tplScope)),api('/admin-api/presets'),api('/admin-api/agent-groups').catch(()=>({items:[]}))]);
    TPLS=results[0].items||[];PRESETS=results[1].items||[];TPL_GROUPS=results[2].items||[];
    // 所有尚未成功的草稿覆盖新快照，避免切页/加载将编辑回滚。
    for(const d of promptDrafts.values()) if(d.saved!==d.rev){const item=(d.kind==='templates'?TPLS:PRESETS).find(t=>t.id===d.id);if(item)Object.assign(item,d.patch);}
    $('#cnt-templates').textContent=TPLS.length+PRESETS.length;
    renderPromptLibrary();
  }catch(e){$('#tab-templates').innerHTML=`<p class="bad-t">${esc(e.message)}</p>`;}
};
loadPresets=()=>loadTemplates();
const originalPromptSwitchTab=switchTab;
switchTab=function(tab){if(tab==='presets'){promptPage='图片预设';tab='templates';}return originalPromptSwitchTab(tab);};
saveTpl=id=>{promptRecord('templates',id,promptReadForm('templates',id));return flushPrompt('templates:'+id);};
savePreset=id=>{promptRecord('presets',id,promptReadForm('presets',id));return flushPrompt('presets:'+id);};
const originalNewPreset=openNewPresetDlg;
openNewPresetDlg=function(){originalNewPreset();$('#np_cat').value=promptPage==='视频预设'?'视频预设方案':promptPage==='画风提示词'?'画风':'预设方案';};
const originalNewTpl=openNewTplDlg;
openNewTplDlg=function(){originalNewTpl();$('#nt_cat').value=promptPage;$('#nt_purpose').value=promptPage==='推理提示词'?'storyboard.toVideoPrompt':promptPage==='拆分提示词'?'script.analyze':'';$('#nt_cap').value='text';};
window.addEventListener('beforeunload',e=>{if([...promptDrafts.values()].some(d=>d.saved!==d.rev)){e.preventDefault();e.returnValue='';}});
