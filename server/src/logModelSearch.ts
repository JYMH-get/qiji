import { db } from './store/sqlite.ts';
import { modelCategory } from './modelCategory.ts';
import { listModels } from './store/models.ts';
import { listFamilies } from './store/families.ts';
import { routingConfig, routeFamilyName } from './autoRouting.ts';
import type { LogMeta } from './store/logs.ts';
import { logPurposeCapability, matchesLogFamily, matchesLogModel, type LogModelIdentity } from './logModelSearchCore.ts';

/** 每次筛选仅取轻量观测身份，不读取请求/响应重报文。 */
export function createLogModelSearch() {
  const models = new Map(listModels().map(m => [m.id, m]));
  const families = new Map(listFamilies().map(f => [f.id, f.name]));
  const lines = new Map(routingConfig().lines.map(l => [l.id, l]));
  const observations = new Map((db.prepare("SELECT id, json_extract(data,'$.modelId') modelId, json_extract(data,'$.modelName') modelName, json_extract(data,'$.familyName') familyName FROM route_observations").all() as unknown as (LogModelIdentity & { id: string })[]).map(o => [o.id, o]));
  const identity = (log: Pick<LogMeta, 'id' | 'model' | 'purpose'>): LogModelIdentity => {
    const routed = log.model?.startsWith('route:');
    const observed = routed ? observations.get(log.id) : undefined;
    const modelId = routed ? observed?.modelId : log.model;
    const model = modelId ? models.get(modelId) : undefined;
    const line = routed ? lines.get(log.model!.slice(6)) : undefined;
    const familyId = line?.familyId ?? model?.familyId;
    return { modelId, modelName: observed?.modelName ?? model?.label, capability: model?.capability ?? line?.capability ?? logPurposeCapability(log.purpose),
      familyId, familyName: observed?.familyName ?? (line ? routeFamilyName(line) : familyId ? families.get(familyId) : undefined) };
  };
  return { identity, filter: (model = '', family = '', capability = '') => (log: LogMeta) => {
    const value = identity(log);
    return matchesLogModel(value, model) && matchesLogFamily(value, family) && (!capability || value.capability === capability || (capability === 'other' && !!value.capability && modelCategory(value.capability) === 'other'));
  } };
}
