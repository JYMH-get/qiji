import { useEffect, useState } from 'react';
import type { Catalog } from '@/contract';
import { managedClient } from '@/services/managedClient';
import { useConnectionStore } from '@/store/connectionStore';
import { promptExamples, PROMPT_EXAMPLE_CATEGORIES } from '@/lib/promptExamples';

export function PromptExamplesPanel() {
  const scope = useConnectionStore(s => JSON.stringify([s.serverUrl, s.accessKey, s.user?.id, s.loggedIn]));
  const loggedIn = useConnectionStore(s => s.loggedIn);
  const [response, setResponse] = useState<{ scope: string; catalog: Catalog } | null>(null);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('全部');
  const [selectedId, setSelectedId] = useState('');
  useEffect(() => {
    let active = true;
    setResponse(null); setError('');
    if (loggedIn) managedClient.fetchCatalog().then(catalog => { if (active) setResponse({ scope, catalog }); })
      .catch(e => { if (active) setError(e.message || '读取失败'); });
    return () => { active = false; };
  }, [scope, loggedIn, reload]);
  const data = response?.scope === scope && loggedIn ? response.catalog : null;
  const items = data ? promptExamples(data).filter(t => (category === '全部' || t.category === category) && `${t.name} ${t.note}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) : [];
  const selected = items.find(item => item.id === selectedId) ?? items[0];
  return <>
    <div className="route-status__toolbar prompt-examples__toolbar"><nav aria-label="提示词分类">{['全部', ...PROMPT_EXAMPLE_CATEGORIES].map(c => <button key={c} aria-pressed={category === c} onClick={() => setCategory(c)}>{c}</button>)}</nav>
      <label className="route-status__search"><input aria-label="搜索提示词实例" placeholder="搜索名称或实例说明" value={query} onChange={e => setQuery(e.target.value)} /></label>
      <button onClick={() => setReload(n => n + 1)}>刷新</button></div>
    <div className="route-status__body prompt-examples">
      {!loggedIn ? <p className="route-status__empty">登录后查看提示词实例</p> : error ? <p role="alert" className="route-status__empty">{error}<button onClick={() => setReload(n => n + 1)}>重试</button></p> : !data ? <p role="status" className="route-status__empty">正在读取提示词实例…</p> : !selected ? <p className="route-status__empty">暂无匹配的提示词实例</p> : <>
        <nav className="prompt-examples__directory" aria-label="提示词目录">{items.map(item => <button key={item.id} type="button" aria-current={selected.id === item.id ? 'true' : undefined} onClick={() => setSelectedId(item.id)}><span>{item.name}</span><small>{item.category}</small></button>)}</nav>
        <article key={selected.id} className="prompt-examples__detail" aria-label="提示词详情"><h3>{selected.name}</h3><small>{selected.category}</small><p>{selected.note || '管理员暂未填写实例说明'}</p></article>
      </>}
    </div>
  </>;
}
