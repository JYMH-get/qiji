import { useId } from 'react';
import type { canvasInferenceDuration, InferenceCustomDuration, InferenceDurationPreset } from '@/lib/inferenceStrategy';

interface InferenceDurationPickerProps {
  value: ReturnType<typeof canvasInferenceDuration>;
  onChange: (patch: { inferenceDurationPreset?: InferenceDurationPreset; inferenceCustomDuration?: InferenceCustomDuration }) => void;
  disabled?: boolean;
}

/** 整集推理的分镜时长范围，与视频生成的模型时长档位独立。 */
export function InferenceDurationPicker({ value, onChange, disabled }: InferenceDurationPickerProps) {
  const errorId = useId();
  return <div className="flex flex-wrap items-center gap-2 text-xs" role="group" aria-label="推理时长设置">
    <label className="flex items-center gap-2 whitespace-nowrap text-muted-foreground">
      时长范围
      <select aria-label="时长范围" className="qiji-field-select rounded-md px-2 py-1.5 text-xs" value={value.durationPreset} disabled={disabled}
        onChange={event => onChange({ inferenceDurationPreset: event.target.value as InferenceDurationPreset, inferenceCustomDuration: value.customDuration })}>
        <option value="4-15">4–15 秒</option><option value="4-30">4–30 秒</option><option value="custom">自定义</option>
      </select>
    </label>
    {value.durationPreset === 'custom' && <div className="flex flex-wrap items-center gap-2">
      {(['min', 'max'] as const).map(key => <label key={key} className="flex items-center gap-1.5 whitespace-nowrap text-muted-foreground">
        {key === 'min' ? '最小' : '最大'}
        <input type="number" step="any" min="0" aria-label={key === 'min' ? '时长最小值' : '时长最大值'} disabled={disabled}
          aria-invalid={!!value.durationError} aria-describedby={value.durationError ? errorId : undefined}
          value={typeof value.customDuration[key] === 'number' || typeof value.customDuration[key] === 'string' ? String(value.customDuration[key]) : ''}
          onChange={event => onChange({ inferenceDurationPreset: 'custom', inferenceCustomDuration: { ...value.customDuration, [key]: event.target.value === '' ? '' : Number(event.target.value) } })}
          className="w-[72px] min-w-0 rounded-md border border-white/15 bg-white/5 px-2 py-1.5 text-foreground outline-none focus:border-violet-400 aria-[invalid=true]:border-red-400" />
        秒
      </label>)}
    </div>}
    {value.durationError && <span id={errorId} role="status" className="w-full text-red-300">{value.durationError}</span>}
  </div>;
}
