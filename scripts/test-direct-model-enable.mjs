import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const html = read('../server/src/admin/index.html');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
for (const [, script] of scripts) new Function(script);
new Function(read('../server/src/admin/channels.js'));
let checks = 0;
const check = (condition, message) => { assert.ok(condition, message); checks++; };

// Evaluate only updateModel, with store persistence mocked; never import the real data store.
const source = read('../server/src/store/models.ts');
const tree = ts.createSourceFile('models.ts', source, ts.ScriptTarget.Latest, true);
const update = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'updateModel').getText(tree);
const stored = { id: 'fixture', enabled: false, params: [], routes: [{ when: { resolution: '2k' }, upstreamModel: 'banana', cost: 10 }] };
let saves = 0;
const store = vm.createContext({ exports: {}, getModelDef: id => id === stored.id ? stored : undefined,
  validateModelMaterialPolicy: () => {}, persist: () => saves++, notifyAvailabilityConfigChange: () => {} });
vm.runInContext(ts.transpileModule(update, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, store);
check(store.exports.updateModel('fixture', { enabled: true }).enabled === true, 'enable persists');
check(store.exports.updateModel('fixture', { enabled: false }).enabled === false, 'disable persists');
const routes = JSON.stringify(stored.routes);
store.exports.updateModel('fixture', { label: 'updated' });
check(stored.enabled === false && JSON.stringify(stored.routes) === routes, 'other saves retain enable state and routes');
for (const enabled of ['true', 1, null, undefined]) {
  assert.throws(() => store.exports.updateModel('fixture', { enabled }), /布尔/); checks++;
}
check(saves === 3, 'invalid values do not persist');

let routingEnabled = false, writes = 0, failSave = false, renders = 0;
const model = { id: 'fixture', enabled: false };
const ui = vm.createContext({ window: { __models: [model] }, Set, JSON,
  esc: value => String(value).replaceAll('"', '&quot;'), CUR_TAB: 'channels', dlg: { open: false },
  renderChannelModels: () => renders++, toast: () => {},
  api: async (path, options) => {
    if (path === '/admin-api/auto-routing') return { config: { enabled: routingEnabled } };
    assert.equal(path, '/admin-api/models/fixture');
    check(options.method === 'PUT', 'enable uses PUT');
    const patch = JSON.parse(options.body);
    assert.deepEqual(Object.keys(patch), ['enabled']); checks++;
    if (failSave) throw new Error('fixture rejection');
    writes++;
    return { enabled: patch.enabled };
  } });
vm.runInContext(html.slice(html.indexOf('window.__modelRoutingEnabled = true;'), html.indexOf('function textPeakPeriodRow(')), ui);
const field = () => ui.directModelEnabledFields(model, (label, control) => label + control);
check(field() === '', 'unknown routing state hides switch');
await ui.refreshModelRoutingState();
check(field().includes('直连启用') && field().includes('value="false" selected'), 'OFF exposes disabled model');
await ui.setDirectModelEnabled('fixture', true);
check(model.enabled === true && writes === 1, 'OFF enable saves');
await ui.setDirectModelEnabled('fixture', false);
check(model.enabled === false && writes === 2, 'OFF disable saves');
routingEnabled = true;
await ui.setDirectModelEnabled('fixture', true);
check(writes === 2 && model.enabled === false, 'stale OFF screen cannot write after ON');
check(field() === '', 'ON hides switch');
routingEnabled = false; failSave = true;
await ui.setDirectModelEnabled('fixture', true);
check(model.enabled === false && writes === 2, 'failed save keeps original state');
check(renders === 4, 'success and failure rerender saved state');
check(ui.directModelEnabledFields({ ...model, hidden: true }, (_label, ctl) => ctl) === '', 'internal fee models unchanged');
check(read('../server/src/admin/channels.js').includes("api('/admin-api/models'),refreshModelRoutingState()"), 'channel entry refreshes routing mode');
console.log(`DIRECT_MODEL_ENABLE ${checks}/${checks}; admin syntax OK; no data writes or upstream calls`);
