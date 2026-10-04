import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
const state=vi.hoisted(()=>({model:{capability:'text',params:[] as any[]},config:{textParams:{} as Record<string,Record<string,unknown>>}}));
vi.mock('@/store/catalogStore',()=>({useCatalogStore:(select:any)=>select({model:()=>state.model})}));
vi.mock('@/store/projectStore',()=>({useProjectStore:(select:any)=>select({projectModelConfig:state.config,setProjectModelConfig:vi.fn()})}));
import { TextReasoningSettings } from './TextReasoningSettings';
describe('text thinking controls',()=>{
  it('shows no controls for unsupported models',()=>{
    state.model.params=[];
    expect(renderToStaticMarkup(<TextReasoningSettings modelKey="ds"/>)).toBe('');
  });
  it('shows translated choices and disables effort when thinking is off',()=>{
    state.model.params=[{key:'thinkingMode',label:'思考模式',type:'enum',options:['default','enabled','disabled'],default:'default'},{key:'reasoning_effort',label:'思考强度',type:'enum',options:['default','low','high','max'],default:'high'}];
    state.config.textParams={ds:{thinkingMode:'disabled',reasoning_effort:'max'}};
    const html=renderToStaticMarkup(<TextReasoningSettings modelKey="ds"/>);
    expect(html).toContain('role="switch" aria-label="思考" aria-checked="false"');
    expect(html).toMatch(/aria-label="思考强度"[^>]*disabled/);
    expect(html).toContain('最高');
    expect(html).not.toContain('<select'); expect(html).not.toContain('默认'); expect(html).toContain('type="range"');
  });
  it('does not reuse one model selection for another model',()=>{
    const html=renderToStaticMarkup(<TextReasoningSettings modelKey="other"/>);
    expect(html).toContain('aria-checked="false"');
    expect(html).toContain('aria-valuetext="高"');
  });
});
