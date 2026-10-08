import { describe, expect, it } from 'vitest';
import { projectInferenceDuration } from './inferenceStrategy';

describe('项目推理时长兼容与校验', () => {
  it.each([
    [undefined, '4-15', 15, 15], [15, '4-15', 15, 15], [30, '4-30', 30, 30],
    [8, 'custom', 8, 15], [20, 'custom', 20, 30], [75.5, 'custom', 75.5, 30],
  ])('旧 maxDuration=%s 保留真实范围', (maxDuration, durationPreset, max, durationLimit) => {
    expect(projectInferenceDuration({ maxDuration })).toMatchObject({
      durationPreset, durationRange: { min: 4, max }, durationLimit, durationError: undefined,
    });
  });

  it('显式范围优先于旧字段，支持小数与高于30秒的范围且不修改设置', () => {
    const settings = { maxDuration: 8, inferenceDurationPreset: 'custom', inferenceCustomDuration: { min: 0.5, max: 120.25 } };
    const before = structuredClone(settings);
    expect(projectInferenceDuration(settings)).toMatchObject({ durationRange: { min: 0.5, max: 120.25 }, durationLimit: 30 });
    expect(settings).toEqual(before);
  });

  it.each([
    undefined, null, '', {}, { min: '', max: 15 }, { min: 4, max: '' },
    { min: '4', max: 15 }, { min: NaN, max: 15 }, { min: 4, max: Infinity },
    { min: 0, max: 15 }, { min: -1, max: 15 }, { min: 20, max: 15 },
  ])('显式自定义非法或未填时不得用旧字段回退：%j', inferenceCustomDuration => {
    const result = projectInferenceDuration({ maxDuration: 30, inferenceDurationPreset: 'custom', inferenceCustomDuration });
    expect(result.durationError).toBeTruthy();
    expect(result.durationRange).toBeUndefined();
  });

  it('切换预设保留自定义草稿，保存重开后切回仍要校验', () => {
    const settings = { maxDuration: 8, inferenceDurationPreset: '4-30', inferenceCustomDuration: { min: '', max: 25 } };
    expect(projectInferenceDuration(settings)).toMatchObject({ durationRange: { min: 4, max: 30 }, customDuration: settings.inferenceCustomDuration, durationError: undefined });
    const restored = JSON.parse(JSON.stringify(settings));
    restored.inferenceDurationPreset = 'custom';
    expect(projectInferenceDuration(restored)).toMatchObject({ customDuration: settings.inferenceCustomDuration, durationRange: undefined });
    expect(projectInferenceDuration(restored).durationError).toBeTruthy();
  });

  it('未知预设和旧倒置范围都明确报错', () => {
    expect(projectInferenceDuration({ inferenceDurationPreset: 'unknown' }).durationError).toBeTruthy();
    expect(projectInferenceDuration({ maxDuration: 3 })).toMatchObject({ durationRange: undefined, durationError: '最小时长不能大于最大时长' });
  });
});
