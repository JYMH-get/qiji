import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
const source=readFileSync(new URL('../server/src/admin/auto-routing.js',import.meta.url),'utf8');
function harness(){
  let stored={version:1,enabled:true,lines:[{id:'a',familyId:'A',name:'A',cost:1},{id:'b',familyId:'B',name:'B',cost:2}]};
  const requests=[],events={};let fail=false,release=null,gate=null;
  const context=vm.createContext({structuredClone,Date,Map,Set,JSON,console,MODES:null,CUR_TAB:'channels',location:{hash:'#routing/A'},setTimeout:()=>1,clearTimeout:()=>{},setInterval:()=>1,toast:()=>{},window:{addEventListener:()=>{}},document:{getElementById:()=>null,querySelectorAll:()=>[],addEventListener:(name,fn)=>{events[name]=fn;}},api:async(url,options)=>{
    if(options?.method==='PUT'){
      const body=JSON.parse(options.body);requests.push(body);
      if(gate)await gate;
      if(fail)throw new Error('模拟保存失败');
      assert.equal(body.version,stored.version,'versioned saves must be serialized');
      stored={...structuredClone(body),version:stored.version+1};return {config:structuredClone(stored)};
    }
    return {previews:[],availability:[],health:{}};
  }});
  vm.runInContext(source,context);
  context.seed=structuredClone(stored);vm.runInContext('AR=structuredClone(seed);AR_BASE=structuredClone(seed);AR_FAMILY="A";',context);
  const run=code=>vm.runInContext(code,context);
  return {run,requests,events,get stored(){return stored;},set fail(v){fail=v;},hold(){gate=new Promise(r=>release=r);},release(){gate=null;release();},flush(){run('for(const s of AR_PENDING.values())s.readyAt=0');return run('arFlushSave()');}};
}
test('edits across families save independently with current versions',async()=>{
  const h=harness();h.run('AR.lines[0].cost=11;arChanged("A");AR_FAMILY="B";AR.lines[1].cost=22;arChanged("B")');
  await h.flush();await h.flush();assert.deepEqual(h.stored.lines.map(l=>l.cost),[11,22]);assert.deepEqual(h.requests.map(r=>r.version),[1,2]);assert.equal(h.run('AR_PENDING.size'),0);
});
test('new edit during an in-flight save survives and is sent next',async()=>{
  const h=harness();h.run('AR.lines[0].cost=11;arChanged("A")');h.hold();const first=h.flush();
  h.run('AR.lines[0].cost=99;arChanged("A")');await h.flush();assert.equal(h.requests.length,1);h.release();await first;
  assert.equal(h.run('AR_PENDING.size'),1);assert.equal(h.run('AR.lines[0].cost'),99);await h.flush();assert.equal(h.stored.lines[0].cost,99);
});
test('failure retains draft, allows other families to save, and supports retry',async()=>{
  const h=harness();h.fail=true;h.run('AR.lines[0].name="draft";arChanged("A")');await h.flush();
  assert.match(h.run('AR_PENDING.get("A").error'),/模拟/);h.fail=false;h.run('AR.lines[1].cost=44;arChanged("B")');await h.flush();
  assert.equal(h.stored.lines[0].name,'A');assert.equal(h.stored.lines[1].cost,44);h.run('arRetrySave()');await h.flush();assert.equal(h.stored.lines[0].name,'draft');
});
test('global disable persists and new lines are preserved',async()=>{
  const h=harness();h.run('AR.enabled=false;arChanged("__global");AR.lines.push({id:"new",familyId:"A",name:"temporary",cost:0});arChanged("A")');
  await h.flush();await h.flush();assert.equal(h.stored.enabled,false);assert.equal(h.stored.lines.length,3);
});

test('candidate reordering preserves full settings and saves array order',async()=>{
 const h=harness();h.run(`renderRouting=()=>{};AR.lines[0].members=[{modelId:'url',enabled:true,priority:1},{modelId:'sd',enabled:true,priority:9,defaults:{a:1}}];arReorderMember('a','sd',-1)`);
 await h.flush();assert.deepEqual(h.stored.lines[0].members,[{modelId:'sd',enabled:true,priority:9,defaults:{a:1}},{modelId:'url',enabled:true,priority:1}]);
 h.run(`arReorderMember('a','sd',-1)`);assert.equal(h.run('AR_PENDING.size'),0);
});
test('repeated input is debounced and does not submit before the delay',async()=>{
  const h=harness();h.run('AR.lines[0].name="first";arChanged("A");AR.lines[0].name="last";arChanged("A")');await h.run('arFlushSave()');assert.equal(h.requests.length,0);await h.flush();assert.equal(h.requests.length,1);assert.equal(h.stored.lines[0].name,'last');
});
test('returning to the routing page preserves pending drafts',async()=>{
  const h=harness();h.run('AR.lines[0].cost=88;arChanged("A");renderRouting=()=>{}');await h.run('loadRouting()');assert.equal(h.run('AR.lines[0].cost'),88);assert.equal(h.run('AR_PENDING.size'),1);
});

test('new MJ family merges while a failed draft remains intact and saves independently',async()=>{
  const h=harness();h.fail=true;
  h.run('AR_FAMILIES=[{id:"A",name:"Grok 4.6",capability:"text"}];AR.lines[0].cost=88;arChanged("A")');
  await h.flush();
  h.run(`arMergeNewFamilies({families:[{id:'A'},{id:'mid-journey',name:'Mid journey',capability:'image'}],models:[{id:'mj'}],initial:{lines:[{id:'mj-line',familyId:'mid-journey',name:'优惠',cost:0}]}})`);
  assert.equal(h.run('AR.lines[0].cost'),88);
  assert.match(h.run('AR_PENDING.get("A").error'),/模拟/);
  assert.equal(h.run('AR_BASE.version'),1);
  assert.equal(h.run('AR_FAMILIES.some(f=>f.id==="mid-journey")'),true);
  assert.equal(h.run('AR_PENDING.has("mid-journey")'),true);
  h.run(`arMergeNewFamilies({families:[{id:'A'},{id:'mid-journey'}],models:[{id:'mj'}],initial:{lines:[]}})`);
  assert.equal(h.run('AR.lines.filter(l=>l.familyId==="mid-journey").length'),1);
  h.fail=false;await h.flush();assert.equal(h.stored.lines.some(l=>l.id==='mj-line'),true);
  h.run('arRetrySave()');await h.flush();assert.equal(h.stored.lines[0].cost,88);
});
test('custom tier cost persists through versioned autosave without changing other families',async()=>{
  const h=harness();h.run('AR.lines[0].prices=[{when:{duration:"5",resolution:"720p"},cost:123.5}];arSyncFallback(AR.lines[0]);arChanged("A")');await h.flush();assert.equal(h.stored.lines[0].prices[0].cost,123.5);assert.equal(h.stored.lines[0].cost,123.5);assert.equal(h.stored.lines[1].cost,2);
});

test('moving a model saves both lines atomically and retains member settings',async()=>{
  const h=harness();h.run(`renderRouting=()=>{};AR_MODELS=[{id:'m',channelId:'ch'}];
    AR.lines[0].capability='image';AR.lines[0].members=[{modelId:'m',enabled:true,priority:3,defaults:{quality:'high'}}];
    AR.lines.push({id:'target',familyId:'A',capability:'image',cost:99,members:[]});
    arMoveMember('a','m','target');`);
  await h.flush();assert.equal(h.stored.lines[0].members.length,0);
  assert.deepEqual(h.stored.lines.at(-1).members,[{modelId:'m',enabled:true,priority:3,defaults:{quality:'high'}}]);
  assert.equal(h.stored.lines.at(-1).cost,99);assert.equal(h.requests.length,1);
});

test('moving refuses duplicate channels and different families without changing drafts',()=>{
  const h=harness();h.run(`renderRouting=()=>{};AR_MODELS=[{id:'m',channelId:'ch'},{id:'m2',channelId:'ch'}];
    AR.lines[0].members=[{modelId:'m'}];AR.lines[1].members=[];
    AR.lines.push({id:'target',familyId:'A',members:[{modelId:'m2'}]});
    arMoveMember('a','m','target');arMoveMember('a','m','b');`);
  assert.equal(h.run('AR.lines[0].members.length'),1);assert.equal(h.run('AR_PENDING.size'),0);
});

test('price summary displays resolution rates in credits and keeps fixed billing units',()=>{
 const h=harness();h.run('esc=String');
 const tier=h.run(`arPriceSummary({capability:'video',prices:[{when:{resolution:'480p',duration:'5'},cost:250},{when:{resolution:'480p',duration:'10'},cost:500},{when:{resolution:'720p',duration:'5'},cost:500},{when:{resolution:'720p',duration:'10'},cost:1500}]})`);
 assert.match(tier,/480p <strong>50积分\/秒/);assert.match(tier,/720p <strong>100–150积分\/秒/);assert.ok(!tier.includes('¥'));
 assert.match(h.run(`arPriceSummary({cost:25,capability:'image'})`),/25积分\/次/);
 assert.match(h.run(`arPriceSummary({cost:0,costPerUnit:50,capability:'video'})`),/50积分\/秒/);
});
