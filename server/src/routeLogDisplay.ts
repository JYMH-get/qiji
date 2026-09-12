import { routingConfig, routeFamilyName } from './autoRouting.ts';
import { IMAGE_ROUTE_FAMILIES } from './imageRouting.ts';
import { routeObservationIdentity } from './routeObservations.ts';
import { getModelDef } from './store/models.ts';
import { getLog, type LogMeta } from './store/logs.ts';

/** Display only: preserve canonical model IDs for billing, filtering and request replay. */
export function routeLogLabel(log: Pick<LogMeta, 'id' | 'model'>, audience: 'admin' | 'user'): string | undefined {
  if (!log.model?.startsWith('route:')) return undefined;
  const lineId = log.model.slice(6), identity = routeObservationIdentity(log.id);
  const line = routingConfig().lines.find(l => l.id === lineId);
  const fallback = lineId.startsWith('seedance25-') ? 'Seedance 2.5' : lineId.startsWith('seedance-') ? 'Seedance 2.0'
    : IMAGE_ROUTE_FAMILIES.find(f => lineId.replace(/-(budget|promo|stable)$/, '') === 'image-'+f.id.replace(/^fam-/, ''))?.name;
  const family = identity?.familyName ?? (line ? routeFamilyName(line) : fallback) ?? '模型家族未记录';
  if (audience === 'user') {
    const suffix = lineId.split('-').at(-1) ?? '';
    const lineName = identity?.lineName ?? line?.name ?? ({budget:'低价',promo:'优惠',stable:'稳定',official:'官方'} as Record<string,string>)[suffix] ?? '线路未记录';
    return `${family} · ${lineName}`;
  }
  const modelId = identity?.modelId ?? getLog(log.id)?.routing?.modelId;
  const modelName = identity?.modelName ?? (modelId ? getModelDef(modelId)?.label ?? modelId : undefined);
  return `${family} · ${modelName ?? '未分配模型'}`;
}
