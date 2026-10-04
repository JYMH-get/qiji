import assert from 'node:assert/strict';
import fs from 'node:fs';
if (!import.meta.url.includes('/qiji-text-reasoning-')) throw new Error('Sandbox only');
let checks = 0;
const eq = (a, b) => { assert.deepEqual(a, b); checks++; };
let wire;
globalThis.fetch = async (url, init) => {
  assert.equal(url, 'https://fixture.invalid/v1/chat/completions');
  wire = JSON.parse(init.body);
  return new Response('data: '+JSON.stringify({ choices: [{ delta: { content: 'ok' } }], usage: { prompt_tokens: 2, completion_tokens: 3 } })+'\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
};
const { textReasoningFields, addTextReasoningFields, textReasoningBody } = await import('../src/textReasoning.ts');
if (process.argv[2] === 'first') {
  fs.mkdirSync('data',{recursive:true});
  fs.writeFileSync('data/models.json',JSON.stringify({version:1,models:[{id:'legacy-deepseek',label:'legacy',capability:'text',protocol:'openai-chat',upstreamModel:'deepseek-v4-pro',params:[],enabled:true,createdAt:'',updatedAt:''}]}));
}
const models = await import('../src/store/models.ts');
eq(models.getModelDef('legacy-deepseek').params.map(f=>f.key),['thinkingMode','reasoning_effort']);
const { resolveUpstream } = await import('../src/translators/upstream.ts');
const { translateOpenAIText } = await import('../src/translators/openai.ts');
const run = async (model, params) => {
  const req = { model: model.id, purpose: 'chat.reply', promptOverride: 'fixture', params, output: { format: 'text' } };
  const before = JSON.stringify(req);
  const result = await translateOpenAIText(req, resolveUpstream(model, req));
  eq(result.status, 'success'); eq(JSON.stringify(req), before);
  return wire;
};
if (process.argv[2] === 'restart') {
  const model = models.getModelDef('fixture-deepseek');
  eq(model.params.find(f => f.key === 'reasoning_effort').default, 'max');
  eq((await run(model, {})).reasoning_effort, 'max');
  eq(model.params.filter(f => f.key === 'thinkingMode').length, 1);
} else {
  const alias=models.createModel({id:'fixture-alias',label:'gem3.1',capability:'text',protocol:'openai-chat',upstreamModel:'gem3.1-pro',baseUrl:'https://fixture.invalid',apiKey:'fixture',params:[]});
  models.updateModel(alias.id,{params:[{key:'thinkingMode',label:'思考模式',type:'enum',options:['default','enabled','disabled'],default:'default'},{key:'reasoning_effort',label:'思考强度',type:'enum',options:['default','low','medium','high'],default:'default'}]});
  eq((await run(alias,{})).reasoning_effort,undefined);
  eq((await run(alias,{thinkingMode:'enabled',reasoning_effort:'high'})).reasoning_effort,'high');
  eq((await run(alias,{thinkingMode:'disabled'})).reasoning_effort,'none');
  for (const [id, efforts, modes] of [
    ['deepseek-v4-pro', ['low','high','max'], ['enabled','disabled']],
    ['gpt-5.5', ['low','medium','high','xhigh'], ['enabled','disabled']],
    ['gpt-5.6-sol', ['low','medium','high','xhigh','max'], ['enabled','disabled']],
    ['gemini-3.1-pro-preview', ['low','medium','high'], ['enabled']],
    ['gemini-3.5-flash', ['low','medium','high'], ['enabled']],
  ]) {
    const fields = textReasoningFields(id);
    eq(fields[0].options, modes); eq(fields[1].options, efforts);
    const model = models.createModel({ id: 'fixture-'+id, label: id, capability: 'text', protocol: 'openai-chat', upstreamModel: id, baseUrl: 'https://fixture.invalid', apiKey: 'fixture', params: [] });
    eq(model.params.length, 2);
    const defaultWire = await run(model, {});
    eq(defaultWire.thinking, id.startsWith('deepseek') ? {type:'disabled'} : undefined); eq(defaultWire.reasoning_effort, id.startsWith('deepseek') ? undefined : modes.includes('disabled') ? 'none' : 'high');
    const chosen = await run(model, { thinkingMode: 'enabled', reasoning_effort: 'high' });
    eq(chosen.reasoning_effort, 'high');
    eq(chosen.thinking, id.startsWith('deepseek') ? {type:'enabled'} : undefined);
    if (modes.includes('disabled')) {
      const off = await run(model, { thinkingMode:'disabled', reasoning_effort:'high' });
      eq(off.reasoning_effort, id.startsWith('deepseek') ? undefined : 'none');
      eq(off.thinking, id.startsWith('deepseek') ? {type:'disabled'} : undefined);
    }
  }
  const model = models.createModel({ id:'fixture-deepseek', label:'DeepSeek', capability:'text', protocol:'openai-chat', upstreamModel:'deepseek-v4-pro', baseUrl:'https://fixture.invalid', apiKey:'fixture', params:[] });
  const fields = model.params.map(f => ({...f, default:f.key==='thinkingMode'?'enabled':'max'}));
  models.updateModel(model.id, {params:fields});
  eq((await run(model, {})).reasoning_effort, 'max');
  eq((await run(model, {reasoning_effort:'low'})).reasoning_effort, 'low');
  eq((await run(model, {thinkingMode:'default',reasoning_effort:'default'})).thinking, undefined);
  eq(textReasoningBody('deepseek-v4-pro', {thinking:{type:'disabled',custom:42}}), {thinking:{type:'disabled',custom:42}});
  const preserved = {id:'deepseek-v4-pro', capability:'text',protocol:'openai-chat', params:[{key:'reasoning_effort',type:'enum',label:'custom',options:['high'],default:'high'}]};
  addTextReasoningFields(preserved); addTextReasoningFields(preserved);
  eq(preserved.params.length,2); eq(preserved.params[0].default,'high');
  eq(textReasoningFields('gpt-4o'),[]);
  // Text route parameter intersection must retain controls supported by all candidates.
  const routing = await import('../src/autoRouting.ts');
  const families = await import('../src/store/families.ts');
  const channels = await import('../src/store/channels.ts');
  eq(families.createFamily({id:'fixture-family',name:'Fixture text',capability:'text'}).ok,true);
  channels.updateChannel('ch-gaisc',{enabled:true,apiKey:'fixture',baseUrl:'https://fixture.invalid'});
  models.updateModel(model.id,{familyId:'fixture-family',channelId:'ch-gaisc'});
  const config = routing.routingConfig();
  const member = {modelId:model.id,enabled:true,vipEnabled:false,priority:0,defaults:{},concurrencyWeight:1,failureThreshold:3,failureWindowSec:300,cooldownSec:300,failureRetainPercent:50};
  routing.saveRoutingConfig({...config,enabled:true,lines:[...config.lines,{id:'fixture-text',modelVersion:'fixture-family',familyId:'fixture-family',capability:'text',name:'fixture',kind:'stable',enabled:true,order:0,cost:1,members:[member]}]});
  eq(routing.publicModelDef('route:fixture-text').params.map(f=>f.key),['thinkingMode','reasoning_effort']);
  const request={model:'route:fixture-text',purpose:'chat.reply',params:{thinkingMode:'enabled',reasoning_effort:'low'},output:{format:'text'}};
  eq(routing.prepareRoutingRequest(request),undefined);
  const selected=routing.selectRoute(request);
  eq(selected.request.params,request.params);
  eq((await run(models.getModelDef(selected.request.model),selected.request.params)).reasoning_effort,'low');
}
console.log(process.argv[2]+': '+checks+' assertions passed');
process.exit(0);
