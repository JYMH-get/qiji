import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ ps: {} as any, rtc: {} as any, upload: vi.fn(), requests: [] as any[], seq: 0 }));
vi.mock('@/store/projectStore', () => ({ useProjectStore: { getState: () => h.ps } }));
vi.mock('@/store/rtcStore', () => ({ useRtcStore: { getState: () => h.rtc } }));
vi.mock('@/store/connectionStore', () => ({ getDualModeFeature: () => true }));
vi.mock('@/store/catalogStore', () => ({ useCatalogStore: { getState: () => ({ model: () => undefined }) } }));
vi.mock('@/services/materialPolicy', () => ({ supportsOfficialMaterials: () => false }));
vi.mock('@/components/ModelPicker', () => ({ effectiveModelKey: () => 'model' }));
vi.mock('@/lib/publicUrl', () => ({ ensurePublicUrl: h.upload }));
vi.mock('@/lib/assetVars', () => ({ buildAssetListVars: () => ({}) }));
vi.mock('@/lib/inferContext', () => ({ buildNeighborVars: () => ({}) }));
vi.mock('@/lib/shotMaterialOps', () => ({ identityIndexesForMaterials: () => [], isIdentityShotMaterial: () => false }));
vi.mock('@/lib/presetSchemes', () => ({ resolvePresets: (s: string) => s, countUnifiedShots: () => 1, gridPresetForShotCount: () => '', presetBody: () => '', hasGridInstruction: () => true }));
vi.mock('@/lib/modelOptions', () => ({ imageResolutionOptionsForKey: () => [{ v: '2k' }], modelMethodsForKey: () => ['omni'], videoReqOptionsForKey: () => ({ durations: [5, 20], resolutions: ['720p'], aspects: ['16:9'] }) }));
vi.mock('@/lib/smartInferPrompts', () => ({ SMART_INFER_SINGLE_TPL: 'single', SMART_INFER_UNIFIED_SINGLE_TPL: 'unified' }));
vi.mock('@/services/generationQueue', () => ({ startDerivedGeneration: vi.fn(), startShotGeneration: (spec: any) => { h.requests.push(spec); return 'pending'; } }));
vi.mock('@/rtc/panel/placeholderSwap', () => ({ armPlaceholderSwap: vi.fn(), armPendingWatch: vi.fn() }));
vi.mock('@/rtc/panel/rtcGenSink', () => ({
 resolveRtcTarget: (segId: string) => {
  for (const [episodeId, doc] of Object.entries(h.ps.rtcDocs) as any[]) if (doc.tracks.some((t: any) => t.segments.some((s: any) => s.id === segId))) return { episodeId, segId };
  return null;
 },
 liveSegment: (segId: string, target: any) => h.ps.rtcDocs[target?.episodeId]?.tracks.flatMap((t: any) => t.segments).find((s: any) => s.id === segId), markFailed: vi.fn(),
}));
vi.mock('@/components/VideoProcessModal', () => ({ default: () => null, PROCESS_PURPOSE: {} }));
vi.mock('@/canvas/nodeUpload', () => ({ uploadMediaToCanvasAsset: vi.fn() }));
vi.mock('@/rtc/panel/rtcSegUtils', () => ({ patchSegmentDoc: vi.fn() }));
vi.mock('@/store/assetFormStore', () => ({ useAssetFormStore: {} }));
vi.mock('@/lib/id', () => ({ genId: () => `generated-${++h.seq}` }));
vi.mock('@/rtc/rtcAssetSelStore', () => ({ useRtcAssetSelStore: {} }));
vi.mock('@/rtc/panel/segShotBinding', () => ({ ensureShotForPlaceholder: vi.fn() }));
vi.mock('@/rtc/asset/rtcAssetData', () => ({ collectProjectImageItems: vi.fn() }));
vi.mock('@/rtc/settings/rtcEditorSettingsStore', () => ({ imageDefaultUsFromSettings: () => 3000000 }));
vi.mock('./timelineUtil', () => ({ probeMediaDurationSec: vi.fn() }));
vi.mock('./rtcFreezeActions', () => ({ freezeAtPlayhead: vi.fn() }));
vi.mock('@/rtc/panel/reverseActions', () => ({ toggleReverse: vi.fn() }));
vi.mock('@/rtc/panel/cropEditorStore', () => ({ requestCropEditor: vi.fn() }));
vi.mock('./compoundActions', () => ({ createCompoundFromSelection: vi.fn(), dissolveSelectedCompound: vi.fn(), enterSelectedCompound: vi.fn() }));
import { regenerateShotResult } from './segActions';
const segments = (doc = h.rtc.doc) => doc.tracks.flatMap((t: any) => t.segments);
const holdUpload = () => { let resolve!: (v: string) => void; h.upload.mockImplementationOnce(() => new Promise<string>(r => { resolve = r; })); return (url = 'https://material.test/ref') => resolve(url); };
beforeEach(() => {
 const doc = { version: 1, fps: 30, width: 1920, height: 1080, tracks: [{ id: 'video-track', type: 'video', segments: [{ id: 'source', kind: 'media', media: 'video', uri: 'https://result.test/original', targetStartUs: 0, targetDurationUs: 5000000, shotRef: { episodeId: 'A', shotId: 'shot' } }] }] };
 h.ps = { projectInstanceId: `owner-${++h.seq}`, episodes: [{ id: 'A', shots: [{ id: 'shot', unifiedPrompt: 'prompt', materials: [{ id: 'ref', uri: 'local://ref', media: 'image' }] }] }], mediaSettings: { imgVideoSameSource: true }, pendingGens: [], inferTasks: [], rtcDocs: { A: doc }, blobByUri: () => undefined,
 setRtcEpisodeDoc: (ep: string, next: any) => { h.ps.rtcDocs[ep] = next; } };
 h.rtc = { doc, ownerEpisodeKey: 'A', commit: (fn: any) => { h.rtc.doc = fn(h.rtc.doc); h.ps.rtcDocs[h.rtc.ownerEpisodeKey] = h.rtc.doc; } };
 h.requests = []; h.upload.mockReset(); h.upload.mockResolvedValue('https://material.test/ref'); vi.stubGlobal('alert', vi.fn());
});
describe('regeneration version placeholder ownership', () => {
 it.each(['auto', 23] as const)('new versions inherit RTC duration %s without resizing the source or holder', async generationDuration => {
  Object.assign(segments()[0], { generationDuration, targetDurationUs: 5_000_001 });
  expect(await regenerateShotResult('source')).toBe(true);
  const source = segments().find((s: any) => s.id === 'source');
  const holder = segments().find((s: any) => s.kind === 'placeholder');
  expect(holder.generationDuration).toBe(generationDuration);
  expect(holder.targetDurationUs).toBe(5_000_001); expect(source.targetDurationUs).toBe(5_000_001);
  expect(h.requests[0].params.duration).toBe(generationDuration === 'auto' ? 20 : 23);
 });
 it('two clicks during preparation create one version placeholder and one request', async () => {
  const release = holdUpload(); const first = regenerateShotResult('source');
  expect(segments().filter((s: any) => s.kind === 'placeholder')).toHaveLength(1);
  expect(await regenerateShotResult('source')).toBe(false);
  expect(segments().filter((s: any) => s.kind === 'placeholder')).toHaveLength(1);
  release(); expect(await first).toBe(true); expect(h.requests).toHaveLength(1); expect(segments().find((s: any) => s.id === 'source').uri).toContain('original');
 });
 it('preparation failure removes only its new placeholder, preserving original media', async () => {
  h.upload.mockResolvedValueOnce(''); expect(await regenerateShotResult('source')).toBe(false);
  expect(segments()).toHaveLength(1); expect(segments()[0].id).toBe('source'); expect(h.requests).toHaveLength(0);
 });
 it('after switching projects failure cleanup does not delete a copied same-ID placeholder', async () => {
  const release = holdUpload(); const first = regenerateShotResult('source');
  const copied = structuredClone(h.rtc.doc); const holder = segments(copied).find((s: any) => s.kind === 'placeholder');
  h.ps = { ...h.ps, projectInstanceId: 'copied-project', rtcDocs: { A: copied } }; h.rtc.doc = copied;
  release(''); expect(await first).toBe(false);
  expect(segments().some((s: any) => s.id === holder.id)).toBe(true); expect(h.requests).toHaveLength(0);
 });
 it('same-project episode switch cleans the original inactive preparation placeholder only', async () => {
  const release = holdUpload(); const first = regenerateShotResult('source');
  const other = { ...h.rtc.doc, tracks: [] }; h.ps.rtcDocs.B = other; h.rtc.doc = other; h.rtc.ownerEpisodeKey = 'B';
  release(''); expect(await first).toBe(false);
  expect(segments(h.ps.rtcDocs.A)).toHaveLength(1); expect(h.rtc.doc).toBe(other);
 });
});
