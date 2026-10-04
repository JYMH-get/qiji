(function () {
  if (IS_RELAY) return;

  const style = document.createElement('style');
  style.textContent = `
    #userTransferDialog { max-width:920px; }
    .user-transfer-selection { display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:18px; }
    .user-transfer-target { display:flex;align-items:end;flex-wrap:wrap;gap:12px;margin-bottom:18px; }
    .user-transfer-target label { display:grid;gap:7px;flex:1;min-width:180px;font-size:12px;color:var(--mut); }
    .user-transfer-target select { width:100%; }
    .user-transfer-totals { display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin:14px 0; }
    .user-transfer-total { background:var(--panel2);border:1px solid var(--line);border-radius:var(--r-sm);padding:12px; }
    .user-transfer-total span { display:block;font-size:11.5px;color:var(--mut); }
    .user-transfer-total strong { display:block;font-size:22px;margin-top:4px;font-variant-numeric:tabular-nums; }
    .user-transfer-note { padding:11px 13px;border:1px solid var(--line2);border-radius:var(--r-sm);background:var(--panel2);font-size:12.5px;line-height:1.7; }
    .user-transfer-confirm { display:flex;align-items:flex-start;gap:9px;margin-top:18px;cursor:pointer;font-size:13px; }
    .user-transfer-confirm input { margin-top:3px; }
    .user-transfer-table { max-height:300px;overflow:auto; }
    .user-transfer-table table { min-width:620px; }
    .user-transfer-table .right { text-align:right; }
    .user-transfer-error { color:var(--bad);font-size:12.5px;line-height:1.6;overflow-wrap:anywhere;margin-top:12px; }
    .user-transfer-history { display:grid;gap:12px; }
    .user-transfer-history article { border:1px solid var(--line);border-radius:var(--r-sm);padding:14px; }
    .user-transfer-history header { display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;font-size:13px; }
    .user-transfer-history .mut { font-size:12px; }
    @media(max-width:600px) { .user-transfer-totals { grid-template-columns:1fr; } .user-transfer-total { display:flex;align-items:center;justify-content:space-between;gap:8px; } .user-transfer-total strong { margin:0;font-size:19px; } }
  `;
  document.head.appendChild(style);
  const dialog = document.createElement('dialog');
  dialog.id = 'userTransferDialog';
  dialog.setAttribute('aria-labelledby', 'userTransferTitle');
  dialog.innerHTML = `<div class="mh"><h2 id="userTransferTitle">用户迁移</h2><span class="sp"></span><button class="ghost icon" data-transfer-close aria-label="关闭"><svg><use href="#i-x"/></svg></button></div><div class="mb" id="userTransferBody"></div><div class="mf" id="userTransferFooter"></div>`;
  document.body.appendChild(dialog);
  let state = null;
  const body = () => dialog.querySelector('#userTransferBody');
  const footer = () => dialog.querySelector('#userTransferFooter');
  const amount = value => Number(value || 0).toLocaleString();
  const when = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : '—';
  const titleFor = user => user.name?.trim() || user.account || user.id;
  const current = captured => state === captured && dialog.open;

  function close() { if (state?.busy !== 'commit') dialog.close(); }
  dialog.querySelector('[data-transfer-close]').addEventListener('click', close);
  dialog.addEventListener('cancel', event => { if (state?.busy === 'commit') event.preventDefault(); });
  dialog.addEventListener('close', () => { if (!dialog.open) state = null; });

  function setBusy(captured, kind) {
    captured.busy = kind;
    dialog.querySelectorAll('button,select,input').forEach(el => { el.disabled = !!kind; });
    if (kind !== 'commit') dialog.querySelectorAll('[data-transfer-close]').forEach(el => { el.disabled = false; });
    const previewButton = dialog.querySelector('#userTransferPreview');
    if (previewButton) previewButton.textContent = kind === 'preview' ? '正在预览…' : captured.preview ? '重新预览' : '预览迁移';
    const commitButton = dialog.querySelector('#userTransferCommit');
    if (commitButton) {
      commitButton.textContent = kind === 'commit' ? '正在迁移…' : '确认迁移';
      commitButton.disabled = !!kind || !captured.preview?.token || !dialog.querySelector('#userTransferConfirm')?.checked;
    }
  }

  function setError(message) {
    const el = dialog.querySelector('#userTransferError');
    if (el) el.textContent = message || '';
  }

  function renderControls(captured) {
    footer().innerHTML = `<button data-transfer-close>取消</button><button class="pri" id="userTransferCommit" disabled>确认迁移</button>`;
    footer().querySelector('[data-transfer-close]').addEventListener('click', close);
    footer().querySelector('#userTransferCommit').addEventListener('click', () => commit(captured));
  }

  function invalidatePreview(captured) {
    captured.preview = null;
    dialog.querySelector('#userTransferPreviewResult').innerHTML = '';
    setError('');
    setBusy(captured, null);
  }

  function renderTransfer(captured) {
    const sourceUsers = captured.users.filter(user => !user.agentId);
    const mixed = sourceUsers.length > 0 && sourceUsers.length < captured.users.length;
    const toSource = !sourceUsers.length;
    const options = toSource
      ? '<option value="platform">源站（平台直属）</option>'
      : `<option value="">请选择渠道商</option>${captured.agents.filter(agent => agent.enabled !== false).map(agent => `<option value="${esc(agent.id)}">${esc(agent.name || agent.account || agent.id)}</option>`).join('')}`;
    body().innerHTML = `<div class="user-transfer-selection"><b>已选 ${captured.users.length} 个用户</b>${captured.users.slice(0, 6).map(user => `<span class="badge">${esc(titleFor(user))}</span>`).join('')}${captured.users.length > 6 ? `<span class="faint">另 ${captured.users.length - 6} 个</span>` : ''}${captured.users.length === 1 ? '<span class="sp"></span><button class="sm ghost" id="userTransferHistory">迁移记录</button>' : ''}</div>
      ${mixed ? '<div class="user-transfer-note">源站用户与渠道商用户请分别选择迁移。</div>' : `<div class="user-transfer-target"><label for="userTransferTarget">迁移至<select id="userTransferTarget">${options}</select></label><button id="userTransferPreview">预览迁移</button></div>`}
      <div id="userTransferPreviewResult"></div><div id="userTransferError" class="user-transfer-error" role="alert"></div>`;
    renderControls(captured);
    dialog.querySelector('#userTransferHistory')?.addEventListener('click', () => openHistory(captured.users[0].id));
    const target = dialog.querySelector('#userTransferTarget');
    if (target) {
      captured.targetAgentId = toSource ? null : undefined;
      target.addEventListener('change', () => {
        captured.targetAgentId = toSource ? null : target.value || undefined;
        invalidatePreview(captured);
      });
      dialog.querySelector('#userTransferPreview').addEventListener('click', () => preview(captured));
      if (toSource) dialog.querySelector('#userTransferPreview').focus();
      else target.focus();
    }
  }

  function renderPreview(captured) {
    const result = captured.preview;
    dialog.querySelector('#userTransferPreviewResult').innerHTML = `<div class="user-transfer-note">原积分与会员封存，目标余额为 0；账号及团队保留，迁移后重新登录。${result.totalTeamCredits > 0 ? '<br>团长已分配的团队积分一并封存，成员的团队余额清零。' : ''}</div>
      <div class="user-transfer-totals"><div class="user-transfer-total"><span>封存个人积分</span><strong>${amount(result.totalCredits)}</strong></div><div class="user-transfer-total"><span>封存团队分配积分</span><strong>${amount(result.totalTeamCredits)}</strong></div><div class="user-transfer-total"><span>迁移后个人余额</span><strong>0</strong></div></div>
      <div class="tblwrap user-transfer-table"><table><thead><tr><th>用户</th><th>原归属 → 新归属</th><th class="right">个人积分</th><th class="right">团队积分</th><th>封存会员</th></tr></thead><tbody>${result.users.map(user => `<tr><td>${esc(titleFor(user))}${user.account ? `<div class="sub mono">@${esc(user.account)}</div>` : ''}</td><td>${esc(user.sourceName)} → ${esc(result.targetName)}</td><td class="right">${amount(user.credits)}</td><td class="right">${amount(user.teamCredits)}</td><td>${user.membership ? `${esc(user.membership.planName || '会员')}<div class="sub">至 ${esc(when(user.membership.expiresAt))}</div>` : '<span class="faint">—</span>'}</td></tr>`).join('')}</tbody></table></div>
      ${result.users.some(user => !user.account) ? '<p class="mut" style="font-size:12px;margin:12px 0 0">未注册账号的用户，需由新归属后台提供新的 API 密钥。</p>' : ''}
      <label class="user-transfer-confirm"><input id="userTransferConfirm" type="checkbox"><span>已核对 ${result.affected} 个用户，确认封存原权益并迁移至「${esc(result.targetName)}」</span></label>
      <div class="faint" style="font-size:11.5px;margin-top:8px">预览有效至 ${esc(when(result.expiresAt))}；账户状态变化后需重新预览。</div>`;
    dialog.querySelector('#userTransferConfirm').addEventListener('change', () => setBusy(captured, null));
  }

  async function preview(captured) {
    if (!current(captured) || captured.busy) return;
    if (captured.targetAgentId === undefined) { setError('请选择要迁入的渠道商'); return; }
    invalidatePreview(captured);
    setBusy(captured, 'preview');
    try {
      const result = await api('/admin-api/users/transfer/preview', { method: 'POST', body: JSON.stringify({ ids: captured.ids, targetAgentId: captured.targetAgentId }) });
      if (!current(captured)) return;
      if (!result.ok || !result.token) throw new Error(result.error?.message || '暂时无法迁移，请刷新后重试');
      captured.preview = result;
      renderPreview(captured);
    } catch (error) { if (current(captured)) setError(error.message); }
    finally { if (current(captured)) setBusy(captured, null); }
  }

  async function commit(captured) {
    if (!current(captured) || captured.busy || !captured.preview?.token || !dialog.querySelector('#userTransferConfirm')?.checked) return;
    setError('');
    setBusy(captured, 'commit');
    try {
      const result = await api('/admin-api/users/transfer', { method: 'POST', body: JSON.stringify({ ids: captured.ids, targetAgentId: captured.targetAgentId, token: captured.preview.token }) });
      if (!current(captured)) return;
      if (!result.ok) throw new Error(result.error?.message || '迁移失败，请重新预览后重试');
      captured.busy = null;
      dialog.close();
      if (captured.ids.includes(DRAWER_UID)) closeDrawer();
      toast(`已迁移 ${result.affected} 个用户，请通知用户重新登录`);
      await loadUsers();
    } catch (error) {
      if (current(captured)) {
        const needsPreview = error.status >= 400 && error.status < 500 && error.status !== 429;
        if (needsPreview && captured.preview) captured.preview.token = null;
        const confirm = dialog.querySelector('#userTransferConfirm');
        if (confirm) confirm.checked = false;
        setError(error.message + (needsPreview ? '；请重新预览后再提交。' : '；请核对后再次确认，将使用同一次迁移重试。'));
      }
    } finally { if (current(captured)) setBusy(captured, null); }
  }

  async function openTransfer(ids) {
    if (IS_RELAY || state?.busy === 'commit') return;
    const unique = [...new Set(ids)];
    const selected = unique.map(id => USERS.find(user => user.id === id));
    if (!unique.length || selected.some(user => !user)) { toast('请选择当前列表中的用户', 'bad'); return; }
    const captured = { mode: 'transfer', ids: unique, users: selected, agents: [], preview: null, busy: 'load' };
    state = captured;
    dialog.querySelector('#userTransferTitle').textContent = '用户迁移';
    body().innerHTML = '<div class="mut" role="status">正在加载渠道商…</div>';
    footer().innerHTML = '<button data-transfer-close>取消</button>';
    footer().querySelector('[data-transfer-close]').addEventListener('click', close);
    dialog.querySelector('[data-transfer-close]').disabled = false;
    if (!dialog.open) dialog.showModal();
    try {
      const result = await api('/admin-api/agents');
      if (!current(captured)) return;
      captured.agents = result.items || [];
      captured.busy = null;
      renderTransfer(captured);
    } catch (error) {
      if (current(captured)) {
        captured.busy = null;
        body().innerHTML = `<div class="user-transfer-error" role="alert">${esc(error.message)}</div><button class="sm" id="userTransferRetry" style="margin-top:12px">重试</button>`;
        dialog.querySelector('#userTransferRetry').addEventListener('click', () => openTransfer(unique));
      }
    }
  }

  async function openHistory(userId) {
    if (IS_RELAY || state?.busy === 'commit') return;
    const user = USERS.find(item => item.id === userId);
    if (!user) { toast('请刷新用户列表后重试', 'bad'); return; }
    const captured = { mode: 'history', userId, busy: null };
    state = captured;
    dialog.querySelector('#userTransferTitle').textContent = '迁移记录 · ' + titleFor(user);
    body().innerHTML = '<div class="mut" role="status">正在加载迁移记录…</div>';
    footer().innerHTML = '<button id="userTransferBack">迁移用户</button><button data-transfer-close>关闭</button>';
    footer().querySelector('[data-transfer-close]').addEventListener('click', close);
    footer().querySelector('#userTransferBack').addEventListener('click', () => openTransfer([userId]));
    dialog.querySelector('[data-transfer-close]').disabled = false;
    if (!dialog.open) dialog.showModal();
    try {
      const result = await api('/admin-api/users/transfer-history?userId=' + encodeURIComponent(userId));
      if (!current(captured)) return;
      const items = result.items || [];
      body().innerHTML = items.length ? `<div class="user-transfer-history">${items.map(item => `<article><header><b>${esc(item.sourceName)} → ${esc(item.targetName)}</b><time class="mut">${esc(when(item.at))}</time></header><div class="user-transfer-totals"><div class="user-transfer-total"><span>封存个人积分</span><strong>${amount(item.personalCredits)}</strong></div><div class="user-transfer-total"><span>封存团队分配积分</span><strong>${amount(item.teamCredits)}</strong></div><div class="user-transfer-total"><span>迁入时个人余额</span><strong>0</strong></div></div><div class="mut">${item.membership ? `封存会员：${esc(item.membership.planName || '会员')} · 原到期时间 ${esc(when(item.membership.expiresAt))}` : '无会员权益封存'}</div><div class="faint mono" style="font-size:11px;margin-top:8px;overflow-wrap:anywhere">${esc(item.transferId)}</div></article>`).join('')}</div>` : '<div class="mut" style="padding:18px 0">暂无迁移记录</div>';
    } catch (error) { if (current(captured)) body().innerHTML = `<div class="user-transfer-error" role="alert">${esc(error.message)}</div>`; }
  }

  window.openUserTransfer = openTransfer;
  window.openUserTransferHistory = openHistory;
})();
