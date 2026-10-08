import { db } from './sqlite.ts';
import { getModelDef, listModels } from './models.ts';
import { notifyAvailabilityConfigChange, onAvailabilityConfigChange } from '../availabilityConfigEvents.ts';
import { StatisticsRuleError, statisticsProjection, validateStatisticsRules, type StatisticsEvidence, type StatisticsRule } from '../statisticsRules.ts';

db.exec(`CREATE TABLE IF NOT EXISTS model_statistics_rules(model_id TEXT NOT NULL,identity TEXT NOT NULL,version INTEGER NOT NULL,rules TEXT NOT NULL,updated_at INTEGER,PRIMARY KEY(model_id,identity));
CREATE TABLE IF NOT EXISTS model_statistics_rule_audit(version INTEGER PRIMARY KEY AUTOINCREMENT,model_id TEXT NOT NULL,identity TEXT NOT NULL,created_at INTEGER NOT NULL,data TEXT NOT NULL);`);
export interface StatisticsRulesView {version:number;rules:StatisticsRule[];updatedAt:number|null;}
const cache=new Map<string,StatisticsRulesView|undefined>();
let modelIdentities:Map<string,string>|undefined;
onAvailabilityConfigChange(()=>{modelIdentities=undefined;});
const key=(id:string,identity:string)=>JSON.stringify([id,identity]);
function read(id:string,identity:string):StatisticsRulesView|undefined{
 const k=key(id,identity);if(cache.has(k))return cache.get(k);
 const row=db.prepare('SELECT version,rules,updated_at AS updatedAt FROM model_statistics_rules WHERE model_id=? AND identity=?').get(id,identity) as {version:number;rules:string;updatedAt:number|null}|undefined;
 if(!row){cache.set(k,undefined);return undefined;}const view={...row,rules:JSON.parse(row.rules) as StatisticsRule[]};cache.set(k,view);return view;
}
function identityOf(id:string){const m=getModelDef(id);if(!m)throw new StatisticsRuleError('模型不存在',404);return m.createdAt;}
export function getStatisticsRules(id:string):StatisticsRulesView{
 const identity=identityOf(id),existing=read(id,identity);if(existing)return existing;
 // Global revisions also protect a fresh empty configuration after deleting/recreating an ID.
 db.exec('BEGIN IMMEDIATE');try{
  const at=Date.now(),r=db.prepare('INSERT INTO model_statistics_rule_audit(model_id,identity,created_at,data) VALUES(?,?,?,?)').run(id,identity,at,JSON.stringify({action:'initialize',actor:'admin',before:null,after:[]}));
  const view={version:Number(r.lastInsertRowid),rules:[],updatedAt:null};
  db.prepare('INSERT INTO model_statistics_rules(model_id,identity,version,rules,updated_at) VALUES(?,?,?,?,?)').run(id,identity,view.version,'[]',null);db.exec('COMMIT');cache.set(key(id,identity),view);return view;
 }catch(e){db.exec('ROLLBACK');throw e;}
}
export function saveStatisticsRules(id:string,input:unknown,now=Date.now()):StatisticsRulesView{
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['version','rules'].includes(k)))throw new StatisticsRuleError('统计规则请求格式无效');
 const {version,rules} = input as {version:unknown;rules:unknown};
 if(typeof version!=='number'||!Number.isSafeInteger(version)||version<1)throw new StatisticsRuleError('统计规则版本无效');
 const next=validateStatisticsRules(rules),identity=identityOf(id),before=getStatisticsRules(id);
 if(before.version!==version)throw new StatisticsRuleError('统计规则已变化，请重新读取后再保存',409);
 db.exec('BEGIN IMMEDIATE');let view:StatisticsRulesView;
 try{
  const event={action:'save',actor:'admin',before,after:next};
  const r=db.prepare('INSERT INTO model_statistics_rule_audit(model_id,identity,created_at,data) VALUES(?,?,?,?)').run(id,identity,now,JSON.stringify(event));
  view={version:Number(r.lastInsertRowid),rules:next,updatedAt:now};
  const changed=db.prepare('UPDATE model_statistics_rules SET version=?,rules=?,updated_at=? WHERE model_id=? AND identity=? AND version=?').run(view.version,JSON.stringify(next),now,id,identity,version);
  if(!changed.changes)throw new StatisticsRuleError('统计规则已变化，请重新读取后再保存',409);
  db.exec('COMMIT');
 }catch(e){db.exec('ROLLBACK');throw e;}
 cache.set(key(id,identity),view!);notifyAvailabilityConfigChange();return view!;
}
export function projectModelStatistics(evidence:StatisticsEvidence&{modelId?:string;modelCreatedAt?:string}){
 const identities=modelIdentities??=new Map(listModels().map(model=>[model.id,model.createdAt]));
 const identity=evidence.modelId?identities.get(evidence.modelId):undefined;
 // An old request must never inherit the rules of a replacement model with the same ID.
 if(!identity||!evidence.modelId||!evidence.modelCreatedAt||identity!==evidence.modelCreatedAt)return {status:evidence.status};
 return statisticsProjection(evidence,read(evidence.modelId,identity)?.rules??[]);
}
