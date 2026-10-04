import assert from 'node:assert/strict';import fs from 'node:fs';
if(!import.meta.url.includes('qiji-usage-reports-'))throw Error('Sandbox only');
globalThis.fetch=async()=>{throw Error('No upstream')};
const state=JSON.parse(fs.readFileSync(new URL('../data/product-test-state.json',import.meta.url),'utf8'));
const service=await import('../src/services/usageReports.ts');service.startUsageReports(false);
const c=service.getUsageReport(state.agent,30).companies[0];assert.deepEqual(c.products,state.products);assert.equal(c.total,state.total);service.stopUsageReports();console.log('Product restart: quantities, prices, missing coverage and deduplication passed');
