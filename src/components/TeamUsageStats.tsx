import { useEffect, useState } from 'react';
import { managedClient } from '@/services/managedClient';
import type { TeamUsageReport, TeamUsageProducts } from '@/contract';

const kinds = [ ['text','文本','次'], ['image','图片','张'], ['video','视频','秒'], ['audio','音频','次'], ['other','其他','次'] ] as const;
const fmt = (value: number) => value.toLocaleString('zh-CN',{maximumFractionDigits:4});
const control = 'rounded-lg border border-border bg-secondary/30 px-3 py-1.5 text-xs';

export function TeamUsageStats({personal = false}: {personal?: boolean}) {
  const today = new Date().toISOString().slice(0,10);
  const [view,setView] = useState<'credits'|'products'>(personal ? 'products' : 'credits');
  const [days,setDays] = useState('30');
  const [from,setFrom] = useState(today);
  const [to,setTo] = useState(today);
  const [day,setDay] = useState(today);
  const [refresh,setRefresh] = useState(0);
  const [report,setReport] = useState<TeamUsageReport|null>(null);
  const [busy,setBusy] = useState(true);
  const [error,setError] = useState('');
  useEffect(() => {
    let active = true;
    let version = 0;
    const load = async () => {
      const requestVersion = ++version;
      setBusy(true); setError(''); setReport(null);
      const range = view === 'products' ? {from:day,to:day} : days === 'custom' ? {from,to} : undefined;
      if (range && (!range.from || !range.to || range.from > range.to || range.to > today || Date.parse(range.to)-Date.parse(range.from)>365*86400000)) {
        setError('请选择有效日期，单次最多366天，结束日期不能晚于今天'); setBusy(false); return;
      }
      try {
        const result = await (personal ? managedClient.getPersonalProductReport : managedClient.getTeamUsageReport)(range ?? {days:Number(days)});
        if (active && requestVersion === version) setReport(result);
      } catch (e) {
        if (active && requestVersion === version) setError((e as Error).message || '加载失败');
      } finally { if (active && requestVersion === version) setBusy(false); }
    };
    void load();
    const timer = setInterval(() => { if (!document.hidden) void load(); },60000);
    return () => { active = false; clearInterval(timer); };
  },[view,days,from,to,day,refresh,today,personal]);

  const exportCsv = () => {
    if (!report || busy) return;
    const productCells = (products: TeamUsageProducts) => kinds.flatMap(([kind,,unit]) => [products[kind].quantity,products[kind].average ?? '',products[kind].missing,unit]);
    const rows: (string|number)[][] = [
      ['日期口径','北京时间当日08:00至次日08:00（不含）'],
      view === 'products' ? [personal ? '用户' : '成员','身份',...kinds.flatMap(([,label]) => [label+'数量',label+'均价（积分）',label+'数量未知次数','单位'])] : ['成员','身份','合计积分',...report.dates],
      ...report.team.members.map(m => [m.name,m.active ? m.role : '已离团',...(view === 'products' ? productCells(m.products) : [m.total,...m.daily])]),
      [personal ? '个人合计' : '团队合计','',...(view === 'products' ? productCells(report.team.products) : [report.team.total,...report.team.daily])],
    ];
    const escape = (v:string|number) => '"'+String(typeof v === 'string' && /^[=+@\-\t\r]/.test(v) ? "'"+v : v).replace(/"/g,'""')+'"';
    const url = URL.createObjectURL(new Blob(['\uFEFF'+rows.map(row => row.map(escape).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8'}));
    const link = document.createElement('a'); link.href = url; link.download = `${personal ? '个人统计' : '团队统计'}-${view}-${report.dates[report.dates.length-1] ?? today}-${report.dates[0] ?? today}.csv`; link.click();
    setTimeout(() => URL.revokeObjectURL(url),1000);
  };
  const productCells = (products:TeamUsageProducts) => kinds.map(([kind,,unit]) => {
    const m = products[kind];
    return <td key={kind} className="px-3 py-3 text-right whitespace-nowrap">
      <div>{fmt(m.quantity)} {unit}</div>
      <div className="mt-1 text-[11px] font-normal text-muted-foreground">{m.average === null ? '—' : fmt(m.average)} 积分/{unit}{m.missing > 0 && m.average !== null ? '（已知部分）' : ''}</div>
      {m.missing > 0 && <div className="text-[11px] font-normal text-muted-foreground">{m.missing} 次数量未知</div>}
    </td>;
  });
  return <section className="space-y-4 text-xs" aria-label={personal ? "个人成品统计" : "团队统计"}>
    <div className="flex flex-wrap items-center gap-2">
      {!personal && <div role="group" aria-label="统计视角" className="flex gap-1">
        {(['credits','products'] as const).map(value => <button key={value} type="button" aria-pressed={view === value} onClick={() => setView(value)} className={`${control} ${view === value ? 'bg-primary/20 text-primary font-semibold' : ''}`}>{value === 'credits' ? '总览' : '成品'}</button>)}
      </div>}
      {view === 'products' ? <label>日期 <input className={control} aria-label="成品日期" type="date" max={today} value={day} onChange={e => setDay(e.target.value)}/></label> : <>
        <select className={control} aria-label="统计时间范围" value={days} onChange={e => setDays(e.target.value)}>
          <option value="7">近7天</option><option value="30">近30天</option><option value="90">近90天</option><option value="custom">自定义</option>
        </select>
        {days === 'custom' && <><input className={control} aria-label="开始日期" type="date" max={to || today} value={from} onChange={e => setFrom(e.target.value)}/><span>至</span><input className={control} aria-label="结束日期" type="date" max={today} value={to} onChange={e => setTo(e.target.value)}/></>}
      </>}
      <button className={control} type="button" disabled={busy} onClick={() => setRefresh(n => n+1)}>刷新</button>
      <button className={control} type="button" disabled={!report || busy} onClick={exportCsv}>导出 CSV</button>
    </div>
    {busy && <p role="status">正在加载统计…</p>}
    {error && <p role="alert" className="text-red-400">{error}</p>}
    {report && <>
      <div className="flex flex-wrap justify-between gap-2"><strong>{report.team.name} · {view === 'credits' ? `消耗 ${fmt(report.team.total)} 积分` : personal ? '本人单日成品' : '成员单日成品'}</strong><span className="text-muted-foreground">北京时间 08:00—次日 08:00 · 每分钟更新</span></div>
      {!report.dates.length ? <p>该时间段暂无可统计数据</p> : <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-xs"><thead className="bg-secondary/40"><tr><th className="px-3 py-2 text-left whitespace-nowrap">{personal ? '用户 / 身份' : '成员 / 身份'}</th>
          {view === 'products' ? kinds.map(([,label]) => <th key={label} className="px-3 py-2 text-right">{label}</th>) : <><th className="px-3 py-2 text-right whitespace-nowrap">合计积分</th>{report.dates.map(date => <th key={date} className="px-3 py-2 text-right whitespace-nowrap">{date}</th>)}</>}
        </tr></thead><tbody>
          {report.team.members.map(m => <tr key={m.userId} className="border-t border-border/40"><td className="px-3 py-3 min-w-28"><div>{m.name}</div><small className="text-muted-foreground">{m.active ? m.role : '已离团'}</small></td>
            {view === 'products' ? productCells(m.products) : <><td className="px-3 py-3 text-right font-semibold">{fmt(m.total)}</td>{m.daily.map((n,i) => <td key={report.dates[i]} className="px-3 py-3 text-right">{fmt(n)}</td>)}</>}
          </tr>)}
          <tr className="border-t border-border bg-secondary/30 font-semibold"><td className="px-3 py-3 whitespace-nowrap">{personal ? '个人合计' : '团队合计'}</td>{view === 'products' ? productCells(report.team.products) : <><td className="px-3 py-3 text-right">{fmt(report.team.total)}</td>{report.team.daily.map((n,i) => <td key={report.dates[i]} className="px-3 py-3 text-right">{fmt(n)}</td>)}</>}</tr>
        </tbody></table>
      </div>}
      <p className="text-[11px] text-muted-foreground">从 {report.startAt.slice(0,10)} 起统计{personal ? '本人的成功成品' : '在本团队期间的消耗；成品仅计成功结果'}。更新于 {new Date(report.generatedAt).toLocaleString('zh-CN')}。</p>
    </>}
  </section>;
}
