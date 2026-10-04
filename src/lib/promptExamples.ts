import type { Catalog } from '@/contract';
export const PROMPT_EXAMPLE_CATEGORIES = ['拆分提示词', '推理提示词', '画风提示词', '输出提示词', '图片预设', '视频预设', '其他提示词'];
export function promptExamples(catalog: Catalog) {
  const presetIds = new Set(catalog.presets?.map(p => p.id));
  const templates = catalog.templates.filter(t => !presetIds.has(t.id)).map(t => ({
    id: 'template:' + t.id, name: t.name, note: t.publicNote?.trim() || '',
    category: t.category === '输出提示词' || t.id.startsWith('output.') ? '输出提示词'
      : t.purpose === 'storyboard.split' || t.purpose === 'script.analyze' && t.category !== '内部' ? '拆分提示词'
      : ['storyboard.toVideoPrompt', 'storyboard.singleShot', 'storyboard.unified', 'storyboard.unifiedShot'].includes(t.purpose ?? '') ? '推理提示词'
      : ['画风', '画风提示词'].includes(t.category ?? '') ? '画风提示词' : '其他提示词',
  }));
  return [...templates, ...(catalog.presets ?? []).map(p => ({
    id: 'preset:' + p.id, name: p.name, note: p.publicNote?.trim() || '',
    category: p.category === '画风' ? '画风提示词' : p.category === '视频预设方案' ? '视频预设' : '图片预设',
  }))];
}
