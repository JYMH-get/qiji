import type { ParamField } from '@/contract';

export const reasoningLabel = (value: string): string => ({ default: '跟随上游', enabled: '开启', disabled: '关闭', none: '关闭', minimal: '极低', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最高' })[value] ?? value;
export const reasoningFields = (fields: ParamField[] = []) => fields.filter(field => ['thinkingMode', 'reasoning_effort'].includes(field.key)).map(field => ({...field, options: field.options?.filter(value => !['default','__admin','跟随上游'].includes(value))})).filter(field => field.options?.length);

export function selectedReasoningParams(fields: ParamField[], saved: Record<string, unknown> = {}): Record<string, unknown> {
  return Object.fromEntries(reasoningFields(fields).map(field => {
    const options = field.options!;
    const fallback = field.key === 'thinkingMode' ? 'disabled' : 'high';
    const value = [saved[field.key], field.default, fallback, options[0]].find(value => value !== undefined && options.includes(String(value)));
    return [field.key, value];
  }));
}
