import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as wireDiagnostics from '../../server/src/translators/imageWireDiagnostics';
import { translateGeminiImage } from '../../server/src/translators/gemini';
import { translateYaliGemini } from '../../server/src/translators/yaliGemini';
import type { GenerateRequest } from '../../server/src/contract';

const { resolveEditRefs } = vi.hoisted(() => ({ resolveEditRefs: vi.fn() }));
vi.mock('../../server/src/translators/openai.ts', () => ({ resolveEditRefs }));
vi.mock('../../server/src/translators/prompt.ts', () => ({ buildPrompt: () => '保留参考图主体。' }));
vi.mock('../../server/src/store/logs.ts', () => ({ maskToken: () => '[masked]' }));
vi.mock('../../server/src/translators/submitTimeout.ts', () => ({ submitSignal: () => undefined }));

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const source = Buffer.from('private-image-bytes\u0000\ufffd');
const encoded = source.toString('base64');
const imagePart = { inlineData: { mimeType: 'image/png', data: encoded } };

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); resolveEditRefs.mockReset(); });

describe('Gemini 请求字节诊断', () => {
  it('摘要对应实际 UTF-8 请求字符串，保持请求内容不变且不记录图像内容', () => {
    const body = { contents: [{ role: 'user', parts: [{ text: '保留参考图主体。' }, imagePart] }] };
    const before = structuredClone(body);
    const expected = JSON.stringify(body);
    const wire = wireDiagnostics.serializeGeminiImageRequest(body);
    expect(body).toEqual(before);
    expect(wire.bodyText).toBe(expected);
    expect(wire.diagnostics).toEqual({ jsonBytes: Buffer.byteLength(expected), jsonSha256: hash(expected), images: [{
      contentIndex: 0, partIndex: 1, field: 'inlineData.data', mimeType: 'image/png', transport: 'base64',
      base64Chars: encoded.length, decodedBytes: source.length, sha256: hash(source),
    }] });
    expect(JSON.stringify(wire.diagnostics)).not.toContain(encoded);
    expect(JSON.stringify(wire.diagnostics)).not.toContain('private-image-bytes');
  });

  it('只序列化一次，摘要取实际序列化内容而非原对象的旧字段', () => {
    const toJSON = vi.fn(() => ({ inline_data: { mime_type: 'image/jpeg', data: encoded } }));
    const wire = wireDiagnostics.serializeGeminiImageRequest({ contents: [{ parts: [{ ignored: true, toJSON }] }] });
    expect(toJSON).toHaveBeenCalledTimes(1);
    expect(wire.diagnostics.images[0]).toMatchObject({ field: 'inline_data.data', mimeType: 'image/jpeg', sha256: hash(source) });
    expect(wire.bodyText).not.toContain('ignored');
  });

  it('URL 引用明确标为 URL，不伪造图片字节或暴露签名链接', () => {
    const uri = 'https://assets.invalid/private.png?token=secret';
    const wire = wireDiagnostics.serializeGeminiImageRequest({ contents: [{ parts: [
      { file_data: { mime_type: 'image/png', file_uri: uri } },
      { fileData: { mimeType: 'image/jpeg', fileUri: uri } },
    ] }] });
    expect(wire.diagnostics.images).toEqual([
      { contentIndex: 0, partIndex: 0, field: 'file_data.file_uri', mimeType: 'image/png', transport: 'url', urlChars: uri.length },
      { contentIndex: 0, partIndex: 1, field: 'fileData.fileUri', mimeType: 'image/jpeg', transport: 'url', urlChars: uri.length },
    ]);
    expect(JSON.stringify(wire.diagnostics)).not.toContain(uri);
    expect(JSON.stringify(wire.diagnostics.images)).not.toMatch(/decodedBytes|sha256|base64Chars/);
  });

  it('无参考图时保留空摘要，不改变文生图请求', () => {
    const body = { contents: [{ parts: [{ text: '生成图片' }] }] };
    const wire = wireDiagnostics.serializeGeminiImageRequest(body);
    expect(wire.diagnostics.images).toEqual([]);
    expect(JSON.parse(wire.bodyText)).toEqual(body);
  });

  for (const channel of ['AISC', '鸭梨'] as const) {
    it(`${channel} 日志和 fetch 使用同一次序列化结果，全部垫图保持原顺序`, async () => {
      const second = Buffer.from('different-private-image');
      resolveEditRefs.mockResolvedValue({ missing: [], refs: [
        { bytes: { blob: new Blob([source], { type: 'image/png' }), filename: 'first.png' } },
        { bytes: { blob: new Blob([second], { type: 'image/jpeg' }), filename: 'second.jpg' } },
      ] });
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [imagePart] } }] }), { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);
      const serialize = vi.spyOn(wireDiagnostics, 'serializeGeminiImageRequest');
      const onUpstream = vi.fn();
      const req = { purpose: 'asset.character.image', model: 'banana-2', clientTaskId: 'fixture', projectId: 'fixture-project',
        inputs: { images: [{ url: 'https://fixture.invalid/first.png' }, { url: 'https://fixture.invalid/second.jpg' }] },
        params: { resolution: '2k', size: '16:9', imageSize: '2K', aspectRatio: '16:9' },
      } as GenerateRequest;
      const translate = channel === 'AISC' ? translateGeminiImage : translateYaliGemini;
      const result = await translate(req, { baseUrl: 'https://upstream.invalid', apiKey: 'fixture',
        upstreamModel: 'gemini-3.1-flash-image-preview', imageMaterialMode: 'direct' }, onUpstream);
      expect(result.ok).toBe(true);
      expect(serialize).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const wire = serialize.mock.results[0].value as ReturnType<typeof wireDiagnostics.serializeGeminiImageRequest>;
      const sent = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body;
      expect(sent).toBe(wire.bodyText);
      const requestLog = onUpstream.mock.calls[0][0].request;
      expect(requestLog.wire).toEqual(wire.diagnostics);
      expect(requestLog.wire.jsonSha256).toBe(hash(sent as string));
      expect(requestLog.wire.images.map((image: { sha256: string }) => image.sha256)).toEqual([hash(source), hash(second)]);
      const expectedBody = { contents: [{ role: 'user', parts: [{ text: '保留参考图主体。' }, imagePart,
        { inlineData: { mimeType: 'image/jpeg', data: second.toString('base64') } }] }],
        generationConfig: { ...(channel === 'AISC' ? { responseModalities: ['TEXT', 'IMAGE'] } : {}), imageConfig: { imageSize: '2K', aspectRatio: '16:9' } },
      };
      expect(JSON.parse(sent as string)).toEqual(expectedBody);
      expect(JSON.stringify(requestLog)).not.toContain(encoded);
      expect(JSON.stringify(requestLog)).not.toContain(second.toString('base64'));
    });
  }

  it('AISC URL 模式日志如实记录 URL，仍提交原 file_data 字段', async () => {
    const url = 'https://fixture.invalid/reference.png';
    resolveEditRefs.mockResolvedValue({ missing: [], refs: [{ url }] });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [imagePart] } }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const onUpstream = vi.fn();
    await translateGeminiImage({ purpose: 'asset.character.image', model: 'banana-2', clientTaskId: 'fixture', projectId: 'fixture-project', inputs: { images: [{ url }] } } as GenerateRequest,
      { baseUrl: 'https://upstream.invalid', apiKey: 'fixture', upstreamModel: 'gemini-3.1-flash-image-preview', imageMaterialMode: 'url' }, onUpstream);
    const sent = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string;
    expect(JSON.parse(sent).contents[0].parts[1]).toEqual({ file_data: { mime_type: 'image/png', file_uri: url } });
    expect(onUpstream.mock.calls[0][0].request.wire.images[0]).toMatchObject({ transport: 'url', field: 'file_data.file_uri' });
    expect(onUpstream.mock.calls[0][0].request.wire.jsonSha256).toBe(hash(sent));
  });
});
