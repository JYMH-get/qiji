import { describe, it, expect } from 'vitest';
import { formatRate, rateBand, routePrice, snapshotDescription, historySlots } from './routeAvailability';
import type { RoutePriceAvailabilityRow, TextTokenPricing } from '@/contract';

const price = (pricing: Partial<NonNullable<RoutePriceAvailabilityRow['pricing']>>, discountPercent = 100) => routePrice({ pricing: { params: [], cost: 10, ...pricing }, discountPercent })!;
const token: TextTokenPricing = { enabled: true, multiplier: 2, rates: { input: 5, output: 30, cachedInput: 1 }, cacheEnabled: true, peak: { enabled: true, rates: { input: 10, output: 60, cachedInput: 2 } }, longContext: { enabled: true, threshold: 128000, rates: { input: 15, output: 90, cachedInput: 3 }, peakRates: { input: 20, output: 120, cachedInput: 4 } } };
describe('route statistics presentation', () => {
  it.each([[.9,0],[.8,1],[.6,2],[.2,3],[0,4],[null,5]] as const)('rate %s uses the exact inclusive band', (rate, index) => expect(rateBand(rate)).toBe(rateBand([.95,.85,.65,.25,.1,null][index])));
  it('distinguishes no sample from zero success', () => { expect(formatRate(null)).toBe('—'); expect(formatRate(0)).toBe('0.0%'); });
  it('identifies manual input as a source, not ten measured samples', () => {
    const text = snapshotDescription({ since: 1, until: 2, successRate: .95, hasRequests: true, validSamples: 0, source: 'self-test' });
    expect(text).toContain('自测补录 95.0%'); expect(text).not.toContain('有效采样');
  });
  it('keeps gaps at their actual times instead of compressing old and new points together', () => {
    const p = { since: 600000, until: 1200000, successRate: .9, hasRequests: true, validSamples: 10 };
    const slots = historySlots([p, { ...p, until: 36000000 }], 36000000);
    expect(slots).toHaveLength(60); expect(slots[1]).toBe(p); expect(slots[58]).toBe(null); expect(slots[59]?.until).toBe(36000000);
  });
});
describe('route catalog prices', () => {
  it('does not invent a price when the server omits confidential pricing', () => expect(routePrice({})).toBeNull());
  it('shows fixed tier range with current membership discount and request rounding', () => {
    const p = price({ cost: 11, costRules: [{ when: { resolution: '4k' }, cost: 21 }] }, 50);
    expect(p.summary).toBe('6–11'); expect(p.unit).toBe('积分 / 次'); expect(p.items[1].label).toContain('4k');
  });
  it('keeps free requests free with membership', () => expect(price({ cost: 0 }, 50).summary).toBe('0'));
  it('scales fixed text prices before membership rounding', () => expect(price({ cost: 3, tokenPricing: { ...token, enabled: false, multiplier: 1.5 } }, 50).summary).toBe('3'));
  it('keeps a unit rate fractional instead of rounding each second', () => {
    const p = price({ costField: 'duration', costPerUnit: 2.5, refVideoSecondsWeight: .5 }, 50);
    expect(p.summary).toBe('1.25'); expect(p.unit).toBe('积分 / 秒'); expect(p.notes.join()).toContain('0.5');
  });
  it('shows token prices, including cache and long/high tiers, rather than the ten credit precharge', () => {
    const p = price({ tokenPricing: token }, 50);
    expect(p.summary).toBe('500 / 3,000'); expect(p.items).toHaveLength(12); expect(p.items[p.items.length - 1]?.value).toBe('400');
  });
  it('does not advertise cache discounts when cache billing is disabled', () => expect(price({ tokenPricing: { ...token, cacheEnabled: false } }).items.some(i => i.label.includes('缓存'))).toBe(false));
  it('shows a zero discount without a minimum charge', () => expect(price({ cost: 9 }, 0).summary).toBe('0'));
});

describe('video second prices', () => {
  const params: NonNullable<RoutePriceAvailabilityRow['pricing']>['params'] = [
    { key: 'duration', label: '时长', type: 'enum', options: ['4','5','7','15'] },
    { key: 'resolution', label: '分辨率', type: 'enum', options: ['720p','1080p'] },
  ];
  const tiers = (rate: number, resolution: string) => ['4','5','7','15'].map(duration => ({ when: { duration, resolution }, cost: Number(duration) * rate }));
  const video = (pricing: Partial<NonNullable<RoutePriceAvailabilityRow['pricing']>>, discountPercent = 100) => routePrice({ capability: 'video', pricing: { cost: 600, params, ...pricing }, discountPercent })!;
  it('folds duration tiers by resolution and excludes a fully covered fallback', () => {
    const result = video({ costRules: [...tiers(40,'720p'), ...tiers(80,'1080p')] });
    expect(result.unit).toBe('积分 / 秒'); expect(result.summary).toBe('40–80');
    expect(result.items).toEqual([{ label: '720p', value: '40' },{ label: '1080p', value: '80' }]);
  });
  it('shows genuine duration discounts as a per-second range', () => {
    const result = video({ costRules: [...tiers(40,'720p'), ...tiers(80,'1080p')].map(r => r.when.duration === '15' ? { ...r, cost: r.cost / 2 } : r) });
    expect(result.items).toEqual([{ label: '720p', value: '20–40' },{ label: '1080p', value: '40–80' }]);
  });
  it('keeps fallback prices for uncovered public durations and ignores unsupported tiers', () => {
    const result = video({ params: [params[0], { ...params[1], options: ['720p'] }], costRules: [
      ...tiers(40,'720p').filter(r => r.when.duration !== '4'), { when: { duration: '120', resolution: '720p' }, cost: 12000 },
    ] });
    expect(result.items).toEqual([{ label: '720p', value: '40–150' }]);
  });
  it('uses the first matching rule and preserves non-duration conditions', () => {
    const result = video({ params: [...params, { key: 'sound', label: '声音', type: 'boolean' }], costRules: [
      { when: { resolution: '720p', sound: 'true' }, cost: 300 }, ...tiers(40,'720p'), ...tiers(80,'1080p'),
    ] });
    expect(result.items.find(i => i.label === '720p · 声音 true')?.value).toBe('20–75');
    expect(result.items.find(i => i.label === '720p · 声音 false')?.value).toBe('40');
  });
  it('applies membership rounding to the whole fixed request before division', () => {
    const result = video({ params: [{ ...params[0], options: ['4','5'] },{ ...params[1], options: ['720p'] }], costRules: tiers(55,'720p') }, 50);
    expect(result.items).toEqual([{ label: '720p', value: '27.5–27.6' }]);
  });
  it('retains fractional configured second rates and combines identical duration tiers', () => {
    const result = video({ costField: 'duration', costPerUnit: 2.5, costRules: [{ when: { duration: '4', resolution: '1080p' }, costPerUnit: 3 }] }, 50);
    expect(result.items).toEqual([{ label: '720p', value: '1.25' },{ label: '1080p', value: '1.25–1.5' }]);
  });
  it('supports numeric duration fields and a genuine zero price', () => {
    const result = video({ cost: 0, params: [{ key: 'duration', label: '时长', type: 'number', min: 4, max: 15, step: 1 }] });
    expect(result.summary).toBe('0'); expect(result.unit).toBe('积分 / 秒');
  });
  it('does not invent seconds for a fixed price without duration data', () => {
    expect(video({ params: [] }).unit).toBe('积分 / 次');
  });
});
