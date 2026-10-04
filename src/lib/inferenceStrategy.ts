import { getDualModeFeature } from '@/store/connectionStore';
import type { CatalogTemplate, Purpose } from '@/contract';
import type { CanvasNode, CanvasEdge } from '@/types';
import { smartInferContext } from './inferUpstream';
import { parseInferCards } from './smartInferPrompts';

export interface InferenceStrategy {
  templateId?: string;
  source?: 'template' | 'skill';
  skillText?: string;
  skillName?: string;
  guidance?: string;
}
export const INFER_PURPOSES: Purpose[] = ['storyboard.toVideoPrompt', 'storyboard.singleShot', 'storyboard.unified', 'storyboard.unifiedShot'];
export function strategyName(name: string): string { return name.trim(); }
export function inferenceTemplates(all: CatalogTemplate[] = []): CatalogTemplate[] {
  return all.filter(t => t.id !== 'jianyi' && t.purpose && INFER_PURPOSES.includes(t.purpose) && t.category !== '输出提示词' && t.category !== '内部');
}
export function splitTemplates(all: CatalogTemplate[] = []): CatalogTemplate[] {
  return all.filter(t => t.purpose === 'storyboard.split' && t.category !== '输出提示词' && t.category !== '内部');
}
export function resolveSplitTemplate(all: CatalogTemplate[], id?: string): CatalogTemplate | undefined {
  const opts = splitTemplates(all);
  if (id) return opts.find(t => t.id === id) ?? opts.find(t => t.aliases?.includes(id));
  return opts.find(t => t.isDefault) ?? opts[0];
}
export function isSplitTemplateReference(all: CatalogTemplate[], id?: string): boolean {
  return !!id && (id === 'jianyi' || !!resolveSplitTemplate(all, id));
}
export function resolveStrategyTemplate(all: CatalogTemplate[], id?: string): CatalogTemplate | undefined {
  const opts = inferenceTemplates(all);
  if (id && !isSplitTemplateReference(all, id)) return opts.find(t => t.id === id) ?? opts.find(t => t.aliases?.includes(id));
  return opts.find(t => t.isDefault) ?? opts[0];
}
export function normalInferenceStrategy(strategy: InferenceStrategy | undefined, all: CatalogTemplate[] = []): InferenceStrategy {
  if (strategy?.source !== 'skill' && isSplitTemplateReference(all, strategy?.templateId)) return { ...strategy, templateId: undefined };
  return strategy ?? {};
}
export function splitInferenceStrategy(settings: {
  splitInferenceStrategy?: InferenceStrategy;
  inferenceStrategy?: InferenceStrategy;
  splitTplId?: string;
  templateId?: string;
}, all: CatalogTemplate[] = []): InferenceStrategy {
  if (settings.splitInferenceStrategy) return settings.splitInferenceStrategy;
  if (settings.splitTplId) return { templateId: settings.splitTplId };
  const old = settings.inferenceStrategy ?? { templateId: settings.templateId };
  return old.source !== 'skill' && isSplitTemplateReference(all, old.templateId) ? old : {};
}
export function inferencePurpose(single: boolean, unified: boolean): Purpose {
  return single ? unified ? 'storyboard.unifiedShot' : 'storyboard.singleShot' : unified ? 'storyboard.unified' : 'storyboard.toVideoPrompt';
}
export function inferenceDurationLimit(value: unknown): 15 | 30 {
  const duration = Number(value);
  return Number.isFinite(duration) && duration > 15 ? 30 : 15;
}
export type InferenceDurationPreset = '4-15' | '4-30' | 'custom';
export interface InferenceDurationRange { min: number; max: number }
export interface InferenceCustomDuration { min: unknown; max: unknown }

/** 校验自定义范围；空草稿和非法数值留给用户修正，不变成默认范围。 */
export function inferenceDurationRangeError(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '请输入有效时长';
  const { min, max } = value as InferenceCustomDuration;
  if (typeof min !== 'number' || typeof max !== 'number' || !Number.isFinite(min) || !Number.isFinite(max)) return '请输入有效时长';
  if (min <= 0 || max <= 0) return '时长须大于0';
  if (min > max) return '最小时长不能大于最大时长';
  return undefined;
}

export function canvasInferenceDuration(params: Record<string, unknown>): {
  durationPreset: InferenceDurationPreset;
  customDuration: InferenceCustomDuration;
  durationRange: InferenceDurationRange | undefined;
  durationError: string | undefined;
  durationLimit: 15 | 30;
} {
  const legacyLimit = inferenceDurationLimit(params.inferenceDurationLimit);
  const preset = params.inferenceDurationPreset;
  const knownPreset = preset === '4-15' || preset === '4-30' || preset === 'custom';
  const durationPreset = knownPreset ? preset : legacyLimit === 30 ? '4-30' : '4-15';
  const rawCustom = params.inferenceCustomDuration;
  const customDuration: InferenceCustomDuration = rawCustom === undefined ? { min: 4, max: 15 }
    : rawCustom && typeof rawCustom === 'object' && !Array.isArray(rawCustom)
      ? { min: (rawCustom as InferenceCustomDuration).min, max: (rawCustom as InferenceCustomDuration).max }
      : { min: undefined, max: undefined };
  const selectedRange = durationPreset === 'custom' ? customDuration : { min: 4, max: durationPreset === '4-30' ? 30 : 15 };
  const durationError = preset !== undefined && !knownPreset ? '请选择时长范围' : inferenceDurationRangeError(selectedRange);
  const durationRange = durationError ? undefined : selectedRange as InferenceDurationRange;
  return { durationPreset, customDuration, durationRange, durationError, durationLimit: inferenceDurationLimit(durationRange?.max ?? legacyLimit) };
}
export function projectInferenceStrategy(settings: {
  inferenceStrategy?: InferenceStrategy;
  inferTplId?: string;
  unifiedTplId?: string;
  singleTplId?: string;
  unifiedSingleTplId?: string;
}): InferenceStrategy {
  return settings.inferenceStrategy ?? {
    templateId: settings.inferTplId || settings.unifiedTplId || settings.singleTplId || settings.unifiedSingleTplId,
  };
}

export function canvasInference(node: CanvasNode, nodes: Record<string, CanvasNode>, edges: Record<string, CanvasEdge>, all: CatalogTemplate[]) {
  const params = node.data.params;
  const storedStrategy = (params.inferenceStrategy as InferenceStrategy | undefined) ?? { templateId: params.templateId as string | undefined };
  // 兼容节点中已保存的输出设置；创作方案的 id/purpose 不参与输出选择。
  const legacyOutput = String(params.inferenceOutput ?? params.purpose ?? '');
  const requestedScope = params.inferenceScope === 'single' || params.inferenceScope === 'multi' || params.inferenceScope === 'split'
    ? params.inferenceScope
    : legacyOutput === 'storyboard.split' ? 'split'
      : ['storyboard.toVideoPrompt', 'storyboard.unified'].includes(legacyOutput) ? 'multi' : 'single';
  const ctx = smartInferContext(node.id, nodes, edges);
  const single = ctx.scope === 'single' || ctx.scope === 'both' && requestedScope === 'single';
  const unified = !getDualModeFeature() || params.inferenceMode === 'unified' || params.inferenceMode !== 'storyboard'
    && ['storyboard.unified', 'storyboard.unifiedShot'].includes(legacyOutput);
  const purpose = requestedScope === 'split' && ctx.scope !== 'single' ? 'storyboard.split' : inferencePurpose(single, unified);
  const requestScope = purpose === 'storyboard.split' ? 'split' : single ? 'single' : 'multi';
  const strategyKey = requestScope === 'split' ? 'splitInferenceStrategy' : 'inferenceStrategy';
  const strategy = requestScope === 'split'
    ? splitInferenceStrategy({ splitInferenceStrategy: params.splitInferenceStrategy as InferenceStrategy | undefined, inferenceStrategy: storedStrategy }, all)
    : normalInferenceStrategy(storedStrategy, all);
  return {
    strategy, strategyKey, template: requestScope === 'split' ? resolveSplitTemplate(all, strategy.templateId) : resolveStrategyTemplate(all, strategy.templateId), purpose, single, unified,
    scope: ctx.scope, requestScope, ...canvasInferenceDuration(params),
  };
}

/** 同一上游裂变出的分镜按数字标题排序，使用当前邻镜结果，缺失时回退原文。 */
export function canvasNeighborVars(node: CanvasNode, nodes: Record<string, CanvasNode>, edges: Record<string, CanvasEdge>, unified: boolean): Record<string, string> {
  const parents = new Set(Object.values(edges).filter(e => e.target === node.id).map(e => e.source));
  const siblings = new Set(Object.values(edges).filter(e => parents.has(e.source)).map(e => e.target));
  const ordered = [...siblings].map(id => nodes[id]).filter(n => n?.type === 'smart.infer' && /^分镜[\d-]+原文$/.test(n.data.title ?? ''))
    .sort((a, b) => (a.data.title ?? '').localeCompare(b.data.title ?? '', 'zh', { numeric: true }));
  const i = ordered.findIndex(n => n.id === node.id);
  const text = (n?: CanvasNode) => {
    if (!n) return '';
    const card = parseInferCards(n.data.resultText ?? '')[0];
    const generated = unified ? card?.unifiedPrompt : [card?.storyboardPrompt, card?.videoPrompt].filter(Boolean).join('\n');
    if (generated) return generated;
    const childIds = Object.values(edges).filter(e => e.source === n.id).map(e => e.target);
    const children = childIds.map(id => nodes[id]).filter(Boolean);
    if (unified) {
      const shared = children.find(c => c.type === 'text.seed');
      if (shared) return String(shared.data.params.prompt || shared.data.resultText || '');
    } else {
      const next = Object.values(edges).filter(e => childIds.includes(e.source)).map(e => nodes[e.target]).filter(Boolean);
      const prompts = [...children, ...next].filter(c => c.type === 'image.gen' || c.type === 'video.gen').map(c => c.data.params.prompt).filter(Boolean);
      if (prompts.length) return prompts.join('\n');
    }
    return n.data.resultText || String(n.data.params.prompt ?? '');
  };
  return { 上上一分镜: i < 0 ? '' : text(ordered[i - 2]), 上一分镜: i < 0 ? '' : text(ordered[i - 1]), 下一分镜: i < 0 ? '' : text(ordered[i + 1]) };
}
