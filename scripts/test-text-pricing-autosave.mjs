import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
const html=readFileSync(new URL('../server/src/admin/index.html',import.meta.url),'utf8');
const source=html.slice(html.indexOf('function textPeakPeriodRow'),html.indexOf('function modelSettingsFields'));
const pricing=()=>({enabled:true,multiplier:.25,cacheEnabled:false,rates:{input:4,output:20,cachedInput:.4},peak:{enabled:false,rates:{input:4,output:20,cachedInput:.4}},longContext:{enabled:false,threshold:272000,rates:{input:4,output:20,cachedInput:.4},peakRates:{input:4,output:20,cachedInput:.4}}});
function harness(){
 const calls=[],timers=new Map(),model={id:'m',capability:'text',tokenPricing:pricing()};let timerId=0;
 const c=vm.createContext({structuredClone,Map,JSON,Number,console,esc:String,window:{__models:[model],addEventListener(){}},document:{querySelectorAll:()=>[]},setTimeout:fn=>{timers.set(++timerId,fn);return timerId},clearTimeout:id=>timers.delete(id),api:async(url,options)=>{const p=JSON.parse(options.body).tokenPricing;calls.push(p);return {tokenPricing:p}},toast(){},renderModels(){throw Error('must not redraw editing form')},msRender(){throw Error('must not redraw editing form')}});
 vm.runInContext(source,c);
 function form(multiplier,id='m'){
  const p=pricing();p.multiplier=multiplier;const inputs=[];
  function visit(obj,prefix=''){for(const [key,value]of Object.entries(obj)){const path=prefix+key;if(value&&typeof value==='object')visit(value,path+'.');else inputs.push({dataset:{tp:path},type:typeof value==='boolean'?'checkbox':'number',checked:value,value:String(value)});}}visit(p);
  return {dataset:{textPricing:id},querySelectorAll:q=>q==='[data-tp]'?inputs:q==='[data-peak-day]:checked'?[{dataset:{peakDay:'1'}}]:q==='[data-peak-period]'?[{querySelector:q=>({value:q==='[data-peak-start]'?'09:00':'12:00'})}]:[]};
 }
 return {c,calls,model,form,run:code=>vm.runInContext(code,c),tick:async()=>{const pending=[...timers.values()];timers.clear();for(const fn of pending)await fn();}};
}
test('input is wired to automatic saving',()=>{const h=harness();assert.match(h.c.textPricingFields(h.model),/oninput="textPricingChanged\(this\)"/);});
test('rapid edits debounce and survive model detail redraw',async()=>{const h=harness();h.c.textPricingChanged(h.form(.3));h.c.textPricingChanged(h.form(.4));assert.match(h.c.textPricingFields(h.model),/value="0.4"/);await h.tick();assert.equal(h.calls.length,1);assert.equal(h.calls[0].multiplier,.4);assert.equal(h.model.tokenPricing.multiplier,.4);});
test('old response cannot replace newer draft; requests are serialized',async()=>{const h=harness();let release;h.c.api=async(url,o)=>{const p=JSON.parse(o.body).tokenPricing;h.calls.push(p);if(h.calls.length===1)await new Promise(r=>release=r);return {tokenPricing:p}};h.c.textPricingChanged(h.form(.3));const saving=h.tick();await Promise.resolve();h.c.textPricingChanged(h.form(.6));await h.tick();assert.equal(h.calls.length,1);assert.match(h.c.textPricingFields(h.model),/value="0.6"/);release();await saving;assert.deepEqual(h.calls.map(x=>x.multiplier),[.3,.6]);assert.equal(h.model.tokenPricing.multiplier,.6);});
test('invalid partial input remains a draft and never saves zero',async()=>{const h=harness();h.c.textPricingChanged(h.form(''));await h.tick();assert.equal(h.calls.length,0);assert.match(h.c.textPricingFields(h.model),/data-tp="multiplier"[^>]*value=""/);});
test('failed save preserves draft and manual retry saves it',async()=>{const h=harness();const api=h.c.api;h.c.api=async()=>{throw Error('offline')};h.c.textPricingChanged(h.form(.7));await h.tick();assert.match(h.c.textPricingFields(h.model),/value="0.7"/);h.c.api=api;await h.c.saveTextPricing({closest:()=>h.form(.7)});assert.equal(h.model.tokenPricing.multiplier,.7);});
test('model drafts and pending saves stay independent',async()=>{const h=harness();h.c.textPricingChanged(h.form(.3,'m'));h.c.textPricingChanged(h.form(.8,'other'));await h.tick();assert.deepEqual(h.calls.map(p=>p.multiplier),[.3,.8]);});
