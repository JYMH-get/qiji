import test from 'node:test';
import assert from 'node:assert/strict';
import { companyForUsage } from './team-usage-attribution.mjs';
const companies = new Set(['source', 'company-a', 'company-b']);
const classify = l => companyForUsage(l, companies, { metadataComplete: true });
test('ordinary user logs use frozen owner, not the code-issue agent field', () => {
  assert.equal(classify({ userId: 'deleted-user', ownerId: 'company-a' }), 'company-a');
});
test('historical payment stays with the former company after a move', () => {
  assert.equal(classify({ userId: 'moved-user', ownerId: 'company-b', pricingAgentId: 'company-a' }), 'company-a');
});
test('team wallet identifies the paying company', () => {
  assert.equal(classify({ userId: 'member', userWallet: { ownerAgentId: 'company-a' } }), 'company-a');
});
test('missing extraction and unknown owners stop export', () => {
  assert.throws(() => companyForUsage({ userId: 'u' }, companies));
  assert.throws(() => classify({ userId: 'u', ownerId: 'removed-company' }));
  assert.throws(() => classify({ userId: 'u' }));
});
test('explicit source payment and company conflicts are distinguished', () => {
  assert.equal(classify({ userId: 'u', creditSource: 'personal' }), 'source');
  assert.throws(() => classify({ userId: 'u', usageReportScope: { companyId: 'company-a' }, pricingAgentId: 'company-b' }));
});
test('redemption ledger entries cannot become user usage', () => {
  assert.throws(() => classify({ agentId: 'company-a', cost: -1000 }));
});
