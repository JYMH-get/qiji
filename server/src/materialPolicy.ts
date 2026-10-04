import { createHash } from 'node:crypto';
import type { MaterialPolicy } from './contract.ts';
import type { ModelDef } from './store/models.ts';
import { getChannel } from './store/channels.ts';
import { config } from './config.ts';

export function validateMaterialPolicy(value: unknown): MaterialPolicy | undefined {
  if (value == null) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('素材请求方式无效');
  const p = value as MaterialPolicy;
  if (!['url', 'nyxen', 'official-assets'].includes(p.kind)) throw new Error('素材请求方式无效');
  if (p.kind !== 'official-assets') return { kind: p.kind };
  if (!['sd', 'me', 'we'].includes(p.library ?? '')) throw new Error('请选择官方素材库');
  if (p.groupRequired !== undefined && typeof p.groupRequired !== 'boolean') throw new Error('素材分组设置无效');
  if (p.library !== 'sd' && p.groupRequired) throw new Error('me/we 素材库不支持分组');
  return { kind: p.kind, library: p.library, groupRequired: p.groupRequired ?? p.library === 'sd' };
}

export function materialPolicyForModel(model: ModelDef): MaterialPolicy {
  const configured = validateMaterialPolicy(model.materialPolicy);
  const upstream = model.upstreamModel ?? model.id;
  const library = /^(sd|me|we)-/.exec(upstream)?.[1] as MaterialPolicy['library'];
  const policy: MaterialPolicy = configured ?? (model.protocol === 'official-video'
    ? { kind: 'official-assets', library: library ?? 'sd', groupRequired: (library ?? 'sd') === 'sd' }
    : model.protocol === 'jianmeng-video' ? { kind: 'nyxen' } : { kind: 'url' });
  if (policy.kind !== 'official-assets') return policy;
  const ch = getChannel(model.channelId ?? '');
  const identity = [(model.baseUrl || ch?.baseUrl || config.official.baseUrl).replace(/\/+$/, ''), model.apiKey || ch?.apiKey || config.official.apiKey, policy.library, policy.groupRequired];
  return { ...policy, scopeKey: createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 24) };
}

export function validateModelMaterialPolicy(model: ModelDef): void {
  const policy = materialPolicyForModel(model);
  if (policy.kind !== 'official-assets') return;
  if (model.protocol !== 'official-video') throw new Error('官方素材库请求方式须使用官方视频协议');
  for (const upstream of [model.upstreamModel ?? model.id, ...(model.routes ?? []).map(r => r.upstreamModel).filter(Boolean)]) {
    const library = /^(sd|me|we)-/.exec(upstream)?.[1];
    if (library && library !== policy.library) throw new Error('模型及其重定向必须使用同一素材库前缀');
  }
  if (model.routes?.some(r => r.channelId && r.channelId !== model.channelId)) throw new Error('官方素材模型不能重定向到其他渠道账号，请拆分配置');
}

export function compatibleMaterialPolicies(a: MaterialPolicy, b: MaterialPolicy): boolean {
  if (a.kind !== 'official-assets' && b.kind !== 'official-assets') return true;
  return a.kind === b.kind && a.library === b.library && a.groupRequired === b.groupRequired && a.scopeKey === b.scopeKey;
}
