import { describe, it, expect } from 'vitest';
import { inferenceTemplates, resolveStrategyTemplate, inferencePurpose, canvasInference, canvasNeighborVars } from './inferenceStrategy';
import { INFERENCE_FORMATS, composeInference, inferenceRequestError } from '../../server/src/inferenceComposition';
import { parseInferCards, parseInferCardsStream } from './smartInferPrompts';
const templates = [
  { id: 'multi', aliases: ['merged-single'], name: '官方9', purpose: 'storyboard.unified', isDefault: true },
  { id: 'single', name: '官方9单卡', purpose: 'storyboard.unifiedShot' },
  { id: 'output.storyboard.unified', name: '输出', purpose: 'storyboard.unified', category: '输出提示词' },
] as any;
describe('分离式推理', () => {
  it('不同正文的单双卡均显示，仅显式合并的旧引用解析到保留方案', () => {
    expect(inferenceTemplates(templates).map(t=>t.id)).toEqual(['multi','single']);
    expect(resolveStrategyTemplate(templates,'single')?.id).toBe('single');
    expect(resolveStrategyTemplate(templates,'merged-single')?.id).toBe('multi');
    expect(resolveStrategyTemplate(templates,'deleted')).toBeUndefined();
  });
  it('不同归属的同名方案不会按名称隐藏',()=>{
    expect(inferenceTemplates([...templates,{...templates[0],id:'another-owner'}]).map(t=>t.id)).toEqual(['multi','single','another-owner']);
  });
  it('同源严格使用unified_prompt，video_prompts保留视频含义',()=>{
    const card={card_number:1,duration:15,original_script:'推门',video_prompts:'视频'};
    for(const parse of [parseInferCards,parseInferCardsStream]){
      expect(parse(JSON.stringify([card]))[0].unifiedPrompt).toBe('');
      expect(parse(JSON.stringify([{...card,storyboard_prompts:'故事板'}]))[0].unifiedPrompt).toBe('');
      expect(parse(JSON.stringify([{...card,unified_prompt:'明确同源'}]))[0].unifiedPrompt).toBe('明确同源');
    }
    expect(parseInferCardsStream('[{"card_number":1,"unified_prompt":"动作进行中')[0].unifiedPrompt).toBe('动作进行中');
  });
  it.each([false,true])('创作方案不决定输出模式 unified=%s', unified => {
    for(const single of [false,true]) {
      const purpose=inferencePurpose(single,unified);
      const format=INFERENCE_FORMATS.find(t=>t.purpose===purpose)!;
      const result=composeInference({ clientTaskId:'qa', projectId:'qa', purpose, model:'test', inference:{source:'template',guidance:'更克制'},variables:{原文:'人物推门。',上一分镜:'前镜已落座'} }, '遵守人物性格。',format.body);
      expect(result.indexOf('【最终输出格式与全局输出规范】')).toBeLessThan(result.indexOf('【剧本原文】'));
      expect(result.indexOf('【剧本原文】')).toBeLessThan(result.indexOf('【剧情引导】'));
      expect(result.indexOf('【剧情引导】')).toBeLessThan(result.indexOf('【附件】'));
      expect(result.endsWith('遵守人物性格。')).toBe(true);
      expect(result).toContain('范围是4-15');
      expect(result.includes('前镜已落座')).toBe(single);
      expect(result).not.toContain('{{');
      const card={card_number:1,original_script:'人物推门。',duration:15,...(unified?{unified_prompt:'共用提示词'}:{storyboard_prompts:'图像',video_prompts:'视频'})};
      const parsed=parseInferCards(JSON.stringify([card]))[0];
      expect(unified?parsed.unifiedPrompt:parsed.videoPrompt).toBe(unified?'共用提示词':'视频');
    }
  });
  it('外部Skills原样保留且不混入服务端创作正文', () => {
    const result=composeInference({clientTaskId:'qa',projectId:'qa',model:'test',purpose:'storyboard.singleShot',inference:{source:'skill',skillText:'使用 {{自有变量}}\n自由构图',guidance:'雨夜'},variables:{原文:'走进小巷'}},'不得混入','固定JSON\n{{原文}}\n{{剧情引导}}\n{{提示词}}');
    expect(result).toContain('{{自有变量}}');expect(result).not.toContain('不得混入');expect(result).toContain('雨夜');
  });
  it('完整原提示词的格式章节、示例与输入章节均保留，只填充既有变量', () => {
    const body='# 导演\n克制表演\n## 最终输出格式\n只输出JSON\n```json\n[{"duration":15}]\n```\n## 本次输入\n{{原文}}';
    const result=composeInference({clientTaskId:'qa',projectId:'qa',model:'test',purpose:'storyboard.singleShot',inference:{source:'template'},variables:{原文:'人物走进房间'}},body,'独立格式\n{{提示词}}');
    expect(result).toBe('独立格式\n'+body.replace('{{原文}}','人物走进房间'));
  });
  it('缺失/越权方案与空Skill在提交前拒绝，不允许覆盖输出契约', () => {
    const req={model:'test',purpose:'storyboard.unified',templateId:'multi',inference:{source:'template'}} as any;
    expect(inferenceRequestError(req,templates)).toBeUndefined();
    expect(inferenceRequestError({...req,templateId:'merged-single'},templates)).toBeUndefined();
    expect(inferenceRequestError({...req,templateId:'merged-single'},templates.filter((t:any)=>t.id!=='multi'))).toContain('未对');
    expect(inferenceRequestError({...req,templateId:'private'},templates)).toContain('未对');
    expect(inferenceRequestError({...req,inference:{source:'skill',skillText:''}},templates)).toContain('Skills');
    expect(inferenceRequestError({...req,promptOverride:'skip'},templates)).toContain('覆盖');
  });
  it('画布同源由输出配置决定；上游单卡门禁只约束输出数量', () => {
    const node={id:'n',type:'smart.infer',data:{params:{templateId:'multi',inferenceOutput:'storyboard.toVideoPrompt'}}} as any;
    const nodes={n:node,parent:{id:'parent',type:'smart.infer',data:{params:{}}}} as any;
    const cfg=canvasInference(node,nodes,{e:{id:'e',source:'parent',target:'n'}} as any,templates);
    expect(cfg.purpose).toBe('storyboard.singleShot');expect(cfg.template?.id).toBe('multi');
  });
  it('邻镜按分镜数字顺序读取结果，未生成则使用原文，隔离其他上游', () => {
    const make=(id:string,n:number,resultText:string)=>({id,type:'smart.infer',data:{title:`分镜${n}原文`,params:{prompt:`原文${n}`},resultText}});
    const nodes={a:make('a',1,'前镜结果'),b:make('b',2,''),c:make('c',3,''),other:make('other',0,'不得混入')} as any;
    const edges={a:{source:'p',target:'a'},b:{source:'p',target:'b'},c:{source:'p',target:'c'},other:{source:'other-p',target:'other'}} as any;
    expect(canvasNeighborVars(nodes.b,nodes,edges,true)).toEqual({上上一分镜:'',上一分镜:'前镜结果',下一分镜:'原文3'});
  });
});
