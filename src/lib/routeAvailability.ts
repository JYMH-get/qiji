import type { ParamField, RoutePriceAvailabilityRow, SuccessRateSnapshot, TextTokenRates } from '@/contract';

export const RATE_BANDS = [
  { min: .9, color: '#22c55e', label: '≥90%', height: 28 },
  { min: .8, color: '#86efac', label: '80–<90%', height: 24 },
  { min: .6, color: '#facc15', label: '60–<80%', height: 20 },
  { min: .2, color: '#fb923c', label: '20–<60%', height: 16 },
  { min: 0, color: '#f87171', label: '<20%', height: 12 },
  { min: -1, color: '#60a5fa', label: '样本不足', height: 20 },
] as const;
export const rateBand = (rate: number | null, _hasRequests = false) => rate == null ? RATE_BANDS[5] : RATE_BANDS.find(b => rate >= b.min)!;
export const formatRate = (rate: number | null) => rate == null ? '—' : `${(rate * 100).toFixed(1)}%`;
export const formatCredits = (value: number) => new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 4 }).format(value);
export const formatClock = (value: number) => new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
export function historySlots(history: SuccessRateSnapshot[], until: number): (SuccessRateSnapshot | null)[] {
  const end = Math.floor(Math.max(until, ...history.map(p => p.until)) / 600_000);
  const slots: (SuccessRateSnapshot | null)[] = Array(60).fill(null);
  for (const p of history) { const i = Math.floor(p.until / 600_000) - end + 59; if (i >= 0 && i < 60) slots[i] = p; }
  return slots;
}
export function snapshotDescription(point: SuccessRateSnapshot) {
  if (point.source) return `${new Date(point.since).toLocaleString('zh-CN')} – ${new Date(point.until).toLocaleString('zh-CN')} · ${point.source === 'self-test' ? '自测补录' : '人工修正'} ${formatRate(point.successRate)}`;
  const state = point.insufficientSamples || point.successRate == null ? '样本不足' : point.method === 'interval' ? `区间成功率 ${formatRate(point.successRate)} · 已结束 ${point.completedRequests} 条` : `平均成功率 ${formatRate(point.successRate)} · 有效采样 ${point.validSamples}/10`;
  return `${new Date(point.since).toLocaleString('zh-CN')} – ${new Date(point.until).toLocaleString('zh-CN')} · ${state}`;
}

export interface PriceItem { label: string; value: string }
const creditRange = (values: number[]) => {
  const low = Math.min(...values), high = Math.max(...values);
  return low === high ? formatCredits(low) : `${formatCredits(low)}–${formatCredits(high)}`;
};
function fieldOptions(field: ParamField | undefined): string[] {
  if (field?.options?.length) return field.options;
  if (field?.type === 'boolean') return ['false', 'true'];
  if (field?.type === 'number' && Number.isFinite(field.min) && Number.isFinite(field.max)) {
    const step = field.step || 1, count = Math.floor((field.max! - field.min!) / step) + 1;
    if (step > 0 && count > 0 && count <= 512) return Array.from({ length: count }, (_, i) => String(Number((field.min! + step * i).toFixed(8))));
  }
  return [];
}
/** Fold duration tiers into a comparable second rate; keep other pricing conditions separate. */
function videoSecondPrices(p: NonNullable<RoutePriceAvailabilityRow['pricing']>, price: (cost: number) => number) {
  if (p.costField && p.costField !== 'duration') return null;
  const rules = p.costRules ?? [], perSecond = p.costField === 'duration';
  const durationField = p.params.find(f => f.key === 'duration');
  const declaredDurations = fieldOptions(durationField);
  const durations = (declaredDurations.length ? declaredDurations : rules.map(r => r.when.duration)).filter(d => Number.isFinite(Number(d)) && Number(d) > 0);
  // A configured unit rate needs no invented duration; a fixed price must have a known duration to divide by.
  if (!durations.length && perSecond) durations.push('1');
  if (!durations.length) return null;
  const keys = [...new Set([...p.params.filter(f => f.key === 'resolution').map(f => f.key), ...rules.flatMap(r => Object.keys(r.when).filter(k => k !== 'duration'))])];
  let groups: Record<string, string>[] = [{}];
  for (const key of keys) {
    const values = fieldOptions(p.params.find(f => f.key === key));
    // Open-ended fields have an additional unmatched case which must retain the default price.
    const options = values.length ? values : [...new Set(rules.map(r => r.when[key]).filter(v => v !== undefined)), ''];
    if (groups.length * options.length * durations.length > 10000) return null;
    groups = groups.flatMap(group => options.map(value => ({ ...group, [key]: value })));
  }
  const all: number[] = [];
  const items = groups.map(group => {
    const rates = [...new Set(durations)].map(duration => {
      const params: Record<string, string> = { ...group, duration };
      const rule = rules.find(r => Object.entries(r.when).every(([k, v]) => params[k] === v));
      const rate = perSecond ? price(rule?.costPerUnit ?? p.costPerUnit ?? 0) : price(rule?.cost ?? p.cost!) / Number(duration);
      return Number(rate.toFixed(8));
    });
    all.push(...rates);
    const label = Object.entries(group).map(([k, v]) => k === 'resolution' ? v || '其他分辨率' : `${p.params.find(f => f.key === k)?.label || k} ${v || '其他'}`).join(' · ') || '全部参数';
    return { label, value: creditRange(rates) };
  });
  return { summary: creditRange(all), unit: '积分 / 秒', items };
}
/** Prices are catalog prices with the current payer's membership discount, never token precharges. */
export function routePrice(row: Pick<RoutePriceAvailabilityRow, 'pricing' | 'discountPercent'> & Partial<Pick<RoutePriceAvailabilityRow, 'capability'>>): { summary: string; unit: string; items: PriceItem[]; notes: string[] } | null {
  const p = row.pricing; if (!p || p.cost === undefined) return null;
  const discountPercent = row.discountPercent ?? 100, discount = discountPercent / 100, multiplier = p.tokenPricing?.multiplier ?? 1;
  const notes: string[] = [];
  if (discount < 1) notes.push(`已应用当前付费账户 ${formatCredits(discountPercent)}% 计费比例`);
  if (p.tokenPricing?.enabled) {
    const tp = p.tokenPricing;
    const items: PriceItem[] = [];
    const addRates = (prefix: string, rates: TextTokenRates) => {
      items.push({ label: `${prefix} · 输入`, value: formatCredits(rates.input * 100 * multiplier * discount) });
      items.push({ label: `${prefix} · 输出`, value: formatCredits(rates.output * 100 * multiplier * discount) });
      if (tp.cacheEnabled) items.push({ label: `${prefix} · 缓存输入`, value: formatCredits(rates.cachedInput * 100 * multiplier * discount) });
    };
    addRates('标准', tp.rates);
    if (tp.peak.enabled) {
      addRates('高峰', tp.peak.rates);
      if (tp.peak.schedule) notes.push(`高峰时段（北京时间）：周${tp.peak.schedule.days.map(d => ['日', '一', '二', '三', '四', '五', '六'][d]).join('、')} ${tp.peak.schedule.periods.map(p => `${p.start}–${p.end}`).join('、')}`);
    }
    if (tp.longContext.enabled) {
      notes.push(`长上下文阈值：${formatCredits(tp.longContext.threshold)} tokens`);
      addRates('长上下文', tp.longContext.rates);
      if (tp.peak.enabled) addRates('长上下文高峰', tp.longContext.peakRates);
    }
    notes.push('按实际 token 用量结算，合计积分按计费规则取整。');
    return { summary: `${items[0].value} / ${items[1].value}`, unit: '积分 / 百万 tokens · 标准输入 / 输出', items, notes };
  }
  const perUnit = !!p.costField;
  const unitField = p.params.find(f => f.key === p.costField);
  const unit = perUnit ? `积分 / ${unitField?.unit || (p.costField === 'duration' ? '秒' : unitField?.label || p.costField)}` : '积分 / 次';
  // Unit rates remain fractional; server rounding applies to each complete request, not each second.
  const price = (cost: number) => {
    if (perUnit) return cost * multiplier * discount;
    const scaled = p.tokenPricing ? Math.ceil(cost * multiplier - Number.EPSILON * Math.max(1, cost * multiplier) * 4) : cost;
    return scaled <= 0 || discount === 0 ? 0 : discount < 1 ? Math.max(1, Math.ceil(scaled * discount)) : scaled;
  };
  if (row.capability === 'video' || p.costField === 'duration') {
    const seconds = videoSecondPrices(p, price);
    if (seconds) {
      notes.push(perUnit ? '单价按总用量合计后取整。' : '按各时长档位的整次价格折算每秒价格；不同时长单价有差异时显示范围。');
      if (p.refVideoSecondsWeight) notes.push(`参考视频按逐条向上取整的秒数 × ${p.refVideoSecondsWeight} 计入收费时长。`);
      return { ...seconds, notes };
    }
  }
  const base = perUnit ? p.costPerUnit ?? 0 : p.cost;
  const items = [{ label: '默认', value: formatCredits(price(base)) }, ...(p.costRules ?? []).map(rule => ({
    label: Object.entries(rule.when).map(([k, v]) => `${p.params.find(f => f.key === k)?.label || k} ${v}`).join(' · ') || '全部参数',
    value: formatCredits(price(perUnit ? rule.costPerUnit ?? base : rule.cost ?? base)),
  }))];
  const values = [price(base), ...(p.costRules ?? []).map(r => price(perUnit ? r.costPerUnit ?? base : r.cost ?? base))];
  const low = Math.min(...values), high = Math.max(...values);
  if (perUnit) notes.push('单价按总用量合计后取整。');
  if (p.costRules?.length) notes.push('按参数匹配第一条适用规则；未匹配使用默认价。');
  if (p.refVideoSecondsWeight) notes.push(`参考视频按逐条向上取整的秒数 × ${p.refVideoSecondsWeight} 计入收费时长。`);
  return { summary: low === high ? formatCredits(low) : `${formatCredits(low)}–${formatCredits(high)}`, unit, items, notes };
}
