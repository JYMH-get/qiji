export function InferenceModeSelect({ enabled, unified, disabled, onChange }: {
 enabled: boolean; unified: boolean; disabled?: boolean; onChange: (unified: boolean) => void;
}) {
 const className = 'qiji-field-select rounded-full px-3 py-1.5 text-xs';
 if (!enabled) return <span aria-label="输出模式：同源" className={className}>同源</span>;
 return <select aria-label="输出模式" className={className} value={unified ? 'unified' : 'storyboard'} disabled={disabled} onChange={e => onChange(e.target.value === 'unified')}>
  <option value="storyboard">双模</option><option value="unified">同源</option>
 </select>;
}
