/**
 * panoramaPrompt —— 「720°全景」前置提示词的**服务端**渲染（与转视角 viewAnglePrompt 同规，第194轮）。
 * 客户端只带 purpose "image.panorama"（可选 params.panorama.custom 补充要求）；
 * 正文=管理端「提示词模板」`panorama.main`（分类「转全景」可调优；catalog 连预览都不下发），
 * 模板被删/清空时用本文件 FALLBACK 兜底。
 */
import { getTemplateDef } from "../store/templates.ts";

const FALLBACK =
	"把 @Image1 的场景扩展为完整的 720° 全景：输出一张 equirectangular（等距圆柱投影）全景图，" +
	"宽高比严格为 2:1，覆盖水平 360°、垂直 180° 的完整视野。以原图内容为正前方（画面水平中央）的视角基准，" +
	"向左右两侧与正后方合理延伸出同一场景的其余部分；画面最左边缘与最右边缘必须无缝衔接（可首尾相连），" +
	"顶部为天空/顶面、底部为地面，天顶与地底区域按等距圆柱投影自然拉伸变形。" +
	"全图画风、光照方向、色调、材质与原图完全一致，场景连贯真实；" +
	"不要出现相机、拍摄者、水印、文字或画面分割线。{{补充要求}}";

/** params.panorama → 完整提示词（panorama 字段缺失也照样渲染——纯前置模板，无必需参数） */
export function renderPanoramaPrompt(raw: unknown): string {
	const custom = raw && typeof raw === "object" && typeof (raw as Record<string, unknown>).custom === "string"
		? String((raw as Record<string, unknown>).custom).trim().slice(0, 500)
		: "";
	const t = getTemplateDef("panorama.main");
	const body = t && t.enabled && t.body.trim() ? t.body : FALLBACK;
	return body.replace(/\{\{\s*补充要求\s*\}\}/g, custom ? `补充要求：${custom}。` : "");
}
