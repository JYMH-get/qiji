import { it, expect, vi, beforeEach } from 'vitest';
import type { AssetBlob } from './projectFile';
import type { RunPurposeResult } from './purposeRunner';
const mocks = vi.hoisted(() => ({ download: vi.fn(), run: vi.fn() }));
vi.mock('@/services/assetPersist', () => ({ saveRemoteAsset: mocks.download, uploadBlobToOss: vi.fn() }));
vi.mock('@/services/purposeRunner', () => ({ runPurpose: mocks.run }));
import { useProjectStore as project } from '@/store/projectStore';
import { useCanvasStore as canvas } from '@/store/canvasStore';
import { useLibraryStore as library } from '@/store/libraryStore';
import { useRequestLedgerStore as ledger, attemptDeliverAll } from '@/store/requestLedgerStore';
import { defaultNodeExecute } from '@/nodes/pluginRegistry';
import { syncCanvasFromProject } from './canvasProjection';
import { makeNode } from '@/canvas/nodeFactory';
import { sanitizeLedger } from '@/lib/requestLedgerCore';

const taskId = 'delivery-test-task';
const resultId = `asset-${taskId}`;
const blob: AssetBlob = { id: 'test-video', url: 'https://example.invalid/video.mp4', localUri: 'asset://test-video.mp4', localPath: 'test-video.mp4' };
const result: RunPurposeResult = { status: 'success', taskId, assetId: blob.id, resultUri: blob.url!, modelKey: 'm', adapterKey: 'm' };
function deferred<T>() {
 let resolve!: (value: T) => void;
 const promise = new Promise<T>(r => { resolve = r; });
 return { promise, resolve };
}
beforeEach(() => {
 vi.clearAllMocks();
 vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
 project.setState({ projectInstanceId: 'original-project', savePath: null, canvasEpisodeId: 'a', canvases: {},
  episodes: [{ id: 'a', title: 'A', scriptText: '', shots: [{ id: 'sa', index: 1, videoPrompt: 'p', materials: [] }] },
   { id: 'b', title: 'B', scriptText: '', shots: [{ id: 'sb', index: 1, videoPrompt: 'p', materials: [] }] }],
  mediaSettings: {}, assetBlobs: {}, scheduleAutoSave: () => {}, characters: [], scenes: [], items: [], crowds: [], organisms: [],
 } as unknown as Partial<ReturnType<typeof project.getState>>);
 canvas.setState({ nodes: {}, edges: {}, groups: {}, runtime: {}, past: [], future: [] });
 library.setState({ assets: {} }); ledger.setState({ entries: [] });
});
async function start() {
 const upstream = deferred<RunPurposeResult>();
 const download = deferred<AssetBlob>();
 mocks.run.mockReturnValue(upstream.promise); mocks.download.mockReturnValue(download.promise);
 const node = makeNode('video.gen', 0, 0);
 node.data.params = { prompt: 'original prompt', duration: 15, aspect_ratio: '16:9' };
 node.data.task = { taskId, adapterKey: 'm', startedAt: Date.now() };
 canvas.getState().addNode(node);
 const running = defaultNodeExecute(node.id, { resumeTask: { taskId, adapterKey: 'm' } });
 await vi.waitFor(() => expect(mocks.run).toHaveBeenCalled());
 await vi.waitFor(() => expect(ledger.getState().entries).toHaveLength(1));
 return { node, running, upstream, download };
}
async function beginDownload() {
 const pending = await start(); pending.upstream.resolve(result);
 await vi.waitFor(() => expect(mocks.download).toHaveBeenCalledTimes(1));
 expect(ledger.getState().entries[0].status).toBe('done');
 expect(canvas.getState().nodes[pending.node.id].data.task?.taskId).toBe(taskId);
 return pending;
}
function syncB() { project.getState().switchCanvas('b'); syncCanvasFromProject('b'); }

it('下载过程中同步 B：结果仍写回 A，实际写入后才销账', async () => {
 const p = await beginDownload(); syncB(); p.download.resolve(blob); await p.running;
 const data = project.getState().canvases.a.nodes[p.node.id].data;
 expect(data.resultAssetId).toBe(resultId); expect(data.task).toBeUndefined();
 expect(data.resultHistory).toEqual([resultId]);
 expect(data.resultMetaByAssetId?.[resultId]).toMatchObject({ model: 'm', prompt: 'original prompt', duration: 15, aspect: '16:9' });
 expect(library.getState().assets[resultId].episodeId).toBe('a');
 expect(ledger.getState().entries).toHaveLength(0);
 expect(canvas.getState().nodes[p.node.id]).toBeUndefined();
});
it('上游尚未完成时同步 B：完成后投递非活动 A', async () => {
 const p = await start(); syncB(); p.upstream.resolve(result);
 await vi.waitFor(() => expect(mocks.download).toHaveBeenCalledTimes(1));
 p.download.resolve(blob); await p.running;
 expect(project.getState().canvases.a.nodes[p.node.id].data.resultAssetId).toBe(resultId);
 expect(ledger.getState().entries).toHaveLength(0);
});
it('下载过程中 A→B→A：回到当前 A 后只追加一次，并更新成功状态', async () => {
 const p = await beginDownload(); syncB(); project.getState().switchCanvas('a');
 p.download.resolve(blob); await p.running;
 expect(canvas.getState().nodes[p.node.id].data.resultHistory).toEqual([resultId]);
 expect(canvas.getState().runtime[p.node.id].status).toBe('success');
 expect(mocks.download).toHaveBeenCalledTimes(1);
});
it('下载期间节点改为新任务：旧结果不覆盖新任务或清除其标记', async () => {
 const p = await beginDownload(); const n = canvas.getState().nodes[p.node.id];
 canvas.setState({ nodes: { [n.id]: { ...n, data: { ...n.data, task: { taskId: 'new-task', adapterKey: 'm', startedAt: Date.now() } } } } });
 p.download.resolve(blob); await p.running;
 expect(canvas.getState().nodes[n.id].data.task?.taskId).toBe('new-task');
 expect(canvas.getState().nodes[n.id].data.resultAssetId).toBeNull();
 expect(ledger.getState().entries).toHaveLength(1);
});
it('下载期间节点删除：结果留台账，不能误记已投递', async () => {
 const p = await beginDownload(); canvas.getState().removeNode(p.node.id);
 p.download.resolve(blob); await p.running;
 expect(ledger.getState().entries[0]).toMatchObject({ taskId, status: 'done' });
 expect(canvas.getState().nodes[p.node.id]).toBeUndefined();
});
it('下载期间切换项目：不污染新项目，原项目回来后可投递', async () => {
 const p = await beginDownload(); const original = canvas.getState().nodes;
 project.setState({ projectInstanceId: 'other-project', savePath: 'other.Qiji', canvases: {} });
 canvas.setState({ nodes: {} });
 p.download.resolve(blob); await p.running;
 expect(library.getState().assets[resultId]).toBeUndefined();
 expect(project.getState().assetBlobs[blob.id]).toBeUndefined();
 expect(ledger.getState().entries[0].status).toBe('done');
 project.setState({ projectInstanceId: 'restored-project', savePath: null, canvasEpisodeId: 'a' });
 canvas.setState({ nodes: original }); mocks.download.mockResolvedValue(blob);
 await attemptDeliverAll(taskId);
 expect(canvas.getState().nodes[p.node.id].data.resultAssetId).toBe(resultId);
 expect(ledger.getState().entries).toHaveLength(0);
});
it('重新同步保留图片/视频的主结果、历史与生成参数', () => {
 project.setState({ mediaSettings: { canvasSend: { storyboard: true, video: true } } } as never);
 syncCanvasFromProject('a');
 const nodes = { ...canvas.getState().nodes };
 const media = Object.values(nodes).filter(n => ['image.gen', 'video.gen'].includes(n.type));
 expect(media).toHaveLength(2);
 for (const n of media) nodes[n.id] = { ...n, data: { ...n.data, resultAssetId: 'existing', resultHistory: ['existing'], resultMetaByAssetId: { existing: { prompt: 'original' } } } };
 canvas.setState({ nodes }); syncCanvasFromProject('a');
 for (const n of media) expect(canvas.getState().nodes[n.id].data).toMatchObject({ resultAssetId: 'existing', resultHistory: ['existing'], resultMetaByAssetId: { existing: { prompt: 'original' } } });
});
it('同步正在生成的节点不填入表格旧视频，不移除任务标记', () => {
 syncCanvasFromProject('a'); const n = Object.values(canvas.getState().nodes).find(n => n.type === 'video.gen')!;
 canvas.setState({ nodes: { ...canvas.getState().nodes, [n.id]: { ...n, data: { ...n.data, task: { taskId, adapterKey: 'm', startedAt: Date.now() } } } } });
 project.getState().updateShot('a', 'sa', { videoUri: 'asset://old-table.mp4' }); syncCanvasFromProject('a');
 expect(canvas.getState().nodes[n.id].data.resultAssetId).toBeNull();
 expect(canvas.getState().nodes[n.id].data.task?.taskId).toBe(taskId);
});
it('成功结果缓存序列化后仍保留生成参数，支持重启后投递', async () => {
 const p = await beginDownload();
 const restored = sanitizeLedger(JSON.parse(JSON.stringify(ledger.getState().entries)));
 expect(restored[0].result?.resultMeta).toMatchObject({ prompt: 'original prompt', duration: 15 });
 p.download.resolve(blob); await p.running;
});
