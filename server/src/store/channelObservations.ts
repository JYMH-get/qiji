import { db } from './sqlite.ts';
import { routeFailureKind } from '../routeObservations.ts';
export interface ChannelObservation {
  id:string; modelId:string; modelName:string; channelId:string; capability:string; familyId?:string;
  startedAt:number; finishedAt?:number; status:'running'|'success'|'failed'; failureKind?:'user'|'channel'|'unknown';
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
 importChannelObservation({...value,startedAt:now,status:'running'});
}
export function finishChannelObservation(id:string,success:boolean,error?:string,now=Date.now()) {
 const row=db.prepare('SELECT data FROM channel_observations WHERE id=?').get(id) as {data:string}|undefined;if(!row)return;
 const o=JSON.parse(row.data) as ChannelObservation;if(o.finishedAt!==undefined)return;
 o.status=success?'success':'failed';o.finishedAt=now;if(!success)o.failureKind=routeFailureKind(error,id);
 db.prepare('UPDATE channel_observations SET data=?,finished_at=? WHERE id=?').run(JSON.stringify(o),now,id);revision++;
}
export function channelObservationRows(since:number,now=Date.now()):ChannelObservation[] {
 // Legacy running observations can predate the finish hook. Repair them once, never reread terminal metadata.
 const pending=db.prepare(`SELECT o.id,l.meta FROM channel_observations o JOIN logs l ON l.id=o.id WHERE o.finished_at IS NULL AND o.started_at<=?`).all(now) as {id:string;meta:string}[];
 for(const row of pending){const l=JSON.parse(row.meta);if(l.status==='success'||l.status==='failed')finishChannelObservation(row.id,l.status==='success',l.error,Date.parse(l.finishedAt)||now);}
 const rows=db.prepare(`SELECT data FROM channel_observations WHERE started_at>=? AND started_at<=?
 UNION ALL SELECT data FROM channel_observations WHERE started_at<? AND started_at<=? AND finished_at IS NULL`).all(since,now,since,now) as {data:string}[];
 return rows.map(r=>JSON.parse(r.data) as ChannelObservation);
}
export function pruneChannelObservations(now=Date.now()) {
 const result=db.prepare('DELETE FROM channel_observations WHERE started_at<? AND finished_at IS NOT NULL').run(now-60*86400000);
 if(result.changes)revision++;
}
