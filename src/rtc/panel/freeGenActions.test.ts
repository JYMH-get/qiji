import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ state: {} as any, segments: new Map<string, any>(), drafts: new Map<string, any>(), upload: vi.fn(), runs: [] as any[], seq: 0,
 prepare: vi.fn(), discard: vi.fn(), move: vi.fn(), update: vi.fn(), rememberTask: vi.fn(), rememberCompletion: vi.fn(), received: vi.fn(), readCompletion: vi.fn(), deliver: vi.fn() }));
vi.mock('@/store/projectStore', () => ({ useProjectStore: { getState: () => h.state } }));
vi.mock('@/components/ModelPicker', () => ({ effectiveModelKey: () => 'model' }));
vi.mock('@/lib/publicUrl', () => ({ ensurePublicUrl: h.upload }));
vi.mock('@/lib/presetSchemes', () => ({ resolvePresets: (s: string) => s }));
vi.mock('@/lib/modelOptions', () => ({ imageResolutionOptionsForKey: () => [{ v: '2k' }], videoReqOptionsForKey: () => ({ durations: [5, 15], resolutions: ['720p'], aspects: ['16:9'] }) }));
vi.mock('@/services/purposeRunner', () => ({ runPurpose: (purpose: string, input: any) => new Promise(resolve => h.runs.push({ purpose, input, resolve })) }));
vi.mock('@/services/rtcFreeGenerationDelivery', () => ({ rememberFreeRtcTask: h.rememberTask, rememberFreeRtcCompletion: h.rememberCompletion,
 rememberFreeRtcPreparation: h.prepare, discardFreeRtcPreparation: h.discard, moveFreeRtcReceipt: h.move, updateFreeRtcTask: h.update,
 receivedFreeRtcTasks: h.received, readFreeRtcCompletion: h.readCompletion, deliverFreeRtcCompletion: h.deliver }));
vi.mock('./rtcFreeGenStore', () => ({ useRtcFreeGenStore: { getState: () => ({ draftOf: (seg: string) => h.drafts.get(seg) }) } }));
vi.mock('./rtcGenSink', () => {
 const currentOwner = () => h.state.projectInstanceId;
 const targetOf = (segId: string) => { const s = h.segments.get(segId); return s ? { episodeId: s.episodeId, segId } : null; };
 const liveSegment = (segId: string, target?: any) => { const s = h.segments.get(segId); return !target || target.episodeId === s?.episodeId ? s : null; };
 const write = (id: string, owner: string, guard: any, patch: any) => {
  const s = liveSegment(id, guard?.target);
  if (owner !== currentOwner() || guard?.shouldContinue?.() === false || !s || s.kind !== 'placeholder' || (guard?.expectedTaskRef && s.taskRef !== guard.expectedTaskRef)) return;
  Object.assign(s, patch);
 };
 return { currentOwner, ownerAlive: (owner: string) => owner === currentOwner(), resolveRtcTarget: targetOf, liveSegment,
  rtcSegments: () => [...h.segments.values()].map(seg => ({ target: targetOf(seg.id), seg })),
  armRunning: (id: string, taskRef: string | undefined, owner: string, guard: any) => write(id, owner, guard, { status: 'running', ...(taskRef ? { taskRef } : {}) }),
  mirrorProgress: () => {}, mirrorStatus: (id: string, patch: any, owner: string, guard: any) => write(id, owner, guard, patch), markFailed: (id: string, error: string, owner: string, guard: any) => write(id, owner, guard, { status: 'failed', error }),
  persistGenAsset: async (args: any) => ({ uri: args.resultUri, assetId: args.assetId }), probeDurationSec: async () => 20,
  landMedia: (id: string, args: any) => write(id, args.owner, args, { kind: 'media', uri: args.uri }),
 };
});
import { startFreeGen, retryFreeGen, freeGenBusy, resumeFreeGens } from './freeGenActions';
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
const finish = async () => { h.runs.forEach(run => run.resolve({ status: 'failed', error: 'fixture finished' })); await flush(); };
beforeEach(() => {
 h.state = { projectInstanceId: `free-${++h.seq}`, savePath: `project-${h.seq}.qiji`, mediaSettings: { resolution: '4K', aspect: '21:9' } };
 h.segments = new Map([['seg', { id: 'seg', episodeId: 'A', kind: 'placeholder', genKind: 'video', targetDurationUs: 20_000_000, status: 'pending' }]]);
 h.drafts = new Map([['seg', { prompt: 'original prompt', refs: [{ uri: 'local://ref', media: 'image', name: 'reference' }], modelKey: 'original-model' }]]);
 h.runs = []; h.upload.mockReset(); h.upload.mockResolvedValue('https://material.test/ref');
 h.rememberTask.mockReset(); h.rememberCompletion.mockReset(); h.received.mockReset().mockReturnValue([]); h.readCompletion.mockReset(); h.deliver.mockReset().mockResolvedValue(true);
 h.prepare.mockReset(); h.discard.mockReset(); h.move.mockReset(); h.update.mockReset();
});
describe('legacy free placeholder submission ownership', () => {
 it('free frames keep extras while reordering the selected roles and prompt references', async () => {
  h.state.mediaSettings.videoMethod = 'frames';
  h.drafts.get('seg').prompt = '@Image1 toward @Image3 with @Audio1';
  h.drafts.get('seg').refs = [{ uri: 'local://extra', media: 'image', name: 'extra' }, { uri: 'local://last', media: 'image', name: 'last', rtcFrameRole: 'last' }, { uri: 'local://first', media: 'image', name: 'first', rtcFrameRole: 'first' }, { uri: 'local://audio', media: 'audio', name: 'audio' }];
  expect((await startFreeGen('seg')).ok).toBe(true);
  expect(h.runs[0].input.input.images.map((ref: any) => ref.name)).toEqual(['first', 'last', 'extra']);
  expect(h.runs[0].input.input.audios).toHaveLength(1);
  expect(h.runs[0].input.prompt).toContain('@Image3 toward @Image1 with @Audio1');
  expect(h.runs[0].input.params).toMatchObject({ method: 'frames' });
  expect(h.runs[0].input.params.firstFrameUrl).toBeUndefined(); await finish();
 });
 it('free omni keeps original frame input numbers and image generation ignores role constraints', async () => {
  h.drafts.get('seg').refs = [{ uri: 'local://last', media: 'image', name: 'last', rtcFrameRole: 'last' }, { uri: 'local://first', media: 'image', name: 'first', rtcFrameRole: 'first' }];
  expect((await startFreeGen('seg')).ok).toBe(true);
  expect(h.runs[0].input.input.images.map((ref: any) => ref.name)).toEqual(['last', 'first']);
  expect(h.runs[0].input.prompt).toContain('首帧约束：以 @Image2'); await finish();
  Object.assign(h.segments.get('seg'), { status: 'pending', genKind: 'image' });
  expect((await startFreeGen('seg')).ok).toBe(true);
  expect(h.runs[1].input.prompt).toBe('original prompt');
  expect(h.runs[1].input.input.images.map((ref: any) => ref.name)).toEqual(['last', 'first']); await finish();
 });
 it('claims before upload and duplicate retry cannot bypass the claim', async () => {
  let release!: (v: string) => void; h.upload.mockImplementationOnce(() => new Promise(r => { release = r; }));
  const first = startFreeGen('seg'); expect(freeGenBusy('seg')).toBe(true);
  expect((await retryFreeGen('seg')).ok).toBe(false); expect(h.upload).toHaveBeenCalledTimes(1);
  release('https://material.test/ref'); expect((await first).ok).toBe(true); expect(h.runs).toHaveLength(1); await finish();
 });
 it('old-project upload completion cannot submit or release a new-project same-ID claim', async () => {
  let release!: (v: string) => void; h.upload.mockImplementationOnce(() => new Promise(r => { release = r; }));
  const old = startFreeGen('seg'); const guard = h.upload.mock.calls[0][1].shouldContinue;
  h.state = { ...h.state, projectInstanceId: 'copy-project', savePath: 'copy.qiji' }; expect(guard()).toBe(false);
  expect((await startFreeGen('seg')).ok).toBe(true); expect(h.runs).toHaveLength(1);
  release('https://material.test/old'); expect((await old).ok).toBe(false); expect(freeGenBusy('seg')).toBe(true);
  expect(h.runs).toHaveLength(1); await finish();
 });
 it('deleted target cancels preparation and releases lock', async () => {
  let release!: (v: string) => void; h.upload.mockImplementationOnce(() => new Promise(r => { release = r; }));
  const pending = startFreeGen('seg'); h.segments.clear(); release('https://material.test/ref');
  expect((await pending).ok).toBe(false); expect(h.runs).toHaveLength(0);
 });
 it('snapshot and 20-second request survive draft/settings changes and episode switching', async () => {
  h.segments.get('seg').generationDuration = 20;
  let release!: (v: string) => void; h.upload.mockImplementationOnce(() => new Promise(r => { release = r; }));
  const pending = startFreeGen('seg'); h.state.rtcEpisodeId = 'B'; h.drafts.get('seg').prompt = 'changed'; h.drafts.get('seg').refs = []; h.state.mediaSettings.resolution = '720p';
  release('https://material.test/ref'); expect((await pending).ok).toBe(true);
  expect(h.runs[0].input).toMatchObject({ modelKey: 'original-model', prompt: 'original prompt', params: { duration: 20, resolution: '4K', aspect_ratio: '21:9' }, input: { images: [{ name: 'reference' }] } });
  await finish();
 });
 it('legacy free duration follows the segment as Auto and fits catalog options', async () => {
  h.segments.get('seg').targetDurationUs = 5_000_001;
  expect((await startFreeGen('seg')).ok).toBe(true);
  expect(h.runs[0].input.params.duration).toBe(15);
  expect(h.segments.get('seg').targetDurationUs).toBe(5_000_001);
  expect(h.segments.get('seg').generationDuration).toBeUndefined();
  await finish();
 });
 it('free Auto clamps only to the catalog maximum and freezes before upload', async () => {
  Object.assign(h.segments.get('seg'), { generationDuration: 'auto', targetDurationUs: 20_000_000 });
  let release!: (v: string) => void; h.upload.mockImplementationOnce(() => new Promise(r => { release = r; }));
  const pending = startFreeGen('seg'); h.segments.get('seg').targetDurationUs = 4_000_000;
  release('https://material.test/ref'); expect((await pending).ok).toBe(true);
  expect(h.runs[0].input.params.duration).toBe(15); await finish();
 });
 it('rejected upload returns actionable failure and permits a retry', async () => {
  h.upload.mockRejectedValueOnce(new Error('upload down'));
  expect(await startFreeGen('seg')).toEqual({ ok: false, error: 'upload down' }); expect(freeGenBusy('seg')).toBe(false);
  expect((await startFreeGen('seg')).ok).toBe(true); await finish();
 });
 it('recovery includes inactive episodes and never submits another generation', async () => {
  h.segments.get('seg').status = 'running'; h.segments.get('seg').taskRef = 'model|task-A';
  h.segments.set('seg-B', { id: 'seg-B', episodeId: 'B', kind: 'placeholder', genKind: 'video', status: 'running', taskRef: 'model|task-B' });
  resumeFreeGens(); expect(h.runs).toHaveLength(2);
  expect(h.runs.map(r => r.input.resumeTask.taskId)).toEqual(['task-A', 'task-B']);
  expect(h.runs.every(r => r.input.prompt === undefined)).toBe(true); await finish();
 });
 it('late completion does not overwrite a replacement task', async () => {
  expect((await startFreeGen('seg')).ok).toBe(true);
  h.runs[0].input.onTaskId('old-task', 'model'); h.segments.get('seg').taskRef = 'model|new-task';
  h.runs[0].resolve({ status: 'success', resultUri: 'https://result.test/old.mp4' }); await flush();
  expect(h.segments.get('seg').kind).toBe('placeholder'); expect(h.segments.get('seg').taskRef).toBe('model|new-task');
  expect(h.deliver).toHaveBeenCalledWith(expect.objectContaining({ taskRef: 'model|old-task' }));
 });
 it('accepted/completed callbacks after project switching preserve original path receipts', async () => {
  const owner = { projectInstanceId: h.state.projectInstanceId, savePath: h.state.savePath };
  expect((await startFreeGen('seg')).ok).toBe(true);
  h.state = { ...h.state, projectInstanceId: 'different', savePath: 'different.qiji' };
  h.runs[0].input.onTaskId('accepted', 'model');
  expect(h.rememberTask).toHaveBeenCalledWith(owner, { episodeId: 'A', segId: 'seg' }, 'model|accepted', undefined);
  h.runs[0].resolve({ status: 'success', resultUri: 'https://result.test/out.mp4', taskId: 'accepted' }); await flush();
  expect(h.rememberCompletion).toHaveBeenCalledWith(owner, { episodeId: 'A', segId: 'seg' }, 'model|accepted', expect.objectContaining({ uri: 'https://result.test/out.mp4' }));
  expect(h.deliver).not.toHaveBeenCalled();
 });
 it('accepted receipt restores missing taskRef and cached completion without upstream polling', async () => {
  h.received.mockReturnValue([{ target: { episodeId: 'A', segId: 'seg' }, taskRef: 'model|accepted' }]);
  h.readCompletion.mockReturnValue({ uri: 'https://result.test/cached.mp4', media: 'video' });
  resumeFreeGens(); await flush();
  expect(h.segments.get('seg').taskRef).toBe('model|accepted'); expect(h.deliver).toHaveBeenCalledTimes(1); expect(h.runs).toHaveLength(0);
 });
 it('same-path reopening adopts an in-flight submission before its acceptance arrives', async () => {
  expect((await startFreeGen('seg')).ok).toBe(true);
  expect(h.segments.get('seg').taskRef).toBeUndefined();
  h.state = { ...h.state, projectInstanceId: 'reopened-instance' };
  resumeFreeGens(); expect(h.runs).toHaveLength(1);
  h.runs[0].input.onTaskId('late-acceptance', 'model');
  expect(h.segments.get('seg').taskRef).toBe('model|late-acceptance');
  h.runs[0].resolve({ status: 'success', resultUri: 'https://result.test/completed.mp4', taskId: 'late-acceptance' }); await flush();
  expect(h.deliver).toHaveBeenCalledWith(expect.objectContaining({ owner: { projectInstanceId: 'reopened-instance', savePath: h.state.savePath }, taskRef: 'model|late-acceptance' }));
  expect(h.runs).toHaveLength(1);
 });
 it('clicking a reopened pending disk snapshot adopts its unaccepted request without submitting twice', async () => {
  expect((await startFreeGen('seg')).ok).toBe(true);
  h.state = { ...h.state, projectInstanceId: 'reopened-pending' };
  Object.assign(h.segments.get('seg'), { status: 'pending', taskRef: undefined });
  expect((await startFreeGen('seg')).ok).toBe(true);
  expect(h.runs).toHaveLength(1); expect(h.upload).toHaveBeenCalledTimes(1);
  h.runs[0].input.onTaskId('only-request', 'model');
  expect(h.segments.get('seg').taskRef).toBe('model|only-request');
  h.runs[0].resolve({ status: 'success', resultUri: 'https://result.test/only.mp4', taskId: 'only-request' }); await flush();
  expect(h.deliver).toHaveBeenCalledWith(expect.objectContaining({ taskRef: 'model|only-request' }));
 });
 it('a replaced scope cannot overwrite accepted receipts or results for the restored newer attempt', async () => {
  expect((await startFreeGen('seg')).ok).toBe(true);
  h.state = { ...h.state, projectInstanceId: 'reopened-newer-task' };
  Object.assign(h.segments.get('seg'), { status: 'running', taskRef: 'model|new-task' });
  resumeFreeGens(); expect(h.runs).toHaveLength(2);
  h.runs[0].input.onTaskId('late-old-task', 'model');
  expect(h.rememberTask).toHaveBeenCalledTimes(1);
  expect(h.rememberTask.mock.calls[0][2]).toBe('model|new-task');
  h.runs[0].resolve({ status: 'success', resultUri: 'https://result.test/old.mp4', taskId: 'late-old-task' }); await flush();
  expect(h.rememberCompletion).not.toHaveBeenCalled(); expect(freeGenBusy('seg')).toBe(true);
  h.runs[1].resolve({ status: 'success', resultUri: 'https://result.test/new.mp4', taskId: 'new-task' }); await flush();
  expect(h.rememberCompletion).toHaveBeenCalledTimes(1);
  expect(h.rememberCompletion.mock.calls[0][2]).toBe('model|new-task');
  expect(h.deliver).toHaveBeenCalledWith(expect.objectContaining({ taskRef: 'model|new-task' }));
 });
 it('retry clears result identities from the previous attempt before waiting for acceptance', async () => {
  Object.assign(h.segments.get('seg'), { status: 'failed', taskRef: 'model|old-task', resultTaskRef: 'model|old-task', rtcResult: { uri: 'https://result.test/old.mp4', taskId: 'old-task' } });
  expect((await retryFreeGen('seg')).ok).toBe(true);
  expect(h.segments.get('seg')).toMatchObject({ status: 'running', taskRef: undefined, rtcResult: undefined, resultTaskRef: undefined });
  h.runs[0].input.onTaskId('new-task', 'model');
  expect(h.segments.get('seg').taskRef).toBe('model|new-task'); expect(h.readCompletion).not.toHaveBeenCalled();
  expect(h.rememberTask).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'model|new-task', 'model|old-task');
  await finish();
 });
 it('a retry acceptance receipt replaces its failed predecessor in an unsaved disk snapshot', async () => {
  Object.assign(h.segments.get('seg'), { status: 'failed', taskRef: 'model|old-task', resultTaskRef: 'model|old-task', rtcResult: { uri: 'https://result.test/old.mp4', taskId: 'old-task' } });
  h.received.mockReturnValue([{ target: { episodeId: 'A', segId: 'seg' }, taskRef: 'model|new-task', supersededTaskRefs: ['model|old-task'] }]);
  resumeFreeGens();
  expect(h.segments.get('seg')).toMatchObject({ status: 'running', taskRef: 'model|new-task', rtcResult: undefined, resultTaskRef: undefined });
  expect(h.runs).toHaveLength(1); expect(h.runs[0].input.resumeTask).toEqual({ taskId: 'new-task', adapterKey: 'model' });
  await finish();
 });
 it('an unrelated older receipt cannot replace the newer task already saved in the document', async () => {
  Object.assign(h.segments.get('seg'), { status: 'running', taskRef: 'model|new-task' });
  h.received.mockReturnValue([{ target: { episodeId: 'A', segId: 'seg' }, taskRef: 'model|old-task', supersededTaskRefs: ['model|older-task'] }]);
  resumeFreeGens();
  expect(h.segments.get('seg').taskRef).toBe('model|new-task');
  expect(h.runs).toHaveLength(1); expect(h.runs[0].input.resumeTask.taskId).toBe('new-task');
  expect(h.rememberTask).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'model|new-task');
  await finish();
 });
 it('a receipt for the same failed task does not silently restart its polling', () => {
  Object.assign(h.segments.get('seg'), { status: 'failed', taskRef: 'model|failed-task' });
  h.received.mockReturnValue([{ target: { episodeId: 'A', segId: 'seg' }, taskRef: 'model|failed-task' }]);
  resumeFreeGens(); expect(h.runs).toHaveLength(0); expect(h.segments.get('seg').status).toBe('failed');
 });
 it('preparation is visible before upload yields and progress does not write a persistent frame', async () => {
  let release!: (v: string) => void; h.upload.mockImplementationOnce(() => new Promise(r => { release = r; }));
  const pending = startFreeGen('seg');
  expect(h.prepare).toHaveBeenCalledWith(expect.anything(), { episodeId: 'A', segId: 'seg' }, expect.objectContaining({ media: 'video', name: '视频占位' }), undefined);
  release('https://material.test/ref'); await pending;
  h.runs[0].input.onTaskId('accepted', 'model'); h.runs[0].input.onProgress(48, 'running');
  expect(h.update).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), { status: 'running', progress: 48 }, false);
  await finish();
 });
 it('deletion before delayed acceptance still retains the accepted task and delivers its result', async () => {
  await startFreeGen('seg'); h.segments.clear();
  h.runs[0].input.onTaskId('accepted-after-delete', 'model');
  h.runs[0].resolve({ status: 'success', resultUri: 'https://result.test/retained.mp4', taskId: 'accepted-after-delete' }); await flush();
  expect(h.rememberTask).toHaveBeenCalledWith(expect.anything(), { episodeId: 'A', segId: 'seg' }, 'model|accepted-after-delete', undefined);
  expect(h.rememberCompletion).toHaveBeenCalledOnce();
  expect(h.deliver).toHaveBeenCalledWith(expect.objectContaining({ taskRef: 'model|accepted-after-delete' }));
  expect(h.segments.size).toBe(0); expect(h.runs).toHaveLength(1);
 });
 it('reopening the same path adopts a deleted placement before delayed acceptance', async () => {
  await startFreeGen('seg'); h.segments.clear(); h.state = { ...h.state, projectInstanceId: 'reopen-deleted' };
  resumeFreeGens(); expect(h.runs).toHaveLength(1);
  h.runs[0].input.onTaskId('late-task', 'model');
  h.runs[0].resolve({ status: 'success', resultUri: 'https://result.test/retained.mp4', taskId: 'late-task' }); await flush();
  expect(h.deliver).toHaveBeenCalledWith(expect.objectContaining({ owner: { projectInstanceId: 'reopen-deleted', savePath: h.state.savePath }, taskRef: 'model|late-task' }));
  expect(h.segments.size).toBe(0);
 });
 it.each(['image', 'video'])('a receipt resumes deleted %s placement without submitting a new task', async media => {
  h.segments.clear(); h.received.mockReturnValue([{ target: { episodeId: 'A', segId: 'deleted' }, taskRef: 'model|accepted', media, name: '原占位', status: 'running', createdAt: 123 }]);
  resumeFreeGens(); resumeFreeGens();
  expect(h.runs).toHaveLength(1); expect(h.runs[0].purpose).toBe(media === 'image' ? 'asset.scene.image' : 'video.generate');
  expect(h.runs[0].input.resumeTask).toEqual({ taskId: 'accepted', adapterKey: 'model' }); expect(h.runs[0].input.prompt).toBeUndefined();
  h.runs[0].resolve({ status: 'success', resultUri: 'https://result.test/retained', taskId: 'accepted' }); await flush();
  expect(h.deliver).toHaveBeenCalledOnce(); expect(h.segments.size).toBe(0);
 });
 it('a completed deleted placement replays its receipt without polling', async () => {
  h.segments.clear(); h.received.mockReturnValue([{ target: { episodeId: 'A', segId: 'deleted' }, taskRef: 'model|accepted', media: 'image', status: 'saving' }]);
  h.readCompletion.mockReturnValue({ uri: 'https://result.test/retained.png', media: 'image' });
  resumeFreeGens(); await flush(); expect(h.runs).toHaveLength(0); expect(h.deliver).toHaveBeenCalledOnce();
 });
 it('a crashed unaccepted request becomes interrupted and unlocks its surviving placeholder', () => {
  h.segments.get('seg').status = 'running';
  h.received.mockReturnValue([{ target: { episodeId: 'A', segId: 'seg' }, taskRef: '', media: 'video', status: 'running' }]);
  resumeFreeGens(); expect(h.runs).toHaveLength(0); expect(h.segments.get('seg').status).toBe('failed');
  expect(h.update).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ status: 'failed', error: expect.stringContaining('中断') }));
 });
 it('a failed deleted task stays visible without automatically resubmitting', async () => {
  await startFreeGen('seg'); h.runs[0].input.onTaskId('failed', 'model'); h.segments.clear();
  h.runs[0].resolve({ status: 'failed', error: 'upstream refusal' }); await flush();
  expect(h.update).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), { status: 'failed', error: 'upstream refusal' });
  h.received.mockReturnValue([{ target: { episodeId: 'A', segId: 'seg' }, taskRef: 'model|failed', media: 'video', status: 'failed' }]);
  resumeFreeGens(); expect(h.runs).toHaveLength(1);
 });
 it('Save As moves the same-instance receipt before delayed acceptance', async () => {
  const previousOwner = { projectInstanceId: h.state.projectInstanceId, savePath: h.state.savePath };
  await startFreeGen('seg'); h.state.savePath = 'saved-as.qiji'; h.runs[0].input.onTaskId('accepted', 'model');
  expect(h.move).toHaveBeenCalledWith(previousOwner, { ...previousOwner, savePath: 'saved-as.qiji' }, { episodeId: 'A', segId: 'seg' });
  expect(h.rememberTask).toHaveBeenCalledWith({ ...previousOwner, savePath: 'saved-as.qiji' }, expect.anything(), 'model|accepted', undefined);
  await finish();
 });
});
