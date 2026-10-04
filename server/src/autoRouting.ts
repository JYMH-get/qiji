import { materialPolicyForModel, compatibleMaterialPolicies, validateModelMaterialPolicy } from './materialPolicy.ts';
import { isModelCapability } from './modelCategory.ts';
import { accepts, VIDEO_PUBLIC_KEYS, videoRouteParams, videoModelSupportsParams, videoMemberAccepts, videoMinVisualMaterials } from './videoRouting.ts';
export { accepts } from './videoRouting.ts';
import { RouteConcurrency, migrateRouteConcurrency } from './routeConcurrency.ts';
import { routeActiveCounts } from './routeObservations.ts';
import { IMAGE_DERIVED_KEYS, IMAGE_ROUTE_FAMILIES, IMAGE_PUBLIC_KEYS, imageFamilyOf, imageRouteParams, imageMemberAccepts, imageUpstreamParams, imageRoutingParams } from './imageRouting.ts';
export { isChannelFailure } from './routeObservations.ts';
/** Public Seedance lines. Provider selection never changes the public billing contract. */
import type { GenerateRequest, ParamField, Capability } from './contract.ts';
import { SEEDANCE_FAMILY_ID, SEEDANCE_ROUTE_FAMILIES, seedanceModelFamily } from './contract.ts';
import { loadJson, saveJson, scheduleSave, DATA_DIR } from './store/db.ts';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { getModelDef, listModels, modelAllowedForAgent, resolveModelCost, matchRoute, type ModelDef } from './store/models.ts';
import { getChannel } from './store/channels.ts';
import { listModes } from './store/modes.ts';
import { getFamily, listFamilies } from './store/families.ts';
import { checkMaterialLimits } from './materialLimits.ts';
import { validateTextPricing } from './textPricing.ts';
import { notifyAvailabilityConfigChange } from './availabilityConfigEvents.ts';

export interface RouteMember {
  modelId: string; enabled: boolean; priority: number; concurrencyWeight: number;
  /** Reserved VIP audience preference; not enforced until VIP routing is introduced. */
  vipEnabled?: boolean;
  failureThreshold: number; failureWindowSec: number; cooldownSec: number;
  defaults: Record<string, unknown>; failureRetainPercent: number;
}
export interface AutoLine {
  id: string; name: string; familyId: string; modelVersion: string; enabled: boolean;
  capability?: Capability; familyName?: string;
  tokenPricing?: ModelDef['tokenPricing'];
  refVideoSecondsWeight?: number;
  cost: number; costPerUnit?: number; members: RouteMember[];
  prices?: { when: Record<string, string>; cost: number }[];
}
interface RoutingConfig { routeOnlyVersion?: number; version: number; enabled: boolean; lines: AutoLine[]; deletedFamilyIds?: string[]; initializedFamilyIds?: string[]; defaultLineFamilyIds?: string[]; boundFamilyIds?: string[] }
export interface RouteTicket { observationId?: string; lineId: string; modelId: string; channelId: string; publicModel: string; failureThreshold: number; failureWindowSec: number; cooldownSec: number; failureRetainPercent?: number }
interface Health { failures: number[]; cooldownUntil: number; penaltyUntil?: number; penaltyPercent?: number; selected: number; succeeded: number; failed: number }
const FILE = 'auto-routing.json';
let state: RoutingConfig = existsSync(join(DATA_DIR, FILE)) ? JSON.parse(readFileSync(join(DATA_DIR, FILE), 'utf8')) : { version: 0, enabled: true, lines: [] };
if (!state || typeof state.enabled !== 'boolean' || !Array.isArray(state.lines) || !Number.isInteger(state.version)) throw new Error('自动路由配置损坏，请从备份恢复');
const health = loadJson<Record<string, Health>>('auto-routing-health.json', {});
migrateRouteConcurrency(state.lines);
for (const line of state.lines) for (const member of line.members) member.vipEnabled ??= false;
const concurrency = new RouteConcurrency();
const coreKeys = VIDEO_PUBLIC_KEYS;
export const publicId = (id: string) => `route:${id}`;
export const routingConfig = (): RoutingConfig => structuredClone(state);
export const routingVersion = () => `${state.version}.${state.lines.flatMap(l => l.members.map(r => getChannel(getModelDef(r.modelId)?.channelId ?? '')?.enabled ? '1' : '0')).join('')}`;
export const routingEnabled = () => state.enabled;
export const routingHealth = () => structuredClone(health);
export const routingChannelName = (id: string) => ({ 'ch-007': '007', 'ch-overseas': '高速二', 'ch-jianmeng': '稳定', 'ch-official': '官方' })[id] ?? getChannel(id)?.name ?? id;
function concurrencyPenalty(lineId: string, channelId: string, now: number) {
  const h = health[`${lineId}/${channelId}`];
  const until = h?.penaltyUntil ?? h?.cooldownUntil ?? 0;
  return { until: until > now ? until : 0, percent: until > now ? h?.penaltyPercent ?? 0 : 100 };
}
export function routingAvailability(now = Date.now()) {
  return state.lines.flatMap(line => {
    const counts = routeActiveCounts(line.id);
    return line.members.map(r => {
      const model = getModelDef(r.modelId), channelId = model?.channelId ?? '';
      const penalty = concurrencyPenalty(line.id, channelId, now);
      const enabled = state.enabled && line.enabled && r.enabled && r.concurrencyWeight > 0 && !!model && getChannel(channelId)?.enabled;
      const effectiveWeight = enabled ? r.concurrencyWeight * penalty.percent / 100 : 0;
      const active = counts[channelId] ?? 0;
      return { lineId: line.id, lineName: line.name, familyId: line.familyId, familyName: routeFamilyName(line), modelVersion: line.modelVersion, modelId: r.modelId,
        channelId, channelName: routingChannelName(channelId), priority: r.priority, concurrencyWeight: r.concurrencyWeight,
        effectiveWeight, active, normalizedLoad: effectiveWeight ? active / effectiveWeight : null, penaltyUntil: penalty.until,
        status: !enabled ? 'disabled' : !effectiveWeight ? 'cooling' : penalty.percent < 100 ? 'reduced' : 'ready' };
    });
  });
}
export const SEEDANCE_25_FAMILY = 'fam-seedance-2-5';
export const seedanceFamilyOf = (m: ModelDef) => m.capability === 'image' ? imageFamilyOf(m) : m.capability === 'video' ? seedanceModelFamily(m.id) ?? m.familyId : m.familyId || ('fam-'+m.capability+'-'+createHash('sha256').update(m.id).digest('hex').slice(0,16));
export const routeCapability = (l: AutoLine) => l.capability ?? 'video';
export const routeFamilyName = (l: AutoLine) => l.familyName ?? (routeCapability(l) === 'image' ? IMAGE_ROUTE_FAMILIES.find(f => f.id === l.familyId)?.name : SEEDANCE_ROUTE_FAMILIES.find(f => f.id === l.familyId)?.name) ?? getFamily(l.familyId)?.name ?? l.familyId;
export function routingFamilyOptions(config: RoutingConfig) {
  const options = new Map(config.lines.map(l => [l.familyId,{id:l.familyId,name:routeFamilyName(l),capability:routeCapability(l),modelVersion:l.modelVersion}]));
  for (const f of listFamilies()) {
    if (config.deletedFamilyIds?.includes(f.id)) continue;
    const capability = f.capability ?? listModels().find(m => seedanceFamilyOf(m) === f.id && isModelCapability(m.capability))?.capability;
    if (!options.has(f.id) && isModelCapability(capability)) options.set(f.id,{id:f.id,name:f.name,capability,modelVersion:SEEDANCE_ROUTE_FAMILIES.find(s => s.id === f.id)?.version ?? f.id});
  }
  for (const m of listModels().filter(m => !m.hidden && !['image','video'].includes(m.capability) && isModelCapability(m.capability))) {
    const id=seedanceFamilyOf(m)!;if(!options.has(id)&&!config.deletedFamilyIds?.includes(id))options.set(id,{id,name:getFamily(id)?.name||m.label,capability:m.capability,modelVersion:id});
  }
  return [...options.values()];
}
function validLineFamily(line: AutoLine): boolean {
  const seedance = SEEDANCE_ROUTE_FAMILIES.find(f => f.id === line.familyId);
  if (seedance) return routeCapability(line) === 'video' && line.modelVersion === seedance.version;
  if (IMAGE_ROUTE_FAMILIES.some(f => f.id === line.familyId)) return routeCapability(line) === 'image';
  if (!['image','video'].includes(routeCapability(line)) && routingFamilyOptions({version:0,enabled:false,lines:[]}).some(f=>f.id===line.familyId&&f.capability===routeCapability(line))) return line.modelVersion===line.familyId;
  const registered = getFamily(line.familyId);
  if (!registered && line.members.some(r => { const m = getModelDef(r.modelId); return m && seedanceFamilyOf(m) === line.familyId && m.capability === routeCapability(line); })) return true;
  return !!registered && (!registered.capability || registered.capability === routeCapability(line)) && line.modelVersion === line.familyId;
}
export const routingFamilies = () => [...new Set(state.lines.map(l => l.familyId))];
export const routedFamily = (m: ModelDef) => !m.hidden && !['echo','stub'].includes(m.protocol);
export function accessModes() { return state.enabled ? state.lines.map((l, i) => ({ id: publicId(l.id), name: `${routeFamilyName(l)} · ${l.name}`, enabled: l.enabled, order: i })) : listModes(); }
const lineOf = (id: string) => state.lines.find(l => publicId(l.id) === id);
const healthKey = (t: Pick<RouteTicket, 'lineId' | 'channelId'>) => `${t.lineId}/${t.channelId}`;
function healthOf(t: Pick<RouteTicket, 'lineId' | 'channelId'>): Health {
  return health[healthKey(t)] ??= { failures: [], cooldownUntil: 0, selected: 0, succeeded: 0, failed: 0 };
}
function persistHealth() { scheduleSave('auto-routing-health.json', () => JSON.stringify(health)); }
export function resetRouteHealth(lineId: string, channelId: string) {
  delete health[`${lineId}/${channelId}`]; persistHealth();
}
export function recordRouteResult(t: RouteTicket, success: boolean, now = Date.now()) {
  const h = healthOf(t);
  if (success) h.succeeded++;
  else {
    h.failed++;
    h.failures = h.failures.filter(at => at > now - t.failureWindowSec * 1000);
    h.failures.push(now);
    if (h.failures.length >= t.failureThreshold) { h.penaltyUntil = now + t.cooldownSec * 1000; h.penaltyPercent = t.failureRetainPercent ?? 50; h.cooldownUntil = 0; h.failures = []; }
  }
  persistHealth();
}

export function resolveLineMaterialModel(id: string, suppliedLine?: AutoLine): ModelDef | undefined {
  const line = suppliedLine ?? lineOf(id);
  if (!line) return;
  return line.members.filter(r => r.enabled && r.concurrencyWeight > 0).map(r => getModelDef(r.modelId)).find((m): m is ModelDef => !!m);
}
function compatibleMember(line: AutoLine, r: RouteMember): boolean {
  const first = resolveLineMaterialModel(publicId(line.id), line), model = getModelDef(r.modelId);
  return !!first && !!model && compatibleMaterialPolicies(materialPolicyForModel(first), materialPolicyForModel(model));
}
function configuredModels(line: AutoLine): ModelDef[] {
  return line.members.filter(r => r.enabled && r.concurrencyWeight > 0 && compatibleMember(line, r)).map(r => getModelDef(r.modelId)).filter((m): m is ModelDef => !!m && !!getChannel(m.channelId ?? '')?.enabled);
}
function genericRouteParams(models: ModelDef[]): ParamField[] {
  return models[0].params.filter(p=>models.every(m=>m.params.some(f=>f.key===p.key&&f.type===p.type))).map(p=>{
    const fields=models.map(m=>m.params.find(f=>f.key===p.key)!);
    if(p.type==='enum')return {...p,options:[...new Set(fields.flatMap(f=>f.options??[]))]};
    if(p.type==='number')return {...p,min:fields.every(f=>f.min!==undefined)?Math.min(...fields.map(f=>f.min!)):undefined,max:fields.every(f=>f.max!==undefined)?Math.max(...fields.map(f=>f.max!)):undefined,step:undefined};
    return {...p};
  });
}
function genericMemberAccepts(model: ModelDef, req: GenerateRequest): boolean {
  const supported=(p:ParamField,value:unknown)=>accepts(p,value)||(p.type==='number'&&p.step&&typeof p.default==='number'&&accepts({...p,step:undefined},value)&&Math.abs((Number(value)-p.default)/p.step-Math.round((Number(value)-p.default)/p.step))<1e-7);
  return model.params.every(p=>req.params?.[p.key]===undefined||supported(p,req.params[p.key]))
    && !checkMaterialLimits(model.label,model.matLimits,req.inputs);
}
function genericMaterialLimit(models: ModelDef[], key: 'img'|'vid'|'aud'): number|undefined {
  const values=models.map(m=>m.matLimits?.[key]).filter((v):v is number=>v!==undefined);
  return values.length ? Math.min(...values) : undefined;
}
/** Capability union for video, stable across temporary cooling. Images retain their own sizing policy. */
export function lineModel(line: AutoLine): ModelDef | undefined {
  const models = configuredModels(line);
  if (!models.length) return undefined;
  const image = routeCapability(line) === 'image', video = routeCapability(line) === 'video';
  const params: ParamField[] | undefined = image ? imageRouteParams(models) : video ? videoRouteParams(models) : genericRouteParams(models);
  if (!params || ((image||video) && !params.length)) return undefined;
  const methods = !video ? [] : [...new Set(models.flatMap(m => m.methods ?? ['omni' as const]))];
  if (video && !methods.length) return undefined;
  return { id: publicId(line.id), label: `${routeFamilyName(line)} · ${line.name}`, familyId: line.familyId,
    modeId: publicId(line.id), capability: routeCapability(line), protocol: 'stub', enabled: line.enabled, params, methods,
    materialPolicy: materialPolicyForModel(resolveLineMaterialModel(publicId(line.id), line) ?? models[0]),
    officialAssets: materialPolicyForModel(resolveLineMaterialModel(publicId(line.id), line) ?? models[0]).kind === 'official-assets',
    minVisualMaterials: !video ? 0 : Math.min(...models.map(videoMinVisualMaterials)),
    note: video && models.every(m => videoMinVisualMaterials(m) > 0) ? '至少提供一份图片或视频参考素材' : undefined,
    matLimits: Object.fromEntries(['img', 'vid', 'aud'].map(k => [k, !image&&!video ? genericMaterialLimit(models,k as 'img') : image ? genericMaterialLimit(models,k as 'img') : models.some(m => m.matLimits?.[k as 'img'] === undefined) ? undefined : Math.max(...models.map(m => m.matLimits![k as 'img']!))])),
    tokenPricing: line.tokenPricing,
    refVideoSecondsWeight: line.refVideoSecondsWeight,
    cost: line.cost, costField: line.costPerUnit === undefined ? undefined : 'duration', costPerUnit: line.costPerUnit,
    routes: line.prices?.map(p => ({ ...p, upstreamModel: '' })),
    createdAt: '', updatedAt: '' };
}
function availableMember(r: RouteMember, agentId?: string, _modes?: Record<string, boolean>): boolean {
  const m = getModelDef(r.modelId);
  return !!(r.enabled && r.concurrencyWeight > 0 && !!m && m.channelId && getChannel(m.channelId)?.enabled
    && modelAllowedForAgent(m, agentId));
}
export function resolveLinePreparationModel(id: string, agentId?: string, modes?: Record<string, boolean>): ModelDef | undefined {
  const line = lineOf(id);
  if (!line?.enabled || modes?.[id] === false) return;
  const member = line.members.find(r => availableMember(r, agentId, modes) && compatibleMember(line, r));
  return member ? getModelDef(member.modelId) : undefined;
}
export function publicRoutingModels(agentId?: string, modes?: Record<string, boolean>): ModelDef[] {
  if (!state.enabled) return [];
  return state.lines.filter(l => l.enabled && modes?.[publicId(l.id)] !== false && l.members.some(r => availableMember(r, agentId, modes)))
    .map(l => {
      const model = lineModel({ ...l, members: l.members.filter(r => availableMember(r, agentId, modes) && compatibleMember(l, r)) });
      const first = resolveLineMaterialModel(publicId(l.id), l);
      if (model && first) { model.materialPolicy = materialPolicyForModel(first); model.officialAssets = model.materialPolicy.kind === 'official-assets'; }
      return model;
    }).filter((m): m is ModelDef => !!m);
}
export function publicModelDef(id: string): ModelDef | undefined {
  if (id.startsWith('route:')) { const l = lineOf(id); return state.enabled && l ? lineModel(l) : undefined; }
  return getModelDef(id);
}
/** Read-only view for capability checks and pricing. Never merge this view into the submitted request. */
export function routingRequestParams(req: GenerateRequest): Record<string, unknown> {
  const model = publicModelDef(req.model);
  // Direct non-image requests keep their original missing-field/fallback billing semantics.
  if (!req.model.startsWith('route:') && model?.capability !== 'image') return { ...req.params };
  const fields = model?.capability === 'image' && !req.model.startsWith('route:') ? imageRouteParams([model]) ?? [] : model?.params ?? [];
  const defaults = Object.fromEntries(fields.filter(field => field.default !== undefined).map(field => [field.key, field.default]));
  const params: Record<string, unknown> = { ...defaults, ...req.params };
  if (fields.some(f => f.key === 'botType')) {
    if (req.params?.aspectRatio === undefined) params.aspectRatio = req.params?.aspect_ratio ?? req.params?.aspect ?? params.aspectRatio;
    return params;
  }
  if (model?.capability === 'image') Object.assign(params, imageRoutingParams(req.params ?? {}));
  if (model?.capability === 'video' && params.method === undefined) params.method = model.methods?.[0] ?? 'omni';
  return params;
}
/** Billing internals are computed by the server; preserved provider parameters cannot supply them. */
export function routingBillingParams(req: GenerateRequest): Record<string, unknown> {
  const params = routingRequestParams(req);
  delete params.__refVideoBillingSeconds;
  return params;
}
export function prepareRoutingRequest(req: GenerateRequest, agentId?: string, modes?: Record<string, boolean>): string | undefined {
  const raw = getModelDef(req.model);
  if (state.enabled && raw && routedFamily(raw)) return '该模型已改为线路选择，请刷新模型目录后选择线路';
  if (!req.model?.startsWith('route:')) {
    if (!raw || !raw.enabled) return '模型不存在或已禁用，请刷新模型目录';
    if (raw.channelId && !getChannel(raw.channelId)?.enabled) return '该模型所属渠道已停用';
    const policy = materialPolicyForModel(raw);
    if (req.materialPolicyKey && req.materialPolicyKey !== (policy.scopeKey ?? policy.kind)) return '模型素材请求方式已更新，请刷新模型目录后重试';
    const channelError = (params: Record<string, unknown> | undefined) => {
      const channelId = matchRoute(raw, params)?.channelId || raw.channelId;
      return channelId && !getChannel(channelId)?.enabled ? '该模型使用的渠道已停用' : undefined;
    };
    if (raw.capability !== 'image') return channelError(req.params as Record<string, unknown> | undefined);
    const model = imageRouteParams([raw]);
    if (!model?.length) return '该图片模型没有可用的公共比例和分辨率';
    let p: Record<string, unknown>;
    try { p = routingRequestParams(req); } catch (error) { return (error as Error).message; }
    for (const field of model) {
      if (p[field.key] === undefined) p[field.key] = field.default;
      if (!accepts(field, p[field.key])) return `图片参数不支持：${field.label}=${String(p[field.key])}`;
    }
    if (!imageMemberAccepts(raw, p)) return '该图片模型不支持所选比例和分辨率';
    if (req.inputs?.videos?.length || req.inputs?.audios?.length) return '图片模型仅支持图片参考素材';
    try { return channelError(imageUpstreamParams(raw, p)); } catch (error) { return (error as Error).message; }
  }
  if (!state.enabled) return '自动路由已关闭，请刷新模型目录后选择原渠道模型';
  const line = lineOf(req.model);
  const model = line && routeCapability(line) !== 'image'
    ? lineModel({ ...line, members: line.members.filter(r => availableMember(r, agentId, modes) && compatibleMember(line, r)) })
    : publicModelDef(req.model);
  if (!state.enabled || !line?.enabled || !model || modes?.[req.model] === false) return '所选线路未开放';
  const policy = materialPolicyForModel(resolveLineMaterialModel(req.model)!);
  if (req.materialPolicyKey && req.materialPolicyKey !== (policy.scopeKey ?? policy.kind)) return '线路素材请求方式已更新，请刷新模型目录后重试';
  if (!line.members.some(r => availableMember(r, agentId, modes))) return '所选线路未对当前账号开放';
  if (model.capability === 'video') {
    // A read-only default must not charge one duration/tier while the provider chooses another.
    const required = new Set(['duration', ...line.prices?.flatMap(price => Object.keys(price.when)) ?? []]);
    for (const key of required) {
      const value = req.params?.[key];
      if (value === undefined || value === null || typeof value === 'string' && !value.trim()) {
        return `视频线路须明确选择${model.params.find(field => field.key === key)?.label ?? key}，请补齐参数后重试`;
      }
    }
  }
  let p: Record<string, unknown>;
  try { p = routingRequestParams(req); } catch (error) { return (error as Error).message; }
  const image = model.capability === 'image', video = model.capability === 'video';
  // Extra provider parameters are preserved. Only read known fields for capability/access checks.
  if (model.capability === 'image-enhance') {
    if (p.multiple !== undefined && (typeof p.multiple !== 'number' || !Number.isFinite(p.multiple) || p.multiple < 1 || p.multiple > (p.tool_version === 'standard' ? 8 : 30))) return '图片超分倍率无效';
    for (const k of ['target_width', 'target_height']) if (p[k] !== undefined && (!Number.isInteger(p[k]) || Number(p[k]) <= 0)) return '图片目标尺寸无效';
  }
  if (model.capability === 'video-erase' && p.erase_ratio_location !== undefined) {
    const boxes = p.erase_ratio_location;
    if (!Array.isArray(boxes) || boxes.length < 1 || boxes.length > 20 || boxes.some(b => !b || ['top_left_x','top_left_y','bottom_right_x','bottom_right_y'].some(k => typeof b[k] !== 'number' || !Number.isFinite(b[k]) || b[k] < 0 || b[k] > 1) || b.top_left_x >= b.bottom_right_x || b.top_left_y >= b.bottom_right_y)) return '去字幕选区无效';
  }
  for (const field of model.params) {
    if (p[field.key] === undefined) p[field.key] = field.default;
    if (!image&&!video&&p[field.key] === undefined) continue;
    if (!accepts(field, p[field.key])) return `线路参数不支持：${field.label}=${String(p[field.key])}`;
  }
  if (video) {
    if (p.method === undefined) p.method = model.methods![0];
    if (!model.methods!.includes(String(p.method))) return '线路不支持该生成方法';
    if (!line.members.some(r => availableMember(r, agentId, modes) && compatibleMember(line, r) && videoMemberAccepts(getModelDef(r.modelId)!, { ...req, params: p as GenerateRequest['params'] }))) return '当前线路没有支持所选参数与素材组合的可用渠道';
  } else if(image) {
    if (!line.members.some(r => availableMember(r, agentId, modes) && compatibleMember(line, r) && imageMemberAccepts(getModelDef(r.modelId)!, p))) return '当前线路没有支持该图片比例和分辨率的可用渠道';
    if (req.inputs?.videos?.length || req.inputs?.audios?.length) return '图片线路仅支持图片参考素材';
  }
  if (!image&&!video&&!line.members.some(r=>availableMember(r,agentId,modes)&&genericMemberAccepts(getModelDef(r.modelId)!,{...req,params:p as GenerateRequest['params']}))) return '当前线路没有支持所选参数与素材的可用渠道';
  if (p.firstFrameUrl !== undefined && (typeof p.firstFrameUrl !== 'string' || !/^https?:\/\//.test(p.firstFrameUrl))) return '整体参考图地址无效';
  const countedInputs = p.firstFrameUrl ? { ...req.inputs, images: [...(req.inputs?.images ?? []), { url: String(p.firstFrameUrl) }] } : req.inputs;
  const matError = checkMaterialLimits(model.label, model.matLimits, countedInputs);
  if (matError) return matError;
  if ((countedInputs?.images?.length ?? 0) + (countedInputs?.videos?.length ?? 0) < (model.minVisualMaterials ?? 0)) return '该线路至少需要一份图片或视频参考素材';
  return undefined;
}

export function selectRoute(req: GenerateRequest, agentId?: string, modes?: Record<string, boolean>, now = Date.now()): { request: GenerateRequest; ticket: RouteTicket } {
  const error = prepareRoutingRequest(req, agentId, modes);
  if (error) throw new Error(error);
  const line = lineOf(req.model)!;
  const checkedRequest = { ...req, params: routingRequestParams(req) as GenerateRequest['params'] };
  const eligible = line.members.filter(r => availableMember(r, agentId, modes) && compatibleMember(line, r) && (routeCapability(line) === 'image' ? imageMemberAccepts(getModelDef(r.modelId)!, checkedRequest.params as Record<string, unknown>) : routeCapability(line)==='video' ? videoMemberAccepts(getModelDef(r.modelId)!, checkedRequest) : genericMemberAccepts(getModelDef(r.modelId)!, checkedRequest)) && concurrencyPenalty(line.id, getModelDef(r.modelId)!.channelId!, now).percent > 0);
  if (!eligible.length) throw new Error('线路暂时不可用，请稍后重试');
  const priority = Math.min(...eligible.map(r => r.priority));
  const pool = eligible.filter(r => r.priority === priority);
  const counts = routeActiveCounts(line.id);
  const selectedId = concurrency.select(`${line.id}/${priority}`, pool.map(r => {
    const channelId = getModelDef(r.modelId)!.channelId!;
    return { id: r.modelId, active: counts[channelId] ?? 0, weight: r.concurrencyWeight * concurrencyPenalty(line.id, channelId, now).percent / 100 };
  }));
  const selected = pool.find(r => r.modelId === selectedId)!;
  const model = getModelDef(selected.modelId)!;
  const ticket: RouteTicket = { lineId: line.id, modelId: model.id, channelId: model.channelId!, publicModel: req.model,
    failureThreshold: selected.failureThreshold, failureWindowSec: selected.failureWindowSec, cooldownSec: selected.cooldownSec, failureRetainPercent: selected.failureRetainPercent };
  healthOf(ticket).selected++; persistHealth();
  return { ticket, request: { ...req, model: model.id } };
}

export function saveRoutingConfig(input: unknown): RoutingConfig {
  const b = input as RoutingConfig;
  if (!b || typeof b.enabled !== 'boolean' || !Array.isArray(b.lines)) throw new Error('路由配置格式错误');
  if (b.version !== state.version) throw new Error('配置已更新，请刷新后重试');
  const ids = new Set<string>();
  for (const line of b.lines) {
    if (line?.capability !== undefined && !['image', 'video', 'text', 'audio', 'video-enhance', 'video-erase', 'image-enhance'].includes(line.capability)) throw new Error('线路能力类型错误');
    if (!line || !/^[a-z0-9-]{1,48}$/.test(line.id) || ids.has(line.id) || typeof line.name !== 'string' || !line.name.trim() || line.name.length > 30
      || !validLineFamily(line) || typeof line.enabled !== 'boolean'
      || !Array.isArray(line.members) || line.members.length > 40) throw new Error('线路身份或家族配置错误');
    ids.add(line.id);
    if (line.tokenPricing !== undefined) { if(routeCapability(line)!=='text') throw new Error('仅文本线路支持 token 计费');validateTextPricing(line.tokenPricing); }
    if (line.refVideoSecondsWeight !== undefined && (typeof line.refVideoSecondsWeight!=='number'||!Number.isFinite(line.refVideoSecondsWeight)||line.refVideoSecondsWeight<0||line.refVideoSecondsWeight>100)) throw new Error('输入视频折算系数须为0到100');
    if (line.refVideoSecondsWeight && (routeCapability(line)!=='video'||(line.costPerUnit===undefined&&!line.prices?.length))) throw new Error('输入视频计费须使用视频按秒价或档位价');
    if (routeCapability(line) !== 'video' && line.costPerUnit !== undefined) throw new Error('仅视频线路支持按秒计费');
    if (!Number.isFinite(line.cost) || line.cost < 0 || (line.costPerUnit !== undefined && (!Number.isFinite(line.costPerUnit) || line.costPerUnit < 0))) throw new Error('积分必须是非负数');
    if (line.prices !== undefined && (!Array.isArray(line.prices) || line.prices.length > 1000 || line.costPerUnit !== undefined
      || line.prices.some(p => !p || !Number.isFinite(p.cost) || p.cost < 0 || !p.when || Object.keys(p.when).some(k => !(routeCapability(line) === 'image' ? IMAGE_PUBLIC_KEYS : coreKeys).includes(k))))) throw new Error('按档价格格式错误');
    const firstMaterialModel = resolveLineMaterialModel(publicId(line.id), line);
    if (firstMaterialModel && line.members.some(r => r.enabled && !compatibleMember(line, r))) throw new Error('同一线路的候选素材请求方式或素材库不兼容，请拆分线路');
    const members = new Set<string>();
    for (const r of line.members) {
      const m = getModelDef(r.modelId);
      if (m) validateModelMaterialPolicy(m);
      if (!m || seedanceFamilyOf(m) !== line.familyId || m.capability !== routeCapability(line) || !m.channelId || members.has(m.channelId)) throw new Error('每条线路每个渠道只能选一个同家族模型');
      members.add(m.channelId);
      if (m.routes?.some(route => route.channelId && route.channelId !== m.channelId)) throw new Error('候选模型包含跨渠道重定向，请先在模型管理中拆分');
      // 上方 seedanceFamilyOf 已校验具体版本家族；自定义渠道 ID 不要求包含版本号。
      for (const [key, min, max] of [['priority', 0, 1000], ['failureThreshold', 1, 1000], ['failureWindowSec', 1, 86400], ['cooldownSec', 1, 86400]] as const) {
        if (!Number.isInteger(r[key]) || r[key] < min || r[key] > max) throw new Error(`${({ priority: '优先级', failureThreshold: '失败次数阈值', failureWindowSec: '统计窗口', cooldownSec: '处罚时长' })[key]}超出范围（${min}–${max}）`);
      }
      if (!Number.isFinite(r.concurrencyWeight) || r.concurrencyWeight < 0 || r.concurrencyWeight > 100 || Math.abs(r.concurrencyWeight * 100 - Math.round(r.concurrencyWeight * 100)) > 1e-7) throw new Error('并发权重超出范围（0–100，最多两位小数）');
      if (!Number.isInteger(r.failureRetainPercent) || r.failureRetainPercent < 0 || r.failureRetainPercent > 100) throw new Error('故障保留并发比例超出范围（0–100）');
      if (r.vipEnabled !== undefined && typeof r.vipEnabled !== 'boolean') throw new Error('VIP预留开关必须为启用或禁用');
      if (typeof r.enabled !== 'boolean' || !r.defaults || typeof r.defaults !== 'object' || Array.isArray(r.defaults)) throw new Error('渠道默认字段格式错误');
      for (const [key, value] of Object.entries(r.defaults)) {
        const field = m.params.find(p => p.key === key);
        if ((routeCapability(line) === 'image' ? [...IMAGE_PUBLIC_KEYS, ...IMAGE_DERIVED_KEYS] : routeCapability(line)==='video' ? coreKeys : []).includes(key) || !field || !accepts(field, value)) throw new Error(`渠道默认字段无效：${key}`);
      }
    }
    // A line may remain configured/open while all its members are disabled; it is then absent from the public catalog.
    if (line.enabled && configuredModels(line).length > 0 && !lineModel(line)) throw new Error('启用的渠道必须配置可用参数与生成方法');
  }
  const deletedFamilyIds = b.deletedFamilyIds ?? state.deletedFamilyIds;
  if (deletedFamilyIds !== undefined && (!Array.isArray(deletedFamilyIds) || deletedFamilyIds.some(id => typeof id !== 'string' || !id))) throw new Error('已删除家族格式错误');
  // A deliberately emptied family must not have its default lines seeded again.
  const initializedFamilyIds = [...new Set([...(state.initializedFamilyIds ?? []), ...state.lines.map(l => l.familyId), ...b.lines.map(l => l.familyId)])];
  if (b.defaultLineFamilyIds !== undefined && (!Array.isArray(b.defaultLineFamilyIds) || b.defaultLineFamilyIds.some(id => typeof id !== 'string' || !id))) throw new Error('默认线路初始化标记错误');
  const defaultLineFamilyIds = [...new Set([...(state.defaultLineFamilyIds ?? []), ...(b.defaultLineFamilyIds ?? [])])];
  const boundFamilyIds = [...new Set([...(state.boundFamilyIds ?? []), ...b.lines.filter(l=>l.members.length>0).map(l=>l.familyId)])];
  const next = structuredClone({ routeOnlyVersion: b.routeOnlyVersion ?? state.routeOnlyVersion, initializedFamilyIds, defaultLineFamilyIds, boundFamilyIds, version: state.version + 1, enabled: b.enabled, lines: b.lines, ...(deletedFamilyIds ? { deletedFamilyIds: [...new Set(deletedFamilyIds)].filter(id => !b.lines.some(l => l.familyId === id)) } : {}) });
  next.lines = sortRoutingLines(next.lines);
  for (const line of next.lines) for (const member of line.members) member.vipEnabled ??= false;
  saveJson(FILE, next); state = next; concurrency.clear(); notifyAvailabilityConfigChange(); return routingConfig();
}

/** Explicit local/admin initialization only; importing code never enables routing or rewrites existing models. */
export function initialRoutingConfig(): RoutingConfig {
  const member = (modelId: string): RouteMember => ({ modelId, enabled: true, vipEnabled: false, priority: 0, concurrencyWeight: 1, failureThreshold: 3, failureWindowSec: 300, cooldownSec: 300, failureRetainPercent: 50, defaults: {} });
  const line = (id: string, name: string, models: string[], enabled: boolean, cost: number, version = '2.0'): AutoLine => ({ id, name, familyId: version === '2.5' ? SEEDANCE_25_FAMILY : SEEDANCE_FAMILY_ID, modelVersion: version, enabled, cost, members: models.filter(id => listModels().some(m => m.id === id)).map(member) });
  const lines = [
    line('seedance-budget', '低价', ['jmt933-sd2.0'], false, 45),
    line('seedance-promo', '优惠', ['007-sd2.0', 'os933-sd2.0', 'seedance-2.0'], true, 825),
    { ...line('seedance-official', '官方', ['off-sd2.0'], true, 750), costPerUnit: 50 },
    line('seedance25-budget', '低价', [], false, 0, '2.5'),
    { ...line('seedance25-promo', '优惠', ['007-sd2.5', 'os933-sd2.5'], true, 3750, '2.5'), costPerUnit: 125 },
    { ...line('seedance25-official', '官方', ['off-sd2.5'], true, 1500, '2.5'), costPerUnit: 50 },
  ];
  for (const line of lines) Object.assign(line, highestLinePrices(line));
  return { version: state.version, enabled: true, lines };
}

/** Freeze current highest cost per public duration/resolution. Later provider price edits do not alter retail silently. */
export function highestLinePrices(line: AutoLine): Pick<AutoLine, 'cost' | 'costPerUnit' | 'prices'> {
  const model = lineModel(line);
  if (!model) return { cost: line.cost, costPerUnit: undefined, prices: undefined };
  if (routeCapability(line) === 'image') {
    const models = configuredModels(line);
    const aspects = model.params.find(p => p.key === 'aspect_ratio')?.options ?? [];
    const prices = (model.params.find(p => p.key === 'resolution')?.options ?? []).flatMap(resolution => {
      const costs = models.flatMap(m => aspects.filter(aspect_ratio => imageMemberAccepts(m, { aspect_ratio, resolution })).flatMap(aspect_ratio =>
        ['auto','low','medium','high'].map(quality => resolveModelCost(m, imageUpstreamParams(m, { aspect_ratio, resolution, quality })))));
      return costs.length ? [{ when: { resolution }, cost: Math.max(...costs) }] : [];
    });
    return { cost: prices.length ? Math.max(...prices.map(p => p.cost)) : line.cost, costPerUnit: undefined, prices };
  }
  const prices: NonNullable<AutoLine['prices']> = [];
  for (const duration of model.params.find(p => p.key === 'duration')!.options!) {
    for (const resolution of model.params.find(p => p.key === 'resolution')!.options!) {
      const candidates = configuredModels(line).filter(m => videoModelSupportsParams(m, { duration, resolution }));
      if (!candidates.length) continue;
      const cost = Math.max(...candidates.map(m => resolveModelCost(m, { duration, resolution, aspect_ratio: m.params.find(p => p.key === 'aspect_ratio')?.default ?? '16:9' })));
      prices.push({ when: { duration, resolution }, cost });
    }
  }
  return { cost: Math.max(...prices.map(p => p.cost)), costPerUnit: undefined, prices };
}

/** Missing image families only; preserve every existing line and its operator settings. */
export function withSeedanceVariantRouting(config: RoutingConfig): RoutingConfig {
  const next = structuredClone(config);
  for (const family of SEEDANCE_ROUTE_FAMILIES.slice(2)) {
    if (config.deletedFamilyIds?.includes(family.id) || config.initializedFamilyIds?.includes(family.id)) continue;
    if (next.lines.some(l => l.familyId === family.id)) continue;
    const used = new Set<string>();
    // Only the video channels already authorized for public routing are opened by default.
    const members: RouteMember[] = listModels().filter(m => {
      if (m.capability !== 'video' || seedanceFamilyOf(m) !== family.id || !m.enabled || !m.channelId || !['ch-007','ch-overseas','ch-jianmeng'].includes(m.channelId) || !getChannel(m.channelId)?.enabled || used.has(m.channelId)) return false;
      used.add(m.channelId); return true;
    }).map(m => ({ modelId:m.id, enabled:true, vipEnabled:false, priority:0, concurrencyWeight:1, failureThreshold:3, failureWindowSec:300, cooldownSec:300, failureRetainPercent:50, defaults:{} }));
    for (const [suffix,name] of [['budget','低价'],['promo','优惠'],['stable','稳定'],['official','官方']]) {
      const line: AutoLine = { id:`seedance20-${family.version.split('-')[1]}-${suffix}`, familyId:family.id, modelVersion:family.version, name, enabled:false, cost:0, members:suffix==='promo'?structuredClone(members):[] };
      line.enabled = suffix==='promo' && !!lineModel(line);
      Object.assign(line,highestLinePrices(line)); next.lines.push(line);
    }
  }
  return next;
}

/** Fill the four standard lines once per family, without changing existing operator settings. */
export function withDefaultRouting(config: RoutingConfig): RoutingConfig {
  const next = structuredClone(config);
  const initialized = new Set(config.defaultLineFamilyIds ?? []);
  for (const family of routingFamilyOptions(config)) {
    // Processing families keep their own named lines; only generation families receive tier defaults.
    if (!['image', 'video', 'text', 'audio'].includes(family.capability)) continue;
    const names = SEEDANCE_ROUTE_FAMILIES.some(f => f.id === family.id) ? ['低价', '优惠', '稳定', '官方1', '官方2', '官方3'] : ['低价', '优惠', '稳定', '官方'];
    if (config.deletedFamilyIds?.includes(family.id) || initialized.has(family.id)) continue;
    // Preserve a family deliberately emptied before this migration.
    if (!config.lines.some(l => l.familyId === family.id) && config.initializedFamilyIds?.includes(family.id)) { initialized.add(family.id); continue; }
    for (let i = 0; i < names.length; i++) {
      if (next.lines.some(l => l.familyId === family.id && l.name.replace(/线路$/, '') === names[i])) continue;
      const id = 'default-' + createHash('sha256').update(family.id).digest('hex').slice(0, 20) + '-' + i;
      if (next.lines.some(l => l.id === id)) continue;
      next.lines.push({ id, name: names[i], familyId: family.id, familyName: family.name, modelVersion: family.modelVersion, capability: family.capability, enabled: false, cost: 0, members: [] });
    }
    initialized.add(family.id);
  }
  next.lines = sortRoutingLines(next.lines);
  next.defaultLineFamilyIds = [...initialized];
  return next;
}
function sortRoutingLines(lines: AutoLine[]): AutoLine[] {
  const families=[...new Set(lines.map(l=>l.familyId))],names=['低价','优惠','稳定','官方','官方1','官方2','官方3'];
  const rank=(l:AutoLine)=>{const i=names.indexOf(l.name.replace(/线路$/,''));return i<0?7:i;};
  return [...lines].sort((a,b)=>families.indexOf(a.familyId)-families.indexOf(b.familyId)||rank(a)-rank(b));
}

/** Missing image families only; preserve every existing line and its operator settings. */
export function withImageRouting(config: RoutingConfig): RoutingConfig {
  const next = structuredClone(config);
  for (const family of IMAGE_ROUTE_FAMILIES) {
    if (config.deletedFamilyIds?.includes(family.id) || config.initializedFamilyIds?.includes(family.id)) continue;
    const models = listModels().filter(m => m.capability === 'image' && imageFamilyOf(m) === family.id);
    if (!models.length || next.lines.some(l => l.familyId === family.id)) continue;
    const used = new Set<string>();
    const members: RouteMember[] = models.filter(m => {
      if (!m.enabled || !m.channelId || !getChannel(m.channelId)?.enabled || used.has(m.channelId)) return false;
      used.add(m.channelId); return true;
    }).map(m => ({ modelId:m.id, enabled:true, vipEnabled:false, priority:0, concurrencyWeight:1, failureThreshold:3, failureWindowSec:300, cooldownSec:300, failureRetainPercent:50, defaults:{} }));
    for (const [suffix,name] of [['budget','低价'],['promo','优惠'],['stable','稳定'],['official','官方']]) {
      const line: AutoLine = { id:`image-${family.id.replace(/^fam-/, '')}-${suffix}`, familyId:family.id, familyName:family.name, modelVersion:family.name, capability:'image', name, enabled:false, cost:0, members:suffix==='promo'?structuredClone(members):[] };
      line.enabled = suffix==='promo' && !!lineModel(line);
      Object.assign(line,highestLinePrices(line)); next.lines.push(line);
    }
  }
  return next;
}
