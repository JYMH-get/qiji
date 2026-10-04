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
    enabled:$('#pe_enabled').checked,body:val('#pe_body'),publicNote:val('#pe_public_note')||'',
    autoAttach:Array.from(document.querySelectorAll('#pre_editor [data-attach]')).filter(c=>c.checked).map(c=>c.dataset.attach),
  };
  return {
    name:val('#te_name')?.trim()||id,category:val('#te_cat')?.trim()||'',capability:val('#te_cap'),purpose:val('#te_purpose')||null,
    variables:JSON.parse($('#prompt_variables')?.dataset.values||'[]'),
    isDefault:$('#te_default').checked,enabled:$('#te_enabled').checked,
    body:val('#te_body'),publicNote:val('#te_public_note')||'',...(tplSharePatch()||{}),
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
    promptRecord(kind,id,{...promptDrafts.get(key)?.patch,...promptReadForm(kind,id)});
  };
  host.oninput=capture;host.onchange=capture;host.oncompositionend=capture;
  // 开放范围使用按钮，需要等它更新分组集合之后再抓取。
  host.onclick=e=>{if(e.target.closest('[onclick*="TplGroup"]')) queueMicrotask(capture);};
  renderPromptStatus();
}
function addPublicPromptNote(kind,item){
  const prefix=kind==='templates'?'te':'pe';
  const body=$('#'+prefix+'_body');if(!body)return;
  const field=document.createElement('div');field.className='fld';field.style.marginBottom='14px';
  field.innerHTML=`<label for="${prefix}_public_note">可见注释（渠道商及用户可见）</label><textarea id="${prefix}_public_note" aria-label="可见注释" maxlength="10000" rows="5" placeholder="填写适用场景、预期效果或输出实例">${esc(item.publicNote||'')}</textarea>`;
  body.parentElement.before(field);
}
renderTplEditor=function(){
  const t=TPLS.find(t=>t.id===tplSel);const draft=promptDrafts.get('templates:'+tplSel);
  if(t && draft && draft.saved!==draft.rev) Object.assign(t,draft.patch);
  originalTplEditor();
  if(t)addPublicPromptNote('templates',t);
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
  compactPromptEditor('templates',t);
};
renderPresetEditor=function(){
  const p=PRESETS.find(p=>p.id===preSel);const draft=promptDrafts.get('presets:'+preSel);
  if(p && draft && draft.saved!==draft.rev) Object.assign(p,draft.patch);
  originalPresetEditor();if(p){addPublicPromptNote('presets',p);bindPromptAutosave('presets',p.id);compactPromptEditor('presets',p);}
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
  return [{key:'inference',label:'推理方案',items:groups.flatMap(g=>g.items).sort(promptOrderCompare)}];
};
presetGroupsList=function(){ return originalPresetGroups().map(g=>({...g,items:g.items.filter(t=>promptCategory(t,true)===promptPage)})).filter(g=>g.items.length); };
function setPromptPage(page){
  promptSelection.set(promptPage,{tplSel,preSel});promptPage=page;
  const saved=promptSelection.get(page);tplSel=saved?.tplSel||'';preSel=saved?.preSel||'';
  renderPromptLibrary();
}
function renderPromptLibrary(){
  const host=$('#tab-templates');
  document.body.classList.add('prompt-workspace');
  if(promptPage==='用户预设'){renderUserPromptBackups();return;}
  const preset=promptIsPresetPage();
  if(preset && !promptItems(true).some(t=>t.id===preSel)) preSel=promptItems(true)[0]?.id||'';
  if(!preset && !promptItems().some(t=>t.id===tplSel)) tplSel=promptItems()[0]?.id||'';
  host.innerHTML=`
    ${promptTabsMarkup()}
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
switchTab=function(tab){if(tab==='presets'){promptPage='图片预设';tab='templates';}document.body.classList.toggle('prompt-workspace',tab==='templates');return originalPromptSwitchTab(tab);};
saveTpl=id=>{promptRecord('templates',id,{...promptDrafts.get('templates:'+id)?.patch,...promptReadForm('templates',id)});return flushPrompt('templates:'+id);};
savePreset=id=>{promptRecord('presets',id,{...promptDrafts.get('presets:'+id)?.patch,...promptReadForm('presets',id)});return flushPrompt('presets:'+id);};
const originalNewPreset=openNewPresetDlg;
openNewPresetDlg=function(){originalNewPreset();$('#np_cat').value=promptPage==='视频预设'?'视频预设方案':promptPage==='画风提示词'?'画风':'预设方案';};
const originalNewTpl=openNewTplDlg;
openNewTplDlg=function(){originalNewTpl();$('#nt_cat').value=promptPage;$('#nt_purpose').value=promptPage==='推理提示词'?'storyboard.toVideoPrompt':promptPage==='拆分提示词'?'script.analyze':'';$('#nt_cap').value='text';};
window.addEventListener('beforeunload',e=>{if([...promptDrafts.values()].some(d=>d.saved!==d.rev)){e.preventDefault();e.returnValue='';}});

function promptOrderCompare(a,b){return (a.order||0)-(b.order||0)||String(a.name).localeCompare(String(b.name));}
function promptMoveGroup(kind,id){
  // 排序按完整分组计算，搜索只筛选显示，不改变相邻关系。
  const previous=kind==='templates'?tplSearch:preSearch;
  if(kind==='templates')tplSearch='';else preSearch='';
  try{return (kind==='templates'?tplGroups():presetGroupsList()).find(g=>g.items.some(t=>t.id===id))?.items||[];}
  finally{if(kind==='templates')tplSearch=previous;else preSearch=previous;}
}
function movePrompt(kind,id,direction){
  const items=promptMoveGroup(kind,id).slice(),index=items.findIndex(t=>t.id===id),target=index+direction;
  if(index<0||target<0||target>=items.length)return;
  const key=kind+':'+id;
  promptRecord(kind,id,{...promptDrafts.get(key)?.patch,...promptReadForm(kind,id)});
  [items[index],items[target]]=[items[target],items[index]];
  items.forEach((item,order)=>{
    item.order=order;
    promptRecord(kind,item.id,{...promptDrafts.get(kind+':'+item.id)?.patch,order});
  });
  if(kind==='templates'){renderTplList();renderTplEditor();}else{renderPresetList();renderPresetEditor();}
}
function compactPromptEditor(kind,item){
  const prefix=kind==='templates'?'te':'pe',host=$('#'+(kind==='templates'?'tpl_editor':'pre_editor'));
  const readonly=kind==='templates'&&(isAgentScope(tplScope)||!!item.agentId);
  ['schema','nodes','vars','chain','pipe','order'].forEach(s=>$('#'+prefix+'_'+s)?.closest('.fld')?.remove());
  const purpose=$('#te_purpose');if(purpose)purpose.previousElementSibling.textContent='用途';
  if(kind==='templates')$('#te_enabled')?.closest('.fld')?.classList.add('prompt-switches');
  if(kind==='presets')for(const [id,label] of [['pe_cat','分组'],['pe_group','互斥组']]){const heading=$('#'+id)?.previousElementSibling;if(heading){heading.title=heading.textContent;heading.textContent=label;}}
  const header=host.querySelector('.hd');
  const group=promptMoveGroup(kind,item.id),index=group.findIndex(t=>t.id===item.id);
  for(const [direction,label] of [[-1,'↑ 上移'],[1,'↓ 下移']]){
    const button=document.createElement('button');button.className='sm';button.textContent=label;
    button.disabled=readonly||index+direction<0||index+direction>=group.length;
    button.onclick=()=>movePrompt(kind,item.id,direction);header.append(button);
  }
  const share=$('#te_share_groups');
  if(share){const field=share.parentElement;field.classList.add('prompt-share');field.removeAttribute('style');field.firstElementChild.textContent='开放范围';field.title=tplShareHint();$('#te_share_hint')?.remove();share.removeAttribute('style');}
  host.querySelector('.varchips')?.closest('.fld')?.remove();
  const body=$('#'+prefix+'_body'),note=$('#'+prefix+'_public_note');
  body.previousElementSibling.textContent=kind==='presets'?'预设正文':isCreative(item)?'推理提示词原文':promptCategory(item)==='输出提示词'?'输出格式正文':'提示词原文';
  const columns=document.createElement('div');columns.className='prompt-columns';
  body.parentElement.before(columns);
  columns.append(body.parentElement,note.parentElement);
  body.setAttribute('aria-label','提示词原文');
  body.parentElement.removeAttribute('style');note.parentElement.removeAttribute('style');
  if(kind==='templates'){
    const vars=document.createElement('div');vars.id='prompt_variables';vars.className='prompt-variables';vars.dataset.values=JSON.stringify(item.variables||[]);columns.before(vars);
    renderPromptVariables(vars,readonly);
  }
  const file=$('#'+prefix+'_file');
  if(file){const field=file.parentElement;field.classList.add('prompt-images');field.firstElementChild.textContent='参考图';}
  if(kind==='presets'){
    const attach=host.querySelector('[data-attach]')?.closest('.fld');
    if(attach){attach.classList.add('prompt-share');attach.removeAttribute('style');attach.firstElementChild.title=attach.firstElementChild.textContent;attach.firstElementChild.textContent='自动附加';}
  }
}
function renderPromptVariables(host,readonly){
  host.replaceChildren();
  const label=document.createElement('span');label.textContent='变量';host.append(label);
  const values=JSON.parse(host.dataset.values||'[]');
  values.forEach((value,index)=>{
    const chip=document.createElement('span');chip.className='prompt-variable';
    const copy=document.createElement('button');copy.type='button';copy.textContent='{{'+value+'}}';copy.title='复制占位符';copy.onclick=()=>copyText('{{'+value+'}}','变量已复制');chip.append(copy);
    if(!readonly){const remove=document.createElement('button');remove.type='button';remove.className='prompt-variable-remove';remove.textContent='×';remove.setAttribute('aria-label','删除变量 '+value);remove.title='移除变量声明，正文保持不变';remove.onclick=()=>{values.splice(index,1);host.dataset.values=JSON.stringify(values);renderPromptVariables(host,false);host.dispatchEvent(new Event('input',{bubbles:true}));};chip.append(remove);}
    host.append(chip);
  });
  if(readonly)return;
  const add=document.createElement('button');add.type='button';add.className='sm';add.textContent='＋';add.setAttribute('aria-label','添加变量');
  add.onclick=()=>{
    const input=document.createElement('input');input.placeholder='变量名';input.setAttribute('aria-label','新变量名称');input.className='prompt-variable-input';
    const finish=()=>{const name=input.value.trim().replace(/^\{\{|\}\}$/g,'');if(!name)return;if(/[{},，\r\n]/.test(name)){toast('变量名不能包含括号、逗号或换行','bad');return;}if(!values.includes(name))values.push(name);host.dataset.values=JSON.stringify(values);renderPromptVariables(host,false);host.dispatchEvent(new Event('input',{bubbles:true}));};
    const confirm=document.createElement('button');confirm.type='button';confirm.textContent='添加';confirm.className='sm';confirm.onclick=finish;
    input.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();finish();}if(e.key==='Escape')renderPromptVariables(host,false);};
    add.replaceWith(input,confirm);input.focus();
  };host.append(add);
}
const promptStyle=document.createElement('style');
promptStyle.textContent=`
body.prompt-workspace{height:100dvh;overflow:hidden}
.prompt-workspace #app{height:100%;min-height:0}
.prompt-workspace .main{height:100%;min-height:0}
.prompt-workspace .views{flex:1;min-height:0;padding:14px 20px 16px;overflow:hidden}
.prompt-workspace #tab-templates{height:100%;display:flex;flex-direction:column;min-height:0}
.prompt-workspace #tab-templates>.page-sticky{position:static;overflow:visible;max-height:none;flex:none;padding:0}
.prompt-workspace #tab-templates>.tpl{flex:1;min-height:0;height:0;grid-template-columns:240px minmax(0,1fr);gap:12px}
.prompt-workspace .tpled{overflow:hidden;display:flex;flex-direction:column}
.prompt-workspace .tpled>.hd{position:static;flex:none;display:flex;align-items:center;gap:6px;padding:10px 12px;flex-wrap:wrap}
.prompt-workspace .tpled>.hd h3{margin:0;font-size:14px}
.prompt-workspace .tpled>.bd{display:flex;flex-direction:column;flex:1;min-height:0;padding:10px 12px;gap:10px}
.prompt-workspace .tpled .fgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(145px,1fr));gap:8px;margin:0!important;flex:none}
.prompt-workspace .tpled .fld{min-width:0}
.prompt-workspace .tpled .prompt-switches{grid-column:span 2}.prompt-workspace .prompt-switches label{white-space:nowrap}
.prompt-workspace .tpled .fld>span,.prompt-workspace .tpled .fld>label{font-size:12px}
.prompt-workspace .prompt-share{display:flex;flex-direction:row;align-items:center;gap:10px;flex:none}
.prompt-workspace .prompt-share>span{white-space:nowrap}
.prompt-workspace #te_share_groups{display:flex;flex-wrap:wrap;gap:6px}
.prompt-workspace .prompt-columns{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:14px;flex:1;min-height:0}
.prompt-workspace .prompt-columns>.fld{display:flex;flex-direction:column;min-height:0;gap:6px}
.prompt-workspace .prompt-columns textarea{flex:1;min-height:0;height:0;width:100%;resize:none;overflow:auto;font-family:var(--mono);font-size:12.5px;line-height:1.7}
.prompt-workspace .prompt-variables{display:flex;align-items:center;flex-wrap:wrap;gap:7px;flex:none;font-size:12px}
.prompt-variable{position:relative;display:inline-flex}.prompt-variable>button{padding:3px 8px;font-size:11px}
.prompt-variable .prompt-variable-remove{position:absolute;right:-5px;top:-7px;border-radius:50%;padding:0;width:16px;height:16px;justify-content:center;opacity:0;background:var(--danger,#b84050);color:white}
.prompt-variable:hover .prompt-variable-remove,.prompt-variable:focus-within .prompt-variable-remove{opacity:1}
.prompt-variable-input{width:140px}
.prompt-workspace .prompt-images{display:flex;flex-direction:row;align-items:center;gap:8px;flex:none}
.prompt-workspace .prompt-images>span{white-space:nowrap}.prompt-workspace .prompt-images input{max-width:220px;font-size:11px}
.prompt-workspace .prompt-images .imggrid{margin:0!important;flex-wrap:nowrap;min-width:0;overflow-x:auto;scrollbar-width:none}
.prompt-workspace .prompt-images img{width:32px;height:32px}.prompt-workspace .prompt-images .im button{padding:0;right:0;top:0}
.prompt-workspace .tpllist .lbody{scrollbar-width:none}.prompt-workspace .tpllist .lbody::-webkit-scrollbar{display:none}
.prompt-workspace .nav{scrollbar-width:none}.prompt-workspace .nav::-webkit-scrollbar{display:none}
@media(max-width:1100px){.prompt-workspace #tab-templates>.tpl{grid-template-columns:180px minmax(0,1fr)}.prompt-workspace .side{width:170px}.prompt-workspace .views{padding:10px}}
`;
document.head.append(promptStyle);
function promptTabsMarkup(){return `<div class="toolbar" style="gap:8px;flex-wrap:wrap;margin-bottom:14px">${PROMPT_PAGES.map(p=>`<button class="${p===promptPage?'pri':''}" onclick="setPromptPage('${p}')">${p}${p==='用户预设'?'':` <span class="faint">${TPLS.filter(t=>promptCategory(t)===p).length+PRESETS.filter(t=>promptCategory(t,true)===p).length}</span>`}</button>`).join('')}</div>`;}
