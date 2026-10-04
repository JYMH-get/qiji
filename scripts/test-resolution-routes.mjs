import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const html=readFileSync(new URL('../server/src/admin/index.html',import.meta.url),'utf8');
const scripts=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
scripts.forEach(x=>new Function(x[1]));
const channels=readFileSync(new URL('../server/src/admin/channels.js',import.meta.url),'utf8');
new Function(channels);
const context=vm.createContext({structuredClone,maxDurOf:()=>15});
vm.runInContext(html.slice(html.indexOf('function modelResolutionOptions('),html.indexOf('function modelSettingsFields(')),context);
const fill=(model,routes)=>JSON.parse(JSON.stringify(context.resolutionRouteDefaults(model,routes)));
const model={id:'any-provider-model',upstreamModel:'same-upstream',params:[{key:'resolution',options:['480p','720p','1080p']}],costField:'duration',costPerUnit:80,cost:1200};
let checks=0;const check=(value,message)=>{assert.ok(value,message);checks++};
for(const capability of ['video','image','audio']){
 const m={...model,capability,...(capability==='video'?{}:{costField:undefined,cost:20})};
 const rows=fill(m,[]);
 check(rows.length===3,capability+' resolution rows');
 check(rows.every(r=>r.upstreamModel==='same-upstream'),capability+' same upstream');
 check(rows.every(r=>capability==='video'?r.costPerUnit===80&&r.cost===1200:r.cost===20&&r.costPerUnit===undefined),capability+' preserves initial price');
 assert.deepEqual(fill(m,rows),rows);checks++;
}
const existing=[{when:{resolution:'480p'},upstreamModel:'special-model',channelId:'special-channel',costPerUnit:12,cost:180},{when:{resolution:'720p'},upstreamModel:'',costPerUnit:25},{when:{},upstreamModel:'fallback',cost:123}];
const original=structuredClone(existing),rows=fill(model,existing);
assert.deepEqual(existing,original);checks++;
assert.deepEqual(rows[0],existing[0]);checks++;
check(rows[1].upstreamModel==='same-upstream'&&rows[1].costPerUnit===25&&rows[1].cost===375,'blank model filled, custom price retained');
check(rows[2].when.resolution==='1080p'&&rows[3].upstreamModel==='fallback','new resolution before unconditional fallback');
check(fill({...model,upstreamModel:''},[])[0].upstreamModel===model.id,'model id fallback');
check(fill({...model,params:[{key:'resolution',options:['720p']}]},[]).length===0,'single resolution unchanged');
check(fill({...model,tokenPricing:{enabled:true}},[]).length===0,'token pricing unchanged');
check(fill({...model,params:[{key:'resolution',options:['720p','720p']}]},[]).length===0,'duplicate option not multiple resolutions');
check(fill({...model,params:[{key:'resolution',options:['480p','720p','1080p','2k']}]},rows).filter(r=>r.when.resolution==='2k').length===1,'new parameter option receives one route');
// Channel navigation retains unsaved route prices and each model owns its draft.
context.window={__models:[model,{...model,id:'second-model'}],addEventListener(){}};
vm.runInContext(channels,context);
vm.runInContext("chRouteDraft('any-provider-model').routes[0].costPerUnit=99;chRouteDraft('second-model');",context);
check(vm.runInContext("chRouteDraft('any-provider-model').routes[0].costPerUnit===99",context),'draft preserved across model navigation');
check(model.routes===undefined,'rendering does not mutate saved settings');
console.log(`RESOLUTION_ROUTES ${checks}/${checks}; admin scripts syntax OK`);
