import { describe, it, expect } from 'vitest';
import { imageRouteParams, imageMemberAccepts, imageUpstreamParams } from '../../server/src/imageRouting';
import { buildImageParams } from './genParams';
import type { ModelDef } from '../../server/src/store/models';
const params = [
  {key:'botType',label:'模型风格',type:'enum' as const,options:['MID_JOURNEY','NIJI_JOURNEY'],default:'MID_JOURNEY'},
  {key:'aspectRatio',label:'比例',type:'enum' as const,options:['1:1','9:16','4:5'],default:'1:1'},
  {key:'quality',label:'质量',type:'enum' as const,options:['0.25','0.5','1','2'],default:'1'},
  {key:'stylize',label:'风格化',type:'enum' as const,options:['0','100','1000'],default:'100'},
  {key:'style',label:'风格',type:'enum' as const,options:['','raw'],default:''},
];
const model={id:'mj',capability:'image',protocol:'xiha888-image',params} as ModelDef;
describe('MJ 原生参数从线路目录到上游',()=>{
  it('线路提供数值质量与MJ控件，不捏造分辨率',()=>{
    expect(imageRouteParams([model])).toEqual(params);
    expect(imageRouteParams([{...model,protocol:'stub'}])).toEqual(params);
    expect(imageRouteParams([model])?.some(f=>f.key==='resolution')).toBe(false);
  });
  it('新资产请求填充原生默认值，保留选择及扩展字段且不注入high/2K',()=>{
    const request=buildImageParams({aspectRatio:'4:5',quality:'0.5',stylize:'0',custom:{x:1}},undefined,params);
    expect(request).toEqual({botType:'MID_JOURNEY',aspectRatio:'4:5',quality:'0.5',stylize:'0',style:'',custom:{x:1}});
    expect(imageMemberAccepts(model,request)).toBe(true);
    expect(imageUpstreamParams(model,request)).toEqual(request);
  });
  it('旧high不被暗改成数值，候选验证拒绝并要求重新选择',()=>{
    expect(buildImageParams({quality:'high'},undefined,params).quality).toBe('high');
    expect(imageMemberAccepts(model,{quality:'high'})).toBe(false);
    for(const quality of ['0.25','0.5','1','2']) expect(imageMemberAccepts(model,{quality})).toBe(true);
  });
  it('修改线路参数不会修改模型声明',()=>{
    const fields=imageRouteParams([model])!;fields[0].options!.push('extra');
    expect(model.params[0].options).not.toContain('extra');
  });
  it('画布既有比例在原生默认值补齐时保持一致',()=>{
    const request=buildImageParams({aspect_ratio:'9:16',quality:'1'},undefined,params);
    expect(request.aspectRatio).toBe('9:16');
    expect(imageUpstreamParams(model,request)).toEqual(request);
  });
});
