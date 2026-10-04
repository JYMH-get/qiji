import { db } from './sqlite.ts';
import { genId } from './db.ts';
import { createHash } from 'node:crypto';

export interface MessageInput {
  issuer: 'source' | 'agent' | 'system';
  issuerId?: string;
  audience: 'all' | 'source' | 'agent' | 'user';
  audienceId?: string;
  kind: 'notice' | 'announcement' | 'team-credit' | 'balance-warning' | 'system';
  title: string;
  body: string;
  dedupeKey?: string;
}
export interface UserMessage extends Omit<MessageInput, 'dedupeKey'> { id: string; createdAt: string; read: boolean }
db.exec(`CREATE TABLE IF NOT EXISTS user_messages (
  id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, issuer TEXT NOT NULL, issuer_id TEXT,
  audience TEXT NOT NULL, audience_id TEXT, kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
  dedupe_key TEXT UNIQUE
);
CREATE TABLE IF NOT EXISTS user_message_reads (message_id TEXT NOT NULL, user_id TEXT NOT NULL, read_at INTEGER NOT NULL, PRIMARY KEY(message_id,user_id));
CREATE TABLE IF NOT EXISTS relay_announcements (
  id TEXT PRIMARY KEY, scope TEXT NOT NULL, created_at INTEGER NOT NULL, issuer TEXT NOT NULL, issuer_id TEXT,
  audience TEXT NOT NULL, audience_id TEXT, kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_relay_announcements_scope ON relay_announcements(scope,created_at);
CREATE TABLE IF NOT EXISTS relay_announcement_cursors (scope TEXT PRIMARY KEY, cursor INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_messages_audience ON user_messages(audience,audience_id,created_at);
CREATE INDEX IF NOT EXISTS idx_message_reads_user ON user_message_reads(user_id);`);
type Row = { id: string; created_at: number; issuer: MessageInput['issuer']; issuer_id?: string; audience: MessageInput['audience']; audience_id?: string; kind: MessageInput['kind']; title: string; body: string; read_at?: number };
const project = (r: Row): UserMessage => ({ id:r.id,createdAt:new Date(r.created_at).toISOString(),issuer:r.issuer,issuerId:r.issuer_id||undefined,audience:r.audience,audienceId:r.audience_id||undefined,kind:r.kind,title:r.title,body:r.body,read:!!r.read_at });

export function publishMessage(input: MessageInput): UserMessage {
  const title = String(input.title ?? '').trim(), body = String(input.body ?? '').trim();
  if (!title || title.length > 80 || !body || body.length > 5000) throw new Error('标题需1–80字，正文需1–5000字');
  if (!['source','agent','system'].includes(input.issuer) || !['all','source','agent','user'].includes(input.audience)
    || !['notice','announcement','team-credit','balance-warning','system'].includes(input.kind)) throw new Error('消息类型无效');
  if ((input.audience === 'agent' || input.audience === 'user') && !input.audienceId) throw new Error('缺少消息接收对象');
  if (input.issuer === 'agent' && (input.audience !== 'agent' || input.audienceId !== input.issuerId)) throw new Error('渠道商只能通知名下用户');
  if (input.dedupeKey) {
    const existing = db.prepare('SELECT * FROM user_messages WHERE dedupe_key=?').get(input.dedupeKey) as Row | undefined;
    if (existing) return project(existing);
  }
  const id = genId('msg'), at = Date.now();
  db.prepare('INSERT INTO user_messages(id,created_at,issuer,issuer_id,audience,audience_id,kind,title,body,dedupe_key) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(id,at,input.issuer,input.issuerId??null,input.audience,input.audienceId??null,input.kind,title,body,input.dedupeKey??null);
  return { ...input,id,title,body,createdAt:new Date(at).toISOString(),read:false };
}

export function listPublishedMessages(issuer: MessageInput['issuer'], issuerId?: string): UserMessage[] {
  return (db.prepare('SELECT * FROM user_messages WHERE issuer=? AND COALESCE(issuer_id,\'\')=? ORDER BY created_at DESC LIMIT 200').all(issuer,issuerId??'') as Row[]).map(project);
}

const visibility = `(m.audience='all' OR (m.audience='source' AND ?='') OR (m.audience='agent' AND m.audience_id=?) OR (m.audience='user' AND m.audience_id=?))`;
const messageColumns = 'id,created_at,issuer,issuer_id,audience,audience_id,kind,title,body';
const visibleMessages = `WITH visible_messages AS (
  SELECT ${messageColumns} FROM user_messages m WHERE ${visibility}
  UNION ALL SELECT ${messageColumns} FROM relay_announcements WHERE scope=?
)`;
const integer = (value: unknown, fallback: number, min: number, max: number) => {
  const n = Number(value); return Number.isFinite(n) ? Math.min(max,Math.max(min,Math.floor(n))) : fallback;
};
export function listMessagesForUser(user: {id:string;agentId?:string}, opts: {offset?:number;limit?:number;remoteScope?:string} = {}): {items:UserMessage[];unread:number;total:number} {
  const args = [user.agentId??'',user.agentId??'',user.id,opts.remoteScope??''];
  const limit = integer(opts.limit,30,1,100),offset=integer(opts.offset,0,0,Number.MAX_SAFE_INTEGER);
  const items = (db.prepare(`${visibleMessages} SELECT m.*,r.read_at FROM visible_messages m LEFT JOIN user_message_reads r ON r.message_id=m.id AND r.user_id=? ORDER BY m.created_at DESC,m.id DESC LIMIT ? OFFSET ?`).all(...args,user.id,limit,offset) as Row[]).map(project);
  const count = db.prepare(`${visibleMessages} SELECT COUNT(*) AS total,SUM(CASE WHEN r.read_at IS NULL THEN 1 ELSE 0 END) AS unread FROM visible_messages m LEFT JOIN user_message_reads r ON r.message_id=m.id AND r.user_id=?`).get(...args,user.id) as {total:number;unread:number|null};
  return {items,unread:count.unread??0,total:count.total};
}

export function readMessagesForUser(user: {id:string;agentId?:string}, id?: string, remoteScope?: string): number {
  return Number(db.prepare(`${visibleMessages} INSERT OR IGNORE INTO user_message_reads(message_id,user_id,read_at) SELECT m.id,?,? FROM visible_messages m${id?' WHERE m.id=?':''}`).run(user.agentId??'',user.agentId??'',user.id,remoteScope??'',user.id,Date.now(),...(id?[id]:[])).changes);
}

export interface NodeAnnouncementPage { agentId: string; items: UserMessage[]; cursor: number; hasMore: boolean }
/** 节点只能同步全站和该商公告；没有源站真实用户身份，也不参与源站已读状态。 */
export function listNodeAnnouncements(agentId: string, opts: {cursor?:number;limit?:number} = {}): NodeAnnouncementPage {
  const cursor=integer(opts.cursor,0,0,Number.MAX_SAFE_INTEGER),limit=integer(opts.limit,200,1,200);
  const rows=db.prepare(`SELECT rowid AS sequence,* FROM user_messages WHERE rowid>? AND kind IN ('notice','announcement')
    AND ((issuer='source' AND audience='all') OR (audience='agent' AND audience_id=? AND (issuer='source' OR (issuer='agent' AND issuer_id=?))))
    ORDER BY rowid ASC LIMIT ?`).all(cursor,agentId,agentId,limit+1) as (Row & {sequence:number})[];
  const selected=rows.slice(0,limit);
  return {agentId,items:selected.map(project),cursor:selected.at(-1)?.sequence??cursor,hasMore:rows.length>limit};
}

/** 身份只依赖源站地址和商 ID；更换密钥不会更换已读记录。 */
export function relayAnnouncementScope(sourceUrl: string, agentId: string): string {
  return createHash('sha256').update(sourceUrl+'\0'+agentId).digest('hex');
}
export function relayAnnouncementCursor(scope: string): number {
  return (db.prepare('SELECT cursor FROM relay_announcement_cursors WHERE scope=?').get(scope) as {cursor:number}|undefined)?.cursor??0;
}
export function cacheRelayAnnouncements(scope: string, page: NodeAnnouncementPage): void {
  const insert=db.prepare(`INSERT INTO relay_announcements(id,scope,created_at,issuer,issuer_id,audience,audience_id,kind,title,body)
    VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET created_at=excluded.created_at,issuer=excluded.issuer,issuer_id=excluded.issuer_id,
    audience=excluded.audience,audience_id=excluded.audience_id,kind=excluded.kind,title=excluded.title,body=excluded.body`);
  db.exec('SAVEPOINT relay_announcement_import');
  try {
    for(const item of page.items){
      if(!item || typeof item.id!=='string' || !item.id || item.id.length>200 || !Number.isFinite(Date.parse(item.createdAt))
        || !['notice','announcement'].includes(item.kind) || typeof item.title!=='string' || !item.title || item.title.length>80
        || typeof item.body!=='string' || !item.body || item.body.length>5000
        || !((item.issuer==='source' && item.audience==='all') || (item.audience==='agent' && item.audienceId===page.agentId
          && (item.issuer==='source' || (item.issuer==='agent' && item.issuerId===page.agentId))))) throw new Error('源站公告格式无效');
      insert.run(`remote:${scope}:${item.id}`,scope,Date.parse(item.createdAt),item.issuer,item.issuerId??null,item.audience,item.audienceId??null,item.kind,item.title,item.body);
    }
    db.prepare('INSERT INTO relay_announcement_cursors(scope,cursor) VALUES(?,?) ON CONFLICT(scope) DO UPDATE SET cursor=MAX(cursor,excluded.cursor)').run(scope,page.cursor);
    db.exec('RELEASE relay_announcement_import');
  } catch(error) {
    db.exec('ROLLBACK TO relay_announcement_import'); db.exec('RELEASE relay_announcement_import'); throw error;
  }
}

export function notifyTeamCreditShortage(teamId:string,leaderId:string,userId:string,userName:string,source:string,needed:number,remaining:number): void {
  publishMessage({issuer:'system',audience:'user',audienceId:leaderId,kind:'team-credit',title:'团队积分不足',
    body:`${userName || '团队成员'}的请求因团队积分不足未提交。需 ${needed} 积分，剩余 ${remaining} 积分。`,
    dedupeKey:`team-shortage:${teamId}:${userId}:${source}:${Math.floor(Date.now()/3600000)}`});
}
