import assert from 'node:assert/strict';

if (!import.meta.url.includes('/qiji-routing-passthrough-')) throw new Error('Sandbox only');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
// Distinct valid PNG payloads retain an identifying trailing byte for order assertions.
const references = Array.from({ length: 6 }, (_, i) => ({
  url: `https://fixture.invalid/reference-${i}.png`,
  bytes: Buffer.concat([png, Buffer.from([i])]),
}));
const calls = [];
globalThis.fetch = async (url, init = {}) => {
  const call = { url: String(url), method: init.method ?? 'GET', body: init.body };
  calls.push(call);
  const ref = references.find(item => item.url === call.url);
  if (ref) return new Response(call.method === 'HEAD' ? null : ref.bytes, { headers: { 'content-type': 'image/png', 'content-length': String(ref.bytes.length) } });
  if (/^https:\/\/fixture\.invalid\/(aisc|yali)\/v1beta\/models\/gemini-3-pro-image-preview:generateContent$/.test(call.url)) {
    return Response.json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: png.toString('base64') } }] } }] });
  }
  throw new Error('Sandbox blocked unexpected network: ' + call.url);
};
let checks = 0;
const eq = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks++; };
const ok = (actual, message) => { assert.ok(actual, message); checks++; };
const freeze = value => {
  if (value && typeof value === 'object') { Object.freeze(value); for (const item of Object.values(value)) freeze(item); }
  return value;
};
const routing = await import('../src/autoRouting.ts');
const models = await import('../src/store/models.ts');
const channels = await import('../src/store/channels.ts');
const users = await import('../src/store/users.ts');
const tasks = await import('../src/store/tasks.ts');
const logs = await import('../src/store/logs.ts');
const db = await import('../src/store/db.ts');
const sqlite = await import('../src/store/sqlite.ts');
const { default: Fastify } = await import('fastify');
const app = Fastify();
await app.register((await import('../src/routes.ts')).registerRoutes);
await app.ready();

const upstreamModel = 'gemini-3-pro-image-preview';
const modelIds = ['fixture-passthrough-aisc', 'fixture-passthrough-yali'];
const lineId = 'fixture-passthrough-line';
const routeId = 'route:' + lineId;
const member = modelId => ({ modelId, enabled: true, vipEnabled: false, priority: 0, concurrencyWeight: 1, failureThreshold: 3, failureWindowSec: 300, cooldownSec: 300, failureRetainPercent: 50, defaults: { model_default: 19 } });
let config;
const save = changes => (config = routing.saveRoutingConfig({ ...(config ?? routing.routingConfig()), ...changes }));
const request = (model, params = {}) => ({
  model, purpose: 'image.generate', promptOverride: '逐张保留六份参考图，不得更换衣服。', materialPolicyKey: 'url',
  params,
  inputs: { images: references.map((ref, i) => ({ id: 'fixture-ref-' + i, name: '垫图' + i, url: ref.url, usage: 'identity', custom: { position: i } })) },
  variables: { subject: '六个人', extension: { nested: [false, null, 0, ''] } },
  output: { format: 'assets' },
});

try {
  channels.updateChannel('ch-gaisc', { apiKey: 'fixture-key', baseUrl: 'https://fixture.invalid/aisc', enabled: true });
  channels.updateChannel('ch-yali-openai', { apiKey: 'fixture-key', baseUrl: 'https://fixture.invalid/yali', enabled: true });
  for (const [index, id] of modelIds.entries()) {
    models.createModel({ id, label: id, capability: 'image', protocol: index ? 'yali-image' : 'gemini-image',
      channelId: index ? 'ch-yali-openai' : 'ch-gaisc', familyId: 'fam-nano-banana-pro',
      upstreamModel, enabled: true, shareScope: 'all', cost: 99, imageMaterialMode: 'direct', saveToOss: false,
      params: [
        { key: 'resolution', label: '分辨率', type: 'enum', options: ['1k', '2k', '4k'], default: '1k' },
        { key: 'aspect_ratio', label: '比例', type: 'enum', options: ['16:9', '1:1'], default: '1:1' },
        { key: 'model_default', label: '上游默认值', type: 'number', default: 7 },
      ],
      routes: [{ when: { resolution: '1k' }, upstreamModel, cost: 11 + index }, { when: { resolution: '2k' }, upstreamModel, cost: 23 + index }, { when: { resolution: '4k' }, upstreamModel, cost: 43 + index }],
    });
  }
  save({ enabled: true, lines: [{ id: lineId, name: '透传测试', familyId: 'fam-nano-banana-pro', modelVersion: 'fam-nano-banana-pro', capability: 'image',
    enabled: true, cost: 101, prices: [{ when: { resolution: '1k' }, cost: 37 }, { when: { resolution: '2k' }, cost: 59 }, { when: { resolution: '4k' }, cost: 83 }],
    members: [member(modelIds[0])],
  }] });

  const passParams = {
    aspect_ratio: '16:9', resolution: '2k', quality: 'high',
    provider_extension: { referenceWeight: 0.88, flags: [false, null, 0, ''], mapping: { alpha: 'β' } },
    generationConfig: { temperature: 0.43, seed: 67891, imageConfig: { imageSize: '2K', aspectRatio: '16:9', providerImageControl: { strength: 0.7 } }, customGenerationField: ['retain', 0] },
    model: 'unrelated-provider-field', cost: 0, __refVideoBillingSeconds: 999999,
  };
  for (const params of [passParams, {}, undefined]) {
    const req = request(routeId, structuredClone(params));
    if (params === undefined) delete req.params;
    const snapshot = structuredClone(req);
    freeze(req);
    eq(routing.prepareRoutingRequest(req), undefined, 'prepare accepts arbitrary params without write');
    eq(req, snapshot, 'prepare leaves entire request byte-equivalent');
    const selected = routing.selectRoute(req);
    eq(selected.request, { ...snapshot, model: modelIds[0] }, 'select changes only logical model id');
    eq(req, snapshot, 'select does not mutate source request');
    eq(selected.request.params?.model_default, undefined, 'neither model nor member defaults injected');
    eq(selected.request.inputs, snapshot.inputs, 'all reference metadata retained');
    eq(selected.request.variables, snapshot.variables, 'nested variables retained');
  }
  const aliased = request(routeId, { generationConfig: { imageConfig: { imageSize: '4K', aspectRatio: '16:9' } }, cost: 0, __refVideoBillingSeconds: 999999 });
  const billingView = routing.routingBillingParams(aliased);
  eq(billingView.resolution, '4k', 'native imageSize drives the routing billing view');
  eq(billingView.__refVideoBillingSeconds, undefined, 'untrusted reference billing marker excluded from billing view');
  eq(aliased.params.__refVideoBillingSeconds, 999999, 'billing view does not alter original params');
  eq(models.resolveModelCost(routing.publicModelDef(routeId), billingView), 83, 'native size uses matching line resolution price, ignoring params.cost');
  const videoPrice = { id: 'route:test-video-price', capability: 'video', cost: 100, routes: [{ when: { duration: '5', resolution: '720p' }, cost: 100 }], refVideoSecondsWeight: 0.5 };
  const fakeVideo = { model: 'route:test-video-price', params: { duration: 5, resolution: '720p', cost: 0, __refVideoBillingSeconds: 999999 } };
  eq(models.resolveModelCost(videoPrice, routing.routingBillingParams(fakeVideo)), 100, 'forged reference-video marker cannot raise or reduce configured video billing');

  const user = users.createUser({ name: 'Routing passthrough sandbox', credits: 10000 });
  const headers = { authorization: 'Bearer ' + user.accessKey, 'x-device-id': 'routing-passthrough-sandbox' };
  const generate = payload => app.inject({ method: 'POST', url: '/v1/generate', headers, payload });
  const balance = () => users.getUser(user.id).credits;
  const terminal = async taskId => {
    for (let i = 0; i < 500; i++) {
      const task = tasks.getTaskState(taskId);
      if (['success', 'failed'].includes(task?.status)) return task;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error('Task did not finish: ' + taskId);
  };
  const reject = async (req, reason) => {
    const before = balance(), callCount = calls.length;
    const response = await generate(req);
    ok([400, 403].includes(response.statusCode), reason + ': rejected ' + response.body);
    eq(balance(), before, reason + ': no charge');
    eq(calls.length, callCount, reason + ': no upstream fetch');
  };
  await reject(request(modelIds[0], passParams), 'ON raw-model permission');
  users.updateUser(user.id, { features: { modes: { [routeId]: false } } });
  await reject(request(routeId, passParams), 'ON user line gate');
  users.updateUser(user.id, { features: {} });
  await reject(request(routeId, { resolution: '1k', generationConfig: { imageConfig: { imageSize: '4K' } } }), 'conflicting native/public resolution');

  for (const [modelIndex, id] of modelIds.entries()) {
    save({ enabled: true, lines: config.lines.map(line => ({ ...line, members: [member(id)] })) });
    const byMode = {};
    for (const enabled of [true, false]) {
      save({ enabled });
      const params = structuredClone(passParams);
      // Native-only sizing must retain the exact nested shape and use the 2K price.
      delete params.resolution;
      delete params.aspect_ratio;
      const req = request(enabled ? routeId : id, params), before = balance(), start = calls.length;
      const response = await generate(req);
      eq(response.statusCode, 200, `${id} routing=${enabled}: accepted arbitrary native params ${response.body}`);
      const task = await terminal(response.json().taskId);
      eq(task.status, 'success', `${id} routing=${enabled}: successful mock generation`);
      const expected = enabled ? 59 : 23 + modelIndex;
      eq(before - balance(), expected, `${id} routing=${enabled}: actual native 2K price ignores forged cost`);
      const upstreamCalls = calls.slice(start).filter(call => call.url.includes(':generateContent'));
      eq(upstreamCalls.length, 1, 'exactly one upstream submission');
      const body = JSON.parse(upstreamCalls[0].body), parts = body.contents[0].parts;
      eq(parts[0].text, req.promptOverride, 'prompt retained');
      const images = parts.filter(part => part.inlineData);
      eq(images.length, 6, 'all six references sent as inlineData');
      for (const [index, image] of images.entries()) {
        eq(Buffer.from(image.inlineData.data, 'base64'), references[index].bytes, 'reference bytes and order ' + index);
        eq(image.inlineData.mimeType, 'image/png', 'reference MIME ' + index);
      }
      eq(body.generationConfig.temperature, params.generationConfig.temperature, 'native temperature retained');
      eq(body.generationConfig.seed, params.generationConfig.seed, 'native seed retained');
      eq(body.generationConfig.imageConfig, params.generationConfig.imageConfig, 'native imageConfig including nested extension retained');
      eq(body.generationConfig.customGenerationField, params.generationConfig.customGenerationField, 'unknown native generation config retained');
      const index = logs.listLogs({ userIds: [user.id], limit: 100 }).items.find(log => log.taskId === response.json().taskId);
      const detail = logs.getLog(index.id);
      eq(detail.request.params, req.params, 'logged client params retain full original request');
      eq(detail.request.inputs, req.inputs, 'logged client reference metadata remains untouched');
      eq(detail.cost, expected, 'request log uses actual configured price');
      eq(!!detail.routing, enabled, 'routing ticket follows switch');
      byMode[String(enabled)] = body;
      for (const [resolution, lineCost, directCost] of [['1k', 37, 11], ['4k', 83, 43]]) {
        const sizeParams = {
          temperature: 0.28, seed: 413, reference_strength: 0.95, cost: -500,
          generationConfig: { imageConfig: { imageSize: resolution.toUpperCase(), aspectRatio: '16:9' } },
        };
        const sizedReq = request(enabled ? routeId : id, sizeParams), sizedBefore = balance(), sizedStart = calls.length;
        const sizedResponse = await generate(sizedReq);
        eq(sizedResponse.statusCode, 200, `${id} routing=${enabled}: native-only ${resolution} accepted`);
        eq((await terminal(sizedResponse.json().taskId)).status, 'success', `${id}: ${resolution} mock succeeds`);
        eq(sizedBefore - balance(), enabled ? lineCost : directCost + modelIndex, `${id} routing=${enabled}: native-only ${resolution} actual charge`);
        const sizedCalls = calls.slice(sizedStart).filter(call => call.url.includes(':generateContent'));
        eq(sizedCalls.length, 1, 'one native-only sized upstream request');
        const sizedBody = JSON.parse(sizedCalls[0].body);
        eq(sizedBody.generationConfig.imageConfig, sizeParams.generationConfig.imageConfig, 'native-only sizing preserved at upstream boundary');
        eq(sizedBody.generationConfig.temperature, sizeParams.temperature, 'top-level temperature mapped to native config');
        eq(sizedBody.generationConfig.seed, sizeParams.seed, 'top-level seed mapped to native config');
      }
    }
    eq(byMode.true, byMode.false, id + ': routing and direct serialize identical upstream bodies');
  }
  await reject(request(routeId, passParams), 'OFF stale route');
  models.updateModel(modelIds[0], { enabled: false });
  await reject(request(modelIds[0], passParams), 'OFF disabled raw model');
  models.updateModel(modelIds[0], { enabled: true, shareScope: 'none' });
  await reject(request(modelIds[0], passParams), 'OFF private raw model');
  models.updateModel(modelIds[0], { shareScope: 'all' });
  channels.updateChannel('ch-gaisc', { enabled: false });
  await reject(request(modelIds[0], passParams), 'OFF disabled channel');

  const videoModelId = 'fixture-passthrough-video', videoRouteId = 'route:fixture-video-line';
  models.createModel({
    id: videoModelId, label: '视频缺参校验', capability: 'video', protocol: 'longyou-video',
    channelId: 'ch-yali-openai', familyId: 'fam-seedance', upstreamModel: 'videos-standard',
    enabled: true, shareScope: 'all', cost: 300, costField: 'duration', costPerUnit: 20,
    params: [
      { key: 'duration', label: '时长', type: 'number', min: 4, max: 15, default: 5 },
      { key: 'resolution', label: '分辨率', type: 'enum', options: ['720p', '1080p'], default: '720p' },
      { key: 'aspect_ratio', label: '比例', type: 'enum', options: ['16:9', '1:1'], default: '16:9' },
    ],
  });
  const directVideo = freeze({ model: videoModelId, purpose: 'video.generate', params: { vendorExtension: { unchanged: true } } });
  eq(routing.routingBillingParams(directVideo), directVideo.params, 'direct non-image billing does not inject catalog defaults');
  eq(models.resolveModelCost(models.getModelDef(videoModelId), routing.routingBillingParams(directVideo)), 300, 'direct missing duration keeps legacy fixed fallback, not 5-second default charge');
  save({ enabled: true, lines: [...config.lines, {
    id: 'fixture-video-line', name: '视频价格', familyId: 'fam-seedance', modelVersion: '2.0', capability: 'video',
    enabled: true, cost: 300, prices: [{ when: { duration: '5', resolution: '720p' }, cost: 100 }, { when: { duration: '5', resolution: '1080p' }, cost: 150 }],
    members: [{ ...member(videoModelId), defaults: {} }],
  }] });
  for (const missing of [undefined, null, '', '  ']) {
    const req = { model: videoRouteId, purpose: 'video.generate', promptOverride: '保持原请求', params: { resolution: '720p', aspect_ratio: '16:9', ...(missing === undefined ? {} : { duration: missing }) } };
    const snapshot = structuredClone(req);
    const error = routing.prepareRoutingRequest(freeze(req));
    ok(error?.includes('时长'), 'route video missing/blank duration rejected explicitly');
    eq(req, snapshot, 'missing-duration rejection leaves request untouched');
    await reject(snapshot, 'missing route video duration ' + String(missing));
  }
  await reject({ model: videoRouteId, purpose: 'video.generate', params: { duration: 5, aspect_ratio: '16:9' } }, 'missing price-dependent video resolution');
  const completeVideo = freeze({
    model: videoRouteId, purpose: 'video.generate', promptOverride: '完整保留视频参数',
    params: { duration: 5, resolution: '1080p', aspect_ratio: '16:9', providerExtension: { seed: 999, falseValue: false } },
  });
  eq(routing.prepareRoutingRequest(completeVideo), undefined, 'explicit video pricing fields accepted');
  eq(routing.selectRoute(completeVideo).request, { ...completeVideo, model: videoModelId }, 'explicit video fields are preserved; no defaults injected');
  eq(models.resolveModelCost(routing.publicModelDef(videoRouteId), routing.routingBillingParams(completeVideo)), 150, 'explicit video duration/resolution charged by selected tier');
  console.log('ROUTING_PASSTHROUGH: ' + checks + ' checks passed; all network mocked, all state isolated');
} finally {
  await app.close();
  db.flushPendingSaves();
  sqlite.closeSqlite();
}
