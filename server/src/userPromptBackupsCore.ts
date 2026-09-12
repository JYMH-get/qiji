import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { GenerateRequest } from './contract.ts';

export type BackupKind = 'image' | 'video' | 'skill';
interface Snapshot { kind: BackupKind; source: string; sourceId: string; name: string; body: string }
export interface BackupContext { userId: string; userName?: string; agentId?: string; requestId: string; projectId?: string; model?: string; purpose?: string }
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const small = (value: unknown, fallback = '') => typeof value === 'string' ? value.slice(0, 1024) : fallback;

export function usedPromptSnapshots(req: GenerateRequest): Snapshot[] {
  const out: Snapshot[] = [];
  const texts = req.promptOverride ? [req.promptOverride] : Object.values(req.variables ?? {}).filter((v): v is string => typeof v === 'string');
  if (Array.isArray(req.usedPresets)) for (const p of req.usedPresets.slice(0, 100)) {
    if (!p || !['image','video'].includes(p.kind) || !['builtin','custom'].includes(p.source) || typeof p.body !== 'string' || !p.body.trim() || p.body.length > 1000000) continue;
    // 来源是客户端声明；正文必须确实出现在本次请求内，不能借生成接口上传未使用的库。
    if (!texts.some(text => text.includes(p.body))) continue;
    out.push({ kind:p.kind,source:p.source,sourceId:small(p.sourceId),name:small(p.name,'未命名预设'),body:p.body });
  }
  const inf = req.inference;
  if (inf?.source === 'skill' && typeof inf.skillText === 'string' && inf.skillText.trim() && inf.skillText.length <= 1000000) {
    out.push({kind:'skill',source:'external',sourceId:'external-skill',name:small(inf.skillName,'外部 Skills'),body:inf.skillText});
  }
  return out;
}

/** 索引与原文存 SQLite；内容按用户/类型/来源/原文区分版本，请求记录负责幂等。 */
export function createUserPromptBackupStore(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS user_prompt_backups (
    id TEXT PRIMARY KEY,user_id TEXT NOT NULL,user_name TEXT NOT NULL,agent_id TEXT NOT NULL,
    kind TEXT NOT NULL,source TEXT NOT NULL,source_id TEXT NOT NULL,name TEXT NOT NULL,body TEXT NOT NULL,
    content_hash TEXT NOT NULL,first_used_at TEXT NOT NULL,last_used_at TEXT NOT NULL,use_count INTEGER NOT NULL DEFAULT 0,
    last_project_id TEXT NOT NULL,last_model TEXT NOT NULL,last_purpose TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS user_prompt_backups_recent ON user_prompt_backups(last_used_at DESC,id);
  CREATE INDEX IF NOT EXISTS user_prompt_backups_user ON user_prompt_backups(user_id,kind);
  CREATE TABLE IF NOT EXISTS user_prompt_backup_uses (
    backup_id TEXT NOT NULL,request_id TEXT NOT NULL,project_id TEXT NOT NULL,model TEXT NOT NULL,purpose TEXT NOT NULL,used_at TEXT NOT NULL,
    PRIMARY KEY(backup_id,request_id)
  );`);
  const put=db.prepare(`INSERT INTO user_prompt_backups VALUES(?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?) ON CONFLICT(id) DO NOTHING`);
  const use=db.prepare(`INSERT INTO user_prompt_backup_uses VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING`);
  const update=db.prepare(`UPDATE user_prompt_backups SET use_count=use_count+1,last_used_at=?,user_name=?,last_project_id=?,last_model=?,last_purpose=? WHERE id=?`);
  return {
    capture(req: GenerateRequest, context: BackupContext) {
      if (!context.userId || !context.requestId) return 0;
      const items=usedPromptSnapshots(req); if (!items.length) return 0;
      const now=new Date().toISOString(); let added=0;
      db.exec('SAVEPOINT prompt_backups');
      try {
        for (const s of items) {
          const bodyHash=hash(s.body), id=hash([context.userId,context.agentId??'',s.kind,s.source,s.sourceId,bodyHash]);
          const project=small(context.projectId),model=small(context.model),purpose=small(context.purpose);
          put.run(id,context.userId,small(context.userName),context.agentId??'',s.kind,s.source,s.sourceId,s.name,s.body,bodyHash,now,now,project,model,purpose);
          if (use.run(id,context.requestId,project,model,purpose,now).changes) {
            update.run(now,small(context.userName),project,model,purpose,id);added++;
          }
        }
        db.exec('RELEASE prompt_backups');return added;
      } catch(e) { db.exec('ROLLBACK TO prompt_backups; RELEASE prompt_backups');throw e; }
    },
    list(q: {kind?:string;userId?:string;search?:string;page?:string;pageSize?:string}={}) {
      const clauses:string[]=[], args:string[]=[];
      if(q.kind){clauses.push('kind=?');args.push(q.kind);}
      if(q.userId){clauses.push('user_id=?');args.push(q.userId);}
      if(q.search?.trim()){clauses.push('(instr(name,?)>0 OR instr(user_name,?)>0 OR instr(user_id,?)>0 OR instr(last_project_id,?)>0)');args.push(...Array(4).fill(q.search.trim()));}
      const where=clauses.length?' WHERE '+clauses.join(' AND '):'';
      const total=Number((db.prepare('SELECT count(*) AS n FROM user_prompt_backups'+where).get(...args) as {n:number}).n);
      const pageSize=Math.min(100,Math.max(1,Number.parseInt(q.pageSize??'30')||30));
      const pages=Math.max(1,Math.ceil(total/pageSize));const page=Math.min(pages,Math.max(1,Number.parseInt(q.page??'1')||1));
      const items=db.prepare(`SELECT id,user_id,user_name,agent_id,kind,source,source_id,name,content_hash,first_used_at,last_used_at,use_count,last_project_id,last_model,last_purpose,length(body) AS body_length FROM user_prompt_backups${where} ORDER BY last_used_at DESC,id LIMIT ? OFFSET ?`).all(...args,pageSize,(page-1)*pageSize);
      return {items,total,page,pageSize,pages};
    },
    detail(id:string) {
      const item=db.prepare('SELECT * FROM user_prompt_backups WHERE id=?').get(id);
      if(!item)return undefined;
      const uses=db.prepare('SELECT * FROM user_prompt_backup_uses WHERE backup_id=? ORDER BY used_at DESC LIMIT 30').all(id);
      return {...item,uses};
    },
  };
}
