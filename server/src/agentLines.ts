import { createHash } from 'node:crypto';
import { routingConfig, lineModel, publicId, routeCapability, routeFamilyName, routingVersion, type AutoLine } from './autoRouting.ts';
import { getAgent, agentModelLabel, setAgentModelLabel, audienceGroupId, getAgentGroup } from './store/agents.ts';
import { groupLineSetting, groupPriceVersion } from './store/agentGroupPrices.ts';
import { getModelDef, modelVisibleToAgent, modelAllowedForAgent, type ModelDef } from './store/models.ts';
import { agentLineSetting, linePriceOf, pricedAgentLine, saveAgentLineSetting, type PriceLayer } from './store/agentLinePrices.ts';
import { priceEditorFields } from './agentPriceEditor.ts';
import { publicLineAvailability } from './lineAvailability.ts';
import type { Catalog } from './contract.ts';

function visibleLine(line: AutoLine, agentId: string): boolean {
  return line.members.some(r => { const m = getModelDef(r.modelId); return m && modelVisibleToAgent(m, agentId); });
}
function businessModel(line: AutoLine, agentId: string): ModelDef {
  const filtered = { ...line, members: line.members.filter(r => { const m = getModelDef(r.modelId); return m && modelVisibleToAgent(m, agentId); }) };
  return lineModel(filtered) ?? { id: publicId(line.id), label: line.name, familyId: line.familyId, modeId: publicId(line.id), capability: routeCapability(line),
    protocol: 'stub', enabled: line.enabled, params: [], cost: line.cost, costField: line.costPerUnit === undefined ? undefined : 'duration', costPerUnit: line.costPerUnit,
    tokenPricing: line.tokenPricing, routes: line.prices?.map(r => ({ ...r, upstreamModel: '' })), createdAt: '', updatedAt: '' };
}
function rowConfig(line: AutoLine, agentId: string, layer: PriceLayer) {
  const agent = getAgent(agentId)!, id = publicId(line.id), setting = agentLineSetting(agentId, id), base = businessModel(line, agentId);
  const purchase = pricedAgentLine(base, agentId, 'purchase'), retail = pricedAgentLine(base, agentId, 'retail');
  const visible = visibleLine(line, agentId);
  const sourceEnabled = setting.purchase?.enabled ?? agent.features?.modes?.[id] !== false;
  const retailEnabled = setting.retail?.enabled !== false;
  const usable = line.enabled && visible && line.members.some(r => { const m = getModelDef(r.modelId); return m && modelAllowedForAgent(m, agentId); });
  const revision = createHash('sha256').update(JSON.stringify([routingVersion(), groupPriceVersion(agentId),base, setting, agent.features?.modes, agent.blockedModels, agent.modelLabels?.[id]])).digest('hex');
  return { base, current: layer === 'purchase' ? purchase : retail, setting, row: {
    id, name: line.name, displayName: agentModelLabel(agentId, id), familyId: line.familyId, familyName: routeFamilyName(line), capability: routeCapability(line),
    enabled: layer === 'purchase' ? sourceEnabled : retailEnabled, sourceEnabled, retailEnabled, effectiveEnabled: usable && sourceEnabled && retailEnabled,
    canEnable: layer === 'purchase' ? visible && line.enabled : usable && sourceEnabled,
    unavailableReason: !visible ? '尚未向该渠道商开放' : !line.enabled ? '线路全局已停用' : !usable ? '暂无可用模型' : !sourceEnabled ? '源站已禁用' : '',
    revision, customPrice: Object.values(groupLineSetting(audienceGroupId(agentId),id)[layer]??{}).some(Boolean),
    priceReadonly:true,groupName:getAgentGroup(audienceGroupId(agentId))?.name,
    fields: priceEditorFields(layer === 'purchase' ? purchase : retail),
    referenceFields: priceEditorFields(layer === 'purchase' ? retail : purchase),
  } };
}
export function agentLinesView(agentId: string, layer: PriceLayer) {
  if (!getAgent(agentId)) throw Object.assign(new Error('渠道商不存在'), { statusCode: 404 });
  const lines = routingConfig().lines.filter(l => layer === 'purchase' || visibleLine(l, agentId));
  const configs = lines.map(l => rowConfig(l, agentId, layer));
  const catalog = { models: configs.map(c => ({ ...c.base, ...linePriceOf(c.base) })), modes: lines.map(l => ({ id: publicId(l.id), name: l.name })),
    families: lines.map(l => ({ id: l.familyId, name: routeFamilyName(l) })) } as unknown as Catalog;
  const stats = publicLineAvailability(catalog), byId = new Map(stats.rows.map(r => [r.id, r]));
  return { until: stats.until, since: stats.since, layer, rows: configs.map(c => {
    const stat = byId.get(c.row.id);
    return { ...c.row, success: stat?.success ?? 0, failed: stat?.failed ?? 0, running: stat?.running ?? 0, successRate: stat?.successRate ?? null, history: stat?.history ?? [] };
  }) };
}
export function saveAgentBusinessLine(agentId: string, lineId: string, layer: PriceLayer, input: unknown) {
  if (!getAgent(agentId)) throw Object.assign(new Error('渠道商不存在'), { statusCode: 404 });
  const line = routingConfig().lines.find(l => publicId(l.id) === lineId);
  if (!line || (layer === 'retail' && !visibleLine(line, agentId))) throw Object.assign(new Error('线路不存在'), { statusCode: 404 });
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('保存内容无效');
  const body = input as { revision?: string; fields?: unknown; enabled?: boolean; reset?: boolean; label?: string };
  if('fields' in body||'reset' in body)throw Object.assign(new Error('价格由源站统一管理，请在渠道商分组设置中修改'),{statusCode:403});
  if (Object.keys(body).some(k => !['revision', 'fields', 'enabled', 'reset', 'label'].includes(k))) throw new Error('不支持的修改字段');
  const current = rowConfig(line, agentId, layer);
  if (body.revision !== current.row.revision) throw Object.assign(new Error('线路或价格已变化，请刷新后重新保存'), { statusCode: 409 });
  if ('label' in body) {
    if (layer !== 'retail' || typeof body.label !== 'string' || body.label.length > 40 || Object.keys(body).some(k => !['revision','label'].includes(k))) throw new Error('显示名修改无效');
    const result = setAgentModelLabel(agentId, lineId, body.label.trim() || null);
    if (!result.ok) throw new Error(result.error);
    return { ok: true, row: rowConfig(line, agentId, layer).row };
  }
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') throw new Error('启用状态无效');
  if (body.enabled && !current.row.canEnable) throw new Error(current.row.unavailableReason || '当前线路不可启用');
  saveAgentLineSetting(agentId, lineId, layer, current.setting.revision, { enabled: body.enabled });
  return { ok: true, row: rowConfig(line, agentId, layer).row };
}
