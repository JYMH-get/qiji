import { describe, expect, it } from 'vitest';
import { registrationChannels, verificationTargetError } from './registrationOptions';
import { promptExamples } from './promptExamples';
import { publicPromptNote } from '../../server/src/publicPromptNote';
import type { Catalog } from '@/contract';

describe('configured registration methods', () => {
  it('shows email only when SMS is unconfigured and rejects phone before sending', () => {
    const options = { enabled:true, email:true, phone:false };
    expect(registrationChannels(options)).toEqual({label:'邮箱',placeholder:'you@example.com',available:true});
    expect(verificationTargetError('13800000000',options)).toContain('仅支持邮箱');
    expect(verificationTargetError('user@example.com',options)).toBeNull();
  });
  it('supports phone only, both methods, and no configured method', () => {
    expect(registrationChannels({enabled:true,email:false,phone:true}).label).toBe('手机号');
    expect(registrationChannels({enabled:true,email:true,phone:true}).label).toBe('邮箱 / 手机号');
    expect(registrationChannels({enabled:true,email:false,phone:false}).available).toBe(false);
    expect(registrationChannels(null).available).toBe(false);
    expect(verificationTargetError('user@example.com',{enabled:true,email:false,phone:true})).toContain('未开放');
  });
});
describe('public prompt examples', () => {
  it('uses only public notes and deduplicates the compatibility preset projection', () => {
    const catalog = {templates:[{id:'a',name:'推理',purpose:'storyboard.unified',publicNote:'示例',body:'SECRET'},
      {id:'b',name:'预设',body:'BODY'}, {id:'c',name:'无注释',purpose:'storyboard.split',body:'SECRET2'}],
      presets:[{id:'b',name:'预设',category:'视频预设方案',publicNote:'视频说明',body:'BODY'}]} as unknown as Catalog;
    const items = promptExamples(catalog);
    expect(items).toHaveLength(3);
    expect(items.map(i=>i.category)).toEqual(['推理提示词','拆分提示词','视频预设']);
    expect(items.map(i=>i.note)).toEqual(['示例','','视频说明']);
    expect(JSON.stringify(items)).not.toMatch(/SECRET|BODY/);
  });
  it('validates public notes without treating them as executable markup', () => {
    expect(publicPromptNote('  <script>example</script>\n实例  ')).toBe('<script>example</script>\n实例');
    expect(publicPromptNote('')).toBeUndefined();
    expect(publicPromptNote(null)).toBeUndefined();
    expect(()=>publicPromptNote({body:'secret'})).toThrow();
    expect(()=>publicPromptNote('字'.repeat(10001))).toThrow();
  });
});
