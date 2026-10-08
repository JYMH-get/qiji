/** Statistics-only projection. These rules must never enter settlement or scheduling. */
export interface StatisticsRule {
 id:string; enabled:boolean; field:'error'|'durationSec'|'status';
 operator:'contains'|'notContains'|'equals'|'lt'|'lte'|'eq'|'gte'|'gt';
 value:string|number; action:'exclude'|'success'|'failed';
 matchStatus?:'all'|'success'|'failed';
}
export interface StatisticsEvidence {
 status:string; errorEvidence?:string; errorEvidenceComplete?:boolean; durationMs?:number;
}
export class StatisticsRuleError extends Error {constructor(message:string,readonly status=400){super(message);}}
export function validateStatisticsRules(input:unknown):StatisticsRule[]{
 if(!Array.isArray(input)||input.length>50)throw new StatisticsRuleError('最多保存 50 条统计规则');
 const ids=new Set<string>();
 return input.map((raw)=>{
  if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).some(k=>!['id','enabled','field','operator','value','action','matchStatus'].includes(k)))throw new StatisticsRuleError('统计规则含无效字段');
  const {id,enabled,field,operator,value,action,matchStatus}=raw;
  if(matchStatus!==undefined&&!['all','success','failed'].includes(matchStatus))throw new StatisticsRuleError('规则适用结果无效');
  if(typeof id!=='string'||!/^[A-Za-z0-9_-]{1,80}$/.test(id)||ids.has(id))throw new StatisticsRuleError('规则 ID 无效或重复');ids.add(id);
  if(typeof enabled!=='boolean'||!['exclude','success','failed'].includes(action))throw new StatisticsRuleError('规则开关或统计结果无效');
  if(field==='error'){
   if(!['contains','notContains','equals'].includes(operator)||typeof value!=='string'||!value.trim()||value.trim().length>2000)throw new StatisticsRuleError('错误规则需使用包含、不包含或等于，以及 1–2000 字符的文本');
  }else if(field==='durationSec'){
   if(!['lt','lte','eq','gte','gt'].includes(operator)||typeof value!=='number'||!Number.isFinite(value)||value<0||value>604800)throw new StatisticsRuleError('耗时规则需使用数值比较，秒数范围为 0–604800');
  }else if(field==='status'){
   if(operator!=='equals'||!['success','failed'].includes(value))throw new StatisticsRuleError('状态规则只支持等于成功或失败');
   if(matchStatus&&matchStatus!=='all'&&matchStatus!==value)throw new StatisticsRuleError('适用结果与状态条件矛盾');
  }else throw new StatisticsRuleError('统计规则字段无效');
  return {id,enabled,field,operator,value:typeof value==='string'?value.trim():value,action,...(matchStatus===undefined?{}:{matchStatus})} as StatisticsRule;
 });
}
export function statisticsProjection(evidence:StatisticsEvidence,rules:readonly StatisticsRule[]):{status:string;ruleId?:string}{
 if(evidence.status!=='success'&&evidence.status!=='failed')return {status:evidence.status};
 for(const r of rules){
  if(!r.enabled)continue;
  if(r.matchStatus&&r.matchStatus!=='all'&&r.matchStatus!==evidence.status)continue;
  let match=false;
  if(r.field==='status')match=r.value===evidence.status;
  else if(r.field==='durationSec'){
   const n=evidence.durationMs===undefined?NaN:evidence.durationMs/1000,v=Number(r.value);
   if(Number.isFinite(n)&&n>=0)match=r.operator==='lt'?n<v:r.operator==='lte'?n<=v:r.operator==='eq'?n===v:r.operator==='gte'?n>=v:n>v;
  }else{
   const text=evidence.errorEvidence??'',v=String(r.value);
   // Absence/truncation/legacy scrubbed evidence cannot prove a negative.
   if(text.trim())match=r.operator==='contains'?text.includes(v):r.operator==='equals'?evidence.errorEvidenceComplete===true&&text===v:evidence.errorEvidenceComplete===true&&!text.includes(v);
  }
  if(match)return {status:r.action==='exclude'?'excluded':r.action,ruleId:r.id};
 }
 return {status:evidence.status};
}
