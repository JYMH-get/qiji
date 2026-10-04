import { describe, expect, it } from 'vitest';
import { imageMemberAccepts, imageRouteParams, imageRoutingParams, imageUpstreamParams } from '../../server/src/imageRouting';
import { AISC_IMAGE_SIZES, validateImageSizeMap } from '../../server/src/imageSizes';
import type { ModelDef } from '../../server/src/store/models';

const model = (options: string[]): ModelDef => ({
  id: 'gpt-image-2', label: 'GPT Image 2', capability: 'image', protocol: 'openai-image',
  enabled: true, cost: 10,
  params: [{ key: 'resolution', label: '分辨率', type: 'enum', options: ['1k', '2k', '4k'] },
    { key: 'size', label: '尺寸', type: 'enum', options }],
} as ModelDef);
const supported = { ...model(Object.values(AISC_IMAGE_SIZES).flatMap(Object.values)), imageSizeMap: AISC_IMAGE_SIZES };
const rows = [
  ['21:9', '1344x576', '2688x1152', '3840x1648'],
  ['16:9', '1280x720', '2048x1152', '3840x2160'],
  ['4:3', '1024x768', '2048x1536', '3312x2480'],
  ['1:1', '1024x1024', '2048x2048', '2880x2880'],
  ['3:4', '768x1024', '1536x2048', '2480x3312'],
  ['9:16', '720x1280', '1152x2048', '2160x3840'],
];
describe('图片请求不得替换比例或分辨率档位', () => {
  it('手工表优先于旧 size 枚举，空白格不可回退', () => {
    const manual = { ...supported, imageSizeMap: { '16:9': { '2k': '2048x1152' } } };
    expect(imageUpstreamParams(manual, { aspect_ratio: '16:9', resolution: '2k' }).size).toBe('2048x1152');
    expect(imageMemberAccepts(manual, { aspect_ratio: '16:9', resolution: '4k' })).toBe(false);
    expect(() => imageUpstreamParams(manual, { aspect_ratio: '9:16', resolution: '2k' })).toThrow();
  });
  it('手工尺寸支持乘号，拒绝非法值和未知档位', () => {
    expect(validateImageSizeMap({ '16:9': { '2k': ' 2048 × 1152 ', '4k': '' } })).toEqual({ '16:9': { '2k': '2048x1152' } });
    expect(() => validateImageSizeMap({ '16:9': { '2k': 'auto' } })).toThrow();
    expect(() => validateImageSizeMap({ '16:9': { 'unknown': '8192x8192' } })).toThrow();
    expect(validateImageSizeMap(null)).toBeUndefined();
  });
  for (const [aspect, ...sizes] of rows) for (const [index, resolution] of ['1k', '2k', '4k'].entries()) {
    it(`AISC ${aspect} ${resolution} 精确发送 ${sizes[index]}`, () => {
      const request = { aspect_ratio: aspect, resolution };
      expect(imageMemberAccepts(supported, request)).toBe(true);
      expect(imageUpstreamParams(supported, request)).toEqual({ ...request, size: sizes[index] });
    });
  }
  it('复现生产缺少 2K 横屏尺寸：候选必须排除，派发必须拒绝', () => {
    const broken = model(['1024x1024', '2048x2048', '3840x2160', '2160x3840']);
    const request = { aspect_ratio: '16:9', resolution: '2k' };
    expect(imageMemberAccepts(broken, request)).toBe(false);
    expect(() => imageUpstreamParams(broken, request)).toThrow('禁止替换');
  });
  it('其他渠道同样不能以 4K 替代 2K', () => {
    const other = { ...model(['3840x2160']) };
    expect(imageMemberAccepts(other, { aspect_ratio: '16:9', resolution: '2k' })).toBe(false);
  });
  it('AISC 4K 方图必须是 2880，不能套用其他渠道的 4096', () => {
    expect(imageUpstreamParams(supported, { aspect_ratio: '1:1', resolution: '4k' }).size).toBe('2880x2880');
  });
  it('同档位也不能把 4:3 换成 16:9', () => {
    expect(imageMemberAccepts(model(['2048x1152']), { aspect_ratio: '4:3', resolution: '2k' })).toBe(false);
  });
  it('目录展示全部六种比例与三个档位', () => {
    const fields = imageRouteParams([supported])!;
    expect(fields[0].options).toEqual(expect.arrayContaining(rows.map(r => r[0])));
    expect(fields[1].options).toEqual(['1k', '2k', '4k']);
  });
  it('没有该档位时不得接单', () => {
    const limited = { ...supported, params: supported.params.map(p => p.key === 'resolution' ? { ...p, options: ['2k'] } : p) };
    expect(imageMemberAccepts(limited, { aspect_ratio: '16:9', resolution: '4k' })).toBe(false);
  });
  it('保留显式尺寸、原生别名和额外控制，不修改调用者对象', () => {
    const request = { aspect_ratio: '16:9', resolution: '2K', size: '2048x1152', imageSize: '2K', aspectRatio: '16:9', seed: 0,
      referenceStrength: 0.85, generationConfig: { temperature: 0.2, imageConfig: { imageSize: '2K', aspectRatio: '16:9' } } };
    const before = structuredClone(request);
    expect(imageUpstreamParams(supported, request)).toEqual(before);
    expect(request).toEqual(before);
  });
  it('显式尺寸与对应表冲突时拒绝，不静默覆盖', () => {
    expect(() => imageUpstreamParams(supported, { aspect_ratio: '16:9', resolution: '2k', size: '3840x2160' })).toThrow('禁止替换显式尺寸');
    const withoutMap = { ...model([]), imageSizeMap: undefined };
    expect(() => imageUpstreamParams(withoutMap, { resolution: '1k', size: '4096x4096' })).toThrow('禁止替换显式尺寸');
  });
  it('原生 Gemini 配置决定只读档位，缺少公共别名也能选路', () => {
    const request = { generationConfig: { imageConfig: { imageSize: '4K', aspectRatio: '1:1' } }, referenceStrength: 0.9 };
    const before = structuredClone(request);
    expect(imageRoutingParams(request)).toEqual({ aspect_ratio: '1:1', resolution: '4k' });
    expect(imageUpstreamParams(supported, request)).toEqual({ ...before, resolution: '4k', size: '2880x2880' });
    expect(request).toEqual(before);
  });
  it('拒绝低档计价与高档原生输出参数的冲突', () => {
    expect(() => imageRoutingParams({ resolution: '1k', imageSize: '4K' })).toThrow('分辨率参数冲突');
    expect(() => imageRoutingParams({ resolution: '1k', generationConfig: { imageConfig: { imageSize: '4K' } } })).toThrow('分辨率参数冲突');
    expect(() => imageUpstreamParams(supported, { resolution: '1k', imageSize: '4K' })).toThrow('分辨率参数冲突');
  });
  it('尺寸比例别名只读解析，冲突明确拒绝', () => {
    expect(imageRoutingParams({ size: '1:1', resolution: '2K' })).toEqual({ aspect_ratio: '1:1', resolution: '2k' });
    expect(() => imageRoutingParams({ size: '1:1', aspect_ratio: '16:9' })).toThrow('比例参数冲突');
  });
  it('无效原生配置在选路前拒绝，不按空配置继续计价', () => {
    for (const generationConfig of [null, [], 'invalid', { imageConfig: null }, { imageConfig: [] }]) {
      expect(() => imageRoutingParams({ generationConfig })).toThrow('必须为对象');
    }
  });
});
