import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from './store/db.ts';
import { createModel, getModelDef, listModels } from './store/models.ts';
import { materialPolicyForModel } from './materialPolicy.ts';
import { routingConfig, saveRoutingConfig, seedanceFamilyOf, resolveLineMaterialModel, withDefaultRouting, highestLinePrices, lineModel, type AutoLine, type RouteMember } from './autoRouting.ts';
import { SEEDANCE_ROUTE_FAMILIES } from './contract.ts';

const member = (modelId: string): RouteMember => ({ modelId, enabled: true, priority: 0, concurrencyWeight: 1, vipEnabled: false, failureThreshold: 3, failureWindowSec: 300, cooldownSec: 300, failureRetainPercent: 50, defaults: {} });
const idFor = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 20);

/** Only add verified upstream names. Operator edits and model tombstones remain authoritative. */
export function ensureOfficialModelConfigs() {
  const tombstones: string[] = JSON.parse(readFileSync(join(DATA_DIR, 'models.json'), 'utf8')).deletedSeedIds ?? [];
  const base = getModelDef('off-sd2.0');
  if (!base) return;
  for (const [id, upstream, family, label] of [
    ['off-me2.0', 'me-video-v2', 'fam-seedance', 'Seedance 2.0 · 官方2'],
    ['off-we2.0', 'we-video-v2', 'fam-seedance', 'Seedance 2.0 · 官方3'],
    ['off-we2.0-fast', 'we-video-v2-fast', 'fam-seedance-2-0-fast', 'Seedance 2.0 Fast · 官方3'],
    ['off-we2.0-mini', 'we-video-v2-mini', 'fam-seedance-2-0-mini', 'Seedance 2.0 Mini · 官方3'],
  ]) {
    if (getModelDef(id) || tombstones.includes(id)) continue;
    const { createdAt: _created, updatedAt: _updated, ...template } = structuredClone(base);
    createModel({ ...template, id, label, upstreamModel: upstream, familyId: family, enabled: true,
      materialPolicy: { kind: 'official-assets', library: upstream.startsWith('me-') ? 'me' : 'we', groupRequired: false },
      // These configurations inherit the existing selling-price template; new lines remain closed.
      params: template.params.map(p => upstream === 'me-video-v2' && p.key === 'resolution' ? { ...p, options: [...new Set([...(p.options ?? []), '1080p'])] } : p),
      routes: undefined,
    });
  }
}

/** Preserve existing line prices and openness; never re-open a deleted or empty family. */
export function migrateRouteOnlyCatalog() {
  const original = routingConfig();
  if (original.routeOnlyVersion === 1) return;
  let config = structuredClone(original);
  const existingFamilies = new Set(original.lines.map(l => l.familyId));
  for (const line of config.lines) {
    if (!SEEDANCE_ROUTE_FAMILIES.some(f => f.id === line.familyId) || line.name !== '官方') continue;
    const first = resolveLineMaterialModel(`route:${line.id}`, line);
    const library = first ? materialPolicyForModel(first!).library : 'sd';
    line.name = library === 'we' ? '官方3' : library === 'me' ? '官方2' : '官方1';
  }
  config = withDefaultRouting(config);
  for (const family of SEEDANCE_ROUTE_FAMILIES) {
    if (config.deletedFamilyIds?.includes(family.id)) continue;
    for (const [name, library] of [['官方1', 'sd'], ['官方2', 'me'], ['官方3', 'we']] as const) {
      const existing = config.lines.find(l => l.familyId === family.id && l.name === name);
      if (existing && original.lines.some(l => l.id === existing.id)) continue;
      const model = listModels().find(m => seedanceFamilyOf(m) === family.id && materialPolicyForModel(m).library === library);
      const peer = config.lines.find(l => l.familyId === family.id && l.name.startsWith('官方') && l.members.length > 0);
      if (existing) config.lines = config.lines.filter(l => l.id !== existing.id);
      const prices = peer?.prices ? structuredClone(peer.prices) : undefined;
      if (prices && model?.upstreamModel === 'me-video-v2' && !prices.some(p => p.when.resolution === '1080p')) prices.push(...prices.filter(p => p.when.resolution === '720p').map(p => ({ ...p, when: { ...p.when, resolution: '1080p' } })));
      config.lines.push({ id: `official-${idFor(family.id + library)}`, name, familyId: family.id, modelVersion: family.version, capability: 'video', enabled: false,
        cost: peer?.cost ?? model?.cost ?? 0, costPerUnit: peer?.costPerUnit ?? (!peer?.prices?.length && model?.costField === 'duration' ? model.costPerUnit : undefined),
        prices, members: model ? [member(model.id)] : [] });
    }
  }
  // Former direct models whose families never had routing retain an equivalent priced line.
  for (const model of listModels()) {
    const familyId = seedanceFamilyOf(model)!;
    if (SEEDANCE_ROUTE_FAMILIES.some(f => f.id === familyId) || model.hidden || ['echo', 'stub'].includes(model.protocol) || existingFamilies.has(familyId) || config.deletedFamilyIds?.includes(familyId) || !model.channelId) continue;
    const line: AutoLine = { id: `model-${idFor(model.id)}`, name: model.label, familyId, familyName: model.label, capability: model.capability, modelVersion: familyId,
      enabled: model.enabled, cost: model.cost, tokenPricing: model.tokenPricing, refVideoSecondsWeight: model.refVideoSecondsWeight, members: [member(model.id)] };
    if (model.costField === 'duration') line.costPerUnit = model.costPerUnit;
    if (model.capability === 'video') Object.assign(line, highestLinePrices(line));
    line.enabled = line.enabled && !!lineModel(line);
    config.lines.push(line);
  }
  // Seeding lines must retain the operator's global routing switch.
  config.routeOnlyVersion = 1;
  saveRoutingConfig(config);
}
