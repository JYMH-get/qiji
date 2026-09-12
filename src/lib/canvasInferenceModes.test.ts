import { describe, expect, it } from 'vitest';
import type { CanvasEdge, CanvasNode } from '@/types';
import type { CatalogTemplate } from '@/contract';
import { canvasInference, canvasInferenceDuration, inferenceDurationLimit, inferenceDurationRangeError, inferenceTemplates, projectInferenceStrategy } from './inferenceStrategy';
import { buildScriptSplitRows, buildSpawn } from './canvasSpawn';

const templatePurposes = ['storyboard.toVideoPrompt', 'storyboard.singleShot', 'storyboard.unified', 'storyboard.unifiedShot'] as const;
const templates = Array.from({ length: 10 }, (_, i) => ({
  id: `official-${i + 1}`, name: `官方${i + 1}`, purpose: templatePurposes[i % templatePurposes.length],
  category: '智能推理', capability: 'text', variables: [], isDefault: i === 0,
})) as CatalogTemplate[];
const node = (id: string, params: Record<string, unknown> = {}, type = 'smart.infer'): CanvasNode => ({
  id, type, x: 0, y: 0, w: 240, h: 200, parentId: null, parentScriptId: null,
  data: { input: {}, params, resultAssetId: null },
});
const edge = (source: string, target: string): CanvasEdge => ({ id: `${source}-${target}`, kind: 'dataflow', source, target, sourcePort: 'out', targetPort: 'in' });
const config = (params: Record<string, unknown>, upstream?: string) => {
  const n = node('n', params);
  return canvasInference(n, { n, ...(upstream ? { parent: node('parent', {}, upstream) } : {}) }, upstream ? { e: edge('parent', 'n') } : {}, templates);
};

describe('画布请求位置与输出选项', () => {
  it('官方1-10同时可选，选中模板不会反推范围、模式或时长', () => {
    expect(inferenceTemplates(templates).map(t => t.name)).toEqual(Array.from({ length: 10 }, (_, i) => `官方${i + 1}`));
    for (const t of templates) {
      const cfg = config({ templateId: t.id });
      expect(cfg).toMatchObject({ purpose: 'storyboard.singleShot', unified: false, durationLimit: 15, template: { id: t.id } });
    }
  });
  it.each(['storyboard', 'unified'])('上游限制只影响单卡/多卡，输出模式=%s', mode => {
    for (const t of templates) {
      expect(config({ templateId: t.id, inferenceScope: 'multi', inferenceMode: mode }, 'smart.infer').purpose)
        .toBe(mode === 'unified' ? 'storyboard.unifiedShot' : 'storyboard.singleShot');
      expect(config({ templateId: t.id, inferenceScope: 'single', inferenceMode: mode }, 'episode.split').purpose)
        .toBe(mode === 'unified' ? 'storyboard.unified' : 'storyboard.toVideoPrompt');
    }
  });
  it('自由节点明确选择范围；旧输出配置仍可读取，模板别名不参与推断', () => {
    expect(config({ inferenceScope: 'multi', inferenceMode: 'unified' }).purpose).toBe('storyboard.unified');
    expect(config({ inferenceOutput: 'storyboard.unified' }).purpose).toBe('storyboard.unified');
    expect(config({ purpose: 'storyboard.unifiedShot' }).purpose).toBe('storyboard.unifiedShot');
    expect(config({ templateId: 'smart.infer.unified.single-30s' }).purpose).toBe('storyboard.singleShot');
    expect(config({ inferenceOutput: 'storyboard.unified', inferenceMode: 'storyboard', inferenceScope: 'single' }).purpose).toBe('storyboard.singleShot');
  });
  it('仅拆分仍可选，单卡位置不会误发拆分请求', () => {
    expect(config({ inferenceScope: 'split' }).purpose).toBe('storyboard.split');
    expect(config({ inferenceScope: 'split' }, 'episode.split').purpose).toBe('storyboard.split');
    expect(config({ inferenceScope: 'split' }, 'smart.infer').purpose).toBe('storyboard.singleShot');
  });
  it('切换输出仅更新请求选项，创作方案、Skills、引导和当前原文均保持', () => {
    const params = { inferenceStrategy: { source: 'skill', templateId: 'official-6', skillText: '保持人物性格', guidance: '下雨' }, prompt: '人物推门' };
    const before = structuredClone(params);
    const cfg = config({ ...params, inferenceScope: 'multi', inferenceMode: 'unified', inferenceDurationLimit: 30 });
    expect(cfg.strategy).toEqual(before.inferenceStrategy);
    expect(params).toEqual(before);
    expect(cfg).toMatchObject({ purpose: 'storyboard.unified', durationLimit: 30 });
  });
  it('时长只读取请求参数，不读取模板id或名称', () => {
    for (const duration of [undefined, null, '', -1, 0, 4, 15, NaN, Infinity, '无效']) expect(inferenceDurationLimit(duration)).toBe(15);
    for (const duration of [16, 30, 99, '30']) expect(inferenceDurationLimit(duration)).toBe(30);
    expect(config({ templateId: 'official-30s', inferenceDurationLimit: 15 }).durationLimit).toBe(15);
  });
  it('旧时长迁移为范围，新选择优先且自定义缺省4–15', () => {
    expect(config({ inferenceDurationLimit: 30 })).toMatchObject({ durationPreset: '4-30', durationRange: { min: 4, max: 30 }, customDuration: { min: 4, max: 15 } });
    expect(config({ inferenceDurationLimit: 30, inferenceDurationPreset: '4-15' })).toMatchObject({ durationRange: { min: 4, max: 15 } });
    expect(config({ inferenceDurationPreset: 'custom' })).toMatchObject({ durationPreset: 'custom', durationRange: { min: 4, max: 15 } });
  });
  it('自定义时长不被15/30档位夹钳，切换后保留本节点自定义值', () => {
    const params = { inferenceDurationPreset: 'custom', inferenceCustomDuration: { min: 8.5, max: 22 } };
    expect(canvasInferenceDuration(params).durationRange).toEqual({ min: 8.5, max: 22 });
    const presetParams = { ...params, inferenceDurationPreset: '4-30' };
    expect(canvasInferenceDuration(presetParams)).toMatchObject({ durationRange: { min: 4, max: 30 }, customDuration: { min: 8.5, max: 22 } });
    const restoredParams = JSON.parse(JSON.stringify({ ...presetParams, inferenceDurationPreset: 'custom' }));
    expect(canvasInferenceDuration(restoredParams).durationRange).toEqual({ min: 8.5, max: 22 });
  });
  it.each([
    { min: '', max: 15 }, { min: 4, max: '' }, { min: null, max: 15 }, { min: 4 },
    { min: '4', max: 15 }, { min: NaN, max: 15 }, { min: 4, max: Infinity },
    { min: 0, max: 15 }, { min: -1, max: 15 }, { min: 20, max: 15 }, null,
  ])('非法范围被明确标记且不回退默认：%j', custom => {
    const cfg = canvasInferenceDuration({ inferenceDurationPreset: 'custom', inferenceCustomDuration: custom });
    expect(cfg.durationError).toBeTruthy();
    expect(cfg.durationRange).toBeUndefined();
    expect(inferenceDurationRangeError(custom)).toBeTruthy();
    if (custom && 'min' in custom) expect(cfg.customDuration.min).toEqual(custom.min);
  });
  it('自定义草稿不干扰当前预设，重新切回自定义必须修正', () => {
    const params = { inferenceDurationPreset: '4-15', inferenceCustomDuration: { min: '', max: 30 } };
    expect(canvasInferenceDuration(params)).toMatchObject({ durationRange: { min: 4, max: 15 }, customDuration: { min: '', max: 30 }, durationError: undefined });
    expect(canvasInferenceDuration({ ...params, inferenceDurationPreset: 'custom' }).durationRange).toBeUndefined();
    expect(canvasInferenceDuration({ inferenceDurationPreset: 'unknown' }).durationRange).toBeUndefined();
  });
  it('旧项目创作选择顺序固定，输出选择不会改变它', () => {
    const settings = { inferTplId: '', unifiedTplId: 'chosen', singleTplId: 'single' };
    expect(projectInferenceStrategy(settings).templateId).toBe('chosen');
    expect(projectInferenceStrategy({ ...settings, inferenceStrategy: { source: 'skill', skillText: '正文' } })).toEqual({ source: 'skill', skillText: '正文' });
  });
  it('裂变与原文拆分继承同一创作方案，同时明确单卡和输出模式', () => {
    const parent = node('parent', { templateId: 'official-6', inferenceStrategy: { templateId: 'official-6', guidance: '安静' }, inferenceScope: 'multi', inferenceMode: 'unified', inferenceDurationLimit: 30 });
    const result = JSON.stringify([{ card_number: 1, duration: 28, original_script: '人物推门', unified_prompt: '保持悬念' }]);
    const generated = buildSpawn(parent, { spawn: { source: 'cards', childType: 'text.seed' } }, result).nodes[0];
    const split = buildScriptSplitRows(parent, ['一', '二'], '1', 1).nodes;
    for (const n of [generated, ...split]) {
      expect(n.data.params).toMatchObject({ templateId: 'official-6', inferenceStrategy: parent.data.params.inferenceStrategy, inferenceScope: 'single', inferenceMode: 'unified', inferenceDurationLimit: 30, inferenceDurationPreset: '4-30', inferenceCustomDuration: { min: 4, max: 15 }, inferenceOutput: 'storyboard.unifiedShot' });
    }
  });
  it('裂变保留自定义范围，改变子节点不覆盖父节点或其他节点', () => {
    const parent = node('parent', { inferenceDurationPreset: 'custom', inferenceCustomDuration: { min: 6, max: 20 } });
    const children = buildScriptSplitRows(parent, ['一', '二'], '1', 1).nodes;
    for (const child of children) expect(canvasInferenceDuration(child.data.params).durationRange).toEqual({ min: 6, max: 20 });
    (children[0].data.params.inferenceCustomDuration as { min: number }).min = 10;
    expect(canvasInferenceDuration(parent.data.params).durationRange).toEqual({ min: 6, max: 20 });
    expect(canvasInferenceDuration(children[1].data.params).durationRange).toEqual({ min: 6, max: 20 });
    const presetParent = node('preset-parent', { inferenceDurationPreset: '4-30', inferenceCustomDuration: { min: 7, max: 19 } });
    const presetChild = buildScriptSplitRows(presetParent, ['一'], '1', 1).nodes[0];
    expect(canvasInferenceDuration(presetChild.data.params)).toMatchObject({ durationPreset: '4-30', customDuration: { min: 7, max: 19 }, durationRange: { min: 4, max: 30 } });
  });
});
