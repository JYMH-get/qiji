import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../server/src/admin/auto-routing.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../server/src/admin/index.html', import.meta.url), 'utf8');
new vm.Script(source);
for (const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new vm.Script(match[1]);

function harness() {
  const elements = new Map(), calls = [], stored = new Map(), histories = new Map(), events = {};
  let hold = null, historyHold = null, fail = null, uuid = 0;
  const element = id => {
    if (!elements.has(id)) elements.set(id, { innerHTML: '', textContent: '', hidden: false, disabled: false, className: '', setAttribute(key, value) { this[key] = value; } });
    return elements.get(id);
  };
  const snapshot = id => stored.get(id) || { version: 0, rules: [], updatedAt: null };
  const history = target => ({ key: target || 'model', targets: [{ key: 'model', label: '仅此底层模型' }, { key: 'line-a', label: '线路A' }], active: true, slots: [], audit: [] });
  const context = vm.createContext({
    structuredClone, Date, Map, Set, JSON, console, URLSearchParams, MODES: null, CUR_TAB: 'availability',
    crypto: { randomUUID: () => `rule-${++uuid}` }, setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1,
    esc: value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])),
    toast() {}, window: { __models: [{ id: 'model-a', label: '模型 A' }, { id: 'model-b', label: '模型 B' }], addEventListener: (name, fn) => { events[name] = fn; } },
    document: { hidden: false, getElementById: element, querySelectorAll: () => [], querySelector: () => null, addEventListener() {} },
    dlg: { open: false, classList: { add() {}, remove() {} }, showModal() { this.open = true; }, close() { this.open = false; } },
    api: async (url, options = {}) => {
      const method = options.method || 'GET', body = options.body ? JSON.parse(options.body) : null;
      calls.push({ url, method, body });
      if (fail?.method === method) { const error = fail.error; fail = null; throw error; }
      const modelId = decodeURIComponent(url.split('/')[3]);
      if (url.includes('/rate-history')) {
        const target = new URL(url, 'https://test.invalid').searchParams.get('target');
        const result = { ...history(target), slots: structuredClone(histories.get(modelId + '/' + (target || 'model')) || []) };
        if (historyHold) { const pending = historyHold; historyHold = null; await pending.promise; }
        return result;
      }
      assert.match(url, /\/statistics-rules$/);
      const current = structuredClone(snapshot(modelId));
      if (method === 'PUT' && body.version !== current.version) throw Object.assign(new Error('版本冲突'), { status: 409 });
      if (hold?.method === method) { const active = hold; hold = null; await active.promise; }
      if (method === 'GET') return current;
      const result = { version: current.version + 1, rules: body.rules, updatedAt: 1000 };
      stored.set(modelId, structuredClone(result)); return result;
    },
  });
  vm.runInContext(source, context);
  const run = code => vm.runInContext(code, context);
  run('loadAvailability=async()=>{}');
  return {
    run, context, elements, calls, stored, histories, events, snapshot,
    json: code => JSON.parse(run(`JSON.stringify(${code})`)),
    hold(method) { let resolve; const promise = new Promise(done => { resolve = done; }); hold = { method, promise }; return resolve; },
    holdHistory() { let resolve; const promise = new Promise(done => { resolve = done; }); historyHold = { promise }; return resolve; },
    fail(method, error) { fail = { method, error }; },
  };
}
const english = 'the request must be less than or equal to 15.2 for model doubao-seedance-2-0 in r2v.';

test('adjustment opens on statistics rules and historical targets never change rule ownership', async () => {
  const h = harness(); await h.run("openRateAdjustment('model-a')");
  assert.equal(h.run('AV_ADJUST.tab'), 'rules');
  assert.match(h.elements.get('dlgBody').innerHTML, /统计规则/);
  h.run("avStatisticsRuleAdd('model-a',0);avAdjustmentTab('history')");
  await h.run("loadRateAdjustmentHistory('model-a','line-a')");
  assert.equal(h.run('AV_EDIT.key'), 'line-a'); assert.equal(h.run('AV_ADJUST.id'), 'model-a');
  assert.equal(h.json("avStatisticsDraft('model-a').rules")[0].value, '内容不符合平台规范');
  assert.equal(h.calls.filter(call => call.url.endsWith('/statistics-rules')).length, 1);
});

test('history shows rule projection and manual sources while retaining original snapshots and legacy fallback', async () => {
  const h = harness(); await h.run("openRateAdjustment('model-a')");
  h.context.historySlots = [
    { until: 1000, original: { successRate: 0.5 }, display: { successRate: 10 / 14, rulesApplied: true, excluded: 6 } },
    { until: 2000, original: { successRate: 0.5 }, edit: { successRate: 0.9, source: 'correction' }, display: { successRate: 0.9, source: 'correction' } },
    { until: 3000, original: { successRate: 0.5 }, display: { successRate: 0.8, rulesApplied: true, insufficientSamples: true } },
    { until: 4000, original: { successRate: 0.5 }, edit: { successRate: 0.95, source: 'self-test' } },
    { until: 5000, original: { successRate: 0.5 } },
    { until: 6000, original: null, edit: null, display: null },
  ];
  h.run('AV_EDIT.slots=historySlots;renderRateAdjustment()');
  const markup = h.elements.get('av-history-content').innerHTML.replace(/ id="av-edit-(?:current|source)-\d+"/g, '');
  assert.match(markup, /<td>50\.0%<\/td><td>71\.4%<\/td><td>统计规则调整<\/td>/);
  assert.match(markup, /<td>50\.0%<\/td><td>90\.0%<\/td><td>人工修正<\/td>/);
  assert.match(markup, /<td>50\.0%<\/td><td>样本不足<\/td><td>统计规则调整<\/td>/);
  assert.match(markup, /<td>50\.0%<\/td><td>95\.0%<\/td><td>自测补录<\/td>/);
  assert.match(markup, /<td>50\.0%<\/td><td>50\.0%<\/td><td>生产实测<\/td>/);
  assert.match(markup, /<td>—<\/td><td>—<\/td><td>尚未形成快照<\/td>/);
});

test('saving rules refreshes historical display without replacing manual fields, selection or conflict tokens', async () => {
  const h = harness();
  const original = { successRate: 0.5 }, edit = { id: 'prior-edit', successRate: 0.6, source: 'correction' };
  h.histories.set('model-a/model', [{ until: 1000, original, edit }]);
  await h.run("openRateAdjustment('model-a')");
  h.run("document.getElementById('av-edit-rate').value='93';document.getElementById('av-edit-reason').value='未保存依据';document.getElementById('test-slot').checked=true");
  h.run('historyBeforeSave=AV_EDIT; historyRenderCount=0; originalHistoryRender=renderRateAdjustment; renderRateAdjustment=()=>{historyRenderCount++;originalHistoryRender()}');
  h.histories.set('model-a/model', [{ until: 1000, original, edit: null, display: { successRate: 10 / 14, rulesApplied: true } }]);
  h.run("avStatisticsRuleAdd('model-a',1)"); await h.run("saveStatisticsRules('model-a')");
  assert.equal(h.elements.get('av-edit-current-0').textContent, '71.4%');
  assert.equal(h.elements.get('av-edit-source-0').textContent, '统计规则调整');
  assert.equal(h.run('AV_EDIT===historyBeforeSave'), true);
  assert.equal(h.run('AV_EDIT.slots[0].original.successRate'), 0.5);
  assert.equal(h.run('AV_EDIT.slots[0].edit.id'), 'prior-edit');
  assert.equal(h.elements.get('av-edit-rate').value, '93');
  assert.equal(h.elements.get('av-edit-reason').value, '未保存依据');
  assert.equal(h.elements.get('test-slot').checked, true);
  assert.equal(h.run('historyRenderCount'), 0);
});

test('a delayed history refresh cannot update a closed dialog or a different history target', async () => {
  for (const close of [true, false]) {
    const h = harness();
    h.histories.set('model-a/model', [{ until: 1000, original: { successRate: 0.5 } }]);
    await h.run("openRateAdjustment('model-a')");
    h.histories.set('model-a/model', [{ until: 1000, original: { successRate: 0.5 }, display: { successRate: 0.7, rulesApplied: true } }]);
    const release = h.holdHistory(), pending = h.run("refreshRateAdjustmentDisplay('model-a')");
    if (close) h.run('dlg.close()');
    else await h.run("loadRateAdjustmentHistory('model-a','line-a')");
    release(); await pending;
    assert.equal(h.elements.get('av-edit-current-0')?.textContent, undefined);
    assert.equal(h.run('AV_EDIT.slots[0]?.display'), undefined);
    if (!close) assert.equal(h.run('AV_EDIT.key'), 'line-a');
  }
});

test('examples only add drafts; CRUD, enable toggles, action changes and order remain explicit', async () => {
  const h = harness(); await h.run("openRateAdjustment('model-a')");
  h.run("avStatisticsRuleAdd('model-a',0);avStatisticsRuleAdd('model-a',1);avStatisticsRuleAdd('model-a',2)");
  let rules = h.json("avStatisticsDraft('model-a').rules");
  assert.deepEqual(rules.map(rule => rule.value), ['内容不符合平台规范', 10, english]);
  assert.equal(h.calls.filter(call => call.method === 'PUT').length, 0);
  h.run("avStatisticsRuleMove('model-a','rule-3',-1);avStatisticsRuleChange('model-a','rule-1','enabled',false);avStatisticsRuleChange('model-a','rule-3','action','success');avStatisticsRuleDelete('model-a','rule-2')");
  rules = h.json("avStatisticsDraft('model-a').rules");
  assert.deepEqual(rules.map(rule => rule.id), ['rule-1', 'rule-3']); assert.equal(rules[0].enabled, false); assert.equal(rules[1].action, 'success');
  assert.equal(h.run("avStatisticsDirty(avStatisticsDraft('model-a'))"), true);
});

test('field changes reset operators and value types, invalid combinations cannot be selected', async () => {
  const h = harness(); await h.run("openRateAdjustment('model-a')"); h.run("avStatisticsRuleAdd('model-a',0)");
  h.run("avStatisticsRuleChange('model-a','rule-1','field','durationSec');avStatisticsRuleChange('model-a','rule-1','operator','contains')");
  assert.equal(h.run("avStatisticsDraft('model-a').rules[0].operator"), 'lt');
  h.run("avStatisticsRuleChange('model-a','rule-1','field','status')");
  assert.deepEqual(h.json("avStatisticsDraft('model-a').rules[0]"), { id: 'rule-1', enabled: true, field: 'status', operator: 'equals', value: 'failed', action: 'exclude', matchStatus: 'all' });
});

test('duration example applies only to failures, while manual rules default to all and contradictory status scopes are blocked', async () => {
  const h = harness(); await h.run("openRateAdjustment('model-a')");
  h.run("avStatisticsRuleAdd('model-a',1);avStatisticsRuleAdd('model-a')");
  assert.deepEqual(h.json("avStatisticsDraft('model-a').rules.map(rule=>rule.matchStatus)"), ['failed', 'all']);
  h.run("avStatisticsRuleChange('model-a','rule-1','matchStatus','success')");
  assert.equal(h.run("avStatisticsDraft('model-a').rules[0].matchStatus"), 'success');
  h.run("avStatisticsRuleChange('model-a','rule-1','field','status');avStatisticsRuleChange('model-a','rule-1','matchStatus','failed')");
  assert.equal(h.run("avStatisticsDraft('model-a').rules[0].matchStatus"), 'all');
  h.run("avStatisticsRuleDelete('model-a','rule-2');avStatisticsDraft('model-a').rules[0].matchStatus='success'");
  await h.run("saveStatisticsRules('model-a')");
  assert.match(h.run("avStatisticsDraft('model-a').error"), /冲突/);
  assert.equal(h.calls.filter(call => call.method === 'PUT').length, 0);
  assert.equal(h.run("avValidateStatisticsRules([{id:'legacy',enabled:true,field:'durationSec',operator:'lt',value:10,action:'exclude'}])[0].matchStatus"), undefined);
});

test('saves canonical values and prevents changes during the in-flight write', async () => {
  const h = harness(); await h.run("openRateAdjustment('model-a')");
  h.run("avStatisticsRuleAdd('model-a',1);avStatisticsRuleChange('model-a','rule-1','value','9.5')");
  const release = h.hold('PUT'), pending = h.run("saveStatisticsRules('model-a')");
  h.run("avStatisticsRuleChange('model-a','rule-1','value','20');avStatisticsRuleDelete('model-a','rule-1')");
  assert.equal(h.run("avStatisticsDraft('model-a').rules[0].value"), '9.5');
  release(); await pending;
  assert.equal(h.snapshot('model-a').rules[0].value, 9.5); assert.equal(h.run("avStatisticsDraft('model-a').version"), 1);
  assert.equal(h.run("avStatisticsDirty(avStatisticsDraft('model-a'))"), false);
  await h.run("loadStatisticsRules('model-a',true)");
  assert.deepEqual(h.json("avStatisticsDraft('model-a').rules"), h.snapshot('model-a').rules);
});

test('late refreshes keep a newer draft and expose the remote version for review', async () => {
  const h = harness(); await h.run("openRateAdjustment('model-a')");
  h.stored.set('model-a', { version: 2, rules: [], updatedAt: 2000 });
  const release = h.hold('GET'), pending = h.run("loadStatisticsRules('model-a',true)");
  h.run("avStatisticsRuleAdd('model-a',0)"); release(); await pending;
  assert.equal(h.run("avStatisticsDraft('model-a').rules.length"), 1);
  assert.equal(h.run("avStatisticsDraft('model-a').conflict"), true); assert.equal(h.run("avStatisticsDraft('model-a').latest.version"), 2);
});

test('409 keeps the exact draft and requires an explicit conflict choice and another save', async () => {
  const h = harness(); await h.run("openRateAdjustment('model-a')"); h.run("avStatisticsRuleAdd('model-a',2)");
  h.stored.set('model-a', { version: 3, rules: [], updatedAt: 3000 });
  await h.run("saveStatisticsRules('model-a')");
  assert.equal(h.run("avStatisticsDraft('model-a').conflict"), true); assert.equal(h.run("avStatisticsDraft('model-a').rules[0].value"), english);
  await h.run("saveStatisticsRules('model-a')"); assert.equal(h.calls.filter(call => call.method === 'PUT').length, 1);
  h.run("avStatisticsResolve('model-a',true)"); assert.equal(h.snapshot('model-a').rules.length, 0);
  await h.run("saveStatisticsRules('model-a')");
  assert.equal(h.snapshot('model-a').version, 4); assert.equal(h.snapshot('model-a').rules[0].value, english);
});

test('per-model drafts survive close/reopen and browsing another model', async () => {
  const h = harness(); await h.run("openRateAdjustment('model-a')"); h.run("avStatisticsRuleAdd('model-a',0);dlg.close()");
  await h.run("openRateAdjustment('model-b')"); h.run("avStatisticsRuleAdd('model-b',1)");
  await h.run("openRateAdjustment('model-a')");
  assert.equal(h.run("avStatisticsDraft('model-a').rules[0].value"), '内容不符合平台规范');
  assert.equal(h.run("avStatisticsDraft('model-b').rules[0].value"), 10);
  assert.equal(h.calls.filter(call => call.url === '/admin-api/models/model-a/statistics-rules').length, 1);
});

test('blank errors and invalid durations never send a PUT', async () => {
  const h = harness(); await h.run("openRateAdjustment('model-a')"); h.run("avStatisticsRuleAdd('model-a')");
  await h.run("saveStatisticsRules('model-a')"); assert.match(h.run("avStatisticsDraft('model-a').error"), /错误文本/);
  h.run("avStatisticsRuleChange('model-a','rule-1','field','durationSec')");
  for (const value of ['', '-1', '604801', 'Infinity']) {
    h.context.invalidValue = value; h.run("avStatisticsRuleChange('model-a','rule-1','value',invalidValue)");
    await h.run("saveStatisticsRules('model-a')"); assert.match(h.run("avStatisticsDraft('model-a').error"), /耗时/);
  }
  assert.equal(h.calls.filter(call => call.method === 'PUT').length, 0);
});

test('errors preserve drafts and render as text; generated event handlers parse safely', async () => {
  const h = harness(); await h.run("openRateAdjustment('model-a')"); h.run("avStatisticsRuleAdd('model-a',0)");
  h.context.literal = '<img src=x onerror="throw 1">'; h.run("avStatisticsRuleChange('model-a','rule-1','value',literal);renderStatisticsRules('model-a')");
  const markup = h.elements.get('av-statistics-content').innerHTML;
  assert.ok(!markup.includes('<img src=x')); assert.ok(markup.includes('&lt;img'));
  const decode = value => value.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  for (const match of markup.matchAll(/\bon(?:click|input|change)="([^"]*)"/g)) new vm.Script(decode(match[1]));
  h.fail('PUT', new Error('服务器异常')); await h.run("saveStatisticsRules('model-a')");
  assert.equal(h.run("avStatisticsDraft('model-a').rules[0].value"), h.context.literal); assert.equal(h.run("avStatisticsDraft('model-a').saving"), false);
  assert.match(h.elements.get('av-statistics-status').textContent, /服务器异常/);
});

test('load failure can be retried and does not create defaults or write rules', async () => {
  const h = harness(); h.fail('GET', new Error('读取失败')); await h.run("loadStatisticsRules('model-a',true)");
  assert.equal(h.run("avStatisticsDraft('model-a').loaded"), false); h.run("avStatisticsRuleAdd('model-a',0)");
  assert.equal(h.run("avStatisticsDraft('model-a').rules.length"), 0);
  await h.run("loadStatisticsRules('model-a',true)"); assert.equal(h.run("avStatisticsDraft('model-a').loaded"), true);
  assert.equal(h.calls.filter(call => call.method === 'PUT').length, 0);
});
