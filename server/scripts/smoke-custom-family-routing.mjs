import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
assert.ok(existsSync(new URL('../.qiji-custom-family-sandbox',import.meta.url)));
globalThis.fetch=async()=>{throw Error('No network allowed')};
const models=await import('../src/store/models.ts');
const routing=await import('../src/autoRouting.ts');
const {buildCatalog}=await import('../src/catalog.ts');
models.createModel({...models.getModelDef('jmt933-sd2.0'),id:'custom-video-model',label:'自定义视频模型',capability:'video',protocol:'openai-video',channelId:models.getModelDef('jmt933-sd2.0').channelId,enabled:true,shareScope:'all',familyId:'fam-seedance',upstreamModel:'videos-standard'});
const member={modelId:'custom-video-model',enabled:true,priority:0,concurrencyWeight:1,failureThreshold:3,failureWindowSec:300,cooldownSec:300,failureRetainPercent:50,defaults:{}};
const line={id:'custom-family-regression',name:'测试',familyId:'fam-seedance',modelVersion:'2.0',enabled:true,cost:750,members:[member]};
const config=()=>({...routing.routingConfig(),enabled:true,lines:[structuredClone(line)]});
if(process.argv.includes('--before')){assert.throws(()=>routing.saveRoutingConfig(config()),/渠道模型版本与线路不一致/);console.log('REPRODUCED valid configured family rejected by ID');}
else{
 routing.saveRoutingConfig(config());assert.ok(buildCatalog().models.some(m=>m.id==='route:custom-family-regression'));
 for(const familyId of ['fam-seedance-2-5','fam-seedance-2-0-fast','fam-seedance-2-0-mini']){models.updateModel('custom-video-model',{familyId});assert.throws(()=>routing.saveRoutingConfig(config()),/同家族模型/);}
 models.updateModel('007-sd2.5',{familyId:'fam-seedance'});const cross=config();cross.lines[0].members[0].modelId='007-sd2.5';assert.throws(()=>routing.saveRoutingConfig(cross),/同家族模型/);
 models.updateModel('custom-video-model',{familyId:'fam-seedance',enabled:false});assert.ok(!buildCatalog().models.some(m=>m.id==='route:custom-family-regression'));
 models.updateModel('custom-video-model',{enabled:true,shareScope:'none'});assert.ok(!buildCatalog().models.some(m=>m.id==='route:custom-family-regression'));
 console.log('CUSTOM_FAMILY_ROUTING 7/7: catalog visible, cross family rejected, availability gates retained');
}
