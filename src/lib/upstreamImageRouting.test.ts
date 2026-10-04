import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveUpstream, resolveUpstreamRoute } from '../../server/src/translators/upstream';
import type { GenerateRequest } from '../../server/src/contract';
import type { ModelDef } from '../../server/src/store/models';

const { matchRoute, getChannel } = vi.hoisted(() => ({ matchRoute: vi.fn(), getChannel: vi.fn() }));
vi.mock('../../server/src/store/models.ts', () => ({ matchRoute }));
vi.mock('../../server/src/store/channels.ts', () => ({ getChannel }));
vi.mock('../../server/src/config.ts', () => ({ config: { gateway: { baseUrl: 'https://default.invalid', apiKey: 'default-fixture' } } }));

const model = { id: 'banana-pro', upstreamModel: 'default-model', capability: 'image', protocol: 'gemini-image', channelId: 'default-channel' } as ModelDef;
const request = (params: Record<string, unknown>): GenerateRequest => ({
  purpose: 'asset.character.image', model: model.id, projectId: 'fixture', clientTaskId: 'fixture-task', params,
});
beforeEach(() => {
  vi.resetAllMocks();
  getChannel.mockImplementation(id => ({ baseUrl: `https://${id}.invalid/`, apiKey: `${id}-fixture` }));
  matchRoute.mockImplementation((_model, params) => params?.resolution === '2k' && params?.size === '2048x1152'
    ? { upstreamModel: 'redirect-2k-model', channelId: 'redirect-channel' } : undefined);
});

describe('图片重定向与计价使用同一只读档位', () => {
  for (const params of [
    { resolution: '2k', size: '2048x1152' },
    { resolution: '2K', size: '2048x1152' },
    { imageSize: '2K', size: '2048x1152' },
    { generationConfig: { temperature: 0.2, imageConfig: { imageSize: '2K', aspectRatio: '16:9' } }, size: '2048x1152' },
  ]) {
    it(`规范匹配 ${JSON.stringify(params)} 且保留实发原值`, () => {
      const req = request(params);
      const before = structuredClone(req);
      expect(resolveUpstream(model, req)).toMatchObject({
        upstreamModel: 'redirect-2k-model', baseUrl: 'https://redirect-channel.invalid', apiKey: 'redirect-channel-fixture',
      });
      expect(resolveUpstreamRoute(model, req.params)).toMatchObject({ channelId: 'redirect-channel' });
      expect(matchRoute).toHaveBeenCalledWith(model, { ...params, resolution: '2k', aspect_ratio: '16:9' });
      expect(req).toEqual(before);
    });
  }
  it('保留额外 size 条件，不能只按分辨率误命中另一条规则', () => {
    const params = { resolution: '2K', size: '2048x2048', aspectRatio: '1:1', seed: 0 };
    expect(resolveUpstream(model, request(params)).upstreamModel).toBe('default-model');
    expect(matchRoute).toHaveBeenCalledWith(model, { ...params, resolution: '2k', aspect_ratio: '1:1' });
  });
  it('原生与公共分辨率冲突时拒绝，不选低价重定向', () => {
    expect(() => resolveUpstream(model, request({ resolution: '1k', generationConfig: { imageConfig: { imageSize: '4K' } } }))).toThrow('分辨率参数冲突');
    expect(matchRoute).not.toHaveBeenCalled();
  });
  it('非图片协议保留原有严格匹配语义', () => {
    const video = { ...model, capability: 'video', protocol: 'echo' } as ModelDef;
    const params = { resolution: '2K', size: '2048x1152', duration: 5 };
    expect(resolveUpstream(video, request(params)).upstreamModel).toBe('default-model');
    expect(matchRoute).toHaveBeenCalledWith(video, params);
    expect(matchRoute.mock.calls[0][1]).toBe(params);
  });
});
