import { describe, it, expect, vi } from 'vitest';
vi.mock('../../server/src/store/channels.ts', () => ({ getChannel: () => ({ baseUrl: 'https://test.invalid', apiKey: 'test-key' }) }));
import { materialPolicyForModel, compatibleMaterialPolicies, validateMaterialPolicy } from '../../server/src/materialPolicy';
import type { ModelDef } from '../../server/src/store/models';
const model = (upstreamModel: string, materialPolicy?: ModelDef['materialPolicy']) => ({ id: 'fixture', protocol: 'official-video', upstreamModel, materialPolicy } as ModelDef);
describe('material policy', () => {
  it('uses the upstream library instead of historical model id or display label', () => {
    expect(materialPolicyForModel(model('we-video-v2.5'))).toMatchObject({ kind: 'official-assets', library: 'we', groupRequired: false });
    expect(materialPolicyForModel(model('sd-video-v2'))).toMatchObject({ library: 'sd', groupRequired: true });
    expect(materialPolicyForModel(model('me-video-v2'))).toMatchObject({ library: 'me', groupRequired: false });
  });
  it('separates libraries and credentials but shares model variants in one library', () => {
    const we = materialPolicyForModel(model('we-video-v2'));
    expect(compatibleMaterialPolicies(we, materialPolicyForModel(model('we-video-v2-fast')))).toBe(true);
    expect(compatibleMaterialPolicies(we, materialPolicyForModel(model('me-video-v2')))).toBe(false);
    expect(compatibleMaterialPolicies(we, materialPolicyForModel({ ...model('we-video-v2'), apiKey: 'different' }))).toBe(false);
  });
  it('allows HTTP acceleration URLs on regular HTTP candidates', () => {
    expect(compatibleMaterialPolicies({ kind: 'url' }, { kind: 'nyxen' })).toBe(true);
    expect(compatibleMaterialPolicies({ kind: 'url' }, materialPolicyForModel(model('sd-video-v2')))).toBe(false);
  });
  it('validates operator configuration and strips supplied public scope hashes', () => {
    expect(() => validateMaterialPolicy({ kind: 'official-assets', library: 'me', groupRequired: true })).toThrow();
    expect(() => validateMaterialPolicy({ kind: 'unknown' })).toThrow();
    expect(validateMaterialPolicy({ kind: 'official-assets', library: 'we', scopeKey: 'forged' })).toEqual({ kind: 'official-assets', library: 'we', groupRequired: false });
  });
});
