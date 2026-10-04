import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';

if (!import.meta.url.includes('/qiji-routing-toggle-')) throw new Error('Sandbox only');
const phase = process.argv[2];
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const reference = 'https://fixture.invalid/reference.png';
const calls = [];
globalThis.fetch = async (url, init = {}) => {
  const call = { url: String(url), method: init.method ?? 'GET', body: init.body };
  calls.push(call);
  if (call.url === reference) return new Response(call.method === 'HEAD' ? null : png, { headers: { 'content-type': 'image/png', 'content-length': String(png.length) } });
  if (/^https:\/\/fixture\.invalid\/(aisc|yali)\/v1beta\/models\/gemini-3-pro-image-preview:generateContent$/.test(call.url)) {
    return Response.json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: png.toString('base64') } }] } }] });
  }
  throw new Error('Sandbox blocked unexpected network: ' + call.url);
};
let checks = 0;
const eq = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks++; };
const ok = (value, message) => { assert.ok(value, message); checks++; };
const routing = await import('../src/autoRouting.ts');
const migration = await import('../src/routeOnlyMigration.ts');
const db = await import('../src/store/db.ts');
const sqlite = await import('../src/store/sqlite.ts');
const snapshotFile = 'data/routing-toggle-snapshot.json';

if (phase !== 'requests') {
  try {
    const before = JSON.parse(fs.readFileSync(snapshotFile, 'utf8'));
    eq(routing.routingConfig(), before, 'load retains the saved false switch and complete config');
    eq(routing.routingEnabled(), false, 'restart does not re-enable automatic routing');
    migration.migrateRouteOnlyCatalog();
    const after = routing.routingConfig();
    eq(after.enabled, false, 'route-only migration retains disabled switch');
    for (const line of before.lines) eq(after.lines.find(item => item.id === line.id), line, 'migration retains existing line and prices ' + line.id);
    if (phase === 'restart-stable') eq(after, before, 'second migration is completely idempotent');
    else eq(after.routeOnlyVersion, 1, 'first restart runs pending migration');
    fs.writeFileSync(snapshotFile, JSON.stringify(after));
    console.log('ROUTING_TOGGLE ' + phase + ': ' + checks + ' checks passed');
  } finally { db.flushPendingSaves(); sqlite.closeSqlite(); }
} else {
  const models = await import('../src/store/models.ts');
  const channels = await import('../src/store/channels.ts');
  const users = await import('../src/store/users.ts');
  const tasks = await import('../src/store/tasks.ts');
  const logs = await import('../src/store/logs.ts');
  const modes = await import('../src/store/modes.ts');
  const credits = await import('../src/store/credits.ts');
  const { default: Fastify } = await import('fastify');
  const app = Fastify();
  await app.register((await import('../src/routes.ts')).registerRoutes);
  await app.register((await import('../src/routes/admin.ts')).registerAdminRoutes);
  await app.ready();
  const admin = { authorization: 'Bearer routing-toggle-admin' };
  const upstreamModel = 'gemini-3-pro-image-preview';
  const modelIds = ['fixture-aisc-banana', 'fixture-yali-banana'];
  const lineId = 'fixture-banana-stable';
  const routeId = 'route:' + lineId;
  const member = modelId => ({ modelId, enabled: true, vipEnabled: false, priority: 0, concurrencyWeight: 1, failureThreshold: 3, failureWindowSec: 300, cooldownSec: 300, failureRetainPercent: 50, defaults: {} });
  try {
    channels.updateChannel('ch-gaisc', { apiKey: 'fixture-key', baseUrl: 'https://fixture.invalid/aisc', enabled: true });
    channels.updateChannel('ch-yali-openai', { apiKey: 'fixture-key', baseUrl: 'https://fixture.invalid/yali', enabled: true });
    eq(modes.createMode({ id: 'fixture-direct', name: 'Fixture direct' }).ok, true, 'create direct mode');
    for (const [index, id] of modelIds.entries()) models.createModel({
      id, label: id, capability: 'image', protocol: index ? 'yali-image' : 'gemini-image',
      channelId: index ? 'ch-yali-openai' : 'ch-gaisc', familyId: 'fam-nano-banana-pro', modeId: 'fixture-direct',
      upstreamModel, enabled: true, shareScope: 'all', cost: 99, imageMaterialMode: 'direct', saveToOss: false,
      params: [
        { key: 'resolution', label: '分辨率', type: 'enum', options: ['1k', '2k'], default: '2k' },
        { key: 'aspect_ratio', label: '比例', type: 'enum', options: ['16:9', '1:1'], default: '16:9' },
      ],
      routes: [{ when: { resolution: '1k' }, upstreamModel, cost: 11 + index }, { when: { resolution: '2k' }, upstreamModel, cost: 23 + index }],
    });
    const user = users.createUser({ name: 'Routing toggle sandbox', credits: 1000 });
    const headers = { authorization: 'Bearer ' + user.accessKey, 'x-device-id': 'routing-toggle-sandbox' };
    const catalog = async () => { const response = await app.inject({ url: '/v1/catalog', headers }); eq(response.statusCode, 200, 'catalog available'); return response.json(); };
    const request = (model, resolution = '2k') => ({ model, purpose: 'image.generate', promptOverride: '保留参考图主体', materialPolicyKey: 'url', params: { aspect_ratio: '16:9', resolution, quality: 'high' }, inputs: { images: [{ id: 'fixture-ref', name: '垫图', url: reference }] }, output: { format: 'assets' } });
    const generate = payload => app.inject({ method: 'POST', url: '/v1/generate', headers, payload });
    const balance = () => users.getUser(user.id).credits;
    async function availability(id, enabled, reason) {
      const response = await app.inject({ url: '/admin-api/channel-availability', headers: admin });
      eq(response.statusCode, 200, reason + ': availability endpoint succeeds');
      const row = response.json().rows.find(item => item.modelId === id);
      ok(row, reason + ': model availability row exists');
      eq(row.enabled, enabled, reason + ': availability enabled');
      eq(row.status === 'disabled', !enabled, reason + ': availability disabled status');
      const history = await app.inject({ url: '/admin-api/models/' + id + '/rate-history?target=model', headers: admin });
      eq(history.statusCode, 200, reason + ': model history endpoint succeeds');
      eq(history.json().active, enabled, reason + ': model history active');
    }
    async function terminal(taskId) {
      for (let index = 0; index < 300; index++) {
        const task = tasks.getTaskState(taskId);
        if (['success', 'failed'].includes(task?.status)) return task;
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      throw new Error('Task did not finish: ' + taskId);
    }
    async function save(config) {
      const response = await app.inject({ method: 'PUT', url: '/admin-api/auto-routing', headers: admin, payload: config });
      eq(response.statusCode, 200, 'save routing config ' + response.body);
      return response.json().config;
    }
    async function reject(model, reason) {
      const before = balance(), callCount = calls.length;
      const response = await generate(request(model));
      ok([400, 403].includes(response.statusCode), reason + ': rejected before dispatch ' + response.body);
      eq(balance(), before, reason + ': no charge');
      eq(calls.length, callCount, reason + ': no upstream or image download');
    }
    // Keep the fixture focused on one family, including the pending first-start migration.
    const deletedFamilyIds = [...new Set(models.listModels().map(model => routing.seedanceFamilyOf(model)).filter(id => id && id !== 'fam-nano-banana-pro'))];
    let config = await save({ ...routing.routingConfig(), deletedFamilyIds, enabled: true, lines: [{
      id: lineId, name: '稳定', familyId: 'fam-nano-banana-pro', modelVersion: 'fam-nano-banana-pro', capability: 'image',
      enabled: true, cost: 77, prices: [{ when: { resolution: '1k' }, cost: 77 }, { when: { resolution: '2k' }, cost: 88 }],
      members: modelIds.map(member),
    }] });
    const savedLines = structuredClone(config.lines);
    const onCatalog = await catalog();
    ok(onCatalog.models.some(model => model.id === routeId), 'ON exposes route');
    ok(onCatalog.models.every(model => model.id.startsWith('route:')), 'ON exposes only route models');
    for (const id of modelIds) await reject(id, 'ON raw model ' + id);
    for (const id of modelIds) await availability(id, true, 'ON bound candidate ' + id);
    models.updateModel(modelIds[0], { enabled: false });
    await availability(modelIds[0], true, 'ON binding remains authoritative over raw enabled flag');
    models.updateModel(modelIds[0], { enabled: true });
    const enabledEdit = await app.inject({ method: 'PUT', url: '/admin-api/models/' + modelIds[0], headers: admin, payload: { enabled: false } });
    eq(enabledEdit.statusCode, 400, 'ON refuses original-model enable edit');
    eq(models.getModelDef(modelIds[0]).enabled, true, 'rejected original-model edit has no mutation');
    const routedBefore = balance();
    const routedResponse = await generate(request(routeId));
    eq(routedResponse.statusCode, 200, 'ON routed request accepted');
    eq((await terminal(routedResponse.json().taskId)).status, 'success', 'ON routed task succeeds');
    eq(routedBefore - balance(), 88, 'ON charges the line resolution price');
    const routedMeta = logs.listLogs({ userIds: [user.id], limit: 100 }).items.find(log => log.taskId === routedResponse.json().taskId);
    const routedLog = logs.getLog(routedMeta.id);
    eq(routedLog.model, routeId, 'ON log keeps public route id');
    eq(routedLog.routing.lineId, lineId, 'ON log has routing ticket');
    ok(modelIds.includes(routedLog.routing.modelId), 'ON selects one of the configured channels');
    config = await save({ ...config, enabled: false });
    eq(routing.routingEnabled(), false, 'save disables in-memory routing');
    eq(config.lines, savedLines, 'disable retains lines and prices');
    const offCatalog = await catalog();
    ok(onCatalog.version !== offCatalog.version, 'toggle changes catalog version');
    eq(offCatalog.routedFamilies, undefined, 'OFF does not mark raw families as routed');
    ok(offCatalog.models.every(model => !model.id.startsWith('route:')), 'OFF hides routes');
    for (const id of modelIds) {
      const model = offCatalog.models.find(item => item.id === id);
      ok(model, 'OFF exposes original model ' + id);
      eq(model.materialPolicy.kind, 'url', 'original model preserves client URL preparation policy');
      eq(model.params.map(param => param.key), ['aspect_ratio', 'resolution', 'quality'], 'original image keeps public params');
      await availability(id, true, 'OFF enabled original model ' + id);
    }
    await reject(routeId, 'OFF stale route id');
    const materialResponse = await app.inject({ method: 'POST', url: '/v1/materials/prepare', headers, payload: { model: modelIds[0], asset: { id: 'fixture-ref', url: reference }, action: 'inspect' } });
    eq(materialResponse.statusCode, 400, 'OFF original model reaches material protocol validation');
    ok(materialResponse.json().error.message.includes('人像素材库'), 'ordinary image preparation fails for protocol, not raw-model access');
    for (const [index, id] of modelIds.entries()) for (const resolution of ['1k', '2k']) {
      const before = balance(), start = calls.length;
      const response = await generate(request(id, resolution));
      eq(response.statusCode, 200, 'direct accepted ' + id + ': ' + response.body);
      eq((await terminal(response.json().taskId)).status, 'success', 'direct task succeeds ' + id);
      const expectedCost = (resolution === '1k' ? 11 : 23) + index;
      eq(before - balance(), expectedCost, 'direct uses model resolution price, not line price');
      const currentCalls = calls.slice(start);
      ok(currentCalls.some(call => call.url === reference && call.method === 'GET'), 'server downloads client reference URL');
      const upstreamCalls = currentCalls.filter(call => call.url.includes(':generateContent'));
      eq(upstreamCalls.length, 1, 'exactly one upstream generation');
      const body = JSON.parse(upstreamCalls[0].body);
      const parts = body.contents[0].parts;
      eq(parts.filter(part => part.inlineData).length, 1, 'reference carried as inlineData');
      const inline = parts.find(part => part.inlineData).inlineData;
      eq(Buffer.from(inline.data, 'base64'), png, 'base64 bytes equal downloaded reference');
      eq(inline.mimeType, 'image/png', 'reference mime retained');
      eq(parts.some(part => part.fileData || part.file_data), false, 'direct native request contains no URL parts');
      eq(body.generationConfig.imageConfig, { aspectRatio: '16:9', imageSize: resolution.toUpperCase() }, 'native image params retain ratio and resolution');
      const meta = logs.listLogs({ userIds: [user.id], limit: 100 }).items.find(log => log.taskId === response.json().taskId);
      ok(meta, 'direct request log exists');
      const log = logs.getLog(meta.id);
      eq(log.model, id, 'direct log keeps original model id');
      eq(log.routing, undefined, 'direct log has no routing ticket');
      eq(log.cost, expectedCost, 'direct log records original model price');
      eq(log.upstreamRequest.wire.images[0].sha256, createHash('sha256').update(png).digest('hex'), 'wire diagnostic matches sent reference bytes');
    }
    const fixture = modelIds[0];
    const disabledEdit = await app.inject({ method: 'PUT', url: '/admin-api/models/' + fixture, headers: admin, payload: { enabled: false } });
    eq(disabledEdit.statusCode, 200, 'OFF permits original-model enable edit');
    eq((await catalog()).models.some(model => model.id === fixture), false, 'OFF hides disabled model');
    await reject(fixture, 'disabled model');
    await availability(fixture, false, 'OFF disabled original model');
    models.updateModel(fixture, { enabled: true });
    channels.updateChannel('ch-gaisc', { enabled: false });
    eq((await catalog()).models.some(model => model.id === fixture), false, 'OFF hides disabled channel');
    await reject(fixture, 'disabled channel');
    await availability(fixture, false, 'OFF disabled original channel');
    channels.updateChannel('ch-gaisc', { enabled: true });
    const originalRoutes = structuredClone(models.getModelDef(fixture).routes);
    models.updateModel(fixture, { routes: originalRoutes.map(route => ({ ...route, channelId: 'ch-yali-openai' })) });
    channels.updateChannel('ch-yali-openai', { enabled: false });
    await reject(fixture, 'disabled redirected channel');
    channels.updateChannel('ch-yali-openai', { enabled: true });
    models.updateModel(fixture, { routes: originalRoutes });
    models.updateModel(fixture, { shareScope: 'none' });
    eq((await catalog()).models.some(model => model.id === fixture), false, 'OFF hides private model');
    await reject(fixture, 'private model');
    models.updateModel(fixture, { shareScope: 'all' });
    modes.updateMode('fixture-direct', { enabled: false });
    eq((await catalog()).models.some(model => model.id === fixture), false, 'OFF hides globally disabled mode');
    await reject(fixture, 'globally disabled mode');
    modes.updateMode('fixture-direct', { enabled: true });
    const beforeUserGate = await catalog();
    users.updateUser(user.id, { features: { modes: { 'fixture-direct': false } } });
    const userDisabledCatalog = await catalog();
    eq(userDisabledCatalog.models.some(model => model.id === fixture), false, 'OFF hides user-disabled mode');
    ok(userDisabledCatalog.version !== beforeUserGate.version, 'only changing user mode gate changes catalog version');
    const gateRefresh = await app.inject({ url: '/v1/catalog?since=' + encodeURIComponent(beforeUserGate.version), headers });
    eq(gateRefresh.statusCode, 200, 'user mode gate changes do not return stale catalog 304');
    await reject(fixture, 'user-disabled mode');
    users.updateUser(user.id, { features: {} });
    config = await save({ ...routing.routingConfig(), enabled: true });
    eq(config.lines, savedLines, 're-enable restores identical line prices and members');
    ok((await catalog()).models.some(model => model.id === routeId), 're-enable restores route catalog');
    for (const id of modelIds) await availability(id, true, 're-enabled bound candidate ' + id);
    await reject(fixture, 're-enabled raw model');
    config = await save({ ...config, enabled: false });
    eq(config.lines, savedLines, 'final disable retains configuration');
    const loaded = await app.inject({ url: '/admin-api/auto-routing', headers: admin });
    eq(loaded.json().config.enabled, false, 'admin readback reports disabled');
    eq(loaded.json().initial.enabled, false, 'admin initial draft cannot re-enable switch');
    for (const operation of credits.listCreditOps({ accountId: user.id, limit: 100 })) for (const account of operation.accounts) eq(account.pre + account.delta, account.post, 'credit ledger arithmetic');
    fs.writeFileSync(snapshotFile, JSON.stringify(config));
    eq(config.routeOnlyVersion, undefined, 'restart fixture exercises pending route-only migration');
    console.log('ROUTING_TOGGLE requests: ' + checks + ' checks passed');
  } finally { await app.close(); db.flushPendingSaves(); sqlite.closeSqlite(); }
}
