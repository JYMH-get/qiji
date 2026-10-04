import { managedClient } from './managedClient';
import { useConnectionStore } from '@/store/connectionStore';
import type { ModelAdapter } from './adapters/types';

const KEY = 'Qiji:local-generation-report-outbox:v1';
const MARK = '|qiji-report|';
type Pending = {id:string; scope:string; body:Record<string,unknown>; start?:Record<string,unknown>; reportId?:string};
const completed = new Set<string>();
const sending = new Set<string>();
function scope() {
  const s = useConnectionStore.getState();
  return s.user ? JSON.stringify([s.serverUrl.replace(/\/+$/, ''),s.user.id]) : '';
}
function read(): Pending[] {
  try {
    const rows=JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(rows)?rows.filter(p=>p&&typeof p.id==='string'&&typeof p.scope==='string'&&p.body&&typeof p.body==='object'):[];
  } catch { return []; }
}
function write(rows: Pending[]) { localStorage.setItem(KEY,JSON.stringify(rows)); }
async function flush() {
  for (const item of read()) {
    const key=JSON.stringify([item.scope,item.id]);
    if (item.scope !== scope() || sending.has(key)) continue;
    sending.add(key);
    try {
      let reportId=item.reportId??item.id;
      if(item.start) {
        reportId=(await managedClient.startLocalGenerationReport(item.start)).id;
        item.reportId=reportId;delete item.start;
        write(read().map(p=>p.id===item.id&&p.scope===item.scope?item:p));
      }
      if(item.scope!==scope()) continue;
      const {status,taskId,error}=item.body;
      await managedClient.finishLocalGenerationReport(reportId,{status,...(taskId?{taskId}:{}),...(error?{error}:{})});
      write(read().filter(p => p.id !== item.id || p.scope !== item.scope));
      completed.add(key);
    } catch (e) { console.warn('[local-report] 结果待联网补报',item.id,(e as Error).message); }
    finally { sending.delete(key); }
  }
}
function enqueue(item: Pending) {
  if (completed.has(JSON.stringify([item.scope,item.id]))) return;
  const rows=read();
  if (!rows.some(p=>p.id===item.id && p.scope===item.scope)) { rows.push(item); write(rows); }
  void flush();
}

export function withLocalGenerationReport(adapter: ModelAdapter, duration:(params:Record<string,unknown>)=>number): ModelAdapter {
  return {...adapter,
    async submit(input,params,nodeType) {
      const owner=scope();
      if (!owner) throw new Error('请先登录 Qiji 后提交本地生成');
      // Fail before dispatch if the server cannot acknowledge the report.
      const clientTaskId='local-report:'+crypto.randomUUID();
      const variables=input.variables as Record<string,unknown>|undefined;
      const rawInputs=(input.inputs??input) as Record<string,unknown>;
      const start={clientTaskId,model:adapter.key,
        variables:{prompt:String(variables?.prompt??input.prompt??'')},inputs:{images:rawInputs.images,videos:rawInputs.videos,audios:rawInputs.audios},
        projectId:input.projectId,params:{...params,duration:duration(params)}};
      let report:{id:string};
      try { report=await managedClient.startLocalGenerationReport(start); }
      catch(e) {
        const status=(e as {status?:number}).status;
        if(status===undefined||status===0||status>=500) enqueue({id:clientTaskId,scope:owner,start,
          body:{status:'failed',error:'报备响应未确认，本次未向第三方提交'}});
        throw e;
      }
      try {
        if (scope()!==owner) throw new Error('登录账号已变化，请重新提交');
        const result=await adapter.submit(input,params,nodeType);
        return {...result,taskId:result.taskId+MARK+encodeURIComponent(JSON.stringify([report.id,owner]))};
      } catch(e) {
        enqueue({id:report.id,scope:owner,body:{status:'failed',error:((e as Error).message||'本地提交失败').slice(0,8000)}});
        throw e;
      }
    },
    async poll(taskId) {
      const offset=taskId.lastIndexOf(MARK);
      if(offset<0) return adapter.poll(taskId); // Jobs submitted by an older client.
      const raw=taskId.slice(0,offset);
      const [id,owner]=JSON.parse(decodeURIComponent(taskId.slice(offset+MARK.length))) as [string,string];
      if(scope()!==owner) return {status:'lost',progress:100,error:'请使用提交任务的 Qiji 账号和服务器重连'};
      const result=await adapter.poll(raw);
      if ((result.status==='success'||result.status==='failed')&&!completed.has(JSON.stringify([owner,id]))&&!read().some(p=>p.id===id&&p.scope===owner)) {
        const body:Record<string,unknown>={status:result.status,taskId:raw};
        if(result.status==='failed') body.error=(result.error||'本地生成失败').slice(0,8000);
        enqueue({id,scope:owner,body});
      }
      return result;
    },
  };
}

if (typeof window !== 'undefined') {
  window.setInterval(()=>void flush(),30_000);
  window.addEventListener('online',()=>void flush());
}
