import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useCatalogStore } from '@/store/catalogStore';
import { inferenceTemplates, resolveStrategyTemplate, splitTemplates, resolveSplitTemplate, strategyName, type InferenceStrategy } from '@/lib/inferenceStrategy';

const buttonStyle = { border: '1px solid rgba(255,255,255,.16)', background: '#242630', color: '#eee', borderRadius: 7, padding: '7px 12px', cursor: 'pointer', fontSize: 12, whiteSpace: 'nowrap' } as const;

function TextDialog({ title, value, onSave, onClose, skill = false }: { title: string; value: string; onSave: (value: string, name?: string) => void; onClose: () => void; skill?: boolean }) {
  const [draft, setDraft] = useState(value);
  const [name, setName] = useState<string>();
  const [error, setError] = useState('');
  return createPortal(<div onPointerDown={e => e.stopPropagation()} onClick={e => e.stopPropagation()} onKeyDown={e => { e.stopPropagation(); if (e.key === 'Escape') onClose(); }} style={{ position: 'fixed', inset: 0, background: '#0009', zIndex: 12000, display: 'grid', placeItems: 'center' }}>
    <section role="dialog" aria-modal="true" aria-label={title} style={{ width: 'min(680px,92vw)', background: '#191c25', border: '1px solid #434654', borderRadius: 14, padding: 22, color: '#eee' }}>
      <h3 style={{ margin: '0 0 12px' }}>{title}</h3>
      {skill && <label style={{ display: 'block', marginBottom: 12, fontSize: 12 }}>导入 Markdown / 文本文件
        <input aria-label="导入 Skills 文件" type="file" accept=".md,.txt,.markdown" onChange={async e => {
          const file = e.target.files?.[0]; if (!file) return;
          if (file.size > 1024 * 1024) { setError('文件请保持在 1 MB 以内'); return; }
          try { setDraft(await file.text()); setName(file.name); setError(''); } catch { setError('文件读取失败，请重试'); }
        }} />
      </label>}
      <textarea autoFocus aria-label={title} value={draft} onChange={e => setDraft(e.target.value)} placeholder={skill ? '粘贴 Skills 原文' : '输入偏好、想法或要求'} style={{ width: '100%', minHeight: 240, resize: 'vertical', background: '#101218', color: '#eee', border: '1px solid #444', borderRadius: 8, padding: 12, boxSizing: 'border-box' }} />
      {error && <p role="alert">{error}</p>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 14 }}>
        <button style={buttonStyle} onClick={onClose}>取消</button>
        <button style={buttonStyle} disabled={skill && !draft.trim()} onClick={() => { onSave(draft, name); onClose(); }}>保存</button>
      </div>
    </section>
  </div>, document.body);
}

export function StoryGuidanceButton({ value = '', onChange, disabled = false }: { value?: string; onChange: (value: string) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  return <><button type="button" style={buttonStyle} disabled={disabled} onClick={() => setOpen(true)} title={value || '填写用户偏好、想法和要求'}>剧情引导{value.trim() ? ' · 已设置' : ''}</button>
    {open && <TextDialog title="剧情引导" value={value} onSave={onChange} onClose={() => setOpen(false)} />}</>;
}

export function InferenceStrategyPicker({ value, onChange, disabled = false, mode = 'infer' }: { value: InferenceStrategy; onChange: (value: InferenceStrategy) => void; disabled?: boolean; mode?: 'infer' | 'split' }) {
  const all = useCatalogStore(s => s.catalog?.templates) ?? [];
  const options = mode === 'split' ? splitTemplates(all) : inferenceTemplates(all);
  const selected = mode === 'split' ? resolveSplitTemplate(all, value.templateId) : resolveStrategyTemplate(all, value.templateId);
  const [open, setOpen] = useState(false);
  const skill = value.source === 'skill';
  return <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
    <select aria-label={mode === 'split' ? '拆分方案' : '推理方案'} className="qiji-field-select" style={{ ...buttonStyle, maxWidth: 220 }} disabled={disabled} value={skill ? '__external_skill__' : selected?.id ?? ''} onChange={e => {
      if (e.target.value === '__external_skill__') { onChange({ ...value, source: 'skill' }); setOpen(true); }
      else onChange({ ...value, source: 'template', templateId: e.target.value });
    }}>
      {!selected && <option value="">{mode === 'split' ? '请选择拆分方案' : '请选择推理方案'}</option>}
      {options.map(t => <option key={t.id} value={t.id}>{strategyName(t.name)}</option>)}
      <option value="__external_skill__">外部 Skills</option>
    </select>
    {skill && <button style={buttonStyle} disabled={disabled} onClick={() => setOpen(true)}>{value.skillText?.trim() ? value.skillName || '编辑 Skills' : '导入 Skills'}</button>}
    <StoryGuidanceButton value={value.guidance} disabled={disabled} onChange={guidance => onChange({ ...value, guidance })} />
    {open && <TextDialog title="外部 Skills" value={value.skillText ?? ''} skill onSave={(skillText, skillName) => onChange({ ...value, source: 'skill', skillText, skillName: skillName ?? value.skillName })} onClose={() => setOpen(false)} />}
  </div>;
}
