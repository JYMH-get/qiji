/* Source settings share the existing server configuration and save one section at a time. */
(() => {
  let selected = 'basic', loadVersion = 0;
  const field = (id, label, value, type = 'text', attrs = '') => `<label class="fld"><span>${label}</span><input id="${id}" name="${id}" type="${type}" value="${esc(value ?? '')}" ${attrs}/></label>`;
  const actions = label => `<div class="source-settings-actions"><span class="mut" role="status"></span><button class="pri" type="submit">${label}</button></div>`;
  const title = (text, badge = '') => `<div class="hd"><h3>${text}</h3>${badge}</div>`;
  const badge = configured => `<span class="badge ${configured ? 'ok' : 'plain'}">${configured ? '已配置' : '未配置'}</span>`;
  const val = id => document.getElementById(id).value;
  const number = id => Number(val(id));
  const checked = id => document.getElementById(id).checked;
  const formValues = form => [...form.elements].filter(el => el.name && !el.disabled).map(el => ({name:el.name,value:el.value,checked:el.checked}));
  const drafts = () => [...document.querySelectorAll('#tab-settings form[data-dirty="true"]')].map(form => ({id:form.id,fields:formValues(form)}));
  const restore = saved => saved.forEach(item => {
    const form = document.getElementById(item.id);
    if (!form) return;
    form.dataset.dirty = 'true';
    for (const field of item.fields) { const input = form.elements.namedItem(field.name); if (input) { input.value=field.value; input.checked=field.checked; } }
    form.querySelector('[role="status"]').textContent = '有未保存修改';
  });
  const payload = {
    local: () => ({cost:number('rg_local_cost'),refundOnFailure:checked('rg_local_refund')}),
    basic: () => ({enabled:checked('rg_enabled'),sourceInviteCode:val('rg_sourceinvite').trim(),sourceRedeemCodePrefix:val('rg_prefix').trim(),giftCredits:number('rg_gift')}),
    security: () => ({ipRegPerDay:number('rg_ipreg'),ipSendPerHour:number('rg_iph'),ipSendPerDay:number('rg_ipd'),deviceLimit:number('rg_devlimit'),emailDomainBlacklist:val('rg_blacklist').split(/[,，\s]+/).map(s=>s.trim().toLowerCase()).filter(Boolean)}),
    email: () => ({smtp:{host:val('rg_smtp_host').trim(),port:number('rg_smtp_port'),secure:val('rg_smtp_secure')==='true',user:val('rg_smtp_user').trim(),pass:val('rg_smtp_pass'),from:val('rg_smtp_from').trim()}}),
    sms: () => ({sms:{provider:'aliyun',accessKeyId:val('rg_sms_ak').trim(),accessKeySecret:val('rg_sms_sk'),signName:val('rg_sms_sign').trim(),templateCode:val('rg_sms_tpl').trim()}}),
  };

  async function saveSection(form, section) {
    if (form.dataset.saving === 'true' || !form.reportValidity()) return;
    const body = payload[section](), token = TOKEN;
    const inputs = [...form.elements], status = form.querySelector('[role="status"]');
    form.dataset.saving = 'true';
    inputs.forEach(el => { el.disabled = true; });
    status.textContent = '保存中…';
    try {
      const result = await api(section==='local'?'/admin-api/settings/local-generation':'/admin-api/settings/register',{method:'PUT',body:JSON.stringify(body)});
      if (TOKEN !== token) return;
      form.dataset.dirty = 'false';
      for (const input of inputs) if (input.type === 'password') input.value = '';
      if (section === 'basic') {
        form.elements.namedItem('rg_sourceinvite').value = body.sourceInviteCode.toUpperCase();
        form.elements.namedItem('rg_prefix').value = body.sourceRedeemCodePrefix.toUpperCase();
      }
      if (section === 'email' || section === 'sms') {
        const state = form.querySelector('.hd .badge');
        if (state) state.outerHTML = badge(section === 'email' ? result.smtpConfigured : result.smsConfigured);
        const suppliedSecret = section === 'email' ? body.smtp.pass : body.sms.accessKeySecret;
        if (suppliedSecret) form.querySelector('input[type="password"]').placeholder = '已配置，留空保留';
      }
      status.textContent = '已保存';
      toast('设置已保存');
    } catch (error) {
      if (TOKEN !== token) return;
      form.dataset.dirty = 'true';
      status.textContent = error.message;
      toast(error.message,'bad');
    } finally {
      form.dataset.saving = 'false';
      inputs.forEach(el => { el.disabled = false; });
    }
  }

  window.selectSourceSettings = section => {
    if (!['basic','security','channels'].includes(section)) return;
    selected = section;
    document.querySelectorAll('#tab-settings [data-settings-panel]').forEach(el => { el.hidden = el.dataset.settingsPanel !== selected; });
    document.querySelectorAll('#tab-settings [data-settings-tab]').forEach(el => { const on = el.dataset.settingsTab === selected; el.classList.toggle('on',on); el.setAttribute('aria-selected',String(on)); });
  };

  window.loadSourceSettings = async (refresh = false) => {
    const el = document.getElementById('tab-settings');
    if (el.querySelector('form') && !refresh) { selectSourceSettings(selected); return; }
    if (el.querySelector('[data-saving="true"]')) { toast('请等待当前设置保存完成'); return; }
    const version = ++loadVersion, token = TOKEN;
    if (!el.querySelector('form')) el.innerHTML = '<div class="mut" role="status">加载设置…</div>';
    let r, local;
    try { [r,local] = await Promise.all([api('/admin-api/settings/register'),api('/admin-api/settings/local-generation')]); }
    catch (error) {
      if (version !== loadVersion || TOKEN !== token) return;
      if (el.querySelector('form')) toast(error.message,'bad');
      else el.innerHTML = `<div class="card"><div class="bd bad-t" role="alert">${esc(error.message)} <button onclick="loadSourceSettings(true)">重试</button></div></div>`;
      return;
    }
    if (version !== loadVersion || TOKEN !== token) return;
    // Read drafts after the request: typing during refresh must also survive.
    if (el.querySelector('[data-saving="true"]')) return;
    const saved = drafts(), focused = el.contains(document.activeElement) ? document.activeElement.id : '';
    const smtp = r.smtp ?? {}, sms = r.sms ?? {};
    el.innerHTML = `
      <div class="source-settings-head"><div><h2>${IS_RELAY ? '节点设置' : '源站设置'}</h2><span class="mut">${IS_RELAY ? '本地用户与通知通道' : '注册、积分与通知通道'}</span></div><button class="sm" onclick="loadSourceSettings(true)">刷新设置</button></div>
      <div class="logtabs source-settings-tabs" role="tablist" aria-label="设置分类">
        ${[['basic','基础设置'],['security','注册与安全'],['channels','通知通道']].map(([id,name])=>`<button type="button" role="tab" id="settings-tab-${id}" data-settings-tab="${id}" aria-controls="settings-panel-${id}" onclick="selectSourceSettings('${id}')">${name}</button>`).join('')}
      </div>
      <div data-settings-panel="basic" id="settings-panel-basic" role="tabpanel" aria-labelledby="settings-tab-basic">
        <form class="card" id="source-settings-basic" data-section="basic">
          ${title('注册与积分')}<div class="bd"><div class="fgrid">
            <label class="fld full"><span>全站开放注册</span><span class="sw"><input id="rg_enabled" name="rg_enabled" type="checkbox" ${r.enabled?'checked':''}/><i></i></span></label>
            ${field('rg_sourceinvite','源站邀请码',r.sourceInviteCode,'text','required minlength="4" maxlength="32" pattern="[A-Za-z0-9_\\-]{4,32}" autocomplete="off"')}
            ${field('rg_prefix','积分兑换码前缀',r.sourceRedeemCodePrefix??'QJ','text','required minlength="2" maxlength="12" pattern="[A-Za-z0-9]{2,12}" autocomplete="off"')}
            ${field('rg_gift','源站注册赠送积分',r.giftCredits??0,'number','required min="0" max="1000000" step="1"')}
          </div>${actions('保存基础设置')}</div>
        </form>
        <form class="card" id="source-settings-local" data-section="local">
          ${title('LibTV / 即梦手续费')}<div class="bd"><div class="fgrid">
            ${field('rg_local_cost','每次生成积分',local.cost,'number','required min="0" step="any"')}
            <label class="fld"><span>失败返还积分</span><input id="rg_local_refund" name="rg_local_refund" type="checkbox" ${local.refundOnFailure?'checked':''}/></label>
          </div><p class="mut">提交时预扣，成功确认扣费；关闭退款后失败仍收取手续费。修改仅影响新任务。</p>${actions('保存手续费设置')}</div>
        </form>
        ${!IS_RELAY ? `<div class="source-settings-links" aria-label="更多设置">${[['site','网页管理','官网资料与下载'],['messages','消息通知','发布通知与公告'],['quota','收藏与配额','个人与团队默认配额'],['oss','存储','对象存储与保留策略']].map(([id,name,note])=>`<button type="button" onclick="switchTab('${id}')"><b>${name}</b><span class="mut">${note}</span><span aria-hidden="true">→</span></button>`).join('')}</div>` : ''}
      </div>
      <div data-settings-panel="security" id="settings-panel-security" role="tabpanel" aria-labelledby="settings-tab-security" hidden>
        <form class="card" id="source-settings-security" data-section="security">${title('注册与访问限制')}<div class="bd"><div class="fgrid">
          ${field('rg_ipreg','同 IP 每日注册上限',r.ipRegPerDay,'number','required min="1" max="10000" step="1"')}
          ${field('rg_iph','同 IP 每小时发码上限',r.ipSendPerHour,'number','required min="1" max="10000" step="1"')}
          ${field('rg_ipd','同 IP 每日发码上限',r.ipSendPerDay,'number','required min="1" max="10000" step="1"')}
          ${field('rg_devlimit','默认同时在线设备数（0 为不限）',r.deviceLimit,'number','required min="0" max="100" step="1"')}
          <label class="fld full"><span>邮箱域黑名单（逗号或空格分隔）</span><textarea id="rg_blacklist" name="rg_blacklist" rows="3" placeholder="example.com, spam.io">${esc((r.emailDomainBlacklist??[]).join(', '))}</textarea></label>
        </div>${actions('保存安全设置')}</div></form>
      </div>
      <div data-settings-panel="channels" id="settings-panel-channels" role="tabpanel" aria-labelledby="settings-tab-channels" hidden>
        <div class="source-settings-channel-grid">
          <div><form class="card" id="source-settings-email" data-section="email">${title('邮箱通道（SMTP）',badge(r.smtpConfigured))}<div class="bd"><div class="fgrid">
            ${field('rg_smtp_host','SMTP 主机',smtp.host)}
            ${field('rg_smtp_port','端口',smtp.port??465,'number','required min="1" max="65535" step="1"')}
            <label class="fld"><span>连接安全</span><select id="rg_smtp_secure" name="rg_smtp_secure"><option value="true" ${smtp.secure!==false?'selected':''}>SSL / TLS</option><option value="false" ${smtp.secure===false?'selected':''}>STARTTLS</option></select></label>
            ${field('rg_smtp_user','发信账号',smtp.user)}
            ${field('rg_smtp_pass','密码 / 授权码','', 'password',`autocomplete="new-password" placeholder="${smtp.hasPass?'已配置，留空保留':'未配置'}"`)}
            ${field('rg_smtp_from','发件人',smtp.from,'text','placeholder="Qiji <no-reply@example.com>"')}
          </div>${actions('保存邮箱通道')}</div></form>
          <form class="source-settings-mail-test" id="source-settings-mail-test"><label>测试收件邮箱<input id="rg_test_to" name="testEmail" type="email" required placeholder="name@example.com" /></label><button type="submit">发送测试邮件</button><span id="rg_test_msg" class="mut" role="status"></span></form></div>
          <form class="card" id="source-settings-sms" data-section="sms">${title('短信通道（阿里云）',badge(r.smsConfigured))}<div class="bd"><div class="fgrid">
            ${field('rg_sms_ak','AccessKey ID',sms.accessKeyId)}
            ${field('rg_sms_sk','AccessKey Secret','', 'password',`autocomplete="new-password" placeholder="${sms.hasSecret?'已配置，留空保留':'未配置'}"`)}
            ${field('rg_sms_sign','短信签名',sms.signName)}
            ${field('rg_sms_tpl','模板编号',sms.templateCode)}
          </div>${actions('保存短信通道')}</div></form>
        </div>
      </div>`;
    el.querySelectorAll('form[data-section]').forEach(form => {
      form.oninput = () => { form.dataset.dirty='true'; form.querySelector('[role="status"]').textContent='有未保存修改'; };
      form.onsubmit = event => { event.preventDefault(); void saveSection(form,form.dataset.section); };
    });
    document.getElementById('source-settings-mail-test').onsubmit = event => { event.preventDefault(); void testRegMail(); };
    restore(saved);
    selectSourceSettings(selected);
    if (focused) document.getElementById(focused)?.focus();
  };

  window.loadRegisterSettings = () => loadSourceSettings(true);
  window.testRegMail = async () => {
    const form = document.getElementById('source-settings-mail-test'), status = document.getElementById('rg_test_msg');
    if (!form.reportValidity() || form.dataset.saving==='true') return;
    form.dataset.saving='true'; form.querySelector('button').disabled=true; status.textContent='发送中…';
    try { await api('/admin-api/settings/register/test-mail',{method:'POST',body:JSON.stringify({to:val('rg_test_to').trim()})}); status.textContent='已发送，请查收'; }
    catch(error) { status.textContent=error.message; }
    finally { form.dataset.saving='false'; form.querySelector('button').disabled=false; }
  };
})();
