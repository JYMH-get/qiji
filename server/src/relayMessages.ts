import { config } from './config.ts';
import { sourceFetch } from './relay.ts';
import { cacheRelayAnnouncements, relayAnnouncementCursor, relayAnnouncementScope, type NodeAnnouncementPage } from './store/messages.ts';

type SyncState = { url: string; key: string; scope?: string; nextAttempt: number; pending?: Promise<void> };
let state: SyncState | undefined;

function sourceUrl(): string {
  try {
    const url=new URL(config.source.url);
    if(!['http:','https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return '';
    return url.origin+url.pathname.replace(/\/+$/,'');
  } catch { return ''; }
}
function isCurrent(value: SyncState): boolean {
  return state===value && config.role==='relay' && sourceUrl()===value.url && config.source.nodeKey===value.key;
}

async function sync(value: SyncState): Promise<void> {
  // 每轮先确认密钥的当前商身份。游标属于身份域，不能带旧商游标去跳过新商公告。
  let cursor=0, scope: string|undefined;
  const deadline=Date.now()+5000;
  try {
    do {
      if(!isCurrent(value)) return;
      const response=await sourceFetch('/v1/node/announcements?cursor='+cursor,{signal:AbortSignal.timeout(Math.max(1,Math.min(1500,deadline-Date.now())))});
      if(!isCurrent(value)) return;
      if(!response.ok){
        if(response.status===401 || response.status===403) value.scope=undefined;
        return;
      }
      const page=await response.json() as NodeAnnouncementPage;
      if(!isCurrent(value)) return;
      if(!page || typeof page.agentId!=='string' || !page.agentId || page.agentId.length>200 || !Array.isArray(page.items)
        || page.items.length>200 || !Number.isSafeInteger(page.cursor) || page.cursor<cursor || typeof page.hasMore!=='boolean'
        || (page.hasMore && page.cursor===cursor)) throw new Error('源站公告分页无效');
      const nextScope=relayAnnouncementScope(value.url,page.agentId);
      if(scope && scope!==nextScope){ value.scope=undefined; return; }
      scope=nextScope;
      if(value.scope!==scope) value.scope=undefined;
      // 只在整页校验与落盘成功后开放此身份域；已读只写本地账号。
      cacheRelayAnnouncements(scope,page);
      value.scope=scope;
      cursor=Math.max(page.cursor,relayAnnouncementCursor(scope));
      if(!page.hasMore) return;
    } while(Date.now()<deadline);
    // 大量历史公告分批同步，下一次请求继续，不阻塞本地消息读取。
    value.nextAttempt=0;
  } catch {
    // 当前身份暂时离线时继续使用缓存；配置改变后的新身份没有缓存可见权限。
  }
}

/** 返回经当前节点凭证验证过的缓存域。域只在进程内激活，配置切换不能沿用旧授权。 */
export async function ensureRelayAnnouncements(): Promise<string|undefined> {
  if(config.role!=='relay'){ state=undefined; return undefined; }
  const url=sourceUrl(),key=config.source.nodeKey;
  if(!url || !key){ state=undefined; return undefined; }
  if(!state || state.url!==url || state.key!==key) state={url,key,nextAttempt:0};
  const current=state;
  if(!current.pending && Date.now()>=current.nextAttempt){
    current.nextAttempt=Date.now()+60_000;
    current.pending=sync(current).finally(()=>{current.pending=undefined;});
  }
  await current.pending;
  return isCurrent(current)?current.scope:undefined;
}
