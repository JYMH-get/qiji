// Run through scripts/test-user-transfer.ps1; never import stores from the real workspace.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
assert.ok(existsSync(new URL('../.qiji-user-transfer-sandbox', import.meta.url)), 'Refusing to import stores outside isolated sandbox');
globalThis.fetch = async (url) => { throw new Error(`Sandbox blocks network: ${url}`); };
const fastify = (await import('fastify')).default;
const { config } = await import('../src/config.ts');
config.adminToken = 'sandbox-user-transfer-admin';
config.role = 'source';
const users = await import('../src/store/users.ts');
const agents = await import('../src/store/agents.ts');
const teams = await import('../src/store/teams.ts');
const tasks = await import('../src/store/tasks.ts');
const logs = await import('../src/store/logs.ts');
const credits = await import('../src/store/credits.ts');
const models = await import('../src/store/models.ts');
const { flushPendingSaves } = await import('../src/store/db.ts');
const { closeSqlite } = await import('../src/store/sqlite.ts');
const { registerAdminRoutes } = await import('../src/routes/admin.ts');
const { registerRoutes } = await import('../src/routes.ts');
const { registerAgentRoutes } = await import('../src/routes/agent.ts');
let checks = 0;
const eq = (actual, expected, label) => { assert.deepEqual(actual, expected, label); checks++; };
const check = (actual, label) => { assert.ok(actual, label); checks++; };
const app = fastify();
await registerRoutes(app);
await registerAdminRoutes(app);
await registerAgentRoutes(app);
const admin = { authorization: `Bearer ${config.adminToken}` };
const request = (method, url, payload, headers = admin) => app.inject({ method, url, payload, headers });
const transfer = (ids, targetAgentId, headers = admin) => request('POST', '/admin-api/users/transfer', { ids, targetAgentId }, headers);
const snapshot = (u) => { const { agentId, updatedAt, ...rest } = u; return JSON.parse(JSON.stringify(rest)); };
try {
  const madeA = agents.createAgent({ name: '迁移测试甲', account: 'transfer_a', password: 'sandbox123', credits: 500 });
  const madeB = agents.createAgent({ name: '迁移测试乙', account: 'transfer_b', password: 'sandbox123', credits: 700 });
  assert.ok(madeA.ok && madeB.ok);
  const a = madeA.agent, b = madeB.agent;
  const u = users.createUser({ name: '源站迁移测试', credits: 1234.5, features: { assetMode: true } });
  const v = users.createUser({ name: '渠道迁移测试', credits: 765, agentId: a.id });
  users.bindAccount(u, 'transfer_user', 'sandbox123');
  const originalU = snapshot(u), originalV = snapshot(v);
  eq((await transfer([u.id], a.id, {})).statusCode, 401, 'anonymous cannot transfer');
  eq((await transfer([u.id], a.id, { authorization: `Bearer ${u.accessKey}` })).statusCode, 401, 'user cannot transfer');
  const agentToken = agents.createAgentSession(a.id);
  eq((await transfer([u.id], b.id, { authorization: `Bearer ${agentToken}` })).statusCode, 401, 'dealer session cannot transfer');
  for (const payload of [{ ids: [] }, { ids: [u.id] }, { ids: [u.id], targetAgentId: '' }, { ids: [u.id, 4], targetAgentId: null }, { ids: [u.id], targetAgentId: false }]) {
    eq((await request('POST', '/admin-api/users/transfer', payload)).statusCode, 400, 'invalid request rejected');
  }
  eq((await transfer([u.id], 'ag_missing')).statusCode, 404, 'unknown dealer rejected');
  agents.updateAgent(a.id, { enabled: false });
  eq((await transfer([u.id], a.id)).statusCode, 409, 'disabled dealer rejected');
  agents.updateAgent(a.id, { enabled: true });
  eq((await transfer([u.id, 'u_missing'], a.id)).statusCode, 404, 'whole batch rejects missing user');
  eq(u.agentId, undefined, 'failed batch has no partial migration');
  eq((await request('PUT', `/admin-api/users/${u.id}`, { agentId: a.id })).statusCode, 400, 'generic update cannot bypass migration');
  eq((await transfer([u.id, u.id, v.id], a.id)).json(), { ok: true, affected: 1, unchanged: 1, targetAgentId: a.id }, 'duplicates deduplicated and no-op counted');
  eq(snapshot(u), originalU, 'source to dealer preserves all other fields including credentials and fractional credits');
  eq(snapshot(v), originalV, 'already-target user stays unchanged');
  eq(users.getUser(u.id), u, 'authenticated user object retained');
  eq((await transfer([u.id, v.id], null)).json(), { ok: true, affected: 2, unchanged: 0, targetAgentId: null }, 'dealer to source batch');
  eq(snapshot(u), originalU, 'source return preserves identity and credits');
  check(!Object.hasOwn(u, 'agentId'), 'source target removes agentId property');

  // Atomic write failure: users.json.tmp is an isolated directory, causing writeFileSync to fail.
  const usersFile = new URL('../data/users.json', import.meta.url);
  const blockedTemp = fileURLToPath(new URL('../data/users.json.tmp', import.meta.url));
  const beforeDisk = readFileSync(usersFile, 'utf8');
  mkdirSync(blockedTemp);
  try { eq((await transfer([u.id, v.id], b.id)).statusCode, 500, 'disk failure reported'); }
  finally { rmdirSync(blockedTemp); }
  eq(readFileSync(usersFile, 'utf8'), beforeDisk, 'disk failure preserves durable whole batch');
  eq([u.agentId, v.agentId], [undefined, undefined], 'disk failure preserves all in-memory ownership');

  const teamCode = teams.createTeamCodes(1)[0].code;
  const teamResult = teams.createTeam({ code: teamCode, name: '迁移团队', leaderId: u.id });
  assert.ok(teamResult.ok);
  const team = teamResult.team;
  teams.inviteToTeam(team.id, v.id);
  teams.acceptInvite(team.id, v.id);
  teams.bumpGranted(team.id, v.id, 200);
  teams.updateTeam(team.id, { creditMode: 'shared' });
  const teamBefore = JSON.parse(JSON.stringify(team));
  eq((await transfer([v.id], a.id)).statusCode, 200, 'member independently migrates while keeping cross-dealer team');
  eq(JSON.parse(JSON.stringify(team)), teamBefore, 'team, shared pool mode and grant ledger preserved');
  eq([u.credits, v.credits], [1234.5, 765], 'migration does not trigger exit settlement');
  eq(u.agentId, undefined, 'unselected leader is never automatically migrated');

  // Historical charge/refund snapshots must remain valid across ownership changes.
  const billed = credits.settle({ reason: 'generate', payerId: u.id, statsUserId: v.id, userAmount: 100, agents: [{ id: a.id, cost: 10 }] });
  assert.ok(billed.ok);
  const log = logs.startLog({ req: { model: 'fixture', purpose: 'video.generate' }, userId: v.id, payerId: u.id, ownerId: a.id, cost: 100 });
  const task = tasks.createRunningTask('video', undefined, log.id);
  tasks.setTaskBilling(task.taskId, v.id, 100, [{ id: a.id, cost: 10 }], u.id);
  const billingBefore = JSON.parse(JSON.stringify(task.billing));
  const creditsBefore = [u.credits, v.credits, a.credits, b.credits];
  eq((await transfer([u.id, v.id], b.id)).statusCode, 200, 'accepted task does not block owner migration');
  eq([u.credits, v.credits, a.credits, b.credits], creditsBefore, 'in-flight transfer leaves all balances unchanged');
  eq(task.billing, billingBefore, 'in-flight charge snapshot unchanged');
  eq(log.ownerId, a.id, 'historical log keeps original dealer');
  tasks.failTask(task.taskId, 'sandbox failure');
  logs.finishLog(log.id, { status: 'failed', error: 'sandbox failure' });
  eq([u.credits, v.credits, a.credits, b.credits], [1234.5, 765, 500, 700], 'refund returns to original payer and original dealer pool');
  tasks.failTask(task.taskId, 'repeat sandbox failure');
  eq([u.credits, v.credits, a.credits, b.credits], [1234.5, 765, 500, 700], 'repeat failure does not double refund');

  agents.updateAgent(b.id, { features: { assetMode: false } });
  const login = await request('POST', '/v1/login', { account: 'transfer_user', password: 'sandbox123' }, {});
  eq(login.statusCode, 200, 'existing account and password still login after transfer');
  eq(login.json().accessKey, u.accessKey, 'accessKey preserved');
  eq(login.json().user.features.assetMode, false, 'target dealer feature gate effective after migration');
  eq(login.json().user.catalogAudience, b.id, 'login exposes target catalog audience');
  eq((await transfer([u.id], null)).statusCode, 200, 'leader can return independently');
  const me = await request('GET', '/v1/me', undefined, { authorization: `Bearer ${u.accessKey}` });
  eq(me.statusCode, 200, 'existing accessKey remains usable');
  eq(me.json().catalogAudience, 'platform', 'source return exposes platform catalog audience');
  const heartbeat = await request('POST', '/v1/heartbeat', {}, { authorization: `Bearer ${u.accessKey}` });
  eq(heartbeat.json().user.features.assetMode, true, 'heartbeat switches back to source user feature gate');
  eq(heartbeat.json().user.catalogAudience, 'platform', 'heartbeat exposes current company');

  // Equal dealer pricing versions must still invalidate cached catalogs on an ownership change.
  const madeC = agents.createAgent({ name: '目录测试丙', account: 'transfer_c', password: 'sandbox123' });
  const madeD = agents.createAgent({ name: '目录测试丁', account: 'transfer_d', password: 'sandbox123' });
  assert.ok(madeC.ok && madeD.ok);
  const c = madeC.agent, d = madeD.agent;
  eq(c.pricingVersion, d.pricingVersion, 'catalog fixture dealer pricing versions match');
  models.createModel({ id: 'transfer-platform-only', label: '源站目录测试', capability: 'text', protocol: 'openai-chat', enabled: true, shareScope: 'select', shareAgentIds: ['platform'] });
  models.createModel({ id: 'transfer-c-only', label: '渠道目录测试', capability: 'text', protocol: 'openai-chat', enabled: true, shareScope: 'select', shareAgentIds: [c.id] });
  const userHeaders = { authorization: `Bearer ${u.accessKey}` };
  const catalog = async (since = '') => request('GET', '/v1/catalog' + (since ? `?since=${encodeURIComponent(since)}` : ''), undefined, userHeaders);
  const platformCatalog = (await catalog()).json();
  check(platformCatalog.models.some(m => m.id === 'transfer-platform-only') && !platformCatalog.models.some(m => m.id === 'transfer-c-only'), 'platform model visibility');
  eq((await transfer([u.id], c.id)).statusCode, 200, 'catalog fixture source to dealer migration');
  const cResponse = await catalog(platformCatalog.version);
  eq(cResponse.statusCode, 200, 'source catalog version cannot yield 304 after dealer transfer');
  const cCatalog = cResponse.json();
  check(cCatalog.models.some(m => m.id === 'transfer-c-only') && !cCatalog.models.some(m => m.id === 'transfer-platform-only'), 'target company model visibility takes effect');
  eq((await request('POST', '/v1/generate', { model: 'transfer-platform-only', inputs: { prompt: 'sandbox' } }, userHeaders)).statusCode, 403, 'old company model rejected before generation');
  eq((await transfer([u.id], d.id)).statusCode, 200, 'cross-dealer ownership migration');
  const dResponse = await catalog(cCatalog.version);
  eq(dResponse.statusCode, 200, 'equal pricing versions across different dealers cannot yield 304');
  check(dResponse.json().version !== cCatalog.version, 'catalog version contains company identity');
  eq((await transfer([u.id], null)).statusCode, 200, 'catalog fixture dealer to source return');
  eq((await catalog(dResponse.json().version)).statusCode, 200, 'dealer cached catalog invalidated on return to source');
  eq((await request('POST', '/admin-api/users/batch-op', { ids: [u.id], op: 'setFeature', feature: 'assetMode', value: false })).json().affected, 1, 'asset video disable supported');
  users.updateUser(u.id, { features: { assetMode: false, canvasMode: false, editorMode: true } });
  eq((await request('POST', '/admin-api/users/batch-op', { ids: [u.id], op: 'setFeature', feature: 'editorMode', value: false })).json().affected, 1, 'three flags can all close because image table stays open');
  eq(agents.updateAgent(b.id, { features: { assetMode: false, canvasMode: false, editorMode: false } }).ok, true, 'dealer can close all three flags');
  users.updateUser(v.id, { features: { assetMode: false, canvasMode: false, editorMode: true } });
  const bToken = agents.createAgentSession(b.id);
  eq((await request('POST', '/agent-api/users/batch-op', { ids: [v.id], op: 'setFeature', feature: 'editorMode', value: false }, { authorization: `Bearer ${bToken}` })).json().affected, 1, 'dealer user batch may close all three flags');
  agents.updateAgent(b.id, { features: { assetMode: true, canvasMode: false, editorMode: false } });
  const mixedGate = agents.applyAgentFeatureGate(b.id, { assetMode: false, canvasMode: true, editorMode: false });
  eq([mixedGate.assetMode, mixedGate.canvasMode, mixedGate.editorMode], [false, false, false], 'AND gate never reopens asset video as fallback');
  agents.updateAgent(b.id, { features: { assetMode: false } });
  eq(agents.applyAgentFeatureGate(b.id, { assetMode: true }).assetMode, false, 'dealer denial overrides individual enable');
  const relay = fastify();
  config.role = 'relay';
  try {
    await registerAdminRoutes(relay);
    eq((await relay.inject({ method: 'POST', url: '/admin-api/users/transfer', payload: { ids: [u.id], targetAgentId: a.id }, headers: admin })).statusCode, 403, 'relay administrator cannot transfer');
  } finally { config.role = 'source'; await relay.close(); }
  eq(JSON.parse(JSON.stringify(team)), teamBefore, 'leader migration leaves exact original team intact');
  await flushPendingSaves();
  writeFileSync(new URL('../.qiji-user-transfer-expected.json', import.meta.url), JSON.stringify(users.listUsers()));
  console.log(`USER_TRANSFER_SMOKE_PASSED ${checks}/${checks}`);
} finally {
  await app.close();
  await flushPendingSaves();
  closeSqlite();
}
