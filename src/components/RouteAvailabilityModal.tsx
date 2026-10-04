import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Activity, AudioLines, ChevronDown, Image, Info, RefreshCw, Search, Shapes, Type, Video, X } from 'lucide-react';
import type { RoutePriceAvailability, RoutePriceAvailabilityRow } from '@/contract';
import { managedClient } from '@/services/managedClient';
import { useConnectionStore } from '@/store/connectionStore';
import { formatClock, formatRate, historySlots, rateBand, RATE_BANDS, routePrice, snapshotDescription } from '@/lib/routeAvailability';
import './RouteAvailabilityModal.css';
import { PromptExamplesPanel } from './PromptExamplesPanel';

const categories = [
  { id: 'text', label: '文本', Icon: Type }, { id: 'image', label: '图像', Icon: Image },
  { id: 'video', label: '视频', Icon: Video }, { id: 'audio', label: '音频', Icon: AudioLines },
  { id: 'other', label: '其他', Icon: Shapes },
];
const categoryOf = (value: string) => categories.some(c => c.id === value) ? value : 'other';

function LineRow({ row, until }: { row: RoutePriceAvailabilityRow; until: number }) {
  const price = row.capability === 'text' ? null : routePrice(row);
  const latest = row.history.slice(-60);
  return <article className={`route-status__row${!price ? ' without-price' : ''}`} aria-label={row.name}>
    <div className="route-status__line">
      <span className="route-status__line-mark"><Activity size={16} /></span>
      <div><h4>{row.name}</h4><small>{row.requests ? `${row.requests} 次请求 · ${row.running} 次在途` : row.trackingSince > Date.now() - 36_000_000 ? '新线路 · 等待实测' : '本小时暂无请求'}</small></div>
    </div>
    <div className="route-status__measurement">
      <div className="route-status__rate"><span>近 1H 实测成功率</span><strong style={{ color: rateBand(row.successRate).color }}>{row.success + row.failed < 10 ? '样本不足' : formatRate(row.successRate)}</strong><small>成功 {row.success} · 失败 {row.failed}</small></div>
      <div className="route-status__wave" role="group" aria-label={`${row.name}近10小时快照`}>
        {historySlots(latest, until).map((p, i) => p ? <button key={i} className={`route-status__bar${p.source ? ' is-adjusted' : ''}`} style={{ background: rateBand(p.insufficientSamples ? null : p.successRate).color, height: rateBand(p.insufficientSamples ? null : p.successRate).height }} title={snapshotDescription(p)} aria-label={snapshotDescription(p)} /> : <span key={i} className="route-status__bar is-empty" title="尚未形成快照" aria-hidden="true" />)}
      </div>
      <div className="route-status__axis"><span>近 10H 快照</span><span>{latest.length ? `${latest.length}/60 个快照 · 约 10min/点` : '正在积累快照'}</span><span>现在</span></div>
      {latest.some(p => p.source) && <span className="route-status__source">斜纹点：{[latest.some(p => p.source === 'self-test') && '自测补录', latest.some(p => p.source === 'correction') && '人工修正'].filter(Boolean).join(' / ')}</span>}
      {row.trackingSince > 0 && <span className="route-status__tracking">本次统计自 {new Date(row.trackingSince).toLocaleString('zh-CN')}</span>}
    </div>
    {price && <details className="route-status__price">
      <summary><span><strong>{price.summary}</strong><small>{price.unit}</small></span><ChevronDown size={14} /></summary>
      <div className="route-status__price-detail"><p>价格明细 · {price.unit}</p>{price.items.map((item, i) => <div key={i}><span>{item.label}</span><b>{item.value}</b></div>)}{price.notes.map(note => <p key={note}>{note}</p>)}</div>
    </details>}
  </article>;
}

export function RouteAvailabilityModal({ onClose }: { onClose: () => void }) {
	const [section, setSection] = useState<'prices' | 'prompts'>('prices');
  const dialog = useRef<HTMLDialogElement>(null);
  const close = useRef(onClose); close.current = onClose;
  const [category, setCategory] = useState('video');
  const [selectedFamilies, setSelectedFamilies] = useState<Record<string, string>>({});
  const body = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  const [response, setResponse] = useState<{ scope: string; data: RoutePriceAvailability } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const loggedIn = useConnectionStore(s => s.loggedIn);
  const accessKey = useConnectionStore(s => s.accessKey);
  const serverUrl = useConnectionStore(s => s.serverUrl);
  const userId = useConnectionStore(s => s.user?.id);
  const scope = JSON.stringify([serverUrl, accessKey, userId, loggedIn]);
  const data = response?.scope === scope && loggedIn ? response.data : null;
  useEffect(() => {
    const previous = document.activeElement;
    const el = dialog.current!; el.showModal();
    return () => { el.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  useEffect(() => {
    let active = true, pending = false;
    setResponse(null); setError(''); setBusy(false);
    const refresh = async () => {
      if (pending || document.hidden || !loggedIn || section !== 'prices') return;
      pending = true; setBusy(true);
      try {
        const result = await managedClient.routeAvailability();
        if (active) { setResponse({ scope, data: result }); setError(''); }
      } catch (e) {
        if (active) { setResponse(null); setError((e as { status?: number }).status === 404 ? '服务端尚未启用线路统计，请更新服务端后重试。' : (e instanceof Error ? e.message : '读取失败，请重试')); }
      } finally { pending = false; if (active) setBusy(false); }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 60_000);
    const onVisible = () => { if (!document.hidden) void refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { active = false; window.clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [loggedIn, accessKey, serverUrl, userId, reload, section]);
  const rows = data?.rows ?? [];
  const groups = useMemo(() => {
    const result = new Map<string, { name: string; rows: RoutePriceAvailabilityRow[] }>();
    const q = query.trim().toLocaleLowerCase();
    for (const row of rows) {
      if (categoryOf(row.capability) !== category || (q && !`${row.familyName} ${row.name}`.toLocaleLowerCase().includes(q))) continue;
      const group = result.get(row.familyId) ?? { name: row.familyName, rows: [] };
      group.rows.push(row); result.set(row.familyId, group);
    }
    return [...result.entries()];
  }, [data, category, query]);
  const activeFamily = groups.find(([id]) => id === selectedFamilies[category]) ?? groups[0];
  useEffect(() => { if (body.current) body.current.scrollTop = 0; }, [category, query, selectedFamilies]);
  return createPortal(<dialog ref={dialog} className="route-status" aria-labelledby="route-status-title" onCancel={e => { e.preventDefault(); close.current(); }} onClick={e => { if (e.target === e.currentTarget) { const r = e.currentTarget.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) close.current(); } }} onKeyDown={e => e.stopPropagation()}>
    <header className="route-status__header"><div className="route-status__heading"><div className="route-status__icon"><Activity size={22} /></div><div><h2 id="route-status-title">公告</h2></div></div><button className="route-status__close" onClick={onClose} aria-label="关闭公告" autoFocus><X size={20} /></button></header>
    <div className="route-status__toolbar"><nav aria-label="公告分类"><button aria-pressed={section === 'prices'} onClick={() => setSection('prices')}>价格和成功率</button><button aria-pressed={section === 'prompts'} onClick={() => setSection('prompts')}>提示词实例</button></nav></div>
    {section === 'prompts' ? <PromptExamplesPanel /> : <>
    <div className="route-status__toolbar"><nav aria-label="模型类别">{categories.map(({ id, label, Icon }) => <button key={id} aria-pressed={category === id} onClick={() => setCategory(id)}><Icon size={16} />{label}<span>{rows.filter(r => categoryOf(r.capability) === id).length}</span></button>)}</nav><label className="route-status__search"><Search size={15} /><input aria-label="搜索模型或线路" placeholder="搜索模型或线路" value={query} onChange={e => setQuery(e.target.value)} /></label></div>
    {!!groups.length && <nav className="route-status__families" aria-label="模型家族">{groups.map(([id, group]) => <button key={id} type="button" aria-pressed={activeFamily?.[0] === id} onClick={() => setSelectedFamilies(previous => ({ ...previous, [category]: id }))}>{group.name}<small>{group.rows.length}</small></button>)}</nav>}
    <div className="route-status__meta"><span><i className={data ? 'is-live' : ''} />{data ? `更新于 ${formatClock(data.until)} · 每 60 秒刷新` : '线路运行情况'}</span><button disabled={busy || !loggedIn} onClick={() => setReload(n => n + 1)}><RefreshCw size={13} className={busy ? 'is-spinning' : ''} />{busy ? '刷新中' : '刷新'}</button></div>
    <div className="route-status__body" ref={body}>
      {!loggedIn ? <p className="route-status__empty">登录后查看当前账户可用线路与价格</p> : error ? <div className="route-status__empty" role="alert"><Info size={24} /><p>{error}</p><button onClick={() => setReload(n => n + 1)}>重新加载</button></div> : !data ? <p className="route-status__empty" role="status">正在读取线路统计…</p> : !activeFamily ? <p className="route-status__empty">{query ? '没有找到匹配的模型或线路' : '该类别暂无可用线路'}</p> : <section className="route-status__family" key={activeFamily[0]}><h3>{activeFamily[1].name}<span>{activeFamily[1].rows.length} 条线路</span></h3><div className="route-status__list">{activeFamily[1].rows.map(row => <LineRow key={row.id} row={row} until={data.until} />)}</div></section>}
    </div>
    <footer className="route-status__footer"><div className="route-status__legend">{RATE_BANDS.map(b => <span key={b.label}><i style={{ background: b.color }} />{b.label}</span>)}<span><i className="is-empty" />尚未形成快照</span></div><details className="route-status__explanation"><summary><Info size={13} />统计说明</summary><p>近 1H：该线路最近一小时提交的请求，成功数 ÷（成功数 + 失败数），在途请求不参与成功率计算，成功与失败合计不足 10 条时显示样本不足。汇总线路内所有模型的请求。</p><p>近 10H：按完成时间统计独立的 10 分钟区间，每分钟刷新，展示最近 60 个快照。区间已结束请求不足 10 条（含零请求）时，显示蓝色样本不足，统计按 80% 代入；空白代表尚未形成快照。停用时暂停采样并保留历史，重新启用后继续积累；重置后重新形成快照。</p></details></footer>
    </>}
  </dialog>, document.body);
}
