import { db } from './sqlite.ts';
import { routeFailureKind } from '../routeObservations.ts';
import { getModelDef } from './models.ts';
export interface ChannelObservation {
  id:string; modelId:string; modelName:string; channelId:string; capability:string; familyId?:string;
 startedAt:number; finishedAt?:number; status:'running'|'success'|'failed'; failureKind?:'user'|'channel'|'unknown';
 /** Immutable model identity and submit-to-terminal duration, including queue time. */
 modelCreatedAt?:string; durationMs?:number; errorEvidence?:string; errorEvidenceComplete?:boolean;
 evidenceVersion?:number;
}
db.exec(`CREATE TABLE IF NOT EXISTS channel_observations(id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS channel_observations_started ON channel_observations(started_at);`);
// Persist terminal state separately so the dashboard never joins finished requests back to logs.
const columns=db.prepare('PRAGMA table_info(channel_observations)').all() as {name:string}[];
if(!columns.some(c=>c.name==='finished_at')){
 db.exec('ALTER TABLE channel_observations ADD COLUMN finished_at INTEGER');
 db.exec("UPDATE channel_observations SET finished_at=COALESCE(json_extract(data,'$.finishedAt'),started_at) WHERE json_extract(data,'$.status')!='running'");
}
db.exec(`CREATE INDEX IF NOT EXISTS channel_observations_pending ON channel_observations(started_at) WHERE finished_at IS NULL;
CREATE TABLE IF NOT EXISTS channel_observation_state(name TEXT PRIMARY KEY,value TEXT NOT NULL);`);
let revision=0;
export const channelObservationRevision=()=>revision;
export function readChannelObservationState<T>(name:string):T|undefined {
 const row=db.prepare('SELECT value FROM channel_observation_state WHERE name=?').get(name) as {value:string}|undefined;
 return row?JSON.parse(row.value) as T:undefined;
}
export function writeChannelObservationState(name:string,value:unknown) {
 db.prepare('INSERT INTO channel_observation_state(name,value) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value').run(name,JSON.stringify(value));
}
export function importChannelObservation(value:ChannelObservation) {
 const result=db.prepare('INSERT OR IGNORE INTO channel_observations(id,started_at,finished_at,data) VALUES(?,?,?,?)').run(value.id,value.startedAt,value.status==='running'?null:value.finishedAt??value.startedAt,JSON.stringify(value));
 if(result.changes)revision++;
 return !!result.changes;
}
let lastPrune=0;
export function beginChannelObservation(value:Omit<ChannelObservation,'startedAt'|'status'>,now=Date.now()) {
 if(now-lastPrune>3600000){pruneChannelObservations(now);lastPrune=now;}
 const row=db.prepare('SELECT started_at FROM logs WHERE id=?').get(value.id) as {started_at:string}|undefined;
 const submitted=Date.parse(row?.started_at??'');
 importChannelObservation({...value,modelCreatedAt:value.modelCreatedAt??getModelDef(value.modelId)?.createdAt,startedAt:Number.isFinite(submitted)?submitted:now,status:'running',evidenceVersion:1});
}
export function finishChannelObservation(id:string,success:boolean,error?:string,now=Date.now(),timing?:{startedAt:string;durationMs?:number},errorComplete=true) {
 const row=db.prepare('SELECT data FROM channel_observations WHERE id=?').get(id) as {data:string}|undefined;if(!row)return;
 const o=JSON.parse(row.data) as ChannelObservation;if(o.finishedAt!==undefined)return;
 o.status=success?'success':'failed';o.finishedAt=now;if(!success)o.failureKind=routeFailureKind(error,id);
 const submitted=Date.parse(timing?.startedAt??'');
 if(Number.isFinite(submitted))o.startedAt=submitted;
 if(timing&&typeof timing.durationMs==='number'&&Number.isFinite(timing.durationMs)&&timing.durationMs>=0)o.durationMs=timing.durationMs;
 else if(Number.isFinite(submitted)&&now>=submitted)o.durationMs=now-submitted;
 if(error){o.errorEvidence=error.slice(0,16384);o.errorEvidenceComplete=errorComplete&&error.length<=16384;}
 o.evidenceVersion=1;
 db.prepare('UPDATE channel_observations SET data=?,started_at=?,finished_at=? WHERE id=?').run(JSON.stringify(o),o.startedAt,now,id);revision++;
}
export function channelObservationRows(since:number,now=Date.now()):ChannelObservation[] {
 // Legacy running observations can predate the finish hook. Repair them once, never reread terminal metadata.
 const pending=db.prepare(`SELECT o.id,l.meta FROM channel_observations o JOIN logs l ON l.id=o.id WHERE o.finished_at IS NULL AND o.started_at<=?`).all(now) as {id:string;meta:string}[];
 for(const row of pending){const l=JSON.parse(row.meta);if(l.status==='success'||l.status==='failed'){finishChannelObservation(row.id,l.status==='success',l.error,Date.parse(l.finishedAt)||now,l,false);upgradeObservationEvidence(row.id,l);}}
 const rows=db.prepare(`SELECT data FROM channel_observations WHERE started_at>=? AND started_at<=?
 UNION ALL SELECT data FROM channel_observations WHERE started_at<? AND started_at<=? AND finished_at IS NULL`).all(since,now,since,now) as {data:string}[];
 return rows.map(r=>JSON.parse(r.data) as ChannelObservation);
}
/** Legacy evidence is conservative: scrubbed/shortened errors cannot support "not contains". */
export function upgradeObservationEvidence(id:string,l:any,route?:{error?:string;failureEvidence?:string}){
 const row=db.prepare('SELECT data FROM channel_observations WHERE id=?').get(id) as {data:string}|undefined;if(!row)return;
 const o=JSON.parse(row.data) as ChannelObservation;
 const submitted=Date.parse(l.startedAt),finished=Date.parse(l.finishedAt);
 if(Number.isFinite(submitted))o.startedAt=submitted;
 if(o.durationMs===undefined){const ms=l.durationMs??(Number.isFinite(finished)&&Number.isFinite(submitted)?finished-submitted:undefined);if(typeof ms==='number'&&Number.isFinite(ms)&&ms>=0)o.durationMs=ms;}
 if(!o.modelCreatedAt){const m=getModelDef(o.modelId);if(m&&o.startedAt>=Date.parse(m.createdAt))o.modelCreatedAt=m.createdAt;}
 if(!o.errorEvidence){const error=[l.error,route?.error,route?.failureEvidence].filter(v=>typeof v==='string'&&v.trim()).join('\n');if(error){o.errorEvidence=error.slice(0,16384);o.errorEvidenceComplete=false;}}
 o.evidenceVersion=1;
 db.prepare('UPDATE channel_observations SET data=?,started_at=? WHERE id=?').run(JSON.stringify(o),o.startedAt,id);revision++;
}
/** At most one small light-index batch per tick. No request body is read here. */
export function backfillChannelEvidence(batchSize=100){
 type State={cursor:number;upper:number;done:boolean};
 let state=readChannelObservationState<State>('statistics-evidence-v1');
 if(!state){const upper=Number((db.prepare('SELECT COALESCE(MAX(rowid),0) AS n FROM channel_observations').get() as {n:number}).n);state={cursor:0,upper,done:!upper};}
 if(state.done)return state;
 const rows=db.prepare(`SELECT o.rowid AS cursor,o.id,l.meta,r.data AS route FROM channel_observations o LEFT JOIN logs l ON l.id=o.id LEFT JOIN route_observations r ON r.id=o.id WHERE o.rowid>? AND o.rowid<=? ORDER BY o.rowid LIMIT ?`).all(state.cursor,state.upper,batchSize) as {cursor:number;id:string;meta?:string;route?:string}[];
 for(const row of rows){state.cursor=Number(row.cursor);if(row.meta)upgradeObservationEvidence(row.id,JSON.parse(row.meta),row.route?JSON.parse(row.route):undefined);}
 state.done=rows.length<batchSize||state.cursor>=state.upper;writeChannelObservationState('statistics-evidence-v1',state);return state;
}
export function pruneChannelObservations(now=Date.now()) {
 const result=db.prepare('DELETE FROM channel_observations WHERE started_at<? AND finished_at IS NOT NULL').run(now-60*86400000);
 if(result.changes)revision++;
}
