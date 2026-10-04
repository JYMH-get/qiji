// 用户提供的鸭梨图像文档，2026-09-15。只登记文档明确的规格，不作近似取档。
export const YALI_BANANA_RATIOS = ['1:1','3:2','2:3','4:3','3:4','5:4','4:5','16:9','9:16','21:9'];
export const YALI_GEMINI_SPECS: Record<string,{resolutions:string[];ratios:string[]}> = {
  'gemini-2.5-flash-image-preview': {resolutions:['1k'],ratios:YALI_BANANA_RATIOS},
  'gemini-3-pro-image-preview': {resolutions:['1k','2k','4k'],ratios:YALI_BANANA_RATIOS},
  'gemini-3.1-flash-image-preview': {resolutions:['512','1k','2k','4k'],ratios:[...YALI_BANANA_RATIOS,'1:4','1:8','4:1','8:1']},
};
export const YALI_GROK_RATIOS = ['1:1','16:9','9:16','4:3','3:4','3:2','2:3','2:1','1:2','19.5:9','9:19.5','20:9','9:20','auto'];
const ratios=['1:1','4:3','3:4','16:9','9:16','3:2','2:3','21:9'];
const sizes:Record<string,string[]>={
 '1k':['1024x1024','1152x864','864x1152','1424x800','800x1424','1248x832','832x1248','1568x672'],
 '1.5k':['1536x1536','1792x1344','1344x1792','2048x1152','1152x2048','1872x1248','1248x1872','2352x1008'],
 '2k':['2048x2048','2368x1776','1776x2368','2816x1584','1584x2816','2496x1664','1664x2496','3136x1344'],
};
export const YALI_SEEDREAM_PRO_SIZES:Record<string,Record<string,string>>=Object.fromEntries(ratios.map((r,i)=>[r,Object.fromEntries(Object.entries(sizes).map(([k,v])=>[k,v[i]]))]));
