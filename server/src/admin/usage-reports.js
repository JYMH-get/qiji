/* Shared source/merchant daily usage table. Access control lives in the API. */
window.QijiUsageReports = (() => {
  let dispose;
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  const number = value => Number(value || 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
  const mode = value => ({ shared:'共享积分', dispatch:'分配积分', personal:'个人积分', unknown:'待核对' }[value] || value);
  const styles = `.ur-view-buttons{display:flex;gap:4px;padding:3px;border:1px solid var(--line,#dbe2ec);border-radius:9px}.ur-view-buttons button{border-color:transparent;background:transparent}.ur-view-buttons button[aria-pressed="true"]{background:var(--acc,#315edb);color:#fff;border-color:var(--acc,#315edb)}.ur-view-buttons button:focus-visible{outline:2px solid var(--acc,#315edb);outline-offset:2px}.ur-toolbar{position:sticky;top:var(--ur-top-height,0px);z-index:15;background:var(--bg,#0c0e13);padding:10px 0;box-shadow:0 1px 0 var(--line,#dbe2ec);display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:0 0 14px}.ur-toolbar label{display:flex;align-items:center;gap:8px}.ur-status{font-size:12px;color:var(--mut,#64748b)}.ur-company{margin-bottom:24px}.ur-company h3{margin:0 0 10px}.ur-kpis{display:flex;flex-wrap:wrap;gap:24px;margin-bottom:12px}.ur-kpis span{color:var(--mut,#64748b);font-size:12px}.ur-kpis strong{display:block;color:var(--text,#253858);font-size:22px;margin-top:3px}.ur-scroll{overflow:visible;border:1px solid var(--line,#dbe2ec);border-radius:8px}.ur-table{border-collapse:separate;border-spacing:0;width:max-content;min-width:100%;font-size:13px;font-variant-numeric:tabular-nums}.ur-table th,.ur-table td{padding:10px 14px;white-space:nowrap;min-width:84px;text-align:right;border-bottom:1px solid var(--line,#e5eaf1)}.ur-table th{position:sticky;top:0;background:var(--panel2,#f3f6fb);z-index:2;color:var(--text,#253858)}.ur-table th:first-child,.ur-table td:first-child{position:sticky;left:0;text-align:left;min-width:180px;max-width:280px;overflow:hidden;text-overflow:ellipsis;background:var(--panel,#fff);z-index:1}.ur-table th:first-child{z-index:3;background:var(--panel2,#f3f6fb)}.ur-table th:nth-child(2),.ur-table td:nth-child(2){text-align:left}.ur-table tr:nth-child(even) td{background:var(--panel2,#f7f9fc)}.ur-table tfoot td,.ur-table tfoot td:first-child{font-weight:700;background:var(--panel2,#eef3fb)}.ur-detail-title{display:flex;align-items:center;gap:10px;margin:18px 0 10px}.ur-detail-title h4{margin:0}.ur-table button{font:inherit;color:var(--acc,#315edb);padding:0;border:0;background:none;text-align:left;cursor:pointer;text-decoration:underline;text-underline-offset:3px}.ur-error{color:var(--bad,#b42318);padding:12px 0}.ur-note{font-size:12px;color:var(--mut,#64748b);margin:10px 0}.ur-empty{padding:20px;color:var(--mut,#64748b)}`;
  function mount(root, { api, merchant = false }) {
    if (!root) return;
    dispose?.();
    const topBar = root.closest('.main')?.querySelector('.top');
    const updateTopOffset = () => root.style.setProperty('--ur-top-height', `${topBar?.getBoundingClientRect().height || 0}px`);
    const topObserver = new ResizeObserver(updateTopOffset);
    if (topBar) topObserver.observe(topBar);
    updateTopOffset();
    if (!document.getElementById('usage-report-style')) { const style = document.createElement('style'); style.id = 'usage-report-style'; style.textContent = styles; document.head.append(style); }
    let alive = true, version = 0, data, days = 30, companyId = merchant ? '' : 'source', busy = false, view = 'credits', productDay = '', from = '', to = '', appliedRange;
    const types = { text:['文本','次'], image:['图片','张'], video:['视频','秒'], audio:['音频','次'], other:['其他','次'] };
    const average = metric => metric.average == null ? '—' : Number(metric.average).toLocaleString('zh-CN',{maximumFractionDigits:4});
    function totalValue(item) { return number(item.total); }
    function productCells(products) {
      return Object.entries(types).map(([key,[name,unit]])=>{const m=products[key];
        const quantity=m.requests && m.missing===m.requests ? '—' : number(m.quantity);
        const note=m.missing ? number(m.missing)+' 次数量缺失' : '';
        return `<td title="${m.missing ? '仅按数量已知的成功记录计算均价' : '用户消耗积分 / '+unit}"><div>${quantity} ${unit}</div><small class="ur-status">${average(m)} 积分/${unit}${m.missing && m.average!=null ? '（已知部分）' : ''}</small>${note ? '<br><small class="ur-status">'+escape(note)+'</small>' : ''}</td>`;
      }).join('');
    }
    function productCompanyView(company,index) {
      const headers=Object.values(types).map(([name])=>`<th scope="col">${name}</th>`).join('');
      const picked=selectedGroups.get(company.id)||'ungrouped';
      const group=company.groups.find(g=>g.id===picked)||company.groups[0];
      const rows=company.groups.map((g,i)=>`<tr><td><button type="button" data-group="${i}" aria-pressed="${g.id===group?.id}">${escape(g.name)}</button></td><td>${escape(mode(g.mode))}</td><td>${number(g.members.length)}</td>${productCells(g.products)}</tr>`).join('');
      return `<section class="ur-company" data-company-index="${index}"><h3>${escape(company.name)} · ${escape(data.from)} 单日输出</h3><div class="ur-kpis">${kpis(company)}<div><span>团队</span><strong>${number(company.teamCount)}</strong></div><div><span>人数</span><strong>${number(company.userCount)}</strong></div></div>
        <div class="ur-scroll" tabindex="0" aria-label="${escape(company.name)}单日成品统计"><table class="ur-table"><thead><tr><th scope="col">分类 / 小组</th><th scope="col">积分方式</th><th scope="col">人数</th>${headers}</tr></thead><tbody>${rows||'<tr><td colspan="8">暂无团队或个人</td></tr>'}</tbody><tfoot><tr><td>公司合计</td><td></td><td>${number(company.userCount)}</td>${productCells(company.products)}</tr></tfoot></table></div>
        <div class="ur-detail-title"><h4>${escape(group?.name||'成员明细')}</h4><span class="ur-status">${number(group?.members.length)} 人 · 成员单日成品</span></div>
        ${group?.members.length ? `<div class="ur-scroll" tabindex="0" aria-label="${escape(group.name)}成员成品明细"><table class="ur-table"><thead><tr><th scope="col">成员</th><th scope="col">身份</th><th scope="col">账号</th>${headers}</tr></thead><tbody>${group.members.map(m=>`<tr><td title="${escape(m.name)}">${escape(m.name)}</td><td>${escape(m.role)}</td><td>${escape(m.account||'—')}</td>${productCells(m.products)}</tr>`).join('')}</tbody><tfoot><tr><td>小组合计</td><td></td><td></td>${productCells(group.products)}</tr></tfoot></table></div>` : '<div class="ur-empty">暂无成员</div>'}</section>`;
    }
    function kpis(company) {
      if (view === 'credits') return `<div><span>消耗积分</span><strong>${number(company.total)}</strong></div><div><span>团队</span><strong>${number(company.teamCount)}</strong></div><div><span>人数</span><strong>${number(company.userCount)}</strong></div>`;
      return Object.entries(types).map(([key,[name,unit]])=>{const m=company.products[key];return `<div><span>${name} · ${number(m.requests)} 次成功</span><strong>${m.requests && m.missing === m.requests ? '—' : number(m.quantity)} ${unit}</strong><span>均价 ${average(m)} 积分/${unit}${m.missing ? ` · ${number(m.missing)} 次数量缺失` : ''}</span></div>`;}).join('');
    }
    const selectedGroups = new Map();
    const endpoint = merchant ? '/agent-api/usage-reports' : '/admin-api/usage-reports';
    root.innerHTML = '<div class="ur-status" role="status">统计加载中…</div>';
    function cells(values) { return values.map(v => `<td>${number(v)}</td>`).join(''); }
    function dateHeaders() { return data.dates.map(d => `<th scope="col" title="${escape(d)} 北京时间 08:00 至次日 08:00">${escape(d.slice(5))}${d === data.today ? ' *' : ''}</th>`).join(''); }
    function companyView(company, index) {
      if (view === 'products') return productCompanyView(company,index);
      const picked = selectedGroups.get(company.id) || 'ungrouped';
      const group = company.groups.find(g => g.id === picked) || company.groups[0];
      return `<section class="ur-company" data-company-index="${index}"><h3>${escape(company.name)}</h3><div class="ur-kpis">${kpis(company)}</div>
        <div class="ur-scroll" tabindex="0" aria-label="${escape(company.name)}公司总表"><table class="ur-table"><thead><tr><th scope="col">分类 / 小组</th><th scope="col">积分方式</th><th scope="col">人数</th>${dateHeaders()}<th scope="col">合计</th></tr></thead><tbody>${company.groups.map((g, i) => `<tr><td><button type="button" data-group="${i}" aria-pressed="${g.id === group?.id}">${escape(g.name)}</button></td><td>${escape(mode(g.mode))}</td><td>${number(g.members.length)}</td>${cells(g.daily, g.dailyProducts)}<td>${totalValue(g)}</td></tr>`).join('')}</tbody><tfoot><tr><td>公司合计</td><td></td><td>${number(company.userCount)}</td>${cells(company.daily, company.dailyProducts)}<td>${totalValue(company)}</td></tr></tfoot></table></div>
        <div class="ur-detail-title"><h4>${escape(group?.name || '成员明细')}</h4><span class="ur-status">成员每日消耗</span></div>
        ${group?.members.length ? `<div class="ur-scroll" tabindex="0" aria-label="${escape(group.name)}成员明细"><table class="ur-table"><thead><tr><th scope="col">成员</th><th scope="col">身份</th><th scope="col">账号</th>${dateHeaders()}<th scope="col">合计</th></tr></thead><tbody>${group.members.map(m => `<tr><td title="${escape(m.name)}">${escape(m.name)}</td><td>${escape(m.role)}</td><td>${escape(m.account || '—')}</td>${cells(m.daily, m.dailyProducts)}<td>${totalValue(m)}</td></tr>`).join('')}</tbody><tfoot><tr><td>小组合计</td><td></td><td></td>${cells(group.daily, group.dailyProducts)}<td>${totalValue(group)}</td></tr></tfoot></table></div>` : '<div class="ur-empty">暂无成员</div>'}</section>`;
    }
    function render() {
      const scrolls = [...root.querySelectorAll('.ur-scroll')].map(el => [el.scrollLeft, el.scrollTop]);
      root.innerHTML = `<div class="ur-toolbar"><div class="ur-view-buttons" role="group" aria-label="统计视角"><button type="button" data-view="credits" aria-pressed="${view === 'credits'}">总览</button><button type="button" data-view="products" aria-pressed="${view === 'products'}">成品</button></div>${!merchant ? `<label>公司<select data-filter="company" aria-label="统计公司"><option value="all" ${companyId === 'all' ? 'selected' : ''}>全部公司</option>${data.availableCompanies.map(c => `<option value="${escape(c.id)}" ${companyId === c.id ? 'selected' : ''}>${escape(c.name)}</option>`).join('')}</select></label>` : ''}${view === 'products' ? `<label>日期<input type="date" data-filter="product-day" aria-label="成品日期" value="${escape(productDay)}" min="${data.startAt.slice(0,10)}" max="${data.today}"></label>` : `<label>时间<select data-filter="days" aria-label="统计天数">${[7,30,90].map(n => `<option value="${n}" ${n === days ? 'selected' : ''}>近 ${n} 天</option>`).join('')}<option value="custom" ${days === 'custom' ? 'selected' : ''}>自定义</option></select></label>${days === 'custom' ? `<label>开始<input type="date" data-filter="from" aria-label="开始日期" value="${escape(from)}" min="${data.startAt.slice(0,10)}" max="${data.today}"></label><label>结束<input type="date" data-filter="to" aria-label="结束日期" value="${escape(to)}" min="${data.startAt.slice(0,10)}" max="${data.today}"></label><button type="button" data-action="apply">查询</button>` : ''}`}<button type="button" data-action="refresh">刷新</button><button type="button" data-action="export" ${data.companies.length !== 1 ? 'disabled title="请先选择一家公司"' : ''}>导出 CSV</button><span class="ur-status" role="status">更新于 ${escape(new Date(data.generatedAt).toLocaleString('zh-CN', { hour12: false }))}</span></div><div class="ur-error" role="alert" hidden></div><p class="ur-note">从 ${escape(new Date(data.startAt).toLocaleString('zh-CN', { hour12:false }))} 开始统计。按请求提交时间归属统计日：北京时间当日08:00至次日08:00（不含）；* 为当前未结束统计日。${view === 'products' ? '成品仅计成功；去字幕、超分等归入其他，按次统计；均价为用户消耗积分÷成品数量，缺数量的请求不参与均价。' : '发码不计消耗；失败按退款设置结算。'}</p>${data.companies.map(companyView).join('') || '<div class="ur-empty">暂无公司数据</div>'}`;
      [...root.querySelectorAll('.ur-scroll')].forEach((el,i) => { if (scrolls[i]) [el.scrollLeft, el.scrollTop] = scrolls[i]; });
    }
    async function refresh() {
      const requestVersion = ++version;
      busy = true;
      // A changed filter must not leave the previous company's data/export visible.
      root.querySelector('[data-action="export"]')?.setAttribute('disabled', '');
      try {
        const q = new URLSearchParams(view === 'products' ? {from:productDay,to:productDay} : appliedRange || { days: String(days === 'custom' ? 30 : days) }); if (!merchant) q.set('companyId', companyId);
        const result = await api(endpoint + '?' + q);
        if (!alive || requestVersion !== version) return;
        data = result; if (!productDay) productDay = data.to || data.today; if (!from) from = data.from || data.startAt.slice(0,10); if (!to) to = data.to || data.today; render();
      } catch (error) {
        if (!alive || requestVersion !== version) return;
        data = undefined;
        root.innerHTML = `<div class="ur-error" role="alert">统计加载失败：${escape(error.message)}</div><button type="button" data-action="refresh">重试</button>`;
      } finally { if (requestVersion === version) busy = false; }
    }
    function exportCsv() {
      if (busy || data?.companies.length !== 1) return;
      const company = data.companies[0];
      const rows = [['公司', company.name], ['统计起点', data.startAt], ['快照时间', data.generatedAt], ['日期口径', '北京时间当日08:00至次日08:00（不含）；当前统计日为部分日'], ['小组', '成员', '身份', '账号', ...data.dates, '合计']];
      if (view === 'products') {
        rows.splice(4,1,['日期',data.from],['层级','团队 / 个人','所属团队',...Object.values(types).flatMap(([name,unit])=>[name+'数量（'+unit+'）',name+'均价（积分/'+unit+'）',name+'缺数量次数'])]);
        const add=(level,name,group,products)=>rows.push([level,name,group,...Object.keys(types).flatMap(key=>{const m=products[key];return [m.requests && m.missing===m.requests?'':m.quantity,m.average??'',m.missing]})]);
        for(const g of company.groups){
          const personal=g.id==='ungrouped'||g.id==='historical';
          if(!personal)add('团队小计',g.name,'',g.products);
          for(const m of g.members)add(personal?'个人':'成员',m.name,personal?'':g.name,m.products);
        }
        add('公司合计',company.name,'',company.products);
      } else {
       for (const group of company.groups) {
        for (const m of group.members) rows.push([group.name, m.name, m.role, m.account, ...m.daily, m.total]);
        rows.push([group.name, '小组合计', '', '', ...group.daily, group.total]);
       }
       rows.push(['公司合计', '', '', '', ...company.daily, company.total]);
      }
      const encode = value => { let s = String(value ?? ''); if (typeof value === 'string' && /^[\s]*[=+@-]/.test(s)) s = "'" + s; return '"' + s.replaceAll('"', '""') + '"'; };
      const url = URL.createObjectURL(new Blob(['\uFEFF' + rows.map(r => r.map(encode).join(',')).join('\r\n')], { type:'text/csv;charset=utf-8' }));
      const a = document.createElement('a'); a.href = url; a.download = `${company.name.replace(/[<>:"/\\|?*]/g,'-')}-${view === 'products' ? '单日成品' : '积分消耗'}-${data.from || ''}-${data.to || ''}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    function onChange(event) {
      const filter=event.target.dataset.filter, value=event.target.value;
      if (filter === 'product-day') {
        if (!value || value < data.startAt.slice(0,10) || value > data.today) { const error=root.querySelector('.ur-error');error.hidden=false;error.textContent='请选择统计起点至今天内的日期'; return; }
        productDay=value; refresh(); return;
      }
      if (filter === 'from') { from=value; return; }
      if (filter === 'to') { to=value; return; }
      if (filter === 'company') companyId = value;
      else if (filter === 'days') {
        if(value === 'custom') { days='custom'; if(data)render(); return; }
        days=Number(value); appliedRange=undefined; from='';to='';
      }
      else return;
      data = undefined;
      root.innerHTML = '<div class="ur-status" role="status">统计加载中…</div>';
      refresh();
    }
    function onClick(event) {
      const button = event.target.closest('button'); if (!button) return;
      if (button.dataset.view) {
        if (view !== button.dataset.view) { view=button.dataset.view; refresh(); }
        return;
      }
      if (button.dataset.action === 'apply') {
        if (!from || !to || from > to || from < data.startAt.slice(0,10) || to > data.today || Date.parse(to)-Date.parse(from)>365*86400000) {
          const error=root.querySelector('.ur-error');error.hidden=false;error.textContent='请选择统计起点至今天内的有效日期，单次最多366天';return;
        }
        appliedRange={from,to};refresh();
      }
      else if (button.dataset.action === 'refresh') refresh();
      else if (button.dataset.action === 'export') exportCsv();
      else if (button.dataset.group !== undefined && data) {
        const company = data.companies[Number(button.closest('[data-company-index]').dataset.companyIndex)];
        selectedGroups.set(company.id, company.groups[Number(button.dataset.group)].id); render();
      }
    }
    root.addEventListener('change', onChange); root.addEventListener('click', onClick);
    const interval = setInterval(() => { if (alive && root.isConnected && root.getClientRects().length && !document.hidden && !busy) refresh(); }, 60_000);
    dispose = () => { alive = false; ++version; clearInterval(interval); topObserver.disconnect(); root.removeEventListener('change', onChange); root.removeEventListener('click', onClick); };
    refresh();
  }
  return { mount };
})();
