import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
const source=readFileSync(process.argv[2]??new URL('../server/src/admin/auto-routing.js',import.meta.url),'utf8');
function harness(){
 const inputs=new Map(),calls=[];
 const context=vm.createContext({structuredClone,Date,Map,Set,JSON,console,MODES:null,setTimeout:()=>1,clearTimeout:()=>{},toast:()=>{},window:{addEventListener(){}},document:{getElementById:id=>inputs.get(id)??null,querySelectorAll:()=>[],addEventListener(){}},api:async(url,body)=>{calls.push({url,body});throw Error('Unexpected request');}});
 context.setInterval=()=>1;
 vm.runInContext(source,context);
 const run=code=>vm.runInContext(code,context);
 run(`renderRouting=()=>{};AR={lines:[{id:'a',name:'测试',familyId:'A',cost:20,members:[{modelId:'m',enabled:true,concurrencyWeight:1}]}]};AR_MODELS=[{id:'m',params:[{key:'duration',type:'number',min:4,max:6,step:1},{key:'resolution',type:'enum',options:['480p','720p']}]}];`);
 return {run,context,inputs,calls,json:code=>JSON.parse(run('JSON.stringify('+code+')'))};
}
test('custom tiers start with configured fixed cost without fetching highest prices',()=>{const h=harness();h.run(`arBilling(0,'tiers')`);assert.equal(h.calls.length,0);assert.deepEqual(h.json('AR.lines[0].prices.map(p=>p.cost)'),Array(6).fill(20));});
test('per-second prices convert to per-job costs using existing rounding',()=>{const h=harness();h.run(`AR.lines[0].costPerUnit=2.5;arBilling(0,'tiers')`);assert.deepEqual(h.json('AR.lines[0].prices.map(p=>p.cost)'),[10,10,13,13,15,15]);assert.equal(h.run('AR.lines[0].costPerUnit'),undefined);});
test('adding supported tiers preserves custom prices and uses active capability union',()=>{const h=harness();h.run(`AR.lines[0].prices=[{when:{duration:'4',resolution:'480p'},cost:123.5}];AR.lines[0].members.push({modelId:'missing',enabled:false,concurrencyWeight:1});arCustomPrices(0)`);assert.equal(h.run('AR.lines[0].prices[0].cost'),123.5);assert.equal(h.run('AR.lines[0].prices.length'),6);h.run(`AR_MODELS.push({id:'n',params:[{key:'duration',type:'enum',options:['5','6']},{key:'resolution',type:'enum',options:['720p','1080p']}]});AR.lines[0].members.push({modelId:'n',enabled:true,concurrencyWeight:1});arCustomPrices(0)`);assert.equal(h.run('AR.lines[0].prices.length'),8);assert.equal(h.run('AR.lines[0].prices[0].cost'),123.5);assert.deepEqual(h.json('AR.lines[0].prices.slice(-2).map(p=>p.when)'),[{duration:'5',resolution:'1080p'},{duration:'6',resolution:'1080p'}]);});
test('pricing-only resolutions survive supplementing actual capabilities',()=>{const h=harness();h.run(`AR.lines[0].prices=[{when:{duration:'4',resolution:'4k'},cost:999}];arCustomPrices(0)`);assert.equal(h.run('AR.lines[0].prices.length'),7);assert.equal(h.run('AR.lines[0].prices[0].cost'),999);});
test('column bulk rates affect only that resolution and accept fixed zero',()=>{const h=harness();h.run('arCustomPrices(0)');h.inputs.set('ar-rate-0-0',{value:'3.5'});h.inputs.set('ar-rate-unit-0-0',{value:'second'});h.run('arBulkPrice(0,0)');assert.deepEqual(h.json('AR.lines[0].prices.map(p=>p.cost)'),[14,20,18,20,21,20]);h.inputs.set('ar-rate-0-1',{value:'0'});h.inputs.set('ar-rate-unit-0-1',{value:'fixed'});h.run('arBulkPrice(0,1)');assert.deepEqual(h.json('AR.lines[0].prices.map(p=>p.cost)'),[14,0,18,0,21,0]);});
test('blank and negative inputs retain prices; valid cell updates fallback',()=>{const h=harness();h.run('arCustomPrices(0)');for(const value of ['', '-1']){h.context.field={value,setCustomValidity(){}};h.run('arTierPrice(0,0,field)');assert.equal(h.run('AR.lines[0].prices[0].cost'),20);}h.context.field={value:'123.5',setCustomValidity(){}};h.run('arTierPrice(0,0,field)');assert.equal(h.run('AR.lines[0].cost'),123.5);});
test('slow model-price fill cannot overwrite a newer manual price',async()=>{const h=harness();h.run('arCustomPrices(0)');let release;h.context.api=()=>new Promise(r=>release=r);const request=h.run('arHighest(0)');h.run('AR.lines[0].prices[0].cost=777');release({cost:30,prices:[{when:{duration:'4',resolution:'480p'},cost:30}]});await request;assert.equal(h.run('AR.lines[0].prices[0].cost'),777);});
test('image resolution tiers need no duration and preserve edited prices',()=>{
 const h=harness();h.context.esc=String;
 h.run(`AR.lines[0].capability='image';AR_MODELS[0].params=[{key:'resolution',type:'enum',options:['1k','1.5k','2k']}];arBilling(0,'tiers')`);
 assert.deepEqual(h.json('AR.lines[0].prices'),['1k','1.5k','2k'].map(resolution=>({when:{resolution},cost:20})));
 h.run(`AR.lines[0].prices[1].cost=35;AR_MODELS[0].params[0].options.push('4k');arCustomPrices(0)`);
 assert.equal(h.run('AR.lines[0].prices[1].cost'),35);
 assert.equal(h.run('AR.lines[0].prices.length'),4);
 const html=h.run('arPriceTable(AR.lines[0],0)');assert.ok(html.includes('分辨率规格')&&!html.includes('秒'));
});
