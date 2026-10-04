import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../server/src/admin/auto-routing.js', import.meta.url), 'utf8');
function harness(enabled = true) {
  let stored = { version: 1, enabled, defaultLineFamilyIds: ['A'], lines: [
    { id: 'a', familyId: 'A', name: 'A', capability: 'image', enabled: true, cost: 10,
      prices: [{ when: { resolution: '2k' }, cost: 20 }], members: [{ modelId: 'banana', enabled: true, concurrencyWeight: 1, defaults: {} }] },
  ] };
  const requests = [], elements = new Map(['tab-routing', 'pageTitle', 'ar-global-note', 'ar-save-status', 'ar-save-retry', 'ar-message'].map(id => [id, { style: {}, hidden: true }]));
  let failure = '', gate, release;
  const context = vm.createContext({ structuredClone, Date, Map, Set, JSON, console, MODES: null, CUR_TAB: 'routing', esc: String,
    location: { hash: '#routing/A' }, setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, toast() {},
    window: { addEventListener() {} },
    document: { getElementById: id => elements.get(id), querySelector: () => null, querySelectorAll: () => [], addEventListener() {} },
    api: async (url, options) => {
      if (options?.method === 'PUT') {
        const body = JSON.parse(options.body); requests.push(body);
        if (gate) await gate;
        if (failure) throw new Error(failure);
        assert.equal(body.version, stored.version);
        stored = { ...structuredClone(body), version: stored.version + 1 };
        return { config: structuredClone(stored) };
      }
      return { previews: [], availability: [], health: {} };
    },
  });
  vm.runInContext(source, context);
  context.seed = structuredClone(stored);
  const run = code => vm.runInContext(code, context);
  run('AR=structuredClone(seed);AR_BASE=structuredClone(seed);AR_FAMILY="A";AR_CAP="image";AR_FAMILIES=[{id:"A",name:"Banana",capability:"image"}];');
  return { run, requests, elements, get stored() { return stored; }, set failure(value) { failure = value; },
    hold() { gate = new Promise(resolve => { release = resolve; }); }, release() { gate = null; release(); },
    flush() { run('for(const s of AR_PENDING.values())s.readyAt=0'); return run('arFlushSave()'); } };
}

test('top-level toggle renders enabled state and disabled instructions', () => {
  const h = harness(); h.run('renderRouting()');
  assert.match(h.elements.get('tab-routing').innerHTML, /aria-label="启用自动路由"[^>]*checked[^>]*onchange="arGlobalEnabled\(this.checked\)"/);
  h.run('arGlobalEnabled(false)');
  assert.equal(h.elements.get('ar-global-note').hidden, false);
  assert.equal(h.run('AR_PENDING.has("__global")'), true);
  h.run('renderRouting()');
  const html = h.elements.get('tab-routing').innerHTML;
  assert.match(html, /刷新模型目录，选择原渠道模型测试/);
  assert.doesNotMatch(html.match(/<input[^>]*id="ar-global-enabled"[^>]*>/)?.[0] || '', /\schecked(?:\s|=|>)/);
});

test('disable saves false without changing any route, candidate, or price', async () => {
  const h = harness(), original = structuredClone(h.stored.lines);
  h.run('arGlobalEnabled(false)'); await h.flush();
  assert.equal(h.requests[0].enabled, false);
  assert.equal(h.stored.enabled, false);
  assert.deepEqual(h.stored.lines, original);
  assert.equal(h.run('AR_PENDING.size'), 0);
});

test('editing a family while disabled never turns routing back on', async () => {
  const h = harness(false);
  h.run('AR.lines[0].cost=33;arChanged("A")'); await h.flush();
  assert.equal(h.requests[0].enabled, false);
  assert.equal(h.stored.enabled, false);
  assert.equal(h.stored.lines[0].cost, 33);
});

test('changing the toggle during an in-flight save retains and submits the latest choice', async () => {
  const h = harness(); h.run('arGlobalEnabled(false)'); h.hold(); const first = h.flush();
  h.run('arGlobalEnabled(true)'); await h.flush(); assert.equal(h.requests.length, 1);
  h.release(); await first;
  assert.equal(h.run('AR.enabled'), true);
  assert.equal(h.run('AR_PENDING.has("__global")'), true);
  await h.flush();
  assert.deepEqual(h.requests.map(r => r.enabled), [false, true]);
  assert.equal(h.stored.enabled, true);
});

test('failed or conflicted global saves retain draft; family changes cannot submit it accidentally', async () => {
  const h = harness(); h.failure = '配置版本冲突'; h.run('arGlobalEnabled(false)'); await h.flush();
  assert.equal(h.run('AR.enabled'), false);
  assert.match(h.run('AR_PENDING.get("__global").error'), /版本冲突/);
  assert.match(h.elements.get('ar-message').textContent, /修改已保留/);
  h.failure = ''; h.run('AR.lines[0].cost=44;arChanged("A")'); await h.flush();
  assert.equal(h.stored.enabled, true);
  assert.equal(h.stored.lines[0].cost, 44);
  h.run('arRetrySave()'); await h.flush();
  assert.equal(h.stored.enabled, false);
  assert.equal(h.stored.lines[0].cost, 44);
});

test('family save in flight cannot overwrite a newly disabled toggle', async () => {
  const h = harness(); h.run('AR.lines[0].cost=66;arChanged("A")'); h.hold(); const first = h.flush();
  h.run('arGlobalEnabled(false)'); h.release(); await first;
  assert.equal(h.run('AR.enabled'), false);
  await h.flush();
  assert.equal(h.stored.enabled, false);
  assert.equal(h.stored.lines[0].cost, 66);
});
