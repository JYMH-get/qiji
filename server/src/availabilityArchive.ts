import { db } from './store/sqlite.ts';
import type { SuccessRateSnapshot } from './contract.ts';

export const AV_RETENTION_MS=60*86400000;
db.exec(`CREATE TABLE IF NOT EXISTS availability_snapshot_archive(scope TEXT NOT NULL,until INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(scope,until));
CREATE INDEX IF NOT EXISTS availability_snapshot_archive_until ON availability_snapshot_archive(until);`);
const latest=new Map<string,number>();
/** Append completed points only. The minute sampler keeps a small 10H working set. */
export function archiveAvailability(scope:string,points:SuccessRateSnapshot[],now=Date.now()){
 if(!points.length)return;
 let last=latest.get(scope);
 if(last===undefined)last=Number((db.prepare('SELECT COALESCE(MAX(until),0) AS until FROM availability_snapshot_archive WHERE scope=?').get(scope) as {until:number}).until);
 for(const p of points)if(p.until>last&&p.until>now-AV_RETENTION_MS&&p.until<=now){db.prepare('INSERT OR IGNORE INTO availability_snapshot_archive(scope,until,data) VALUES(?,?,?)').run(scope,p.until,JSON.stringify(p));last=p.until;}
 latest.set(scope,last);
}
export function clearAvailabilityArchive(scope:string){db.prepare('DELETE FROM availability_snapshot_archive WHERE scope=?').run(scope);latest.delete(scope);}
export function retainAvailabilityArchives(prefix:string,scopes:Set<string>,now:number){
 for(const scope of latest.keys())if(scope.startsWith(prefix)&&!scopes.has(scope))latest.delete(scope);
 const rows=db.prepare('SELECT DISTINCT scope FROM availability_snapshot_archive WHERE scope LIKE ?').all(prefix+'%') as {scope:string}[];
 for(const row of rows)if(!scopes.has(row.scope))clearAvailabilityArchive(row.scope);
 db.prepare('DELETE FROM availability_snapshot_archive WHERE until<=?').run(now-AV_RETENTION_MS);
}
