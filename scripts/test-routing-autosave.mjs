import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
const source=readFileSync(new URL('../server/src/admin/auto-routing.js',import.meta.url),'utf8');
function harness(){
  let stored={version:1,enabled:true,lines:[{id:'a',familyId:'A',name:'A',cost:1},{id:'b',familyId:'B',name:'B',cost:2}]};
  const requests=[],events={};let fail=false,release=null,gate=null;
  const context=vm.createContext({structuredClone,Date,Map,Set,JSON,console,MODES:null,CUR_TAB:'channels',location:{hash:'#routing/A'},setTimeout:()=>1,clearTimeout:()=>{},toast:()=>{},window:{addEventListener:()=>{}},document:{getElementById:()=>null,querySelectorAll:()=>[],addEventListener:(name,fn)=>{events[name]=fn;}},api:async(url,options)=>{
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
test('global switch and new line are both preserved',async()=>{
  const h=harness();h.run('AR.enabled=false;arChanged("__global");AR.lines.push({id:"new",familyId:"A",name:"temporary",cost:0});arChanged("A")');
  await h.flush();await h.flush();assert.equal(h.stored.enabled,false);assert.equal(h.stored.lines.length,3);
});
test('repeated input is debounced and does not submit before the delay',async()=>{
  const h=harness();h.run('AR.lines[0].name="first";arChanged("A");AR.lines[0].name="last";arChanged("A")');await h.run('arFlushSave()');assert.equal(h.requests.length,0);await h.flush();assert.equal(h.requests.length,1);assert.equal(h.stored.lines[0].name,'last');
});
test('returning to the routing page preserves pending drafts',async()=>{
  const h=harness();h.run('AR.lines[0].cost=88;arChanged("A");renderRouting=()=>{}');await h.run('loadRouting()');assert.equal(h.run('AR.lines[0].cost'),88);assert.equal(h.run('AR_PENDING.size'),1);
});
test('custom tier cost persists through versioned autosave without changing other families',async()=>{
  const h=harness();h.run('AR.lines[0].prices=[{when:{duration:"5",resolution:"720p"},cost:123.5}];arSyncFallback(AR.lines[0]);arChanged("A")');await h.flush();assert.equal(h.stored.lines[0].prices[0].cost,123.5);assert.equal(h.stored.lines[0].cost,123.5);assert.equal(h.stored.lines[1].cost,2);
});
