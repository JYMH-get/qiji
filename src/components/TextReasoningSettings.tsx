import { useCatalogStore } from '@/store/catalogStore';
import { useProjectStore } from '@/store/projectStore';
import { reasoningFields, reasoningLabel, selectedReasoningParams } from '@/lib/textReasoningParams';

/** Project-scoped settings, independently remembered for each text model/line. */
export function TextReasoningSettings({ modelKey, disabled = false }: { modelKey: string; disabled?: boolean }) {
  const model = useCatalogStore(state => state.model(modelKey));
  const config = useProjectStore(state => state.projectModelConfig);
  const setConfig = useProjectStore(state => state.setProjectModelConfig);
  const fields = model?.capability === 'text' ? reasoningFields(model.params) : [];
  if (!fields.length) return null;
  const values = selectedReasoningParams(fields, config.textParams?.[modelKey]);
  const set = (key: string, value: string) => setConfig({textParams: {...config.textParams, [modelKey]: {...values, [key]: value}}});
  return <span className="inline-flex flex-wrap items-center gap-3">
    {fields.map(field => {
      const options = field.options!;
      const value = String(values[field.key]);
      if (field.key === 'thinkingMode') {
        const on = value === 'enabled', next = on ? 'disabled' : 'enabled';
        return <button key={field.key} type="button" role="switch" aria-label="思考" aria-checked={on}
          disabled={disabled || !options.includes(next)}
          className={'rounded-md border px-2 py-1 text-xs ' + (on ? 'border-violet-400 bg-violet-500/20 text-violet-200' : 'border-white/15 text-white/60')}
          onClick={() => set(field.key, next)}>思考 · {on ? '开启' : '关闭'}</button>;
      }
      return <span key={field.key} className="inline-flex items-center gap-2 text-xs">
        <span className="qiji-field-label">强度</span>
        <input type="range" aria-label="思考强度" aria-valuetext={reasoningLabel(value)}
          min={0} max={options.length - 1} step={1} value={options.indexOf(value)}
          disabled={disabled || values.thinkingMode === 'disabled' || options.length < 2}
          className="w-24 accent-violet-400 disabled:opacity-40"
          onChange={event => set(field.key, options[Number(event.target.value)])}/>
        <span className="min-w-6">{reasoningLabel(value)}</span>
      </span>;
    })}
  </span>;
}
