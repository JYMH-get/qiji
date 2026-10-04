/* Shared source/agent business view. Public route identity only; draft prices survive polling. */
window.AgentLines = (() => {
  const instances = new WeakMap();
  const escape = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const number = n => new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 6 }).format(n);
  const rate = n => n == null ? '—' : `${(n * 100).toFixed(1)}%`;
  const bands = [[.9, '#22c55e', 28, '≥90%'], [.8, '#86efac', 24, '80–<90%'], [.6, '#facc15', 20, '60–<80%'], [.2, '#fb923c', 16, '20–<60%'], [0, '#f87171', 12, '<20%'], [-1, '#60a5fa', 20, '样本不足']];
  const band = r => r == null ? bands[5] : bands.find(b => r >= b[0]);
  const categories = [['text', '文本', 'T'], ['image', '图像', '▧'], ['video', '视频', '▹'], ['audio', '音频', '≋'], ['other', '其他', '◇']];
  const categoryOf = capability => categories.some(c => c[0] === capability) ? capability : 'other';
  const style = document.createElement('style');
  style.textContent = `
    .agent-lines{border:1px solid var(--line,#2b3344);border-radius:16px;background:var(--panel,#10141d);overflow:hidden;color:var(--text,#e5eaf3)}
    .agent-lines *{box-sizing:border-box}.al-head{padding:24px 26px 18px}.al-head h2{margin:0 0 7px;font-size:20px}.al-head p,.al-muted{color:var(--mut,#909caf);font-size:12px}.al-head p{margin:0;line-height:1.8}
    .al-toolbar{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;padding:0 26px 20px;border-bottom:1px solid var(--line,#293244)}
    .al-tabs{display:flex;gap:6px;flex-wrap:wrap}.al-tabs button{background:transparent;border:1px solid transparent;border-radius:9px;padding:10px 14px;display:flex;align-items:center;gap:9px;color:var(--mut,#99a6bd)}
    .al-tabs button[aria-pressed=true]{background:#6890f822;border-color:#6890f844;color:#aabffb}.al-tabs small{font-size:11px;opacity:.7}.al-search{min-width:240px;max-width:100%;padding:10px 13px!important;border-radius:9px!important;background:#0c1018!important}
    .al-meta{display:flex;align-items:center;gap:10px;padding:15px 26px;font-size:12px;color:var(--mut,#96a3ba)}.al-meta button{margin-left:auto}.al-live{width:6px;height:6px;border-radius:50%;background:#4ade80}.al-error{color:#fca5a5;padding:10px 26px;line-height:1.6}.al-error:empty{display:none}
    .al-families{padding:16px 26px;border-bottom:1px solid var(--line,#293244);max-height:160px;overflow-y:auto;scrollbar-width:thin}.al-families:empty{display:none}.al-families button{border-color:var(--line,#293244);max-width:100%;overflow-wrap:anywhere;text-align:left}.al-families button:focus-visible{outline:2px solid #8eadff;outline-offset:2px}
    .al-body{padding:0 26px 24px}.al-family{margin:13px 0 26px}.al-family h3{font-size:16px;margin:0 0 14px}.al-family h3 span{font-size:12px;font-weight:400;color:var(--mut,#96a3ba);margin-left:12px}
    .al-list{border:1px solid var(--line,#293244);border-radius:12px;overflow:hidden;background:var(--panel2,#171e29)}
    .al-row{display:grid;grid-template-columns:minmax(145px,.7fr) minmax(280px,1.7fr) minmax(240px,1fr);gap:25px;align-items:center;padding:24px;border-top:1px solid var(--line,#293244)}.al-row:first-child{border-top:0}
    .al-name{display:flex;gap:11px;align-items:center;margin-bottom:10px}.al-pulse{background:#6890f81a;border-radius:9px;color:#91adff;width:36px;height:36px;display:grid;place-items:center;font-size:22px;flex-shrink:0}.al-name strong{font-size:15px}.al-status{display:block;font-size:11px;color:#9aa6bd;margin-top:5px;line-height:1.5}
    .al-switch{display:inline-flex;align-items:center;gap:8px;background:transparent!important;border:0!important;padding:4px 0!important;color:#a4b0c6}.al-switch i{display:inline-block;width:31px;height:18px;border-radius:12px;background:#404859;position:relative}.al-switch i:after{content:'';position:absolute;top:3px;left:3px;width:12px;height:12px;background:#d9e2f2;border-radius:50%;transition:transform .15s}.al-switch[aria-checked=true] i{background:#6890f8}.al-switch[aria-checked=true] i:after{transform:translateX(13px)}.al-switch:disabled{opacity:.5}
    .al-rate-head{display:flex;align-items:baseline;gap:12px;margin-bottom:23px;flex-wrap:wrap}.al-rate-head span{font-size:12px;color:#98a5bd}.al-rate-head strong{font-size:22px;font-variant-numeric:tabular-nums}.al-rate-head small{margin-left:auto;font-size:11px;color:#8e9bb2}
    .al-wave{display:grid;grid-template-columns:repeat(60,minmax(0,1fr));gap:3px;height:29px;align-items:end}.al-wave i{display:block;min-width:0;border-radius:2px}.al-wave i[data-edited]{outline:1px solid #c4b5fd;outline-offset:1px}.al-wave-meta{display:flex;justify-content:space-between;font-size:10px;color:#8b98af;margin-top:10px;gap:8px}
    .al-price{border-left:1px solid var(--line,#2b3546);padding-left:24px;min-width:0}.al-price-head{display:flex;align-items:center;gap:8px;margin-bottom:12px}.al-price-head b{font-size:13px}.al-price-head small{font-size:10px;color:#91a1ba}.al-price-fields{display:flex;flex-direction:column;gap:9px}
    .al-price-field{display:grid;grid-template-columns:minmax(80px,1fr) 92px;align-items:center;gap:10px;font-size:12px}.al-price-field label{line-height:1.45}.al-price-field label small{display:block;font-size:10px;color:#8e9cb5;margin-top:3px}.al-price-field input{width:92px!important;text-align:right;padding:7px 8px!important;background:#0d121c!important;font-variant-numeric:tabular-nums}.al-price-field input:invalid{border-color:#f87171!important}
    .al-actions{display:flex;align-items:center;justify-content:flex-end;gap:7px;margin-top:14px;flex-wrap:wrap}.al-actions button{font-size:11px}.al-reference{font-size:10px;color:#92a0b9;line-height:1.7;margin-top:12px}.al-draft-note{font-size:11px;color:#e9c66f;margin-top:9px;line-height:1.5}.al-empty{text-align:center;color:#92a0b9;padding:48px 10px}
    .al-footer{padding:18px 26px;border-top:1px solid var(--line,#293244)}.al-legend{display:flex;gap:15px;flex-wrap:wrap;font-size:11px;color:#a3b1cc}.al-legend span{display:flex;align-items:center;gap:6px}.al-legend i{width:8px;height:8px;border-radius:2px}.al-footer details{font-size:11px;color:#94a3bf;margin-top:15px;line-height:1.8}.al-footer summary{cursor:pointer;color:#a8bbec}
    @media(max-width:1150px){.al-row{grid-template-columns:150px minmax(220px,1fr);gap:20px}.al-price{grid-column:1/-1;border-left:0;border-top:1px solid var(--line,#293244);padding:16px 0 0}.al-price-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px 28px}.al-reference{max-width:100%}}
    @media(max-width:680px){.al-row{grid-template-columns:minmax(0,1fr);padding:12px}.al-row>div{min-width:0;overflow-wrap:anywhere}.al-price{grid-column:auto}.al-price-fields{grid-template-columns:minmax(0,1fr)}.al-price-field{grid-template-columns:minmax(0,1fr) minmax(45px,92px);gap:6px}.al-price-field input{width:100%!important}.al-price-head{flex-wrap:wrap}.al-head,.al-body,.al-meta,.al-footer{padding-left:12px;padding-right:12px}.al-toolbar{padding-left:12px;padding-right:12px}.al-tabs button{padding:8px}.al-search{width:100%;min-width:0}.al-wave{gap:2px}.al-wave-meta{flex-wrap:wrap}.al-rate-head{gap:8px}.al-rate-head small{margin-left:0}}
    .agent-lines--prices .al-head{padding-bottom:16px}.agent-lines--prices .al-head h2{margin:0}.agent-lines--prices .al-toolbar{justify-content:flex-start}.agent-lines--prices .al-search{margin-left:auto}
    .agent-lines--prices .al-body{padding-top:22px}.agent-lines--prices .al-family{margin:0 0 16px}.agent-lines--prices .al-family:last-child{margin-bottom:0}
    .agent-lines--prices .al-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,280px),1fr));gap:16px;align-items:start;width:100%;border:0;border-radius:0;background:transparent;overflow:visible}
    .agent-lines--prices .al-row{display:block;min-width:0;width:100%;margin:0;padding:20px;border:1px solid var(--line,#293244);border-radius:12px;background:var(--panel2,#171e29)}
    .agent-lines--prices .al-identity{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:18px}.agent-lines--prices .al-name{margin:0;min-width:0;overflow-wrap:anywhere}.agent-lines--prices .al-name strong{font-size:16px}.agent-lines--prices .al-switch{flex-shrink:0}
    .agent-lines--prices .al-price{border-left:0;border-top:1px solid var(--line,#293244);padding:16px 0 0}.agent-lines--prices .al-price-fields{display:flex;gap:12px}.agent-lines--prices .al-price-head{flex-wrap:wrap}.agent-lines--prices .al-price-field{grid-template-columns:minmax(0,1fr) 92px}.agent-lines--prices .al-reference{overflow-wrap:anywhere}.agent-lines--prices .al-draft-note:empty{display:none}
    @media(max-width:680px){.agent-lines--prices .al-toolbar{gap:10px}.agent-lines--prices .al-search{width:auto;flex:1;min-width:0}.agent-lines--prices .al-tabs{width:100%}.agent-lines--prices .al-families{padding:12px;max-height:130px}.agent-lines--prices .al-list{grid-template-columns:minmax(0,1fr)}.agent-lines--prices .al-row{padding:16px}}
  `;
  document.head.appendChild(style);
  function mount(host, { endpoint, layer, layout }) {
    instances.get(host)?.();
    const priceOnly = layout === 'prices';
    let data = null, category = 'video', query = '', busy = false, disposed = false, sequence = 0;
    const selectedFamilies = new Map();
    const drafts = new Map(), saving = new Set(), session = TOKEN;
    const alive = () => !disposed && host.isConnected && session === TOKEN;
    const draft = row => { if (!drafts.has(row.id)) drafts.set(row.id, { revision: row.revision, fields: {} }); return drafts.get(row.id); };
    const rows = () => data?.rows ?? [];
    const rowFor = id => rows().find(r => r.id === id);
    host.classList.add('agent-lines');
    host.classList.toggle('agent-lines--prices', priceOnly);
    const footer = `<footer class="al-footer"><div class="al-legend">${bands.map(b => `<span><i style="background:${b[1]}"></i>${b[3]}</span>`).join('')}<span><i style="background:#374255"></i>尚未形成快照</span><span>◇ 自测补录 / 人工修正</span></div><details><summary>统计与价格说明</summary><p>近 1H 成功率按整条线路的请求记录汇总：成功 ÷（成功 + 失败），在途不参与，成功与失败合计不足 10 条时显示样本不足，数值不显示百分比。波形固定展示近 10H，每点独立统计 10 分钟内完成的请求；不足 10 条（含零请求）显示蓝色样本不足，统计按 80% 代入。</p><p>紫色描边的点表示自测补录或人工修正，悬浮可查看来源。进货价与用户售价独立；用户会员折扣在结算时应用。视频按秒展示，不同时长存在差价时显示范围，填入单价将统一该档位的每秒价格。</p></details></footer>`;
    const refreshButton = '<button type="button" data-action="refresh" class="sm ghost">刷新</button>';
    host.innerHTML = `<div class="al-head"><h2>${priceOnly ? '线路价格' : '线路价格与成功率'}</h2>${priceOnly ? '' : `<p>${layer === 'purchase' ? '为当前渠道商设置进货价格与线路权限；每个渠道商独立生效。' : '为名下用户设置线路售价；进货价格由源站设置。'}价格常展开，修改后逐条保存。</p>`}</div>
      <div class="al-toolbar"><nav class="al-tabs" aria-label="模型类别"></nav><input class="al-search" type="search" aria-label="搜索模型或线路" placeholder="搜索模型或线路">${priceOnly ? refreshButton : ''}</div>
      ${priceOnly ? '<nav class="al-families al-tabs" aria-label="模型家族"></nav>' : ''}
      ${priceOnly ? '' : `<div class="al-meta"><i class="al-live"></i><span data-updated>正在读取线路统计…</span>${refreshButton}</div>`}
      <div class="al-error" role="alert"></div><div class="al-body"></div>${priceOnly ? '' : footer}`;
    const $ = selector => host.querySelector(selector);
    function wave(row) {
      const history = row.history ?? [], end = Math.floor(Math.max(data.until, ...history.map(p => p.until)) / 600000), slots = Array(60).fill(null);
      for (const p of history) { const i = Math.floor(p.until / 600000) - end + 59; if (i >= 0 && i < 60) slots[i] = p; }
      return `<div class="al-rate-head"><span>近 1H 实测成功率</span><strong style="color:${band(row.successRate)[1]}">${row.success + row.failed < 10 ? '样本不足' : rate(row.successRate)}</strong><small>成功 ${row.success} · 失败 ${row.failed}${row.running ? ` · 在途 ${row.running}` : ''}</small></div><div class="al-wave" role="img" aria-label="近十小时成功率快照">${slots.map(p => {
        const b = p ? (p.insufficientSamples || p.successRate == null ? bands[5] : band(p.successRate)) : [-1, '#374255', 5], source = p?.source === 'self-test' ? '自测补录' : p?.source ? '人工修正' : '实测';
        const description = p ? `${new Date(p.since).toLocaleString('zh-CN')} – ${new Date(p.until).toLocaleTimeString('zh-CN')} · ${source} · ${p.insufficientSamples || p.successRate == null ? '样本不足' : rate(p.successRate)}` : '尚未形成快照';
        return `<i style="background:${b[1]};height:${b[2]}px" ${p?.source ? 'data-edited' : ''} title="${escape(description)}"></i>`;
      }).join('')}</div><div class="al-wave-meta"><span>近 10H 快照</span><span>${slots.filter(Boolean).length}/60 个快照 · 约 10min/点</span><span>现在</span></div>`;
    }
    function rowHtml(row) {
      const d = drafts.get(row.id), pending = saving.has(row.id), changed = !!d && Object.keys(d.fields).length > 0;
      const status = row.unavailableReason || (priceOnly ? '' : !row.effectiveEnabled ? '已停用' : row.success + row.failed + row.running ? '线路已启用' : '本小时暂无请求');
      return `<article class="al-row" data-line="${escape(row.id)}">
        <div class="al-identity">
          <div class="al-name">${priceOnly ? '' : '<span class="al-pulse">⌁</span>'}<div><strong>${escape(row.displayName || row.name)}</strong>${status ? `<span class="al-status">${escape(status)}</span>` : ''}</div></div>
          <button type="button" class="al-switch" role="switch" aria-label="${escape(row.familyName + ' · ' + row.name)}启用" aria-checked="${row.enabled}" data-action="toggle" ${pending || !row.enabled && !row.canEnable ? 'disabled' : ''}><i></i>${row.enabled ? '启用' : '禁用'}</button>
          ${layer === 'retail' ? '<button type="button" data-action="label" class="sm ghost" style="margin-left:10px">显示名</button>' : ''}
        </div>
        ${priceOnly ? '' : `<div class="al-stat">${wave(row)}</div>`}
        <div class="al-price">
          <div class="al-price-head"><b>${layer === 'purchase' ? '渠道商进货价' : '用户售价'}</b><small>${escape(row.groupName||'分组价格')} · 分组统一设置</small></div>
          <div class="al-price-fields">${row.fields.map((f, i) => `<div class="al-price-field"><label for="al-${escape(row.id)}-${i}">${escape(f.label)}<small>${escape(f.unit)}</small></label><input id="al-${escape(row.id)}-${i}" data-field="${escape(f.key)}" type="number" min="${f.key === 'multiplier' ? '0.00000001' : '0'}" max="${f.key === 'multiplier' ? 1000 : 1000000}" step="any" value="${escape(d && Object.hasOwn(d.fields, f.key) ? d.fields[f.key] : f.value ?? '')}" placeholder="${escape(f.range ?? '')}" ${pending || row.priceReadonly ? 'disabled' : ''}></div>`).join('')}</div>
          <div class="al-draft-note">${changed ? d.revision !== row.revision ? '配置已更新；未保存的输入已保留，请刷新核对后重新填写。' : '价格已修改，尚未保存' : ''}</div>
          <div class="al-actions" ${row.priceReadonly ? 'hidden style="display:none"' : ''}><button type="button" class="sm ghost" data-action="discard" ${!changed || pending ? 'disabled' : ''}>撤销输入</button><button type="button" class="sm ghost" data-action="reset" ${!row.customPrice || pending ? 'disabled' : ''}>恢复平台价</button><button type="button" class="sm pri" data-action="save" ${!changed || pending ? 'disabled' : ''}>${pending ? '保存中…' : '保存价格'}</button></div>
          <div class="al-reference">${layer === 'purchase' ? '用户售价' : '进货价'}：${row.referenceFields.map(f => `${escape(f.label)} ${escape(f.value == null ? f.range : number(f.value))} ${escape(f.unit)}`).join(' · ')}</div>
        </div>
      </article>`;
    }
    function updateTimestamp() {
      const updated = $('[data-updated]');
      if (updated) updated.textContent = data ? `更新于 ${new Date(data.until).toLocaleTimeString('zh-CN')} · 每 60 秒刷新` : '正在读取线路统计…';
    }
    function render() {
      if (!alive()) return;
      const focusedFamily = host.contains(document.activeElement) ? document.activeElement?.closest('[data-family]')?.dataset.family : undefined;
      $('.al-toolbar .al-tabs').innerHTML = categories.map(([id, label, icon]) => `<button type="button" data-category="${id}" aria-pressed="${category === id}"><span>${icon}</span>${label}<small>${rows().filter(r => categoryOf(r.capability) === id).length}</small></button>`).join('');
      updateTimestamp();
      const groups = new Map();
      for (const row of rows()) {
        if (categoryOf(row.capability) !== category || query && !`${row.familyName} ${row.name}`.toLocaleLowerCase().includes(query)) continue;
        if (!groups.has(row.familyId)) groups.set(row.familyId, { name: row.familyName, rows: [] });
        groups.get(row.familyId).rows.push(row);
      }
      const activeFamily = groups.has(selectedFamilies.get(category)) ? selectedFamilies.get(category) : groups.keys().next().value;
      if (priceOnly) $('.al-families').innerHTML = [...groups].map(([id, g]) => `<button type="button" data-family="${escape(id)}" aria-pressed="${id === activeFamily}">${escape(g.name)}<small>${g.rows.length}</small></button>`).join('');
      const visibleGroups = priceOnly ? groups.has(activeFamily) ? [groups.get(activeFamily)] : [] : [...groups.values()];
      $('.al-body').innerHTML = !data ? '<div class="al-empty">正在读取…</div>' : !groups.size ? '<div class="al-empty">暂无匹配线路</div>' : visibleGroups.map(g => `<section class="al-family"><h3>${escape(g.name)}<span>${g.rows.length} 条线路</span></h3><div class="al-list">${g.rows.map(rowHtml).join('')}</div></section>`).join('');
      if (focusedFamily) [...host.querySelectorAll('[data-family]')].find(b => b.dataset.family === focusedFamily)?.focus({ preventScroll: true });
    }
    async function refresh() {
      if (busy || !alive()) return;
      busy = true; const seq = ++sequence;
      $('[data-action=refresh]').disabled = true;
      try {
        const next = await api(endpoint);
        if (!alive() || seq !== sequence) return;
        data = next; $('.al-error').textContent = '';
        for (const id of drafts.keys()) if (!rowFor(id)) drafts.delete(id);
        // A minute refresh never replaces the focused number input.
        if (document.activeElement?.matches('[data-field]') && host.contains(document.activeElement)) {
          if (!priceOnly) host.querySelectorAll('[data-line]').forEach(el => { const r = rowFor(el.dataset.line); if (r) el.querySelector('.al-stat').innerHTML = wave(r); });
          updateTimestamp();
        } else render();
      } catch (e) { if (alive()) $('.al-error').textContent = `读取失败：${e.message}。已输入的价格仍保留，可重试刷新。`; }
      finally { busy = false; if (alive()) $('[data-action=refresh]').disabled = false; }
    }
    async function save(row, patch, keepDraft = false) {
      if (saving.has(row.id)) return;
      saving.add(row.id); sequence++; render();
      try {
        const d = drafts.get(row.id), revision = patch.fields ? d.revision : row.revision;
        const result = await api(`${endpoint}/${encodeURIComponent(row.id)}`, { method: 'PUT', body: JSON.stringify({ revision, ...patch }) });
        if (!alive()) return;
        Object.assign(rowFor(row.id), result.row, { displayName: result.row.displayName });
        if (keepDraft && d) d.revision = result.row.revision; else drafts.delete(row.id);
        $('.al-error').textContent = ''; toast('线路设置已保存');
      } catch (e) { if (alive()) $('.al-error').textContent = `保存失败：${e.message}。未保存的输入已保留。`; }
      finally { saving.delete(row.id); render(); }
    }
    host.oninput = event => {
      const input = event.target;
      if (input.matches('.al-search')) { query = input.value.trim().toLocaleLowerCase(); render(); return; }
      if (!input.matches('[data-field]')) return;
      const article = input.closest('[data-line]'), row = rowFor(article.dataset.line), d = draft(row);
      d.fields[input.dataset.field] = input.value;
      article.querySelector('[data-action=save]').disabled = false; article.querySelector('[data-action=discard]').disabled = false;
      article.querySelector('.al-draft-note').textContent = '价格已修改，尚未保存';
    };
    host.onclick = event => {
      const button = event.target.closest('button'); if (!button || button.disabled) return;
      if (button.dataset.category) { category = button.dataset.category; render(); return; }
      if (button.dataset.family) { selectedFamilies.set(category, button.dataset.family); render(); return; }
      const action = button.dataset.action; if (action === 'refresh') { void refresh(); return; }
      const row = rowFor(button.closest('[data-line]')?.dataset.line); if (!row) return;
      if (action === 'discard') { drafts.delete(row.id); render(); }
      if (action === 'toggle') void save(row, { enabled: !row.enabled }, true);
      if (action === 'label') confirmDo({ title: '客户端显示名', text: '<label>留空沿用平台名称<input id="al-label-edit" maxlength="40" value="' + escape(row.displayName || '') + '" style="width:100%;margin-top:10px"></label>', okLabel: '保存', danger: false, onOk: () => void save(row, { label: document.getElementById('al-label-edit').value }, true) });
      if (action === 'reset') confirmDo({ title: '恢复平台价', text: '仅恢复这条线路的价格；启用状态保持不变。', okLabel: '恢复', danger: false, onOk: () => void save(row, { reset: true }) });
      if (action === 'save') {
        const d = drafts.get(row.id); if (!d) return;
        const article = button.closest('[data-line]');
        for (const input of article.querySelectorAll('[data-field]')) if (Object.hasOwn(d.fields, input.dataset.field) && (!input.value.trim() || !input.checkValidity())) { input.reportValidity(); input.focus(); $('.al-error').textContent = '请填写有效价格，0 表示免费，空白不会保存为 0。'; return; }
        void save(row, { fields: Object.fromEntries(Object.entries(d.fields).map(([k, v]) => [k, Number(v)])) });
      }
    };
    const timer = setInterval(() => { if (!alive()) { dispose(); return; } if (!document.hidden && host.getClientRects().length) void refresh(); }, 60000);
    function dispose() { disposed = true; sequence++; clearInterval(timer); drafts.clear(); host.oninput = host.onclick = null; }
    instances.set(host, dispose); render(); void refresh();
    return dispose;
  }
  return { mount };
})();
