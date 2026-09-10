// Run only in the isolated mirror created by scripts/test-user-transfer.ps1.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

assert.ok(existsSync(fileURLToPath(new URL('../.qiji-user-transfer-sandbox', import.meta.url))),
  'Refusing to import stores outside the marked user-transfer sandbox');

let checks = 0;
const check = (value, label) => { assert.ok(value, label); checks++; };
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
async function within(promise, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 5000);
    })]);
  } finally { clearTimeout(timer); }
}

// A complete minimal moov/mvhd box with a two-second duration; no media bytes or network.
const mp4 = Buffer.alloc(36);
mp4.writeUInt32BE(36, 0); mp4.write('moov', 4);
mp4.writeUInt32BE(28, 8); mp4.write('mvhd', 12);
mp4.writeUInt32BE(1000, 28); mp4.writeUInt32BE(2000, 32);
let probeGate;
let onGeneration;
let generated = 0;
const unexpected = [];
globalThis.fetch = async (url) => {
  const target = String(url);
  if (target.startsWith('https://scope-probe.invalid/')) {
    const gate = probeGate;
    assert.ok(gate, 'probe must be explicitly armed');
    gate.entered.resolve();
    await gate.release.promise;
    return new Response(mp4, { headers: { 'content-length': String(mp4.length) } });
  }
  if (target === 'https://scope-upstream.invalid/v1/chat/completions') {
    generated++;
    onGeneration?.();
    return new Response('data: {"choices":[{"delta":{"content":"sandbox result"}}]}\n\ndata: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } });
  }
  unexpected.push(target);
  throw new Error(`Sandbox blocks unexpected fetch: ${target}`);
};

const { default: Fastify } = await import('fastify');
const { registerRoutes } = await import('../src/routes.ts');
const { createUser, getUser } = await import('../src/store/users.ts');
const { createAgent } = await import('../src/store/agents.ts');
const { createModel } = await import('../src/store/models.ts');
const { getTaskState } = await import('../src/store/tasks.ts');
const { listLogs } = await import('../src/store/logs.ts');
const { transferUsers } = await import('../src/services/userTransfer.ts');

const app = Fastify({ logger: false });
await registerRoutes(app);
await app.ready();
const suffix = Date.now().toString(36);
const destination = createAgent({ account: `scope-${suffix}`, password: 'sandbox-only' });
assert.ok(destination.ok);
const destinationId = destination.agent.id;
const model = createModel({
  id: `scope-model-${suffix}`, label: 'Transfer scope sandbox', capability: 'text', protocol: 'openai-chat',
  baseUrl: 'https://scope-upstream.invalid', apiKey: 'sandbox-only', upstreamModel: 'sandbox-model',
  cost: 10, costField: 'duration', costPerUnit: 1, refVideoSecondsWeight: 1,
});
const request = (name, withVideo = true) => ({
  model: model.id, clientTaskId: name, promptOverride: 'sandbox', params: { duration: 10 },
  ...(withVideo ? { inputs: { videos: [{ url: `https://scope-probe.invalid/${name}.mp4` }] } } : {}),
});
const headers = (user) => ({ authorization: `Bearer ${user.accessKey}`, 'x-device-id': 'scope-test-device' });
const migrate = (user) => {
  const result = transferUsers({ ids: [user.id], targetAgentId: destinationId });
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.affected, 1);
};
const logsFor = (user) => listLogs({ userIds: [user.id], limit: 100 });

try {
  // Single request: migration while the reference-duration fetch is suspended must reject before billing.
  const single = createUser({ name: 'scope-single', credits: 100 });
  probeGate = { entered: deferred(), release: deferred() };
  const singlePending = app.inject({ method: 'POST', url: '/v1/generate', headers: headers(single),
    payload: request('single') }).then((r) => r);
  await within(probeGate.entered.promise, 'single probe start');
  check(single.credits === 100 && logsFor(single).total === 0, 'single probe starts before debit or log');
  migrate(single);
  probeGate.release.resolve();
  const singleResponse = await within(singlePending, 'single response');
  check(singleResponse.statusCode === 409, 'single migration during probe returns conflict');
  check(singleResponse.json().error.message.includes('归属已变更'), 'single conflict explains refresh and retry');
  check(getUser(single.id).credits === 100, 'single rejected before any credit change');
  check(logsFor(single).total === 0 && generated === 0, 'single rejected without log or generation');

  // Batch: when the first probe overlaps a migration, each unaccepted item gets a terminal failure.
  const batch = createUser({ name: 'scope-batch', credits: 100 });
  probeGate = { entered: deferred(), release: deferred() };
  const batchPending = app.inject({ method: 'POST', url: '/v1/batch', headers: headers(batch),
    payload: { tasks: [request('batch-a'), request('batch-b', false), request('batch-c', false)] } }).then((r) => r);
  await within(probeGate.entered.promise, 'batch probe start');
  migrate(batch);
  probeGate.release.resolve();
  const batchResponse = await within(batchPending, 'batch response');
  check(batchResponse.statusCode === 200, 'batch retains normal envelope with per-item failures');
  const rejectedIds = batchResponse.json().taskIds;
  check(rejectedIds.length === 3, 'batch preserves one task per requested item');
  check(rejectedIds.every((id) => getTaskState(id)?.status === 'failed'), 'all unaccepted batch items fail');
  check(rejectedIds.every((id) => getTaskState(id)?.error?.includes('归属已变更')), 'each batch failure explains migration');
  check(batch.credits === 100 && generated === 0 && logsFor(batch).total === 0, 'rejected batch has no debit, generation, or request log');

  // An already-debited item may finish; migration during its dispatch must stop subsequent batch items.
  const accepted = createUser({ name: 'scope-accepted', credits: 100 });
  onGeneration = () => { onGeneration = undefined; migrate(accepted); };
  const acceptedResponse = await app.inject({ method: 'POST', url: '/v1/batch', headers: headers(accepted),
    payload: { tasks: [request('accepted-a', false), request('accepted-b', false), request('accepted-c', false)] } });
  check(acceptedResponse.statusCode === 200, 'partially accepted batch retains normal envelope');
  const acceptedIds = acceptedResponse.json().taskIds;
  await new Promise((resolve) => setImmediate(resolve));
  check(acceptedIds.length === 3 && getTaskState(acceptedIds[0])?.status === 'success', 'previously accepted task completes');
  check(acceptedIds.slice(1).every((id) => getTaskState(id)?.status === 'failed'), 'migration stops remaining items before dispatch');
  check(generated === 1 && accepted.credits === 90, 'only the accepted item generates and debits');
  const acceptedLogs = logsFor(accepted);
  check(acceptedLogs.total === 1 && !acceptedLogs.items[0].ownerId, 'accepted log keeps original platform ownership');
  check(accepted.agentId === destinationId, 'accepted request user observes the completed migration');
  check(unexpected.length === 0, 'all fetches were explicit local stubs');
  console.log(JSON.stringify({ ok: true, checks, generated, scenarios: ['single-probe-migration', 'batch-probe-migration', 'accepted-batch-migration'] }));
} finally {
  probeGate?.release.resolve();
  await app.close();
}
