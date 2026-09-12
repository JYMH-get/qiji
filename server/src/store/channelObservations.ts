import { db } from './sqlite.ts';
import { routeFailureKind } from '../routeObservations.ts';
export interface ChannelObservation {
  id:string; modelId:string; modelName:string; channelId:string; capability:string; familyId?:string;
  startedAt:number; finishedAt?:number; status:'running'|'success'|'failed'; failureKind?:'user'|'channel'|'unknown';
}
db.exec(`CREATE TABLE IF NOT EXISTS channel_observations(id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS channel_observations_started ON channel_observations(started_at);`);
let lastPrune=0;
export function beginChannelObservation(value:Omit<ChannelObservation,'startedAt'|'status'>,now=Date.now()) {
 if(now-lastPrune>3600000){pruneChannelObservations(now);lastPrune=now;}
 db.prepare('INSERT OR IGNORE INTO channel_observations(id,started_at,data) VALUES(?,?,?)').run(value.id,now,JSON.stringify({...value,startedAt:now,status:'running'}));
}
export function finishChannelObservation(id:string,success:boolean,error?:string,now=Date.now()) {
 const row=db.prepare('SELECT data FROM channel_observations WHERE id=?').get(id) as {data:string}|undefined;if(!row)return;
 const o=JSON.parse(row.data) as ChannelObservation;if(o.finishedAt!==undefined)return;
 o.status=success?'success':'failed';o.finishedAt=now;if(!success)o.failureKind=routeFailureKind(error,id);
 db.prepare('UPDATE channel_observations SET data=? WHERE id=?').run(JSON.stringify(o),id);
}
export function channelObservationRows(since:number,now=Date.now()):ChannelObservation[] {
 const rows=db.prepare(`SELECT o.data,l.meta FROM channel_observations o LEFT JOIN logs l ON l.id=o.id
 WHERE o.started_at<=? AND (o.started_at>=? OR json_extract(o.data,'$.status')='running')`).all(now,since) as {data:string;meta?:string}[];
 return rows.map(r=>{const o=JSON.parse(r.data) as ChannelObservation;
  if(o.status==='running'&&r.meta){const l=JSON.parse(r.meta);if(l.status==='success'||l.status==='failed'){o.status=l.status;o.finishedAt=Date.parse(l.finishedAt)||now;o.failureKind=l.status==='failed'?routeFailureKind(l.error,o.id):undefined;}}
  return o;
 });
}
export function pruneChannelObservations(now=Date.now()) {
 db.prepare("DELETE FROM channel_observations WHERE started_at<? AND json_extract(data,'$.status')!='running'").run(now-30*86400000);
}
