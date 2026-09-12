import type { TextTokenPricing, TextTokenUsage } from './contract.ts';

export const TEXT_PRECHARGE = 10;
export const TEXT_CREDITS_PER_YUAN = 100;
export const DEFAULT_TEXT_PEAK_SCHEDULE = { days: [1, 2, 3, 4, 5], periods: [{ start: '09:00', end: '12:00' }, { start: '14:00', end: '18:00' }] };
const clockMinutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));

export function validateTextPricing(value: unknown): TextTokenPricing | undefined {
  if (value == null) return undefined;
  const p = value as TextTokenPricing;
  if (p.multiplier != null && (typeof p.multiplier !== "number" || !Number.isFinite(p.multiplier) || p.multiplier <= 0 || p.multiplier > 1000)) throw new Error("文本倍率须大于0且不超过1000");
  const rates = (r: any) => r && ['input', 'output', 'cachedInput'].every(k => typeof r[k] === 'number' && Number.isFinite(r[k]) && r[k] >= 0 && r[k] <= 1e6);
  if (!p || typeof p.enabled !== 'boolean' || typeof p.cacheEnabled !== 'boolean' || !rates(p.rates)
    || !p.peak || typeof p.peak.enabled !== 'boolean' || !rates(p.peak.rates)
    || !p.longContext || typeof p.longContext.enabled !== 'boolean' || !Number.isSafeInteger(p.longContext.threshold) || p.longContext.threshold <= 0
    || !rates(p.longContext.rates) || !rates(p.longContext.peakRates)) throw new Error('文本计价配置无效：单价须为非负数，长上下文阈值须为正整数');
  const schedule = p.peak.schedule;
  const validTime = (v: unknown) => typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
  if (schedule !== undefined && (!schedule || !Array.isArray(schedule.days) || !schedule.days.length
    || schedule.days.some(d => !Number.isInteger(d) || d < 0 || d > 6) || new Set(schedule.days).size !== schedule.days.length
    || !Array.isArray(schedule.periods) || !schedule.periods.length || schedule.periods.length > 24
    || schedule.periods.some(r => !r || !validTime(r.start) || !validTime(r.end) || r.start === r.end))) {
    throw new Error('高峰时间无效：请选择星期并填写不同的开始、结束时间（HH:mm）');
  }
  return structuredClone(p);
}

/** Use reported counts only. Missing/invalid usage stays unknown, never zero. */
export function normalizeTextUsage(raw: any, protocol: 'openai' | 'anthropic' = 'openai'): TextTokenUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
  const cached = protocol === 'anthropic' ? raw.cache_read_input_tokens : raw.prompt_tokens_details?.cached_tokens ?? raw.prompt_cache_hit_tokens;
  const cacheWrite = protocol === 'anthropic' ? raw.cache_creation_input_tokens : undefined;
  let input = protocol === 'anthropic' ? raw.input_tokens : raw.prompt_tokens;
  const output = protocol === 'anthropic' ? raw.output_tokens : raw.completion_tokens;
  if (!count(input) || !count(output) || (cached != null && !count(cached)) || (cacheWrite != null && !count(cacheWrite))) return undefined;
  if (protocol === 'anthropic') input += (cached ?? 0) + (cacheWrite ?? 0);
  if (!count(input) || !count(input + output) || (cached ?? 0) > input) return undefined;
  const reasoning = raw.completion_tokens_details?.reasoning_tokens;
  if (reasoning != null && (!count(reasoning) || reasoning > output)) return undefined;
  return { source: 'upstream', inputTokens: input, outputTokens: output, totalTokens: input + output,
    ...(cached != null ? { cachedInputTokens: cached } : {}), ...(cacheWrite != null ? { cacheWriteTokens: cacheWrite } : {}),
    ...(reasoning != null ? { reasoningTokens: reasoning } : {}) };
}

export function isTextPeak(at: number, schedule = DEFAULT_TEXT_PEAK_SCHEDULE): boolean {
  const d = new Date(at + 8 * 3600_000);
  const day = d.getUTCDay(), minute = d.getUTCHours() * 60 + d.getUTCMinutes();
  return schedule.periods.some(r => {
    const start = clockMinutes(r.start), end = clockMinutes(r.end);
    return start < end ? schedule.days.includes(day) && minute >= start && minute < end
      : (schedule.days.includes(day) && minute >= start) || (schedule.days.includes((day + 6) % 7) && minute < end);
  });
}

export function textCharge(p: TextTokenPricing, usage: TextTokenUsage, at: number, discountPercent = 100) {
  const peak = p.peak.enabled && isTextPeak(at, p.peak.schedule);
  const parts = usage.parts ?? [usage];
  let inputYuan=0, outputYuan=0, cachedYuan=0;
  for (const part of parts) {
    const long = p.longContext.enabled && part.inputTokens > p.longContext.threshold;
    const r = long ? (peak ? p.longContext.peakRates : p.longContext.rates) : peak ? p.peak.rates : p.rates;
    const cached = p.cacheEnabled ? (part.cachedInputTokens ?? 0) : 0;
    inputYuan += (part.inputTokens-cached)*r.input/1e6; cachedYuan += cached*r.cachedInput/1e6; outputYuan += part.outputTokens*r.output/1e6;
  }
  const rounding=(yuan:number)=>{
    const raw=yuan*TEXT_CREDITS_PER_YUAN*discountPercent/100*(p.multiplier ?? 1);
    return raw>0 ? Math.max(1,Math.ceil(raw-Number.EPSILON*Math.max(1,raw)*4)) : 0;
  };
  const items={input:rounding(inputYuan),output:rounding(outputYuan),cache:rounding(cachedYuan)};
  const cost=items.input+items.output+items.cache, yuan=inputYuan+outputYuan+cachedYuan;
  return { cost, yuan, items, multiplier: p.multiplier ?? 1, period: peak ? 'peak' as const : 'offPeak' as const };
}

export function mergeTextUsage(a?: TextTokenUsage, b?: TextTokenUsage): TextTokenUsage | undefined {
  if (!a || !b) return undefined;
  return { source: 'upstream', inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens,
    totalTokens: a.totalTokens + b.totalTokens, cachedInputTokens: (a.cachedInputTokens ?? 0) + (b.cachedInputTokens ?? 0),
    reasoningTokens: (a.reasoningTokens ?? 0) + (b.reasoningTokens ?? 0), parts: [...(a.parts ?? [a]), ...(b.parts ?? [b])] };
}
