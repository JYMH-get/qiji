// Run only from an isolated mirror created by scripts/test-007.ps1.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const marker = fileURLToPath(new URL('../.qiji-007-sandbox', import.meta.url));
assert.ok(existsSync(marker), 'Refusing to import stores outside the marked sandbox');

let checks = 0;
function check(value, label) { assert.ok(value, label); checks++; }
const phase = process.argv[2] || 'full';
const base = 'https://env-00jy6ktfybhu.dev-hz.cloudbasefunction.cn/gateway';
const key = 'ic_live_sandbox_007_key_do_not_use';
const up = { baseUrl: base, apiKey: key, upstreamModel: 'seedance-2.5' };
const up20 = { ...up, upstreamModel: 'seedance-2.0' };
const videoModelIds = ['007-sd2.5', '007-sd2.0'];
const standard = () => ({ id: 'seedance-2.5', capability: 'video', parameters: {
  durations: Array.from({ length: 27 }, (_, i) => i + 4), resolutions: ['480p', '720p'],
  ratios: ['1:1', '3:4', '4:3', '9:16', '16:9', '21:9'],
  maxImages: 30, maxVideos: 10, maxAudios: 10, maxPromptChars: 15000,
} });
const seedance20 = () => ({ id: 'seedance-2.0', capability: 'video', parameters: {
  durations: Array.from({ length: 12 }, (_, i) => i + 4), resolutions: ['480p', '720p', '1080p', '4k'],
  ratios: ['1:1', '3:4', '4:3', '9:16', '16:9', '21:9', 'adaptive'],
  maxImages: 9, maxVideos: 3, maxAudios: 3, maxPromptChars: 5000, minVisualMaterials: 1,
}, pricing: { unit: 'request', resolutionPoints: { '480p': 58, '720p': 58, '1080p': 58, '4k': 58 } } });
let directory, posts, polls, calls, records, unexpected;
function reset() { directory = [standard()]; posts = []; polls = []; calls = []; records = []; unexpected = []; }
function reset20() { reset(); directory = [seedance20()]; }
reset();
const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
globalThis.fetch = async (url, init = {}) => {
  const call = { url: String(url), method: init.method || 'GET', headers: new Headers(init.headers), body: init.body };
  calls.push(call);
  let value;
  if (call.url === `${base}/v1/models` && call.method === 'GET') value = { data: directory };
  else if (call.url === `${base}/v1/videos` && call.method === 'POST') value = posts.shift() ?? { data: { id: 'job_sandbox_007', status: 'reserved' } };
  else if (call.url.startsWith(`${base}/v1/jobs/`) && call.method === 'GET') value = polls.shift() ?? { data: { status: 'completed', result: { url: 'https://cdn.example.com/007.mp4' } } };
  else { unexpected.push(call.url); throw new Error(`Sandbox blocks unexpected fetch: ${call.url}`); }
  if (value instanceof Error) throw value;
  if (value instanceof Response) return value;
  return response(value, call.method === 'POST' ? 202 : 200);
};

const models = await import('../src/store/models.ts');
const channels = await import('../src/store/channels.ts');
const modes = await import('../src/store/modes.ts');
const protocols = await import('../src/store/protocols.ts');
const model = models.getModelDef('007-sd2.5');
const model20 = models.getModelDef('007-sd2.0');
if (phase === 'tombstones') {
  for (const id of videoModelIds) check(!models.getModelDef(id), `deleted ${id} model stays absent`);
  check(!channels.listChannels().some(c => c.id === 'ch-007'), 'deleted channel stays absent');
  check(!modes.listModes().some(m => m.id === '007'), 'deleted mode stays absent');
} else {
  check(!!model, '007 model seeded');
  check(model.protocol === 'zero007-video' && model.upstreamModel === 'seedance-2.5', 'protocol and exact upstream ID');
  check(model.channelId === 'ch-007' && model.modeId === '007' && model.familyId === 'fam-seedance', 'channel/mode/family');
  check(!model.enabled, 'placeholder model disabled');
  check(JSON.stringify(model.matLimits) === JSON.stringify({ img: 30, vid: 10, aud: 10 }), 'standard reference limits');
  check(model.methods?.join() === 'omni' && !model.officialAssets, 'only documented reference method');
  check(model.costField === 'duration' && model.costPerUnit === 50 && model.cost === 1500, 'placeholder price fallback');
  check(model.params.find(p => p.key === 'duration').options.join() === Array.from({ length: 27 }, (_, i) => String(i + 4)).join(), '4 through 30 seconds');
  check(model.params.find(p => p.key === 'resolution').options.join() === '480p,720p', 'documented resolution choices');
  check(!!model20, '007 Seedance 2.0 seeded');
  check(model20.protocol === 'zero007-video' && model20.upstreamModel === 'seedance-2.0', '2.0 protocol and exact upstream ID');
  check(model20.channelId === 'ch-007' && model20.modeId === '007' && model20.familyId === 'fam-seedance', '2.0 shares channel/mode/family');
  check(!model20.enabled, '2.0 placeholder model disabled');
  check(JSON.stringify(model20.matLimits) === JSON.stringify({ img: 9, vid: 3, aud: 3 }), '2.0 reference limits');
  check(model20.methods?.join() === 'omni' && !model20.officialAssets, '2.0 omni without official asset preparation');
  check(!model20.costField && model20.costPerUnit === undefined && model20.cost === 750, '2.0 fixed request placeholder price');
  check([4, 5, 15].every(duration => models.resolveModelCost(model20, { duration }) === 750), '2.0 request price independent of duration');
  check(model20.params.find(p => p.key === 'duration').options.join() === Array.from({ length: 12 }, (_, i) => String(i + 4)).join(), '2.0 4 through 15 seconds');
  check(model20.params.find(p => p.key === 'resolution').options.join() === '480p,720p,1080p,4k', '2.0 live resolution choices');
  check(model20.params.find(p => p.key === 'aspect_ratio').options.join() === seedance20().parameters.ratios.join(), '2.0 live ratios include adaptive');
  const channel = channels.listChannels().find(c => c.id === 'ch-007');
  check(channel?.name === '007' && channel.baseUrl === base && channel.apiKey === '', 'channel base retains gateway; no real credential');
  check(modes.listModes().some(m => m.id === '007' && m.name === '007'), '007 mode exists');
  check(protocols.isBuiltinProtocol('zero007-video'), 'protocol registered');
  if (phase === 'seed') {
    const retainedPath = new URL('../.qiji-007-upgrade-models.json', import.meta.url);
    if (existsSync(retainedPath)) {
      const retained = JSON.parse(readFileSync(retainedPath, 'utf8'));
      assert.deepEqual(models.listModels().filter(m => !videoModelIds.includes(m.id)), retained, 'upgrade preserves all existing models and admin values');
      checks++;
    }
  }
}
if (phase === 'seed' || phase === 'tombstones') {
  check(calls.length === 0, 'seed startup uses no network');
  console.log(`007_${phase.toUpperCase()}_PASSED ${checks}/${checks}`);
} else {
  const { submitZero007Video: submit, pollZero007Video: poll } = await import('../src/translators/zero007.ts');
  const { resolveUpstream } = await import('../src/translators/upstream.ts');
  const { buildCatalog } = await import('../src/catalog.ts');
  const { scrubChannelInfo } = await import('../src/errorScrub.ts');
  const { flushPendingSaves } = await import('../src/store/db.ts');
  const req = (patch = {}) => ({ clientTaskId: 'client-007', purpose: 'sandbox.007', model: '007-sd2.5', promptOverride: '清晨人物自然向前行走', ...patch, params: { duration: '5', resolution: '720p', aspect_ratio: '16:9', ...patch.params } });
  const req20 = (patch = {}) => req({ ...patch, model: '007-sd2.0' });
  const refs = (n, kind = 'image') => Array.from({ length: n }, (_, i) => ({ url: `https://assets.example.com/${kind}-${i}.png`, name: `${kind}${i}` }));
  const postCalls = () => calls.filter(c => c.method === 'POST');
  const log = record => records.push(record);
  check(resolveUpstream(model).baseUrl === base, 'resolveUpstream keeps path prefix');
  check(!buildCatalog().models.some(m => m.id === model.id), 'disabled model absent from catalog');
  models.updateModel(model.id, { enabled: true });
  const projected = buildCatalog().models.find(m => m.id === model.id);
  check(!!projected && !('protocol' in projected) && !('upstreamModel' in projected) && !('apiKey' in projected), 'enabled catalog exposes no protocol or credential');
  check(!JSON.stringify(projected).includes('cloudbasefunction'), 'catalog hides provider endpoint');
  check(!buildCatalog().models.some(m => m.id === model20.id), 'disabled 2.0 absent from catalog');
  models.updateModel(model20.id, { enabled: true });
  const projected20 = buildCatalog().models.find(m => m.id === model20.id);
  check(!!projected20 && projected20.cost === 750 && !projected20.costField, 'enabled 2.0 catalog uses request price');
  check(!('protocol' in projected20) && !('upstreamModel' in projected20) && !('apiKey' in projected20) && !JSON.stringify(projected20).includes('cloudbasefunction'), '2.0 catalog hides protocol and credentials');
  let result = await submit(req({ inputs: { images: refs(2), videos: refs(1, 'video'), audios: refs(1, 'audio') } }), up, log);
  check(result.ok && result.taskId === 'job_sandbox_007', '202 data.id accepted');
  check(calls[0].url.endsWith('/v1/models'), 'live catalog read before first submit');
  const first = postCalls()[0];
  const body = JSON.parse(first.body);
  check(first.headers.get('Authorization') === `Bearer ${key}`, 'Bearer authentication');
  check(!!first.headers.get('Idempotency-Key'), 'idempotency key present');
  check(body.model === 'seedance-2.5' && body.duration === 5 && body.ratio === '16:9' && body.resolution === '720p', 'exact request field mapping');
  check(body.images.length === 2 && body.videos.length === 1 && body.audios.length === 1, 'all three reference arrays');
  check(body.prompt.includes('@Image1') && body.prompt.includes('@Image2') && body.prompt.includes('@Video1') && body.prompt.includes('@Audio1'), 'reference legends match ordering');
  check(!JSON.stringify(records).includes(key), 'upstream logs mask full API key');
  check(records.filter(r => r.request).at(-1).request.method === 'POST', 'third log section preserves actual submission');

  reset();
  await submit(req({ params: { duration: '47', resolution: '1080p', aspect_ratio: '13:7', generate_audio: 'false', watermark: true } }), up);
  const passthrough = JSON.parse(postCalls()[0].body);
  check(passthrough.duration === 47 && passthrough.resolution === '1080p' && passthrough.ratio === '13:7', 'explicit out-of-catalog values unchanged for upstream rejection');
  check(passthrough.generate_audio === false && passthrough.watermark === true, 'explicit boolean values preserved');
  reset();
  directory[0].parameters.durations = [30]; directory[0].parameters.resolutions = ['720p']; directory[0].parameters.ratios = ['21:9'];
  await submit(req({ params: { duration: '30', resolution: undefined, aspect_ratio: undefined } }), up);
  const defaults = JSON.parse(postCalls()[0].body);
  check(defaults.duration === 30 && defaults.resolution === '720p' && defaults.ratio === '21:9', 'missing resolution and ratio use live catalog defaults');

  for (const [label, request, upstream] of [
    ['missing key', req(), { ...up, apiKey: '' }],
    ['missing model', req(), { ...up, upstreamModel: '' }],
    ['missing duration', req({ params: { duration: undefined } }), up],
    ['empty prompt', req({ promptOverride: '', variables: {} }), up],
    ['empty JSON prompt with image', req({ promptOverride: '{}', inputs: { images: refs(1) } }), up],
    ['unsupported frames', req({ params: { method: 'frames' }, inputs: { images: refs(2) } }), up],
    ['invalid boolean', req({ params: { watermark: 'maybe' } }), up],
    ['too many images', req({ inputs: { images: refs(31) } }), up],
    ['too many videos', req({ inputs: { videos: refs(11, 'video') } }), up],
    ['too many audios', req({ inputs: { audios: refs(11, 'audio') } }), up],
    ['unresolved material in middle', req({ inputs: { images: [refs(1)[0], { id: 'missing-007' }, refs(2)[1]] } }), up],
    ['local image URI', req({ inputs: { images: [{ url: 'http://asset.localhost/file.png' }] } }), up],
    ['private image URL', req({ inputs: { images: [{ url: 'https://127.0.0.1/file.png' }] } }), up],
    ['URL userinfo', req({ inputs: { images: [{ url: 'https://user:password@assets.example.com/file.png' }] } }), up],
    ['storyboard exceeds cap', req({ inputs: { images: refs(30) }, params: { firstFrameUrl: 'https://assets.example.com/storyboard.png' } }), up],
  ]) {
    reset(); const rejected = await submit(request, upstream);
    check(!rejected.ok && postCalls().length === 0, `preflight rejects ${label} without generation POST`);
  }
  reset(); directory = [];
  check(!(await submit(req(), up)).ok && postCalls().length === 0, 'model not authorized by key rejected');
  reset(); directory[0].parameters.maxVideos = 0; directory[0].parameters.maxAudios = 0;
  check(!(await submit(req({ inputs: { videos: refs(1, 'video') } }), { ...up, apiKey: 'ic_live_discount_fixture' })).ok && !postCalls().length, 'different key uses current image-only capabilities');
  reset(); await submit(req({ inputs: { images: refs(2) }, params: { duration: 5, firstFrameUrl: 'https://assets.example.com/storyboard.png' } }), up);
  check(JSON.parse(postCalls()[0].body).images.at(-1).endsWith('/storyboard.png'), 'storyboard appended without shifting reference indices');
  reset(); await submit(req({ inputs: { images: refs(30), videos: refs(10, 'video'), audios: refs(10, 'audio') } }), up);
  check(postCalls().length === 1, 'standard 50-material boundary accepted');

  for (const [label, inputs] of [['no references', {}], ['audio-only references', { audios: refs(1, 'audio') }]]) {
    reset20(); const rejected = await submit(req20({ inputs }), up20);
    check(!rejected.ok && rejected.error.includes('至少需要 1 个图片或视频素材') && !postCalls().length, `2.0 rejects ${label} before generation`);
  }
  for (const [label, inputs] of [['image reference', { images: refs(1) }], ['video reference', { videos: refs(1, 'video') }]]) {
    reset20(); const accepted = await submit(req20({ inputs }), up20);
    check(accepted.ok && postCalls().length === 1 && JSON.parse(postCalls()[0].body).model === 'seedance-2.0', `2.0 accepts ${label} with exact upstream model`);
  }
  reset20();
  check((await submit(req20({ params: { firstFrameUrl: 'https://assets.example.com/storyboard.png' } }), up20)).ok && JSON.parse(postCalls()[0].body).images.length === 1, '2.0 firstFrameUrl counts toward minimum visual material');
  reset20();
  check((await submit(req20({ inputs: { images: refs(1) }, params: { firstFrameUrl: refs(1)[0].url } }), up20)).ok && JSON.parse(postCalls()[0].body).images.length === 1, '2.0 existing firstFrameUrl not double-counted');
  for (const invalid of [-1, 0.5, '1', null]) {
    reset20(); directory[0].parameters.minVisualMaterials = invalid;
    const rejected = await submit(req20({ inputs: { images: refs(1) } }), up20);
    check(!rejected.ok && rejected.error.includes('下限无效') && !postCalls().length, `invalid minVisualMaterials ${JSON.stringify(invalid)} rejected`);
  }
  reset20(); directory[0].parameters.minVisualMaterials = 0;
  check((await submit(req20(), up20)).ok && postCalls().length === 1, 'live zero visual minimum allows text-only request');
  reset20(); directory[0].parameters.minVisualMaterials = 2;
  check(!(await submit(req20({ inputs: { images: refs(1) } }), up20)).ok && !postCalls().length, 'changed live minimum immediately rejects one visual reference');
  check((await submit(req20({ inputs: { images: refs(1), videos: refs(1, 'video') } }), up20)).ok && postCalls().length === 1, 'visual minimum combines image and video references');
  reset();
  check((await submit(req({ inputs: { audios: refs(1, 'audio') } }), up)).ok && postCalls().length === 1, 'older 2.5 directory without minimum retains audio-only behavior');
  reset20();
  check((await submit(req20({ inputs: { images: refs(9), videos: refs(3, 'video'), audios: refs(3, 'audio') }, params: { duration: '15', resolution: '4k', aspect_ratio: 'adaptive' } }), up20)).ok, '2.0 9/3/3 material boundary accepted');
  const boundary20 = JSON.parse(postCalls()[0].body);
  check(boundary20.duration === 15 && boundary20.resolution === '4k' && boundary20.ratio === 'adaptive', '2.0 maximum duration and live resolution/ratio transmitted verbatim');
  for (const [label, inputs, params = {}] of [
    ['images', { images: refs(10) }],
    ['videos', { images: refs(1), videos: refs(4, 'video') }],
    ['audios', { images: refs(1), audios: refs(4, 'audio') }],
    ['firstFrameUrl beyond image cap', { images: refs(9) }, { firstFrameUrl: 'https://assets.example.com/storyboard.png' }],
  ]) {
    reset20(); const rejected = await submit(req20({ inputs, params }), up20);
    check(!rejected.ok && !postCalls().length, `2.0 ${label} overflow rejected before generation`);
  }
  const { buildPrompt } = await import('../src/translators/prompt.ts');
  const { injectReferenceTags } = await import('../src/translators/jianmeng.ts');
  for (const [label, makeRequest, upstream, resetModel] of [
    ['2.5', req, up, reset], ['2.0', req20, up20, reset20],
  ]) {
    for (const maxPromptChars of [undefined, null, 0, -1, 0.5, '15000', {}, [], true, 1, 5000, 15000]) {
      resetModel();
      if (maxPromptChars === undefined) delete directory[0].parameters.maxPromptChars;
      else directory[0].parameters.maxPromptChars = maxPromptChars;
      const promptOverride = '完整提示词😀\n'.repeat(2001) + '终点';
      const images = refs(1);
      const request = makeRequest({ promptOverride, inputs: { images } });
      const expectedPrompt = injectReferenceTags(buildPrompt(request), { images, videos: [], audios: [] });
      const accepted = await submit(request, upstream);
      check(accepted.ok && postCalls().length === 1, `${label} maxPromptChars=${JSON.stringify(maxPromptChars) ?? 'missing'} does not block submission`);
      const submittedPrompt = JSON.parse(postCalls()[0].body).prompt;
      check(submittedPrompt === expectedPrompt && submittedPrompt.includes(promptOverride) && submittedPrompt.includes('@Image1'), `${label} full prompt and material legend submitted without truncation`);
    }
  }

  reset(); posts = [new Error('simulated network disconnect'), response({ error: { message: 'busy' } }, 503), response({ data: { id: 'job_retry_same', status: 'reserved' } }, 202)];
  result = await submit(req(), up);
  check(result.ok && result.taskId === 'job_retry_same' && postCalls().length === 3, 'network and 503 retry to original accepted task');
  check(new Set(postCalls().map(c => c.body)).size === 1 && new Set(postCalls().map(c => c.headers.get('Idempotency-Key'))).size === 1, 'all retries reuse byte-identical body and key');
  const retriedKey = postCalls()[0].headers.get('Idempotency-Key');
  reset(); await submit(req(), up);
  check(postCalls()[0].headers.get('Idempotency-Key') !== retriedKey, 'separate charged task never reuses clientTaskId as provider key');
  for (const status of [400, 401, 402, 403, 404, 422]) {
    reset(); posts = [response({ error: { code: 'BUSINESS_ERROR', message: 'explicit reject' }, requestId: 'req_007' }, status)];
    check(!(await submit(req(), up)).ok && postCalls().length === 1, `HTTP ${status} business error not retried`);
  }

  for (const [state, expected] of [['reserved', 'queued'], ['processing', 'running'], ['mystery_state', 'running'], ['failed', 'failed'], ['refunded', 'failed']]) {
    reset(); polls = [{ data: { status: state, error: 'provider failure detail', result: { url: 'https://cdn.example.com/premature.mp4' } } }];
    const polled = await poll(up, 'job/id space', log);
    check(polled.status === expected, `poll ${state} maps to ${expected}`);
    check(calls[0].url.endsWith('/job%2Fid%20space') && !postCalls().length, 'poll escapes ID and never resubmits');
    if (expected === 'failed') check(polled.error.includes('provider failure detail'), 'provider failure details retained');
  }
  reset(); polls = [{ data: { status: 'processing', stage: 'storing', result: { url: 'https://cdn.example.com/temporary.mp4' } } }];
  check((await poll(up, 'job_storing', log)).status === 'running', 'storing is not completed even with temporary URL');
  check(!records.some(r => r.request), 'poll logs never overwrite submission section');
  for (const status of [408, 429, 500, 502, 503, 504]) {
    reset(); polls = [response({ error: { message: 'temporary' } }, status)];
    check((await poll(up, 'job_007')).status === 'running', `poll HTTP ${status} remains running`);
  }
  reset(); polls = [new Error('network')]; check((await poll(up, 'job_007')).status === 'running', 'poll network failure remains running');
  reset(); polls = [response({ error: { message: 'missing job' } }, 404)]; check((await poll(up, 'job_007')).status === 'failed', 'poll 404 fails explicitly');
  reset(); polls = [{ data: { status: 'completed', result: null } }]; check((await poll(up, 'job_007')).status === 'failed', 'completed without URL fails');
  reset(); const cdn = await poll(up, 'job_007'); check(cdn.status === 'completed' && !cdn.resultHeaders, 'third-party CDN never receives API key');
  reset(); polls = [{ data: { status: 'completed', result: { url: `${base}/results/007.mp4` } } }];
  check((await poll(up, 'job_007')).resultHeaders?.Authorization === `Bearer ${key}`, 'same-origin authenticated result');
  const scrubbed = scrubChannelInfo('007 Infinite Canvas INFINITE_CANVAS env-00jy6ktfybhu.dev-hz.cloudbasefunction.cn');
  check(scrubbed.includes('007') && !/Infinite|INFINITE|cloudbasefunction/.test(scrubbed), 'error scrub hides upstream identity and keeps visible mode');
  check(scrubChannelInfo('007 协议错误：zero007-video') === '007 协议错误：渠道', 'internal protocol removed before mode substring protection');
  check(scrubChannelInfo('007 ZERO007_API_KEY ZERO007_BASE_URL') === '007 渠道 渠道', 'internal environment names removed while visible mode remains');

  const { dispatchGenerate } = await import('../src/translators/index.ts');
  const tasks = await import('../src/store/tasks.ts');
  const { startLog, getLog } = await import('../src/store/logs.ts');
  channels.updateChannel('ch-007', { apiKey: key });
  let reversals = 0;
  tasks.setBillingReverseHook(billing => { check(billing.cost === 250, 'unified refund uses original charge'); reversals++; });
  reset(); polls = [{ data: { status: 'refunded', error: '007 generation failed' } }];
  const logEntry = startLog({ userId: 'sandbox-user', req: req() });
  const dispatched = await dispatchGenerate(req(), logEntry.id);
  check(dispatched.kind === 'async', 'builtin dispatch creates asynchronous task');
  tasks.setTaskBilling(dispatched.taskId, 'sandbox-user', 250);
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && tasks.getTaskState(dispatched.taskId)?.status !== 'failed') await new Promise(resolve => setTimeout(resolve, 25));
  check(tasks.getTaskState(dispatched.taskId)?.status === 'failed' && reversals === 1, 'refunded provider state triggers exactly one Qiji refund');
  tasks.failTask(dispatched.taskId, 'duplicate terminal callback');
  check(reversals === 1, 'repeated terminal notification cannot refund twice');
  const recorded = getLog(logEntry.id);
  check(recorded.upstreamRequest?.method === 'POST', 'real log store section three remains POST');
  check(recorded.upstreamResponse?.body?.data?.status === 'refunded', 'real log store section four retains provider terminal state');
  check(!JSON.stringify(recorded).includes(key), 'stored logs contain no full API key');
  check(postCalls().length === 1 && unexpected.length === 0, 'dispatch polls original job with zero unrecognized network calls');
  const { isOssConfigured } = await import('../src/store/oss.ts');
  check(!isOssConfigured(), 'sandbox has no real OSS credentials');
  reset();
  const successTask = await dispatchGenerate(req({ clientTaskId: 'client-007-success' }));
  check(successTask.kind === 'async', 'success path dispatches asynchronously');
  const successDeadline = Date.now() + 15000;
  let resumeVerified = false;
  while (Date.now() < successDeadline && tasks.getTaskState(successTask.taskId)?.status !== 'success') {
    const pending = tasks.listPendingTasks().find(t => t.taskId === successTask.taskId);
    if (pending?.resume?.upstreamTaskId === 'job_sandbox_007' && pending.resume.protocol === 'zero007-video') resumeVerified = true;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  check(resumeVerified, 'accepted provider ID saved in shared restart polling context');
  const succeeded = tasks.getTaskState(successTask.taskId);
  check(succeeded?.status === 'success' && succeeded.result.assets[0].url === 'https://cdn.example.com/007.mp4', 'completed provider result reaches unified task output');
  check(succeeded.result.assets[0].meta.rehosted === false && postCalls().length === 1 && unexpected.length === 0, 'no-OSS sandbox reports direct-link fallback without extra generation or download');
  const driverSource = readFileSync(new URL('../src/translators/index.ts', import.meta.url), 'utf8');
  check(driverSource.includes('"zero007-video": 5000'), 'five-second interval registered for submit and resume');
  await flushPendingSaves();
  for (const id of videoModelIds) check(models.deleteModel(id), `delete ${id} records tombstone`);
  channels.deleteChannel('ch-007'); modes.deleteMode('007');
  await flushPendingSaves();
  console.log(`007_SMOKE_PASSED ${checks}/${checks}; mocked upstream only; tombstones prepared`);
}
