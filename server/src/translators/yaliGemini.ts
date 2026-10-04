import { buildPrompt } from './prompt.ts';
import { resolveEditRefs, type ImageResult, type OnUpstream } from './openai.ts';
import { submitSignal } from './submitTimeout.ts';
import { maskToken } from '../store/logs.ts';
import type { GenerateRequest } from '../contract.ts';
import type { Upstream } from './upstream.ts';
import { YALI_GEMINI_SPECS } from './yaliSpecs.ts';
import { serializeGeminiImageRequest } from './imageWireDiagnostics.ts';
import { geminiGenerationConfig, geminiRequestOptions } from './geminiImageParams.ts';
import { imageRoutingParams } from '../imageRouting.ts';

export async function translateYaliGemini(req:GenerateRequest,up:Upstream,onUpstream?:OnUpstream):Promise<ImageResult>{
 const spec=YALI_GEMINI_SPECS[up.upstreamModel];
 const config=geminiGenerationConfig(req.params);
 const nativeImage=(config.imageConfig??{}) as Record<string,unknown>;
 const resolution=String(nativeImage.imageSize??req.params?.imageSize??req.params?.resolution??spec.resolutions[0]).toLowerCase();
 const ratio=String(nativeImage.aspectRatio??req.params?.aspectRatio??req.params?.aspect_ratio??req.params?.size??'1:1');
 imageRoutingParams(req.params??{});
 if(!spec.resolutions.includes(resolution)||!spec.ratios.includes(ratio))return {ok:false,error:'鸭梨 Gemini 不支持所请求的分辨率或比例，禁止自动降档'};
 const {refs,missing}=await resolveEditRefs(req,up.imageMaterialMode);
 if(missing.length||refs.length!==(req.inputs?.images?.length??0))return {ok:false,error:'参考图无法获取，请重新上传'};
 const parts:Record<string,unknown>[]=[{text:buildPrompt(req)}];
 try{
  for(const ref of refs){
   let bytes:Buffer,mime:string;
   if(ref.bytes){bytes=Buffer.from(await ref.bytes.blob.arrayBuffer());mime=ref.bytes.blob.type||'image/png';}
   else{const response=await fetch(ref.url!,{signal:AbortSignal.timeout(60000)});if(!response.ok)throw Error('参考图下载失败');bytes=Buffer.from(await response.arrayBuffer());mime=response.headers.get('content-type')||'image/png';}
   parts.push({inlineData:{mimeType:mime,data:bytes.toString('base64')}});
  }
 }catch{return {ok:false,error:'参考图无法下载，请重新上传'};}
 const body={contents:[{role:'user',parts}],...geminiRequestOptions(req.params),generationConfig:geminiGenerationConfig(req.params,{imageSize:req.params?.imageSize??(resolution==='512'?'512':resolution.toUpperCase()),aspectRatio:req.params?.aspectRatio??ratio})};
 const url=`${up.baseUrl.replace(/\/+$/,'').replace(/\/v1$/,'')}/v1beta/models/${encodeURIComponent(up.upstreamModel)}:generateContent`;
 const wire=serializeGeminiImageRequest(body);
 onUpstream?.({request:{url,method:'POST',headers:{Authorization:`Bearer ${maskToken(up.apiKey)}`},body:{...body,contents:[{role:'user',parts:parts.map(p=>p.inlineData?{inlineData:'[image bytes]'}:p)}]},wire:wire.diagnostics}});
 try{
  const response=await fetch(url,{method:'POST',headers:{Authorization:`Bearer ${up.apiKey}`,'Content-Type':'application/json'},body:wire.bodyText,signal:submitSignal()});
  const data:any=await response.json().catch(()=>({}));
  onUpstream?.({response:{httpStatus:response.status,body:JSON.parse(JSON.stringify(data,(k,v)=>k==='data'&&typeof v==='string'?'[image bytes]':v))}});
  if(!response.ok||data.error)return {ok:false,error:data.error?.message||`鸭梨 Gemini HTTP ${response.status}`};
  const inline=data.candidates?.flatMap((c:any)=>c.content?.parts||[]).find((p:any)=>p.inlineData?.data)?.inlineData;
  if(!inline)return {ok:false,error:'鸭梨 Gemini 未返回图片'};
  return {ok:true,data:Buffer.from(inline.data,'base64'),contentType:inline.mimeType||'image/png'};
 }catch{return {ok:false,error:'鸭梨 Gemini 请求失败'};}
}
