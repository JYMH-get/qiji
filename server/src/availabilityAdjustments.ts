import { randomUUID } from 'node:crypto';
import { db } from './store/sqlite.ts';
import type { SuccessRateSnapshot } from './contract.ts';
import { AV_HISTORY_MS } from './availabilityHistory.ts';
import { AV_RETENTION_MS } from './availabilityArchive.ts';

const SLOT_MS=600_000;
db.exec(`CREATE TABLE IF NOT EXISTS availability_history_edits(scope TEXT NOT NULL,bucket INTEGER NOT NULL,epoch TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(scope,bucket));
CREATE TABLE IF NOT EXISTS availability_history_edit_audit(id TEXT PRIMARY KEY,scope TEXT NOT NULL,created_at INTEGER NOT NULL,data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS availability_history_edit_audit_scope ON availability_history_edit_audit(scope,created_at);`);
export interface HistoryScope {scope:string;epoch:string;history:SuccessRateSnapshot[];active:boolean;}
interface Edit extends SuccessRateSnapshot {id:string;reason:string;source:'self-test'|'correction';editedAt:number;}
const bucket=(until:number)=>Math.floor(until/SLOT_MS)*SLOT_MS;
function editsFor(scope:string,now:number,real:SuccessRateSnapshot[]=[]):Edit[]{
 const native=new Map(real.map(p=>[bucket(p.until),p]));
 return (db.prepare('SELECT data FROM availability_history_edits WHERE scope=? AND bucket>?').all(scope,now-AV_HISTORY_MS-SLOT_MS) as {data:string}[]).map(r=>JSON.parse(r.data) as Edit).filter(e=>{
  if((native.get(bucket(e.until))?.until??0)>e.until){db.prepare('DELETE FROM availability_history_edits WHERE scope=? AND bucket=?').run(scope,bucket(e.until));return false;}
  return e.until>now-AV_HISTORY_MS&&e.until<=now;
 });
}
/** Production samples stay immutable. Only the displayed historical point may have an attributed replacement. */
export function adjustedHistory(real:SuccessRateSnapshot[],scope:string,now:number):SuccessRateSnapshot[]{
 const edits=editsFor(scope,now,real);if(!edits.length)return real;
 const bySlot=new Map(real.map(p=>[bucket(p.until),p]));
 for(const e of edits){
  const original=bySlot.get(bucket(e.until));
  // A later production sample in the same bucket supersedes a manually filled empty slot.
  if(original&&original.until>e.until)continue;
  bySlot.set(bucket(e.until),{since:e.since,until:e.until,successRate:e.successRate,validSamples:0,hasRequests:true,source:e.source,editedAt:e.editedAt});
 }
 return [...bySlot.values()].filter(p=>p.until>now-AV_HISTORY_MS&&p.until<=now).sort((a,b)=>a.until-b.until).slice(-60);
}
export function syncAdjustmentScopes(prefix:string,active:Record<string,string>,now:number){
 const current=db.prepare('SELECT DISTINCT scope,epoch FROM availability_history_edits WHERE scope LIKE ?').all(prefix+'%') as {scope:string;epoch:string}[];
 for(const row of current)if(active[row.scope]!==row.epoch)db.prepare('DELETE FROM availability_history_edits WHERE scope=?').run(row.scope);
 const audits=db.prepare('SELECT DISTINCT scope FROM availability_history_edit_audit WHERE scope LIKE ?').all(prefix+'%') as {scope:string}[];
 for(const {scope} of audits)if(!(scope in active))db.prepare('DELETE FROM availability_history_edit_audit WHERE scope=?').run(scope);
 db.prepare('DELETE FROM availability_history_edits WHERE bucket<=?').run(now-AV_RETENTION_MS);
 db.prepare('DELETE FROM availability_history_edit_audit WHERE created_at<=?').run(now-AV_RETENTION_MS);
}
export function clearHistoryAdjustments(scope:string,history:SuccessRateSnapshot[],now:number){
 const records=db.prepare('SELECT data FROM availability_history_edits WHERE scope=?').all(scope) as {data:string}[];
 const event={at:now,action:'reset',until:now,actor:'admin',original:null,before:null,after:null,clearedSnapshots:history.length,clearedEdits:records.length};
 db.prepare('DELETE FROM availability_history_edits WHERE scope=?').run(scope);
 db.prepare('INSERT INTO availability_history_edit_audit(id,scope,created_at,data) VALUES(?,?,?,?)').run(randomUUID(),scope,now,JSON.stringify(event));
}
export function adjustmentView(target:HistoryScope,now:number){
 const real=new Map(target.history.map(p=>[bucket(p.until),p]));
 const edits=new Map(editsFor(target.scope,now,target.history).map(p=>[bucket(p.until),p]));
 const end=bucket(now);
 const slots=Array.from({length:60},(_,i)=>{
  const time=end-(59-i)*SLOT_MS,original=real.get(time),edit=edits.get(time);
  return {until:original?.until??time,since:original?.since??time-SLOT_MS,original:original??null,edit:edit??null};
 }).filter(p=>p.until>now-AV_HISTORY_MS&&p.until<=now);
 const audit=(db.prepare('SELECT data FROM availability_history_edit_audit WHERE scope=? ORDER BY created_at DESC,rowid DESC LIMIT 30').all(target.scope) as {data:string}[]).map(r=>JSON.parse(r.data));
 return {active:target.active,epoch:target.epoch,slots,audit};
}
export class HistoryEditError extends Error {constructor(message:string,readonly status=400){super(message);}}
export function editHistory(target:HistoryScope,input:unknown,now=Date.now()){
 if(!target.active)throw new HistoryEditError('当前统计对象未在路由中启用，不能调整');
 if(!Array.isArray(input)||!input.length||input.length>60)throw new HistoryEditError('每次请选择 1–60 个历史点');
 const planned: {key:number;before:Edit|null;after:Edit|null;original:SuccessRateSnapshot|null}[]=[];
 const seen=new Set<number>();
 for(const raw of input){
  if(!raw||typeof raw!=='object')throw new HistoryEditError('快照格式错误');
  const {until,successRate,source,reason,expectedId,restore}=raw;
  if(typeof until!=='number'||!Number.isFinite(until)||until>now||until<=now-AV_HISTORY_MS)throw new HistoryEditError('只能修改最近 10 小时内已过去的时间点');
  const key=bucket(until);if(seen.has(key))throw new HistoryEditError('同一个时间段不能重复提交');seen.add(key);
  const record=db.prepare('SELECT data FROM availability_history_edits WHERE scope=? AND bucket=?').get(target.scope,key) as {data:string}|undefined;
  const before:Edit|null=record?JSON.parse(record.data):null;
  if((expectedId??null)!==(before?.id??null))throw new HistoryEditError('快照已被其他操作修改，请重新读取后再保存',409);
  const original=target.history.find(p=>bucket(p.until)===key)??null;
  if(restore===true){planned.push({key,before,after:null,original});continue;}
  if(typeof successRate!=='number'||!Number.isFinite(successRate)||successRate<0||successRate>1)throw new HistoryEditError('成功率必须在 0%–100% 之间');
  if(!['self-test','correction'].includes(source))throw new HistoryEditError('请选择自测补录或人工修正');
  if(typeof reason!=='string'||reason.trim().length<3||reason.trim().length>300)throw new HistoryEditError('请填写 3–300 字的数据来源或修正依据');
  if(source==='correction'&&!original)throw new HistoryEditError('没有实测快照的时间段请使用自测补录');
  if(!original&&until!==key)throw new HistoryEditError('补录时间应选择完整的 10 分钟刻度');
  if(original&&until!==original.until)throw new HistoryEditError('实测快照已更新，请重新读取',409);
  planned.push({key,before,original,after:{id:randomUUID(),since:original?.since??key-SLOT_MS,until,successRate,source,reason:reason.trim(),validSamples:0,hasRequests:true,editedAt:now}});
 }
 db.exec('BEGIN IMMEDIATE');
 try{
  for(const p of planned){
   if(p.after)db.prepare('INSERT INTO availability_history_edits(scope,bucket,epoch,id,data) VALUES(?,?,?,?,?) ON CONFLICT(scope,bucket) DO UPDATE SET epoch=excluded.epoch,id=excluded.id,data=excluded.data').run(target.scope,p.key,target.epoch,p.after.id,JSON.stringify(p.after));
   else db.prepare('DELETE FROM availability_history_edits WHERE scope=? AND bucket=?').run(target.scope,p.key);
   const event={at:now,action:p.after?'edit':'restore',until:p.after?.until??p.before?.until??p.key,before:p.before,after:p.after,original:p.original,actor:'admin'};
   db.prepare('INSERT INTO availability_history_edit_audit(id,scope,created_at,data) VALUES(?,?,?,?)').run(randomUUID(),target.scope,now,JSON.stringify(event));
  }
  db.exec('COMMIT');
 }catch(e){db.exec('ROLLBACK');throw e;}
 return adjustmentView(target,now);
}
