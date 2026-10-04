import type { ModelDef } from './store/models.ts';
import type { ParamField } from './contract.ts';
import { linePriceOf, type LinePrice } from './store/agentLinePrices.ts';
import { validateTextPricing } from './textPricing.ts';

interface Field { key: string; label: string; unit: string; value: number | null; range?: string }
interface EditorField extends Field { set(price: LinePrice, value: number): void; shift?(price: LinePrice, delta: number): void }
const num = (n: number) => Number(n.toFixed(8));
function options(field?: ParamField): string[] {
  if (field?.options?.length) return field.options;
  if (field?.type === 'boolean') return ['false', 'true'];
  if (field?.type === 'number' && Number.isFinite(field.min) && Number.isFinite(field.max)) {
    const step = field.step || 1, count = Math.floor((field.max! - field.min!) / step) + 1;
    if (step > 0 && count > 0 && count <= 512) return Array.from({ length: count }, (_, i) => String(num(field.min! + step * i)));
  }
  return [];
}
function editor(model: ModelDef): EditorField[] {
  const price = linePriceOf(model), fields: EditorField[] = [];
  if (price.tokenPricing) {
    const tp = price.tokenPricing;
    fields.push({ key: 'multiplier', label: '服务计费倍率', unit: '倍', value: tp.multiplier ?? 1,
      set(p, v) { p.tokenPricing!.multiplier = v; } });
    if (tp.enabled) {
      const groups = [['标准', 'rates'], ...(tp.peak.enabled ? [['高峰', 'peak.rates']] : []),
        ...(tp.longContext.enabled ? [['长上下文', 'longContext.rates'], ...(tp.peak.enabled ? [['长上下文高峰', 'longContext.peakRates']] : [])] : [])];
      for (const [label, path] of groups) for (const [key, name] of [['input', '输入'], ['output', '输出'], ...(tp.cacheEnabled ? [['cachedInput', '缓存输入']] : [])]) {
        const parts = path.split('.'), rates = parts.reduce((v: any, k) => v[k], tp);
        fields.push({ key: `${path}.${key}`, label: `${label} · ${name}`, unit: '元 / 百万 tokens', value: rates[key],
          set(p, v) { parts.reduce((o: any, k) => o[k], p.tokenPricing)[key] = v; } });
      }
      return fields;
    }
  }
  const rules = price.costRules ?? [], perUnit = !!price.costField;
  if (model.capability === 'video' && (!price.costField || price.costField === 'duration')) {
    let durations = options(model.params?.find(f => f.key === 'duration'));
    if (!durations.length) durations = [...new Set(rules.map(r => r.when.duration))].filter(Boolean);
    durations = durations.filter(d => Number.isFinite(Number(d)) && Number(d) > 0);
    if (!durations.length && perUnit) durations = ['1'];
    const keys = [...new Set([...(model.params ?? []).filter(f => f.key === 'resolution').map(f => f.key), ...rules.flatMap(r => Object.keys(r.when).filter(k => k !== 'duration'))])];
    let groups: Record<string, string>[] = [{}];
    for (const key of keys) {
      const declared = options(model.params?.find(f => f.key === key));
      const values = declared.length ? declared : [...new Set(rules.map(r => r.when[key]).filter(v => v !== undefined)), ''];
      if (groups.length * values.length * durations.length > 2048) { groups = []; break; }
      groups = groups.flatMap(g => values.map(v => ({ ...g, [key]: v })));
    }
    if (durations.length && groups.length) {
      for (const group of groups) {
        // Unbounded conditions cannot be expressed as a safe editable wildcard.
        if (Object.values(group).includes('')) continue;
        const rates = durations.map(duration => {
          const params: Record<string, string> = { ...group, duration };
          const r = rules.find(r => Object.entries(r.when).every(([k, v]) => params[k] === v));
          return num(perUnit ? r?.costPerUnit ?? price.costPerUnit ?? 0 : (r?.cost ?? price.cost) / Number(duration));
        });
        const low = Math.min(...rates), high = Math.max(...rates);
        fields.push({ key: 'seconds:' + JSON.stringify(group), label: Object.entries(group).map(([k, v]) => k === 'resolution' ? v : `${model.params?.find(f => f.key === k)?.label ?? k} ${v}`).join(' · ') || '全部参数',
          unit: '积分 / 秒', value: low === high ? low : null, range: low === high ? undefined : `${low}–${high}`,
          shift(p, delta) {
            const additions = durations.map((duration,i) => {
              const value = Math.max(0,num(rates[i]+delta));
              return {when:{...group,duration},...(perUnit?{costPerUnit:value}:{cost:num(value*Number(duration))})};
            });
            const replaced = new Set(additions.map(r=>JSON.stringify(Object.entries(r.when).sort())));
            p.costRules = [...additions,...(p.costRules??[]).filter(r=>!replaced.has(JSON.stringify(Object.entries(r.when).sort())))];
          },
          set(p, v) {
            const additions = durations.map(duration => ({ when: { ...group, duration }, ...(perUnit ? { costPerUnit: v } : { cost: num(v * Number(duration)) }) }));
            const replaced = new Set(additions.map(r => JSON.stringify(Object.entries(r.when).sort())));
            p.costRules = [...additions, ...(p.costRules ?? []).filter(r => !replaced.has(JSON.stringify(Object.entries(r.when).sort())))];
          } });
      }
      if (fields.some(f => f.key.startsWith('seconds:'))) return fields;
    }
  }
  const unit = perUnit ? `积分 / ${price.costField === 'duration' ? '秒' : model.params?.find(f => f.key === price.costField)?.unit ?? price.costField}` : '积分 / 次';
  fields.push({ key: 'base', label: '默认', unit, value: perUnit ? price.costPerUnit ?? 0 : price.cost,
    set(p, v) { if (perUnit) p.costPerUnit = v; else p.cost = v; } });
  rules.forEach((r, i) => fields.push({ key: 'rule:'+JSON.stringify(Object.fromEntries(Object.entries(r.when).sort())), label: Object.entries(r.when).map(([k, v]) => `${model.params?.find(f => f.key === k)?.label ?? k} ${v}`).join(' · ') || '全部参数', unit,
    value: perUnit ? r.costPerUnit ?? price.costPerUnit ?? 0 : r.cost ?? price.cost,
    set(p, v) { if (perUnit) p.costRules![i].costPerUnit = v; else p.costRules![i].cost = v; } }));
  return fields;
}
export function priceEditorFields(model: ModelDef): Field[] { return editor(model).map(({ set, shift, ...field }) => field); }
/** 每次从源站当前价格重新计算；折扣偏移的最低结果为零。 */
export function offsetLinePrice(model: ModelDef, offsets: Record<string, number>): LinePrice {
  const price = linePriceOf(model);
  for (const field of editor(model)) {
    const delta = offsets[field.key]; if (!delta) continue;
    if (field.shift) field.shift(price,delta);
    else if (field.value !== null) field.set(price,Math.min(field.key==='multiplier'?1000:1e6,Math.max(field.key==='multiplier'?1e-8:0,num(field.value+delta))));
  }
  validateTextPricing(price.tokenPricing);
  return price;
}
export function editLinePrice(model: ModelDef, input: unknown): LinePrice {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('价格修改格式错误');
  const fields = new Map(editor(model).map(f => [f.key, f])), price = linePriceOf(model);
  for (const [key, value] of Object.entries(input)) {
    const field = fields.get(key);
    if (!field) throw new Error('价格档位已变化，请刷新后重试');
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1e6) throw new Error('价格须为 0 至 1000000 的有效数字');
    field.set(price, value);
  }
  validateTextPricing(price.tokenPricing);
  return price;
}
