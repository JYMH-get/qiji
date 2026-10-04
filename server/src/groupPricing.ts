import { createHash } from 'node:crypto';
import { lineModel, publicId, routeCapability, routeFamilyName, routingConfig, routingVersion, type AutoLine } from './autoRouting.ts';
import { getAgentGroup } from './store/agents.ts';
import type { ModelDef } from './store/models.ts';
import { groupLineSetting, pricedLineForGroup, saveGroupLineOffsets, type PriceOffsets } from './store/agentGroupPrices.ts';
import { priceEditorFields, offsetLinePrice } from './agentPriceEditor.ts';

function baseModel(line:AutoLine):ModelDef {
  return lineModel(line)??{id:publicId(line.id),label:line.name,familyId:line.familyId,modeId:publicId(line.id),capability:routeCapability(line),protocol:'stub',enabled:line.enabled,params:[],cost:line.cost,costField:line.costPerUnit===undefined?undefined:'duration',costPerUnit:line.costPerUnit,tokenPricing:line.tokenPricing,routes:line.prices?.map(r=>({...r,upstreamModel:''})),createdAt:'',updatedAt:''};
}
function row(groupId:string,line:AutoLine){
  const model=baseModel(line),setting=groupLineSetting(groupId,model.id);
  const purchase=priceEditorFields(pricedLineForGroup(model,groupId,'purchase'));
  const retail=priceEditorFields(pricedLineForGroup(model,groupId,'retail'));
  return {id:model.id,name:line.name,familyName:routeFamilyName(line),capability:model.capability,
    revision:createHash('sha256').update(JSON.stringify([groupId,routingVersion(),model,setting])).digest('hex'),
    fields:priceEditorFields(model).map(f=>({...f,purchaseOffset:setting.purchase?.[f.key]??0,retailOffset:setting.retail?.[f.key]??0,
      purchase:purchase.find(p=>p.key===f.key)?.value,purchaseRange:purchase.find(p=>p.key===f.key)?.range,
      retail:retail.find(p=>p.key===f.key)?.value,retailRange:retail.find(p=>p.key===f.key)?.range}))};
}
export function groupPricesView(groupId:string){
  const group=getAgentGroup(groupId);if(!group)throw Object.assign(new Error('分组不存在'),{statusCode:404});
  return {group:{id:group.id,name:group.name},rows:routingConfig().lines.map(l=>row(groupId,l))};
}
export function updateGroupLinePrice(groupId:string,lineId:string,input:unknown){
  if(!getAgentGroup(groupId))throw Object.assign(new Error('分组不存在'),{statusCode:404});
  const line=routingConfig().lines.find(l=>publicId(l.id)===lineId);
  if(!line)throw Object.assign(new Error('线路不存在'),{statusCode:404});
  if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('价格修改格式错误');
  const body=input as Record<string,unknown>;
  if(Object.keys(body).some(k=>!['revision','purchase','retail'].includes(k)))throw new Error('不支持的价格字段');
  const current=row(groupId,line);
  if(body.revision!==current.revision)throw Object.assign(new Error('源站或分组价格已变化，请刷新后重新保存'),{statusCode:409});
  const old=groupLineSetting(groupId,lineId),keys=new Set(current.fields.map(f=>f.key));
  const offsets=(value:unknown,previous:PriceOffsets={}):PriceOffsets=>{
    if(value===undefined)return previous;
    if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('偏移量格式错误');
    const result={...previous};
    for(const [key,delta] of Object.entries(value)){
      if(!keys.has(key))throw new Error('价格档位已变化，请刷新后重试');
      if(typeof delta!=='number'||!Number.isFinite(delta)||Math.abs(delta)>1e6)throw new Error('偏移量须为 -1000000 至 1000000 的有效数字');
      result[key]=Number(delta.toFixed(8));
    }return result;
  };
  const patch={purchase:offsets(body.purchase,old.purchase),retail:offsets(body.retail,old.retail)};
  const model=baseModel(line);
  offsetLinePrice(model,patch.purchase);offsetLinePrice(model,patch.retail);
  saveGroupLineOffsets(groupId,lineId,old.revision,patch);
  return {ok:true,row:row(groupId,line)};
}
