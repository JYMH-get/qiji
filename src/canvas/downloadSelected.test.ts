import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CanvasNode } from '@/types';
import type { Asset } from '@/store/libraryStore';
import { downloadSelectedResults, selectedResults } from './downloadSelected';

const io = vi.hoisted(() => ({ open: vi.fn(), exists: vi.fn(), copy: vi.fn(), write: vi.fn(), text: vi.fn(), invoke: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: io.open }));
vi.mock('@tauri-apps/api/path', () => ({ join: async (...parts: string[]) => parts.join('/') }));
vi.mock('@tauri-apps/plugin-fs', () => ({ exists: io.exists, copyFile: io.copy, writeFile: io.write, writeTextFile: io.text }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: io.invoke }));
vi.mock('@/store/projectStore', () => ({ useProjectStore: { getState: () => ({ blobByUri: () => undefined }) } }));
const node = (data: Partial<CanvasNode['data']>, type = 'image') => ({ type, data: { params: {}, input: {}, resultAssetId: null, ...data } } as CanvasNode);
const asset = (uri: string) => ({ uri, name: '图.png', kind: 'image' } as Asset);

describe('selected current results', () => {
  it('exports current asset only, skips history, unselected nodes, groups and empty nodes', () => {
    const nodes = { a: node({ resultAssetId: 'current', resultHistory: ['old', 'current'], title: '分镜1' }),
      b: node({ resultAssetId: 'old' }), c: node({}), g: node({}, 'group') };
    const result = selectedResults(['a', 'a', 'c', 'g'], nodes, { current: asset('current.png'), old: asset('old.png') });
    expect(result).toEqual([{ name: '分镜1', uri: 'current.png', localPath: undefined, media: 'image' }]);
  });
  it('keeps text and uploaded audio but never substitutes old input for a missing current result', () => {
    const nodes = { t: node({ resultText: '  正文\n' }, 'text'), a: node({ fileUri: 'blob:audio', fileMime: 'audio/mpeg' }, 'upload'),
      missing: node({ resultAssetId: 'missing', fileUri: 'old.png' }) };
    expect(selectedResults(Object.keys(nodes), nodes, {})).toMatchObject([{ text: '  正文\n' }, { uri: 'blob:audio', media: 'audio' }]);
  });
});

describe('saving a selection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    io.open.mockResolvedValue('D:/downloads');
    io.exists.mockImplementation(async (path: string) => path === 'D:/original.mp3' || path === 'D:/downloads/声音.mp3');
    io.invoke.mockResolvedValue({ bytes: 10 });
  });
  it('chooses a folder once, copies WebView local originals and avoids overwriting names', async () => {
    const report = vi.fn();
    const result = await downloadSelectedResults([{ name: '声音', uri: 'http://asset.localhost/D%3A%2Foriginal.mp3', media: 'audio' }], report);
    expect(io.open).toHaveBeenCalledTimes(1);
    expect(io.copy).toHaveBeenCalledWith('D:/original.mp3', 'D:/downloads/声音 (2).mp3');
    expect(io.invoke).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: 1, failures: [] });
    expect(report).toHaveBeenLastCalledWith(1, 1);
  });
  it('reports failed media and continues saving text without exporting HTML error bodies', async () => {
    io.invoke.mockRejectedValueOnce(new Error('下载 HTTP 404'));
    const result = await downloadSelectedResults([
      { name: '坏视频', uri: 'https://cdn.test/bad.mp4', media: 'video' },
      { name: 'CON', text: '正文', media: 'image' },
    ], vi.fn());
    expect(result).toEqual({ ok: 1, failures: ['坏视频：下载 HTTP 404'] });
    expect(io.text).toHaveBeenCalledWith('D:/downloads/_CON.txt', '正文');
    expect(io.write).not.toHaveBeenCalled();
  });
  it('cancelled directory selection does not write files', async () => {
    io.open.mockResolvedValue(null);
    expect(await downloadSelectedResults([{ name: 'a', text: 'a', media: 'image' }], vi.fn())).toBeNull();
    expect(io.text).not.toHaveBeenCalled();
    expect(io.copy).not.toHaveBeenCalled();
  });
});
