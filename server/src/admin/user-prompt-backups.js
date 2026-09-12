/* 用户使用原文备份：仅管理员读取，与推送给用户的内置库独立。 */
const userPromptView={kind:'',search:'',page:1,selected:'',revision:0,detailRevision:0,item:null};
const backupKindName=k=>({image:'图片预设',video:'视频预设',skill:'Skills'}[k]||k);
const backupSourceName=s=>({builtin:'内置预设',custom:'用户自建',external:'外部 Skills'}[s]||s);
const backupTime=t=>new Date(t).toLocaleString('zh-CN',{hour12:false});
function renderUserPromptBackups(){
  $('#tab-templates').innerHTML=`
    <div class="toolbar" style="gap:8px;flex-wrap:wrap;margin-bottom:14px">${PROMPT_PAGES.map(p=>`<button class="${p==='用户预设'?'pri':''}" onclick="setPromptPage('${p}')">${p}</button>`).join('')}</div>
    <div class="toolbar" style="gap:10px;margin-bottom:12px">
      <select aria-label="用户预设类型" id="up_kind" onchange="userPromptView.kind=this.value;userPromptView.page=1;loadUserPromptBackups()">${[['','全部类型'],['image','图片预设'],['video','视频预设'],['skill','Skills']].map(([v,n])=>`<option value="${v}" ${userPromptView.kind===v?'selected':''}>${n}</option>`).join('')}</select>
      <input id="up_search" aria-label="搜索用户预设" placeholder="搜索用户、名称或项目" value="${esc(userPromptView.search)}" onkeydown="if(event.key==='Enter')searchUserPromptBackups()" />
      <button onclick="searchUserPromptBackups()">搜索</button><button onclick="loadUserPromptBackups()">刷新</button>
      <span id="up_total" class="mut"></span>
    </div>
    <div class="tpl"><div class="tpllist"><div id="up_list" class="lbody"></div><div id="up_pager" class="toolbar" style="padding:10px"></div></div><div id="up_detail" class="tpled"><p class="mut">选择一份备份查看原文</p></div></div>`;
  void loadUserPromptBackups();
}
function searchUserPromptBackups(){userPromptView.search=$('#up_search').value;userPromptView.page=1;void loadUserPromptBackups();}
async function loadUserPromptBackups(){
  const revision=++userPromptView.revision;
  ++userPromptView.detailRevision;userPromptView.item=null;
  if(!$('#up_list'))return;
  $('#up_list').innerHTML='<p class="mut" style="padding:12px">正在加载…</p>';
  $('#up_detail').innerHTML='<p class="mut">选择一份备份查看原文</p>';
  try{
    const q=new URLSearchParams({kind:userPromptView.kind,search:userPromptView.search,page:String(userPromptView.page),pageSize:'30'});
    const data=await api('/admin-api/user-prompt-backups?'+q);
    if(revision!==userPromptView.revision||promptPage!=='用户预设'||!$('#up_list'))return;
    userPromptView.page=data.page;
    $('#up_total').textContent=`${data.total} 份原文版本`;
    $('#up_list').innerHTML=data.items.length?data.items.map(t=>`<button data-backup-id="${esc(t.id)}" class="it" style="display:block;width:100%;text-align:left;white-space:normal" onclick="showUserPromptBackup(this.dataset.backupId)"><b>${esc(t.name)}</b><div class="mut" style="margin-top:5px">${backupKindName(t.kind)} · ${backupSourceName(t.source)} · 使用 ${t.use_count} 次</div><div class="mut">${esc(t.user_name||t.user_id)} · ${esc(backupTime(t.last_used_at))}</div></button>`).join(''):'<p class="mut" style="padding:12px">暂无备份</p>';
    $('#up_pager').innerHTML=`<button ${data.page<=1?'disabled':''} onclick="userPromptView.page--;loadUserPromptBackups()">上一页</button><span>${data.page} / ${data.pages}</span><button ${data.page>=data.pages?'disabled':''} onclick="userPromptView.page++;loadUserPromptBackups()">下一页</button>`;
    if(data.items.length) void showUserPromptBackup(data.items.some(t=>t.id===userPromptView.selected)?userPromptView.selected:data.items[0].id);
  }catch(e){if(revision===userPromptView.revision&&$('#up_list'))$('#up_list').innerHTML=`<p class="bad-t" style="padding:12px">${esc(e.message)}</p>`;}
}
async function showUserPromptBackup(id){
  userPromptView.selected=id;const revision=++userPromptView.detailRevision;userPromptView.item=null;
  $('#up_detail').innerHTML='<p class="mut">正在读取原文…</p>';
  document.querySelectorAll('[data-backup-id]').forEach(el=>el.classList.toggle('on',el.dataset.backupId===id));
  try{
    const t=await api('/admin-api/user-prompt-backups/'+encodeURIComponent(id));
    if(revision!==userPromptView.detailRevision||promptPage!=='用户预设'||!$('#up_detail'))return;
    userPromptView.item=t;
    $('#up_detail').innerHTML=`<div class="toolbar"><h3 style="margin:0">${esc(t.name)}</h3><span class="sp"></span><button onclick="copyUserPromptBackup()">复制原文</button><button onclick="downloadUserPromptBackup()">下载原文</button></div>
      <p class="mut">${backupKindName(t.kind)} · ${backupSourceName(t.source)} · 使用 ${t.use_count} 次</p>
      <p>用户：${esc(t.user_name||'未命名')} <span class="mut">${esc(t.user_id)}</span><br>首次使用：${esc(backupTime(t.first_used_at))}<br>最近使用：${esc(backupTime(t.last_used_at))}<br>最近项目：${esc(t.last_project_id||'未提供')}</p>
      <label for="up_body">使用时的完整原文</label><textarea id="up_body" aria-label="用户预设原文" readonly style="width:100%;min-height:390px;white-space:pre;box-sizing:border-box"></textarea>
      <h4>最近使用记录</h4><div style="overflow:auto"><table><thead><tr><th>时间</th><th>项目</th><th>用途</th><th>模型</th></tr></thead><tbody>${t.uses.map(u=>`<tr><td>${esc(backupTime(u.used_at))}</td><td>${esc(u.project_id)}</td><td>${esc(PURPOSE_LABELS[u.purpose]||u.purpose)}</td><td>${esc(u.model)}</td></tr>`).join('')}</tbody></table></div>`;
    $('#up_body').value=t.body;
  }catch(e){if(revision===userPromptView.detailRevision&&$('#up_detail'))$('#up_detail').innerHTML=`<p class="bad-t">${esc(e.message)}</p>`;}
}
async function copyUserPromptBackup(){
  if(!userPromptView.item)return;
  try{await navigator.clipboard.writeText(userPromptView.item.body);toast('原文已复制');}catch{const el=$('#up_body');el.focus();el.select();toast('请按 Ctrl+C 复制原文');}
}
function downloadUserPromptBackup(){
  const t=userPromptView.item;if(!t)return;
  const url=URL.createObjectURL(new Blob([t.body],{type:'text/plain;charset=utf-8'}));
  const a=document.createElement('a');a.href=url;a.download=(t.name||'用户预设').replace(/[\\/:*?"<>|]/g,'_')+(t.kind==='skill'?'.md':'.txt');a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
