import { beforeEach, describe, expect, it } from 'vitest';
import type { CatalogTemplate } from '@/contract';
import type { CanvasNode } from '@/types';
import { useCanvasStore } from '@/store/canvasStore';
import { useCatalogStore } from '@/store/catalogStore';
import { canvasInference, inferenceTemplates, normalInferenceStrategy, resolveSplitTemplate, resolveStrategyTemplate, splitInferenceStrategy, splitTemplates } from './inferenceStrategy';
import { buildRespawn, buildSpawn, IncrementalSpawner } from './canvasSpawn';

const templates = [
  { id: 'official-4', name: '官方4', purpose: 'storyboard.unified', isDefault: true },
  { id: 'official-6', name: '官方6', purpose: 'storyboard.unifiedShot' },
  { id: 'jianyi', name: '智能仅拆分', purpose: 'storyboard.split', aliases: ['old-split-15', 'old-split-30'], isDefault: true },
  { id: 'other-split', name: '用户拆分方案', purpose: 'storyboard.split' },
  { id: 'output-split', name: '拆分格式', purpose: 'storyboard.split', category: '输出提示词' },
] as CatalogTemplate[];
const makeNode = (params: Record<string, unknown>): CanvasNode => ({
  id: 'parent', type: 'smart.infer', x: 0, y: 0, w: 240, h: 200, parentId: null, parentScriptId: null,
  data: { input: {}, params, resultAssetId: null },
});
const config = (params: Record<string, unknown>) => {
  const n = makeNode(params);
  return canvasInference(n, { parent: n }, {}, templates);
};
const cardSpec = { childType: 'text.seed', source: 'cards' } as const;

beforeEach(() => {
  useCanvasStore.setState({ nodes: {}, edges: {} });
  useCatalogStore.setState({ catalog: { version: 'split-test', templates, models: [], nodes: [], imageTemplates: [], variantPrefixes: [], schemas: [] } as never });
});

describe('推理与仅拆分方案隔离', () => {
  it('分别显示对应用途的创作方案，格式模板不进入选择器', () => {
    expect(inferenceTemplates(templates).map(t => t.id)).toEqual(['official-4', 'official-6']);
    expect(splitTemplates(templates).map(t => t.id)).toEqual(['jianyi', 'other-split']);
    expect(resolveSplitTemplate(templates, 'old-split-30')?.id).toBe('jianyi');
    expect(resolveSplitTemplate(templates, 'official-4')).toBeUndefined();
    expect(resolveStrategyTemplate(templates, 'jianyi')?.id).toBe('official-4');
    expect(inferenceTemplates([{ ...templates[2], purpose: 'storyboard.unified' }]).length).toBe(0);
  });
  it('单双卡与仅拆分切换，各自记忆方案、剧情引导和Skills', () => {
    const ordinary = { templateId: 'official-6', source: 'skill' as const, skillText: '普通推理技巧', guidance: '细腻' };
    const split = { templateId: 'other-split', source: 'skill' as const, skillText: '仅拆分规则', guidance: '拆短' };
    const params = { inferenceStrategy: ordinary, splitInferenceStrategy: split, inferenceMode: 'unified', inferenceDurationPreset: 'custom', inferenceCustomDuration: { min: 6, max: 22 } };
    for (const scope of ['multi', 'split', 'single', 'split']) {
      const cfg = config({ ...params, inferenceScope: scope });
      expect(cfg.strategy).toEqual(scope === 'split' ? split : ordinary);
      expect(cfg.strategyKey).toBe(scope === 'split' ? 'splitInferenceStrategy' : 'inferenceStrategy');
      expect(cfg.durationRange).toEqual({ min: 6, max: 22 });
      expect(cfg.unified).toBe(true);
    }
    expect(params.inferenceStrategy).toEqual(ordinary);
    expect(params.splitInferenceStrategy).toEqual(split);
  });
  it('仅拆分尊重用户选择，不回退固定模板；普通方案不会被混进拆分请求', () => {
    expect(config({ inferenceScope: 'split', splitInferenceStrategy: { templateId: 'other-split' } }).template?.id).toBe('other-split');
    expect(config({ inferenceScope: 'split', inferenceStrategy: { templateId: 'official-6', guidance: '普通' } }).template?.id).toBe('jianyi');
    expect(config({ inferenceScope: 'split', inferenceStrategy: { templateId: 'official-6', guidance: '普通' } }).strategy.guidance).toBeUndefined();
    expect(config({ inferenceScope: 'split', splitInferenceStrategy: { templateId: 'missing' } }).template).toBeUndefined();
    expect(config({ inferenceScope: 'split', inferenceDurationPreset: 'custom', inferenceCustomDuration: { min: '', max: 15 } }).durationError).toBeTruthy();
  });
  it('旧jianyi引用迁移到拆分使用，普通推理恢复默认且保留已有引导', () => {
    const old = { templateId: 'jianyi', source: 'template' as const, guidance: '保持台词', skillText: '暂存skills' };
    expect(splitInferenceStrategy({ inferenceStrategy: old }, templates)).toEqual(old);
    expect(normalInferenceStrategy(old, templates)).toEqual({ ...old, templateId: undefined });
    expect(config({ inferenceScope: 'multi', inferenceStrategy: old }).template?.id).toBe('official-4');
    expect(config({ inferenceScope: 'split', inferenceStrategy: old }).template?.id).toBe('jianyi');
    expect(config({ inferenceScope: 'split', templateId: 'old-split-15' }).template?.id).toBe('jianyi');
    const skill = { ...old, source: 'skill' as const };
    expect(normalInferenceStrategy(skill, templates)).toEqual(skill);
  });
});

describe.each(['storyboard', 'unified'])('仅拆分空结果的%s流水线', mode => {
  const raw = JSON.stringify([{ card_number: 1, duration: 12, original_script: '人物进屋', ...(mode === 'unified' ? { unified_prompt: '' } : { storyboard_prompts: '', video_prompts: '' }) }]);
  const parent = () => makeNode({ inferenceScope: 'split', inferenceMode: mode, inferenceDurationPreset: '4-30', inferenceStrategy: { templateId: 'official-6', guidance: '普通指导' }, splitInferenceStrategy: { source: 'skill', skillText: '拆分规则', guidance: '拆分指导' } });
  const shape = mode === 'unified' ? ['smart.infer', 'text.seed', 'image.gen', 'video.gen'] : ['smart.infer', 'image.gen', 'video.gen'];
  it('完整结果和流式终态均建立明确选择的空节点结构', () => {
    for (const built of [buildSpawn(parent(), { spawn: cardSpec }, raw), new IncrementalSpawner(parent(), cardSpec).feed(raw, true)]) {
      expect(built.nodes.map(n => n.type)).toEqual(shape);
      const row = built.nodes[0];
      expect(row.data.params.inferenceStrategy).toEqual({ templateId: 'official-6', guidance: '普通指导' });
      expect(row.data.params.splitInferenceStrategy).toBeUndefined();
      expect(row.data.params.inferenceScope).toBe('single');
      expect(row.data.params.inferenceMode).toBe(mode);
      expect(row.data.params.inferenceDurationPreset).toBe('4-30');
      for (const n of built.nodes.slice(1)) expect(n.data.params.prompt).toBe('');
      const img = built.nodes.find(n => n.type === 'image.gen')!;
      const vid = built.nodes.find(n => n.type === 'video.gen')!;
      expect(built.edges.find(e => e.target === vid.id)?.source).toBe(mode === 'unified' ? built.nodes[1].id : img.id);
      expect(vid.data.params.duration).toBe(12);
    }
  });
  it('已存在原文行的二次解析补齐空媒体节点，重复解析不再新增', () => {
    const p = parent();
    const original = buildSpawn(p, { spawn: cardSpec }, raw);
    const row = original.nodes[0];
    const firstEdge = original.edges.find(e => e.target === row.id)!;
    const initialNodes = { [p.id]: p, [row.id]: row };
    const initialEdges = { [firstEdge.id]: firstEdge };
    const missing = buildRespawn(p, cardSpec, raw, initialNodes, initialEdges);
    expect(missing.nodes.map(n => n.type)).toEqual(shape.slice(1));
    const afterNodes = { ...initialNodes, ...Object.fromEntries(missing.nodes.map(n => [n.id, n])) };
    const afterEdges = { ...initialEdges, ...Object.fromEntries(missing.edges.map(e => [e.id, e])) };
    expect(buildRespawn(p, cardSpec, raw, afterNodes, afterEdges).nodes).toEqual([]);
  });
  it('旧jianyi普通配置不会传给派生单卡节点', () => {
    const p = makeNode({ inferenceScope: 'split', inferenceMode: mode, inferenceStrategy: { templateId: 'old-split-15', guidance: '原有引导' } });
    const row = buildSpawn(p, { spawn: cardSpec }, raw).nodes[0];
    expect(row.data.params.templateId).toBeUndefined();
    expect(config(row.data.params).template?.id).toBe('official-4');
  });
});
