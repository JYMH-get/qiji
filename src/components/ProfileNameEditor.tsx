import { useState } from 'react';
import { useConnectionStore } from '@/store/connectionStore';
import { managedClient } from '@/services/managedClient';

export function ProfileNameEditor() {
  const user = useConnectionStore(s => s.user);
  const [name, setName] = useState(user?.name ?? '');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const save = async () => {
    const value = name.trim();
    if (!value || [...value].length > 40) { setMessage('用户名须为 1–40 个字符'); return; }
    const start = useConnectionStore.getState();
    setBusy(true); setMessage('');
    try {
      const result = await managedClient.updateProfile(value);
      const current = useConnectionStore.getState();
      if (current.serverUrl !== start.serverUrl || current.accessKey !== start.accessKey || current.user?.id !== result.id) return;
      current.setSession(current.loggedIn, { ...current.user, name: result.name });
      setName(result.name); setMessage('用户名已保存');
    } catch (e) { setMessage(e instanceof Error ? e.message : '保存失败，请重试'); }
    finally { setBusy(false); }
  };
  return <section className="flex flex-col gap-2">
    <label htmlFor="profile-name" className="text-xs font-semibold">用户名</label>
    <div className="flex gap-2"><input id="profile-name" value={name} maxLength={80} disabled={busy} onChange={e => { setName(e.target.value); setMessage(''); }} className="flex-1 min-w-0 bg-secondary/40 border border-border/40 rounded-lg px-3 py-2 text-xs" />
      <button type="button" disabled={busy || name.trim() === user?.name} onClick={() => void save()} className="px-3 rounded-lg bg-primary text-primary-foreground text-xs disabled:opacity-50">{busy ? '保存中…' : '保存'}</button></div>
    {message && <p role="status" className="text-xs text-muted-foreground">{message}</p>}
  </section>;
}
