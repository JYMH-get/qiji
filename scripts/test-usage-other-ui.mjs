// Exercise the shared report renderer/export in a small DOM harness, without a browser or network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const metric=(quantity,cost)=>({quantity,cost,knownCost:cost,requests:quantity,missing:0,estimated:0,average:quantity?cost/quantity:null});
const products={text:metric(0,0),image:metric(0,0),video:metric(836,66880),audio:metric(0,0),other:metric(4,200)};
const member={userId:'member',name:'成员',role:'成员',account:'fixture',daily:[67080],total:67080,products};
const group={id:'group',name:'小组',mode:'dispatch',members:[member],daily:[67080],total:67080,products};
const company={id:'source',name:'测试公司',groups:[group],userCount:1,daily:[67080],total:67080,products};
const report={startAt:'2026-09-17T07:28:13.954Z',generatedAt:'2026-09-22T00:00:00Z',today:'2026-09-22',from:'2026-09-21',to:'2026-09-21',dates:['2026-09-21'],companies:[company],availableCompanies:[company]};
for(const merchant of [false,true]){
  const handlers={};let blob,download;
  const root={innerHTML:'',style:{setProperty(){}},closest(){return null},querySelector(){return null},querySelectorAll(){return []},addEventListener(name,fn){handlers[name]=fn},removeEventListener(){}};
  const context={window:{},document:{getElementById(){return true},createElement(){return {click(){download=this.download}}}},
    ResizeObserver:class{observe(){} disconnect(){}},URLSearchParams,Blob,URL:{createObjectURL(value){blob=value;return 'blob:fixture'},revokeObjectURL(){}},
    setInterval(){return 1},clearInterval(){},setTimeout(){}};
  vm.runInNewContext(fs.readFileSync(new URL('../server/src/admin/usage-reports.js',import.meta.url),'utf8'),context);
  context.window.QijiUsageReports.mount(root,{merchant,api:async()=>structuredClone(report)});
  await new Promise(resolve=>setImmediate(resolve));
  handlers.click({target:{closest:()=>({dataset:{view:'products'}})}});
  await new Promise(resolve=>setImmediate(resolve));
  assert.match(root.innerHTML,/<th scope="col">其他<\/th>/);
  assert.match(root.innerHTML,/836 秒/);assert.match(root.innerHTML,/80 积分\/秒/);
  assert.match(root.innerHTML,/4 次/);assert.match(root.innerHTML,/50 积分\/次/);
  assert.doesNotMatch(root.innerHTML,/892\.26/);
  handlers.click({target:{closest:()=>({dataset:{action:'export'}})}});
  const csv=await blob.text();assert.match(csv,/其他数量（次）/);assert.match(csv,/其他均价（积分\/次）/);
  assert.match(csv,/"836","80","0","0","","0","4","50","0"/);
  assert.match(download,/单日成品/);
}
console.log('Admin and merchant: five categories, separated quantities/prices and CSV passed (DOM harness).');
