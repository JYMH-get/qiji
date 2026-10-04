import { afterEach, describe, expect, it, vi } from 'vitest';
import { geminiGenerationConfig } from '../../server/src/translators/geminiImageParams';
import { translateGeminiImage } from '../../server/src/translators/gemini';
import { translateYaliGemini } from '../../server/src/translators/yaliGemini';
import type { GenerateRequest } from '../../server/src/contract';

const { resolveEditRefs } = vi.hoisted(() => ({ resolveEditRefs: vi.fn() }));
vi.mock('../../server/src/translators/openai.ts', () => ({ resolveEditRefs }));
vi.mock('../../server/src/translators/prompt.ts', () => ({ buildPrompt: () => '按垫图生成' }));
vi.mock('../../server/src/store/logs.ts', () => ({ maskToken: () => '[masked]' }));
vi.mock('../../server/src/translators/submitTimeout.ts', () => ({ submitSignal: () => undefined }));
afterEach(() => { vi.unstubAllGlobals(); resolveEditRefs.mockReset(); });

describe('Gemini 显式原生参数透传', () => {
  it('原生配置优先，保留完整内容和零值，不改原对象', () => {
    const params = { temperature: 0.8, generationConfig: { temperature: 0, seed: 0, responseModalities: ['IMAGE'],
      imageConfig: { aspectRatio: '1:1', imageSize: '2K', personGeneration: 'allow_adult' }, customGatewayOption: { value: true } } };
    const before = structuredClone(params);
    expect(geminiGenerationConfig(params, { aspectRatio: '16:9', imageSize: '4K' }, ['TEXT', 'IMAGE'])).toEqual(before.generationConfig);
    expect(params).toEqual(before);
  });
  it('只补原生缺失值，明确支持的平铺采样字段映射，UI 状态不混入配置', () => {
    const params = { temperature: 0, seed: 0, maxOutputTokens: 512, topP: 0.7, generationConfig: { responseModalities: ['IMAGE'] },
      resolution: '2k', quality: 'high', viewAngle: { yaw: 45 }, referenceStrength: 0.8 };
    expect(geminiGenerationConfig(params, { aspectRatio: '16:9', imageSize: '2K' })).toEqual({
      responseModalities: ['IMAGE'], temperature: 0, seed: 0, maxOutputTokens: 512, topP: 0.7,
      imageConfig: { aspectRatio: '16:9', imageSize: '2K' },
    });
  });
  for (const [channel, translate] of [['AISC', translateGeminiImage], ['鸭梨', translateYaliGemini]] as const) {
    it(`${channel} 实发请求保留原生配置及全部垫图字节`, async () => {
      const bytes = Buffer.from('reference-image-original');
      resolveEditRefs.mockResolvedValue({ missing: [], refs: [{ bytes: { blob: new Blob([bytes], { type: 'image/png' }), filename: 'ref.png' } }] });
      const fetchMock = vi.fn(async (_url: RequestInfo | URL, _options?: RequestInit) => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { data: bytes.toString('base64'), mimeType: 'image/png' } }] } }] }), { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);
      const req = { purpose: 'asset.character.image', model: 'banana-pro', clientTaskId: 'fixture-task', projectId: 'fixture-project', inputs: { images: [{ url: 'https://fixture.invalid/ref.png' }] },
        params: { resolution: '2k', aspect_ratio: '16:9', seed: 42, generationConfig: { temperature: 0.1, responseModalities: ['IMAGE'],
          imageConfig: { aspectRatio: '16:9', imageSize: '2K' }, customGatewayOption: { preserve: true } },
          systemInstruction: { parts: [{ text: '保持服装细节' }] }, safetySettings: [{ category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' }] } } as GenerateRequest;
      const before = structuredClone(req);
      const result = await translate(req, { baseUrl: 'https://fixture.invalid', apiKey: 'fixture', upstreamModel: 'gemini-3-pro-image-preview', imageMaterialMode: 'direct' });
      expect(result.ok).toBe(true);
      const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
      expect(body.generationConfig).toEqual({ ...req.params!.generationConfig as object, seed: 42 });
      expect(body.systemInstruction).toEqual(req.params!.systemInstruction);
      expect(body.safetySettings).toEqual(req.params!.safetySettings);
      expect(body.contents[0].parts).toEqual([{ text: '按垫图生成' }, { inlineData: { data: bytes.toString('base64'), mimeType: 'image/png' } }]);
      expect(req).toEqual(before);
    });
  }
});
