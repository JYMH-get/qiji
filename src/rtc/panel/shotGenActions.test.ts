import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ state: {} as any, segments: new Map<string, any>(), upload: vi.fn(), requests: [] as any[], modelKey: 'model-a', infer: vi.fn(), nextId: 0, official: false, dualMode: true, templates: [] as any[] }));
vi.mock('@/store/projectStore', () => ({ useProjectStore: { getState: () => h.state } }));
vi.mock('@/store/connectionStore', () => ({ getDualModeFeature: () => h.dualMode }));
vi.mock('@/store/catalogStore', () => ({ useCatalogStore: { getState: () => ({ model: () => undefined, catalog: { templates: h.templates } }) } }));
vi.mock('@/services/materialPolicy', () => ({ supportsOfficialMaterials: () => h.official }));
vi.mock('@/components/ModelPicker', () => ({ effectiveModelKey: () => h.modelKey }));
vi.mock('@/lib/publicUrl', () => ({ ensurePublicUrl: h.upload }));
vi.mock('@/lib/assetVars', () => ({ buildAssetListVars: () => ({}) }));
vi.mock('@/lib/inferContext', () => ({ buildNeighborVars: () => ({}) }));
vi.mock('@/lib/shotMaterialOps', () => ({ isIdentityShotMaterial: (material: any, index: number, legacy: number[]) => material.usage === 'identity' || (material.usage === undefined && !!legacy?.includes(index)) }));
vi.mock('@/lib/presetSchemes', () => ({ resolvePresets: (s: string) => s, countUnifiedShots: () => 1, gridPresetForShotCount: () => '', presetBody: () => '', hasGridInstruction: () => true }));
vi.mock('@/lib/modelOptions', () => ({ imageResolutionOptionsForKey: () => [{ v: '2k' }], modelMethodsForKey: () => ['omni'], videoReqOptionsForKey: () => ({ durations: [5, 15, 20], resolutions: ['720p'], aspects: ['16:9'] }) }));
vi.mock('@/lib/smartInferPrompts', () => ({ SMART_INFER_SINGLE_TPL: 'single', SMART_INFER_UNIFIED_SINGLE_TPL: 'unified' }));
vi.mock('@/services/inferRun', () => ({ startInfer: h.infer }));
vi.mock('./rtcGenSink', () => ({
 resolveRtcTarget: (segId: string) => { const seg = h.segments.get(segId); return seg ? { episodeId: seg.rtcEpisodeId, segId } : null; },
 liveSegment: (segId: string, target: any) => { const seg = h.segments.get(segId); return seg?.rtcEpisodeId === target?.episodeId ? seg : null; },
}));
vi.mock('./placeholderSwap', () => ({ armPlaceholderSwap: (id: string, _ep: string, _shot: string, seg: string) => { const s = h.segments.get(seg); if (s) s.taskRef = id; } }));
vi.mock('@/services/generationQueue', () => ({ startShotGeneration: (spec: any) => {
 const id = `pending-${++h.nextId}`;
 h.requests.push({ owner: h.state.projectInstanceId, ...spec });
 h.state.pendingGens.push({ id, status: 'running', shot: { episodeId: spec.episodeId, shotId: spec.shotId, field: spec.field } });
 return id;
} }));
import { genShotVideo, genShotStoryboard, inferShotPrompts } from './shotGenActions';
import { claimShotPreparation, withCurrentOption } from './rtcShotSubmission';
const shot = () => h.state.episodes[0].shots[0];
const delayUpload = () => { let resolve!: (v: string) => void; h.upload.mockImplementationOnce(() => new Promise<string>(r => { resolve = r; })); return (v = 'https://material.test/A.png') => resolve(v); };
beforeEach(() => {
 h.state = { projectInstanceId: `project-${++h.nextId}`, isProjectLoading: false, mediaSettings: { imgVideoSameSource: true, genWithAsset: true, maxDuration: 20, imageResolution: '4K' },
 episodes: [{ id: 'episode-A', shots: [{ id: 'shot', title: 'A', unifiedPrompt: 'A prompt', durationSec: 20, materials: [{ id: 'mat', uri: 'local://A.png', media: 'image', name: 'A ref' }] }] }],
 pendingGens: [], inferTasks: [], blobByUri: () => undefined,
 updateShot: (epId: string, shotId: string, patch: any) => Object.assign(h.state.episodes.find((ep: any) => ep.id === epId).shots.find((item: any) => item.id === shotId), patch) };
 h.segments = new Map([['seg', { id: 'seg', rtcEpisodeId: 'timeline-A', kind: 'placeholder', shotRef: { episodeId: 'episode-A', shotId: 'shot' } }]]);
 h.requests = []; h.official = false; h.dualMode = true; h.templates = [{ id: 'creative', name: '创作方案', purpose: 'storyboard.toVideoPrompt', isDefault: true }, { id: 'selected', name: '旧双模多卡30s', purpose: 'storyboard.toVideoPrompt', aliases: ['old-selected'] }];
 h.infer.mockReset(); h.upload.mockReset(); h.upload.mockResolvedValue('https://material.test/A.png'); h.modelKey = 'model-a'; vi.stubGlobal('alert', vi.fn());
});

describe('RTC single-shot inference strategy selection', () => {
 it('submits the selected creation template with single scope and the current output mode', async () => {
  shot().scriptSegment = 'original script'; shot().plotGuidance = '本镜引导'; h.state.visualStyle = '动画';
  h.state.mediaSettings.inferenceStrategy = { templateId: 'creative' };
  await inferShotPrompts('episode-A', 'shot', { strategy: { templateId: 'selected', guidance: '项目引导' } });
  expect(h.infer).toHaveBeenCalledWith(expect.objectContaining({ mode: 'single', sameSource: true, templateId: 'selected', shotId: 'shot',
   inference: expect.objectContaining({ source: 'template', guidance: '项目引导\n\n本镜引导', durationLimit: 30 }), variables: { 原文: 'original script', 视觉风格: '动画' } }));
  expect(shot().unifiedPrompt).toBe(''); expect(h.state.mediaSettings.inferenceStrategy.templateId).toBe('creative');
 });
 it('project strategy and legacy alias resolve to the available template without inferring output from its purpose', async () => {
  shot().scriptSegment = 'script'; h.state.mediaSettings.imgVideoSameSource = false;
  h.state.mediaSettings.inferenceStrategy = { templateId: 'old-selected' };
  await inferShotPrompts('episode-A', 'shot');
  expect(h.infer).toHaveBeenCalledWith(expect.objectContaining({ templateId: 'selected', mode: 'single', sameSource: false }));
  expect(shot().unifiedPrompt).toBe('A prompt'); expect(shot().storyboardPrompt).toBe(''); expect(shot().videoPrompt).toBe('');
 });
 it('external Skills content and guidance are frozen before the import awaits', async () => {
  shot().scriptSegment = 'script'; h.templates = [];
  const strategy = { source: 'skill' as const, skillText: '完整内容 {{保持原文}}', skillName: '规则.md', guidance: '原引导' };
  const pending = inferShotPrompts('episode-A', 'shot', { strategy });
  strategy.skillText = 'later edit'; strategy.guidance = 'changed'; shot().plotGuidance = 'later shot guidance';
  await pending;
  expect(h.infer).toHaveBeenCalledWith(expect.objectContaining({ templateId: '', inference: expect.objectContaining({ source: 'skill', skillText: '完整内容 {{保持原文}}', skillName: '规则.md', guidance: '原引导' }) }));
 });
 it.each([{ templateId: 'unavailable' }, { source: 'skill' as const, skillText: '   ' }])('rejects an invalid strategy before clearing existing prompts: %j', async strategy => {
  shot().scriptSegment = 'script'; await inferShotPrompts('episode-A', 'shot', { strategy });
  expect(h.infer).not.toHaveBeenCalled(); expect(shot().unifiedPrompt).toBe('A prompt'); expect(alert).toHaveBeenCalledOnce();
 });
 it('the permission switch still forces unified output for a legacy dual-mode project', async () => {
  shot().scriptSegment = 'script'; h.dualMode = false; h.state.mediaSettings.imgVideoSameSource = false;
  await inferShotPrompts('episode-A', 'shot');
  expect(h.infer).toHaveBeenCalledWith(expect.objectContaining({ sameSource: true, mode: 'single' }));
 });
 it('project switching during import does not clear prompts or submit to another project', async () => {
  shot().scriptSegment = 'script'; const pending = inferShotPrompts('episode-A', 'shot');
  h.state.projectInstanceId = 'different'; await pending;
  expect(h.infer).not.toHaveBeenCalled(); expect(shot().unifiedPrompt).toBe('A prompt');
 });
 it('preparation blocks repeated inference clicks and preserves the original strategy', async () => {
  shot().scriptSegment = 'script';
  const first = inferShotPrompts('episode-A', 'shot', { strategy: { templateId: 'selected' } });
  const second = inferShotPrompts('episode-A', 'shot', { strategy: { templateId: 'creative' } });
  await Promise.all([first, second]); expect(h.infer).toHaveBeenCalledOnce();
  expect(h.infer.mock.calls[0][0].templateId).toBe('selected');
 });
});
describe('RTC submission owns preparation until queue acceptance', () => {
 it('omni frame roles keep reference order and are only appended to the submitted video prompt', async () => {
  shot().unifiedPrompt = '@Image1 meets @Image2';
  shot().materials = [{ id: 'end', uri: 'local://end', name: 'end', rtcFrameRole: 'last' }, { id: 'first', uri: 'local://first', name: 'first', rtcFrameRole: 'first' }];
  expect(await genShotVideo('episode-A', 'shot')).toBe(true);
  expect(h.requests[0].input.images.map((ref: any) => ref.name)).toEqual(['end', 'first']);
  expect(h.requests[0].prompt).toContain('首帧约束：以 @Image2'); expect(h.requests[0].prompt).toContain('尾帧约束：以 @Image1');
  expect(h.requests[0].params.firstFrameUrl).toBeUndefined(); expect(shot().unifiedPrompt).toBe('@Image1 meets @Image2');
 });
 it('frames remaps image references and official indexes while preserving extras and storyboard', async () => {
  h.official = true; h.upload.mockImplementation(async (uri: string) => uri.replace('local://', 'https://assets.test/'));
  shot().overrides = { method: 'frames', officialAssetIndexes: [0] }; h.state.mediaSettings.genWithStory = true; shot().storyboardUri = 'local://story';
  shot().unifiedPrompt = '@Image1 meets @Image3';
  shot().materials = [{ id: 'extra', uri: 'local://extra', name: 'extra' }, { id: 'last', uri: 'local://last', name: 'last', rtcFrameRole: 'last' }, { id: 'first', uri: 'local://first', name: 'first', rtcFrameRole: 'first' }, { id: 'audio', uri: 'local://audio', name: 'audio', media: 'audio' }];
  expect(await genShotVideo('episode-A', 'shot')).toBe(true);
  expect(h.requests[0].input.images.map((ref: any) => ref.name)).toEqual(['first', 'last', 'extra', '故事板']);
  expect(h.requests[0].input.audios).toHaveLength(1); expect(h.requests[0].params.officialAssetIndexes).toEqual([2]);
  expect(h.requests[0].params.firstFrameUrl).toBeUndefined(); expect(h.requests[0].prompt).toContain('@Image3 meets @Image1');
 });
 it('explicit frames submit with regular materials disabled and an unavailable storyboard', async () => {
  shot().overrides = { method: 'frames' }; h.state.mediaSettings.genWithAsset = false; h.state.mediaSettings.genWithStory = true;
  shot().materials = [{ id: 'unused', uri: '', name: 'disabled reference' }, { id: 'first', uri: 'local://first', name: 'first', rtcFrameRole: 'first' }, { id: 'last', uri: 'local://last', name: 'last', rtcFrameRole: 'last' }];
  expect(await genShotVideo('episode-A', 'shot')).toBe(true);
  expect(h.requests[0].input.images.map((ref: any) => ref.name)).toEqual(['first', 'last']); expect(h.upload).toHaveBeenCalledTimes(2);
 });
 it('storyboard image generation keeps image order and does not add video frame instructions', async () => {
  shot().materials = [{ id: 'last', uri: 'local://last', name: 'last', rtcFrameRole: 'last' }, { id: 'first', uri: 'local://first', name: 'first', rtcFrameRole: 'first' }];
  expect(await genShotStoryboard('episode-A', 'shot')).toBe(true);
  expect(h.requests[0].input.images.map((ref: any) => ref.name)).toEqual(['last', 'first']); expect(h.requests[0].prompt).toBe('A prompt');
 });
 for (const [field, run] of [['video', genShotVideo], ['storyboard', genShotStoryboard]] as const) {
  it(`${field}: switching projects during preparation prevents submission`, async () => {
   const release = delayUpload(); const promise = run('episode-A', 'shot', { swapSegId: 'seg' });
   const guard = h.upload.mock.calls[0][1].shouldContinue; expect(guard()).toBe(true);
   h.state = { ...h.state, projectInstanceId: 'other' }; expect(guard()).toBe(false); release();
   expect(await promise).toBe(false); expect(h.requests).toHaveLength(0); expect(alert).not.toHaveBeenCalled();
  });
  it(`${field}: duplicate preparing/pending clicks cannot create another request`, async () => {
   const release = delayUpload(); const promise = run('episode-A', 'shot', { swapSegId: 'seg' });
   expect(claimShotPreparation('episode-A', 'shot', field)).toBeNull();
   expect(await run('episode-A', 'shot', { swapSegId: 'seg' })).toBe(false); expect(h.upload).toHaveBeenCalledTimes(1);
   release(); expect(await promise).toBe(true);
   expect(await run('episode-A', 'shot', { swapSegId: 'seg' })).toBe(false); expect(h.requests).toHaveLength(1);
  });
 }
 it('deleted shot or deleted placeholder cancels without a paid request', async () => {
  let release = delayUpload(); let promise = genShotVideo('episode-A', 'shot', { swapSegId: 'seg' });
  h.segments.delete('seg'); release(); expect(await promise).toBe(false);
  release = delayUpload(); promise = genShotVideo('episode-A', 'shot'); h.state.episodes[0].shots = []; release();
  expect(await promise).toBe(false); expect(h.requests).toHaveLength(0);
 });
 it('switching the active timeline episode preserves original request/target/settings', async () => {
  const release = delayUpload(); const promise = genShotVideo('episode-A', 'shot', { swapSegId: 'seg' });
  h.state.rtcEpisodeId = 'timeline-B'; h.modelKey = 'model-b'; shot().unifiedPrompt = 'changed'; shot().durationSec = 5;
  shot().materials = []; h.state.mediaSettings.maxDuration = 5; release();
  expect(await promise).toBe(true);
  expect(h.requests[0]).toMatchObject({ modelKey: 'model-a', prompt: 'A prompt', params: { duration: 20 }, rtcTarget: { episodeId: 'timeline-A', segId: 'seg' }, input: { images: [{ name: 'A ref' }] } });
 });
 it('explicit video duration, ratio, resolution and method survive a mismatched catalog', async () => {
  shot().overrides = { duration: 20, resolution: '4K', aspect: '21:9', method: 'custom-method' };
  expect(await genShotVideo('episode-A', 'shot')).toBe(true);
  expect(h.requests[0].params).toMatchObject({ duration: 20, resolution: '4K', aspect_ratio: '21:9', method: 'custom-method' });
  expect(withCurrentOption([5, 15], 20)).toEqual([20, 5, 15]);
 });
 it('RTC Auto uses the bound segment current length and freezes before materials await', async () => {
  Object.assign(h.segments.get('seg'), { generationDuration: 'auto', targetDurationUs: 5_000_001 });
  const release = delayUpload(); const pending = genShotVideo('episode-A', 'shot', { swapSegId: 'seg' });
  h.segments.get('seg').targetDurationUs = 19_000_000; h.segments.get('seg').generationDuration = 20;
  release(); expect(await pending).toBe(true);
  expect(h.requests[0].params.duration).toBe(15);
  expect(shot().durationSec).toBe(20); expect(shot().overrides).toBeUndefined();
 });
 it('RTC Auto uses the maximum catalog duration when the segment is longer', async () => {
  Object.assign(h.segments.get('seg'), { generationDuration: 'auto', targetDurationUs: 26_000_000 });
  expect(await genShotVideo('episode-A', 'shot', { swapSegId: 'seg' })).toBe(true);
  expect(h.requests[0].params.duration).toBe(20); expect(h.segments.get('seg').targetDurationUs).toBe(26_000_000);
 });
 it('a hand-picked RTC duration overrides legacy shot values without changing the segment length', async () => {
  Object.assign(h.segments.get('seg'), { generationDuration: 23, targetDurationUs: 5_000_000 });
  expect(await genShotVideo('episode-A', 'shot', { swapSegId: 'seg' })).toBe(true);
  expect(h.requests[0].params.duration).toBe(23); expect(shot().durationSec).toBe(20);
  expect(h.segments.get('seg').targetDurationUs).toBe(5_000_000);
 });
 it('explicit image resolution survives catalog changes during preparation', async () => {
  const release = delayUpload(); const promise = genShotStoryboard('episode-A', 'shot'); h.state.mediaSettings.imageResolution = '1k'; h.modelKey = 'other'; release();
  expect(await promise).toBe(true); expect(h.requests[0]).toMatchObject({ modelKey: 'model-a', params: { resolution: '4K' } });
 });
 it('selected storyboard preparation failure stops request and releases its claim', async () => {
  h.state.mediaSettings.genWithStory = true; h.state.mediaSettings.genWithAsset = false; shot().storyboardUri = 'missing://story'; h.upload.mockResolvedValueOnce('');
  expect(await genShotVideo('episode-A', 'shot')).toBe(false); expect(h.requests).toHaveLength(0); expect(alert).toHaveBeenCalledWith(expect.stringContaining('故事板'));
  expect(await genShotVideo('episode-A', 'shot')).toBe(true); expect(h.requests).toHaveLength(1);
 });
 it('upload rejection releases claim and a later user retry succeeds', async () => {
  h.upload.mockRejectedValueOnce(new Error('network failed'));
  expect(await genShotVideo('episode-A', 'shot')).toBe(false); expect(alert).toHaveBeenCalledWith('network failed');
  expect(await genShotVideo('episode-A', 'shot')).toBe(true); expect(h.requests).toHaveLength(1);
 });
 it('video preserves every image, video and audio reference in their original group order', async () => {
  shot().materials = ['image', 'video', 'audio', 'image'].map((media, i) => ({ id: `${i}`, media, uri: `local://${i}`, name: `ref-${i}` }));
  expect(await genShotVideo('episode-A', 'shot')).toBe(true);
  expect(h.requests[0].input.images.map((x: any) => x.name)).toEqual(['ref-0', 'ref-3']);
  expect(h.requests[0].input.videos[0].name).toBe('ref-1'); expect(h.requests[0].input.audios[0].name).toBe('ref-2');
 });
});
