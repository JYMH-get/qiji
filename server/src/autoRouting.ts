import { accepts, VIDEO_PUBLIC_KEYS, videoRouteParams, videoModelSupportsParams, videoMemberAccepts, videoMinVisualMaterials } from './videoRouting.ts';
export { accepts } from './videoRouting.ts';
import { RouteConcurrency, migrateRouteConcurrency } from './routeConcurrency.ts';
import { routeActiveCounts } from './routeObservations.ts';
import { IMAGE_DERIVED_KEYS, IMAGE_ROUTE_FAMILIES, IMAGE_PUBLIC_KEYS, imageFamilyOf, imageRouteParams, imageMemberAccepts } from './imageRouting.ts';
export { isChannelFailure } from './routeObservations.ts';
/** Public Seedance lines. Provider selection never changes the public billing contract. */
import type { GenerateRequest, ParamField } from './contract.ts';
import { SEEDANCE_FAMILY_ID, SEEDANCE_ROUTE_FAMILIES, seedanceModelFamily } from './contract.ts';
import { loadJson, saveJson, scheduleSave, DATA_DIR } from './store/db.ts';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getModelDef, listModels, modelAllowedForAgent, resolveModelCost, type ModelDef } from './store/models.ts';
import { getChannel } from './store/channels.ts';
import { listModes } from './store/modes.ts';
import { getFamily, listFamilies } from './store/families.ts';
import { checkMaterialLimits } from './materialLimits.ts';

export interface RouteMember {
  modelId: string; enabled: boolean; priority: number; concurrencyWeight: number;
  /** Reserved VIP audience preference; not enforced until VIP routing is introduced. */
  vipEnabled?: boolean;
  failureThreshold: number; failureWindowSec: number; cooldownSec: number;
  defaults: Record<string, unknown>; failureRetainPercent: number;
}
export interface AutoLine {
  id: string; name: string; familyId: string; modelVersion: string; enabled: boolean;
  capability?: 'video' | 'image'; familyName?: string;
  cost: number; costPerUnit?: number; members: RouteMember[];
  prices?: { when: Record<string, string>; cost: number }[];
}
interface RoutingConfig { version: number; enabled: boolean; lines: AutoLine[] }
export interface RouteTicket { observationId?: string; lineId: string; modelId: string; channelId: string; publicModel: string; failureThreshold: number; failureWindowSec: number; cooldownSec: number; failureRetainPercent?: number }
interface Health { failures: number[]; cooldownUntil: number; penaltyUntil?: number; penaltyPercent?: number; selected: number; succeeded: number; failed: number }
const FILE = 'auto-routing.json';
let state: RoutingConfig = existsSync(join(DATA_DIR, FILE)) ? JSON.parse(readFileSync(join(DATA_DIR, FILE), 'utf8')) : { version: 0, enabled: false, lines: [] };
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
      const enabled = state.enabled && line.enabled && r.enabled && r.concurrencyWeight > 0 && model?.enabled && getChannel(channelId)?.enabled;
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
export const seedanceFamilyOf = (m: ModelDef) => m.capability === 'image' ? imageFamilyOf(m) : seedanceModelFamily(m.id) ?? m.familyId;
export const routeCapability = (l: AutoLine) => l.capability ?? 'video';
export const routeFamilyName = (l: AutoLine) => l.familyName ?? (routeCapability(l) === 'image' ? IMAGE_ROUTE_FAMILIES.find(f => f.id === l.familyId)?.name : SEEDANCE_ROUTE_FAMILIES.find(f => f.id === l.familyId)?.name) ?? getFamily(l.familyId)?.name ?? l.familyId;
export function routingFamilyOptions(config: RoutingConfig) {
  const options = new Map(config.lines.map(l => [l.familyId,{id:l.familyId,name:routeFamilyName(l),capability:routeCapability(l),modelVersion:l.modelVersion}]));
  for (const f of listFamilies()) {
    const capability = f.capability ?? listModels().find(m => seedanceFamilyOf(m) === f.id && ['video','image'].includes(m.capability))?.capability;
    if (!options.has(f.id) && (capability === 'video' || capability === 'image')) options.set(f.id,{id:f.id,name:f.name,capability,modelVersion:SEEDANCE_ROUTE_FAMILIES.find(s => s.id === f.id)?.version ?? f.id});
  }
  return [...options.values()];
}
function validLineFamily(line: AutoLine): boolean {
  const seedance = SEEDANCE_ROUTE_FAMILIES.find(f => f.id === line.familyId);
  if (seedance) return routeCapability(line) === 'video' && line.modelVersion === seedance.version;
  if (IMAGE_ROUTE_FAMILIES.some(f => f.id === line.familyId)) return routeCapability(line) === 'image';
  const registered = getFamily(line.familyId);
  return !!registered && (!registered.capability || registered.capability === routeCapability(line)) && line.modelVersion === line.familyId;
}
export const routingFamilies = () => [...new Set(state.lines.map(l => l.familyId))];
export const routedFamily = (m: ModelDef) => state.enabled && routingFamilies().includes(seedanceFamilyOf(m) ?? '') && ['video','image'].includes(m.capability);
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

function configuredModels(line: AutoLine): ModelDef[] {
  return line.members.filter(r => r.enabled && r.concurrencyWeight > 0).map(r => getModelDef(r.modelId)).filter((m): m is ModelDef => !!m && (routeCapability(line) === 'image' || (!!m.enabled && !!getChannel(m.channelId ?? '')?.enabled)));
}
/** Capability union for video, stable across temporary cooling. Images retain their own sizing policy. */
export function lineModel(line: AutoLine): ModelDef | undefined {
  const models = configuredModels(line);
  if (!models.length) return undefined;
  const image = routeCapability(line) === 'image';
  const params: ParamField[] | undefined = image ? imageRouteParams(models) : videoRouteParams(models);
  if (!params?.length) return undefined;
  const methods = image ? [] : [...new Set(models.flatMap(m => m.methods ?? ['omni' as const]))];
  if (!image && !methods.length) return undefined;
  return { id: publicId(line.id), label: `${routeFamilyName(line)} · ${line.name}`, familyId: line.familyId,
    modeId: publicId(line.id), capability: routeCapability(line), protocol: 'stub', enabled: line.enabled, params, methods,
    officialAssets: models.every(m => m.officialAssets === true),
    minVisualMaterials: image ? 0 : Math.min(...models.map(videoMinVisualMaterials)),
    note: !image && models.every(m => videoMinVisualMaterials(m) > 0) ? '至少提供一份图片或视频参考素材' : undefined,
    matLimits: Object.fromEntries(['img', 'vid', 'aud'].map(k => [k, image ? Math.min(...models.map(m => m.matLimits?.[k as 'img'] ?? (k === 'img' ? 9 : 3))) : models.some(m => m.matLimits?.[k as 'img'] === undefined) ? undefined : Math.max(...models.map(m => m.matLimits![k as 'img']!))])),
    cost: line.cost, costField: line.costPerUnit === undefined ? undefined : 'duration', costPerUnit: line.costPerUnit,
    routes: line.prices?.map(p => ({ ...p, upstreamModel: '' })),
    createdAt: '', updatedAt: '' };
}
function availableMember(r: RouteMember, agentId?: string, _modes?: Record<string, boolean>): boolean {
  const m = getModelDef(r.modelId);
  return !!(r.enabled && r.concurrencyWeight > 0 && m?.enabled && m.channelId && getChannel(m.channelId)?.enabled
    && modelAllowedForAgent(m, agentId));
}
export function publicRoutingModels(agentId?: string, modes?: Record<string, boolean>): ModelDef[] {
  if (!state.enabled) return [];
  return state.lines.filter(l => l.enabled && modes?.[publicId(l.id)] !== false && l.members.some(r => availableMember(r, agentId, modes)))
    .map(l => lineModel(routeCapability(l) === 'image' ? l : { ...l, members: l.members.filter(r => availableMember(r, agentId, modes)) })).filter((m): m is ModelDef => !!m);
}
export function publicModelDef(id: string): ModelDef | undefined {
  if (id.startsWith('route:')) { const l = lineOf(id); return state.enabled && l ? lineModel(l) : undefined; }
  return getModelDef(id);
}
export function prepareRoutingRequest(req: GenerateRequest, agentId?: string, modes?: Record<string, boolean>): string | undefined {
  const raw = getModelDef(req.model);
  if (raw && routedFamily(raw)) return '该模型已改为线路选择，请刷新模型目录后选择线路';
  if (!req.model?.startsWith('route:')) {
    if (raw?.capability !== 'image') return undefined;
    const model = imageRouteParams([raw]);
    if (!model?.length) return '该图片模型没有可用的公共比例和分辨率';
    const p = { ...req.params } as Record<string, unknown>;
    const extras = new Set(['assetName', 'idPrefix']);
    for (const key of Object.keys(p)) if (!IMAGE_PUBLIC_KEYS.includes(key) && !extras.has(key)) return `图片请求不接受参数：${key}`;
    for (const field of model) {
      if (p[field.key] === undefined) p[field.key] = field.default;
      if (!accepts(field, p[field.key])) return `图片参数不支持：${field.label}=${String(p[field.key])}`;
    }
    if (!imageMemberAccepts(raw, p)) return '该图片模型不支持所选比例和分辨率';
    if (req.inputs?.videos?.length || req.inputs?.audios?.length) return '图片模型仅支持图片参考素材';
    req.params = p as GenerateRequest['params'];
    return undefined;
  }
  const line = lineOf(req.model);
  const model = line && routeCapability(line) === 'video'
    ? lineModel({ ...line, members: line.members.filter(r => availableMember(r, agentId, modes)) })
    : publicModelDef(req.model);
  if (!state.enabled || !line?.enabled || !model || modes?.[req.model] === false) return '所选线路未开放';
  if (!line.members.some(r => availableMember(r, agentId, modes))) return '所选线路未对当前账号开放';
  const p = { ...req.params } as Record<string, unknown>;
  const image = model.capability === 'image';
  // Provider-only fields are administrator controlled; clients cannot inject them or billing internals.
  const extras = new Set(image ? ['assetName', 'idPrefix'] : ['method', 'assetName', 'idPrefix', 'firstFrameUrl']);
  for (const key of Object.keys(p)) if (!(image ? IMAGE_PUBLIC_KEYS : coreKeys).includes(key) && !extras.has(key)) return `线路不接受参数：${key}`;
  for (const field of model.params) {
    if (p[field.key] === undefined) p[field.key] = field.default;
    if (!accepts(field, p[field.key])) return `线路参数不支持：${field.label}=${String(p[field.key])}`;
  }
  if (!image) {
    if (p.method === undefined) p.method = model.methods![0];
    if (!model.methods!.includes(String(p.method))) return '线路不支持该生成方法';
    if (!line.members.some(r => availableMember(r, agentId, modes) && videoMemberAccepts(getModelDef(r.modelId)!, { ...req, params: p as GenerateRequest['params'] }))) return '当前线路没有支持所选参数与素材组合的可用渠道';
  } else {
    if (!line.members.some(r => availableMember(r, agentId, modes) && imageMemberAccepts(getModelDef(r.modelId)!, p))) return '当前线路没有支持该图片比例和分辨率的可用渠道';
    if (req.inputs?.videos?.length || req.inputs?.audios?.length) return '图片线路仅支持图片参考素材';
  }
  if (p.firstFrameUrl !== undefined && (typeof p.firstFrameUrl !== 'string' || !/^https?:\/\//.test(p.firstFrameUrl))) return '整体参考图地址无效';
  const countedInputs = p.firstFrameUrl ? { ...req.inputs, images: [...(req.inputs?.images ?? []), { url: String(p.firstFrameUrl) }] } : req.inputs;
  const matError = checkMaterialLimits(model.label, model.matLimits, countedInputs);
  if (matError) return matError;
  if ((countedInputs?.images?.length ?? 0) + (countedInputs?.videos?.length ?? 0) < (model.minVisualMaterials ?? 0)) return '该线路至少需要一份图片或视频参考素材';
  req.params = p as GenerateRequest['params'];
  return undefined;
}

export function selectRoute(req: GenerateRequest, agentId?: string, modes?: Record<string, boolean>, now = Date.now()): { request: GenerateRequest; ticket: RouteTicket } {
  const error = prepareRoutingRequest(req, agentId, modes);
  if (error) throw new Error(error);
  const line = lineOf(req.model)!;
  const eligible = line.members.filter(r => availableMember(r, agentId, modes) && (routeCapability(line) === 'image' ? imageMemberAccepts(getModelDef(r.modelId)!, req.params as Record<string, unknown>) : videoMemberAccepts(getModelDef(r.modelId)!, req)) && concurrencyPenalty(line.id, getModelDef(r.modelId)!.channelId!, now).percent > 0);
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
  const defaults = Object.fromEntries(model.params.filter(p => p.default !== undefined && (model.capability !== 'image' || !IMAGE_DERIVED_KEYS.includes(p.key))).map(p => [p.key, p.default]));
  const ticket: RouteTicket = { lineId: line.id, modelId: model.id, channelId: model.channelId!, publicModel: req.model,
    failureThreshold: selected.failureThreshold, failureWindowSec: selected.failureWindowSec, cooldownSec: selected.cooldownSec, failureRetainPercent: selected.failureRetainPercent };
  healthOf(ticket).selected++; persistHealth();
  const params = { ...defaults, ...selected.defaults, ...req.params };
  return { ticket, request: { ...req, model: model.id, params: params as GenerateRequest['params'] } };
}

export function saveRoutingConfig(input: unknown): RoutingConfig {
  const b = input as RoutingConfig;
  if (!b || typeof b.enabled !== 'boolean' || !Array.isArray(b.lines) || b.lines.length > 100) throw new Error('路由配置格式错误');
  if (b.version !== state.version) throw new Error('配置已更新，请刷新后重试');
  const ids = new Set<string>();
  for (const line of b.lines) {
    if (line?.capability !== undefined && !['image', 'video'].includes(line.capability)) throw new Error('线路能力类型错误');
    if (!line || !/^[a-z0-9-]{1,48}$/.test(line.id) || ids.has(line.id) || typeof line.name !== 'string' || !line.name.trim() || line.name.length > 30
      || !validLineFamily(line) || typeof line.enabled !== 'boolean'
      || !Array.isArray(line.members) || line.members.length > 40) throw new Error('线路身份或家族配置错误');
    ids.add(line.id);
    if (routeCapability(line) === 'image' && line.costPerUnit !== undefined) throw new Error('图片线路不支持按秒计费');
    if (!Number.isFinite(line.cost) || line.cost < 0 || (line.costPerUnit !== undefined && (!Number.isFinite(line.costPerUnit) || line.costPerUnit < 0))) throw new Error('积分必须是非负数');
    if (line.prices !== undefined && (!Array.isArray(line.prices) || line.prices.length > 1000 || line.costPerUnit !== undefined
      || line.prices.some(p => !p || !Number.isFinite(p.cost) || p.cost < 0 || !p.when || Object.keys(p.when).some(k => !(routeCapability(line) === 'image' ? IMAGE_PUBLIC_KEYS : coreKeys).includes(k))))) throw new Error('按档价格格式错误');
    const members = new Set<string>();
    for (const r of line.members) {
      const m = getModelDef(r.modelId);
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
        if ((routeCapability(line) === 'image' ? [...IMAGE_PUBLIC_KEYS, ...IMAGE_DERIVED_KEYS] : coreKeys).includes(key) || !field || !accepts(field, value)) throw new Error(`渠道默认字段无效：${key}`);
      }
    }
    // A line may remain configured/open while all its members are disabled; it is then absent from the public catalog.
    if (line.enabled && configuredModels(line).length > 0 && !lineModel(line)) throw new Error('启用的渠道必须配置可用参数与生成方法');
  }
  const next = structuredClone({ version: state.version + 1, enabled: b.enabled, lines: b.lines });
  for (const line of next.lines) for (const member of line.members) member.vipEnabled ??= false;
  saveJson(FILE, next); state = next; concurrency.clear(); return routingConfig();
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
  if (routeCapability(line) === 'image') return { cost: Math.max(...configuredModels(line).map(m => Math.max(m.cost, ...(m.routes ?? []).map(r => r.cost ?? m.cost)))), costPerUnit: undefined, prices: undefined };
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
    if (next.lines.some(l => l.familyId === family.id)) continue;
    const used = new Set<string>();
    // Only the video channels already authorized for public routing are opened by default.
    const members: RouteMember[] = listModels().filter(m => {
      if (m.capability !== 'video' || seedanceFamilyOf(m) !== family.id || !m.enabled || !m.channelId || !['ch-007','ch-overseas','ch-jianmeng'].includes(m.channelId) || !getChannel(m.channelId)?.enabled || used.has(m.channelId)) return false;
      used.add(m.channelId); return true;
    }).map(m => ({ modelId:m.id, enabled:true, vipEnabled:false, priority:0, concurrencyWeight:1, failureThreshold:3, failureWindowSec:300, cooldownSec:300, failureRetainPercent:50, defaults:{} }));
    for (const [suffix,name] of [['budget','低价'],['promo','优惠'],['official','官方']]) {
      const line: AutoLine = { id:`seedance20-${family.version.split('-')[1]}-${suffix}`, familyId:family.id, modelVersion:family.version, name, enabled:false, cost:0, members:suffix==='promo'?structuredClone(members):[] };
      line.enabled = suffix==='promo' && !!lineModel(line);
      Object.assign(line,highestLinePrices(line)); next.lines.push(line);
    }
  }
  return next;
}

/** Missing image families only; preserve every existing line and its operator settings. */
export function withImageRouting(config: RoutingConfig): RoutingConfig {
  const next = structuredClone(config);
  for (const family of IMAGE_ROUTE_FAMILIES) {
    const models = listModels().filter(m => m.capability === 'image' && imageFamilyOf(m) === family.id);
    if (!models.length || next.lines.some(l => l.familyId === family.id)) continue;
    const used = new Set<string>();
    const members: RouteMember[] = models.filter(m => {
      if (!m.enabled || !m.channelId || !getChannel(m.channelId)?.enabled || used.has(m.channelId)) return false;
      used.add(m.channelId); return true;
    }).map(m => ({ modelId:m.id, enabled:true, vipEnabled:false, priority:0, concurrencyWeight:1, failureThreshold:3, failureWindowSec:300, cooldownSec:300, failureRetainPercent:50, defaults:{} }));
    for (const [suffix,name] of [['budget','低价'],['promo','优惠'],['stable','稳定']]) {
      const line: AutoLine = { id:`image-${family.id.replace(/^fam-/, '')}-${suffix}`, familyId:family.id, familyName:family.name, modelVersion:family.name, capability:'image', name, enabled:false, cost:0, members:suffix==='promo'?structuredClone(members):[] };
      line.enabled = suffix==='promo' && !!lineModel(line);
      Object.assign(line,highestLinePrices(line)); next.lines.push(line);
    }
  }
  return next;
}
