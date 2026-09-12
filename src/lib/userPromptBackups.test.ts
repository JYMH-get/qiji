import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { createUserPromptBackupStore, usedPromptSnapshots } from '../../server/src/userPromptBackupsCore';
import { matchUsedPresets } from './usedPromptPresets';
import type { GenerateRequest } from '@/contract';

const body='  镜头缓慢推进\r\n保留 {{用户变量}}\n</textarea><script>不可执行</script>  ';
const req:GenerateRequest={model:'test',clientTaskId:'client',projectId:'project',purpose:'video.generate',variables:{prompt:body},usedPresets:[{kind:'video',source:'custom',sourceId:'v1',name:'视频规则',body}]};
const ctx={userId:'u1',userName:'甲',requestId:'log1',projectId:'项目一',model:'test',purpose:'video.generate'};

describe('用户原文使用备份',()=>{
  it('只匹配请求里存在的完整预设，分别记录图片与视频来源且不修改正文',()=>{
    const items=matchUsedPresets([body+'\n图片规则'],[
      {id:'v1',name:'视频',body,target:'video'},{id:'i1',name:'图片',body:'图片规则'},
      {id:'unused',name:'未用',body:'用户未提交内容'},
    ],new Set(['v1']));
    expect(items.map(t=>[t.kind,t.source,t.body])).toEqual([['video','custom',body],['image','builtin','图片规则']]);
  });
  it('未知/不在请求中的元数据不备份，覆盖提示词时仅记录实际覆盖正文',()=>{
    expect(usedPromptSnapshots({...req,variables:{prompt:'无预设'}})).toEqual([]);
    expect(usedPromptSnapshots({...req,promptOverride:'完整覆盖'})).toEqual([]);
    expect(usedPromptSnapshots({...req,usedPresets:[null,{body:7}] as any})).toEqual([]);
  });
  it('Skills保存完整原文和文件名，不附带剧本或用户偏好',()=>{
    const items=usedPromptSnapshots({...req,usedPresets:undefined,inference:{source:'skill',skillName:'创作.md',skillText:body,guidance:'不要备份该字段'}});
    expect(items).toEqual([{kind:'skill',source:'external',sourceId:'external-skill',name:'创作.md',body}]);
  });
  it('用户隔离、重复请求幂等、后续使用累计，改原文另存版本且原版本不变',()=>{
    const db=new DatabaseSync(':memory:');try{
      const store=createUserPromptBackupStore(db);
      expect(store.capture(req,ctx)).toBe(1);expect(store.capture(req,ctx)).toBe(0);
      store.capture(req,{...ctx,requestId:'log2',projectId:'项目二'});
      const first=store.list().items[0] as any;
      expect(first.use_count).toBe(2);expect(first.last_project_id).toBe('项目二');expect(first.body).toBeUndefined();
      expect((store.detail(first.id) as any).body).toBe(body);
      store.capture(req,{...ctx,userId:'u2',requestId:'log3'});
      const changed={...req,variables:{prompt:'第二版'},usedPresets:[{...req.usedPresets![0],body:'第二版'}]};
      store.capture(changed,{...ctx,requestId:'log4'});
      expect(store.list().total).toBe(3);expect(store.list({userId:'u1'}).total).toBe(2);
      expect((store.detail(first.id) as any).body).toBe(body);
      expect((store.detail(first.id) as any).uses).toHaveLength(2);
      const reopened=createUserPromptBackupStore(db);expect(reopened.list().total).toBe(3);
      expect(reopened.capture(req,{...ctx,userId:''})).toBe(0);
    }finally{db.close();}
  });
  it('分类、搜索、分页有边界，搜索符号按普通文本处理',()=>{
    const db=new DatabaseSync(':memory:');try{
      const store=createUserPromptBackupStore(db);store.capture(req,ctx);
      store.capture({...req,inference:{source:'skill',skillText:'自由创作'}},{...ctx,requestId:'log2'});
      expect(store.list({kind:'skill'}).total).toBe(1);expect(store.list({search:'项目一'}).total).toBe(2);
      expect(store.list({search:"%' OR 1=1"}).total).toBe(0);
      expect(store.list({pageSize:'1',page:'9000'})).toMatchObject({page:2,pages:2,pageSize:1});
      expect(store.detail('unknown')).toBeUndefined();
    }finally{db.close();}
  });
});
