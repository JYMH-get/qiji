import type { ModelDef } from './models.ts';

/** 用户选定的通用入口；真实型号和每档价格由重定向维护，不自动导入授权目录。 */
export const XINGGUANG_GENERIC = {
  label: '星光·Seedance 2.0',
  upstreamModel: 'seedance2.0-933',
  params: [
    { key: 'duration', label: '时长', type: 'enum', options: ['10', '11', '12', '13', '14', '15'], default: '10', unit: 's' },
    { key: 'aspect_ratio', label: '宽高比', type: 'enum', options: ['16:9', '9:16'], default: '16:9' },
    { key: 'resolution', label: '分辨率', type: 'enum', options: ['720p'], default: '720p' },
  ],
  cost: 150, costField: 'duration', costPerUnit: 10,
  routes: [{ when: { resolution: '720p' }, upstreamModel: 'seedance2.0-933', costPerUnit: 10, cost: 150 }],
} satisfies Partial<ModelDef>;

export const XINGGUANG_RETIRED_IDS = Array.from({ length: 20 }, (_, i) => `xg-${String(i + 1).padStart(2, '0')}`).filter(id => id !== 'xg-13');

/** 一次性收敛旧自动导入项；保留 xg-13 身份、线路引用、管理员价格和重定向。 */
export function compactXingguangModels(store: { models: ModelDef[]; deletedSeedIds?: string[]; xingguangGenericVersion?: number }): boolean {
  if (store.xingguangGenericVersion) return false;
  const retired = new Set(XINGGUANG_RETIRED_IDS);
  store.models = store.models.filter(m => !(m.channelId === 'ch-xingguang' && retired.has(m.id)));
  store.deletedSeedIds = [...new Set([...(store.deletedSeedIds ?? []), ...XINGGUANG_RETIRED_IDS])];
  const m = store.models.find(m => m.id === 'xg-13' && m.channelId === 'ch-xingguang');
  if (m) {
    if (m.label === '星光·seedance-933') m.label = XINGGUANG_GENERIC.label;
    if (m.upstreamModel === 'seedance-933') m.upstreamModel = XINGGUANG_GENERIC.upstreamModel;
    const duration = m.params.find(p => p.key === 'duration');
    if (duration?.type === 'number' && duration.min === 1 && duration.max === undefined && duration.default === 5) {
      Object.assign(duration, structuredClone(XINGGUANG_GENERIC.params[0]));
      delete duration.min; delete duration.max; delete duration.step;
    } else if (duration?.type === 'enum' && duration.options?.join(',') === '10,11,12,13,14,15' && String(duration.default) === '5') {
      duration.default = '10';
    }
    if (!m.params.some(p => p.key === 'resolution')) m.params.push(structuredClone(XINGGUANG_GENERIC.params[2]));
    if (m.cost === 1 && !m.costField && m.costPerUnit === undefined) {
      m.cost = 150; m.costField = 'duration'; m.costPerUnit = 10;
    }
    if (!m.routes?.length) {
      m.routes = [{ when: { resolution: '720p' }, upstreamModel: m.upstreamModel || XINGGUANG_GENERIC.upstreamModel, cost: m.cost, ...(m.costPerUnit !== undefined ? { costPerUnit: m.costPerUnit } : {}) }];
    }
  }
  store.xingguangGenericVersion = 1;
  return true;
}
