/**
 * genParams —— 生图/生视频的**生成参数（以资产模式为准）**，资产模式与画布共用。
 *
 * 资产模式（AssetWorkbench/Frame161195）的出图要求是固定的客户端 UI：模型 + 质量 + 比例 + 分辨率，
 * 出图请求保留原参数，并补齐缺失的 `{ aspect_ratio, resolution, quality }`。
 * 发 `{ duration, resolution, aspect_ratio }`。画布的「生成图片/生成视频」节点复用本文件，参数一一对应。
 */

// ── 图片 ──
export const IMAGE_QUALITIES = ["auto", "low", "medium", "high"];
export const IMAGE_ASPECTS = [
	{ v: "1:1", label: "1：1" },
	{ v: "16:9", label: "16：9" },
	{ v: "9:16", label: "9：16" },
	{ v: "21:9", label: "21：9" },
	{ v: "4:3", label: "4：3" },
	{ v: "3:4", label: "3：4" },
];
// 分辨率档全集。实际开放哪些档由**服务端控制**：
// 图像模型 catalog params 里 key="resolution" 的 enum options（管理端「模型→参数」可改，catalog 热更零发版）。
const RES_LABELS: Record<string, string> = { "1k": "1K", "2k": "2K", "4k": "4K" };
/** 内置回退：模型未声明 resolution 参数时的档位（上游画质映射所致，缺省只开 2K） */
export const IMAGE_RESOLUTIONS = [
	{ v: "2k", label: "2K" },
];
/** 服务端下发的分辨率档位：取模型 params 里 resolution 枚举（限 1k/2k/4k，容忍大小写），缺省回退内置 */
export function imageResolutionOptions(
	model?: { params?: { key: string; type: string; options?: string[] }[] } | null,
): { v: string; label: string }[] {
	const field = model?.params?.find((p) => p.key === "resolution" && p.type === "enum");
	const opts = [...new Set((field?.options ?? []).map((o) => String(o).toLowerCase()))].filter((o) => o in RES_LABELS);
	return opts.length ? opts.map((v) => ({ v, label: RES_LABELS[v] })) : IMAGE_RESOLUTIONS;
}
/**
 * 历史客户端像素尺寸映射已移到服务端；用户端补齐公共比例与分辨率。
 * 像素映射不再属于客户端，避免不同入口或渠道各自换算产生不一致。
 * 管理端会在选定实际上游模型后，依据该模型保存的参数枚举完成转换。
 * 已有上游字段和扩展参数原样保留；不按 catalog 过滤，也不改写显式的分辨率值。
 */
/** 把分辨率档归一到开放档位（旧节点/旧项目残留的档不在开放集 → 第一档） */
export function clampImageResolution(v: unknown, options?: { v: string }[]): string {
	const list = options?.length ? options : IMAGE_RESOLUTIONS;
	const s = String(v ?? "").toLowerCase();
	return list.some((r) => r.v === s) ? s : (list[0]?.v ?? "2k");
}

/** 保留节点图片参数，仅补齐缺失的公共字段；开放档位只用于没有分辨率时的默认值。 */
export function nativeImageSchema(fields?: readonly { key: string }[]): boolean {
	return !!fields?.some(f => f.key === 'botType');
}

export function buildImageParams(p: Record<string, unknown>, resOptions?: { v: string }[], fields?: readonly { key: string; default?: unknown }[]): Record<string, unknown> {
	if (nativeImageSchema(fields)) {
		const out = { ...Object.fromEntries((fields ?? []).filter(f => f.default !== undefined).map(f => [f.key, f.default])), ...p };
		if (p.aspectRatio === undefined && (p.aspect_ratio !== undefined || p.aspect !== undefined)) out.aspectRatio = p.aspect_ratio ?? p.aspect;
		return out;
	}
	const out = { ...p };
	const config = p.generationConfig && typeof p.generationConfig === "object" && !Array.isArray(p.generationConfig)
		? p.generationConfig as Record<string, unknown> : {};
	const imageConfig = config.imageConfig && typeof config.imageConfig === "object" && !Array.isArray(config.imageConfig)
		? config.imageConfig as Record<string, unknown> : {};
	if (out.aspect_ratio === undefined) out.aspect_ratio = p.aspect ?? p.aspectRatio ?? imageConfig.aspectRatio ?? "16:9";
	if (out.resolution === undefined) out.resolution = p.imageSize ?? imageConfig.imageSize ?? clampImageResolution("2k", resOptions);
	if (out.quality === undefined) out.quality = "high";
	return out;
}

// ── 视频 ──
export const VIDEO_RESOLUTIONS = ["480p", "720p", "1080p"];
export const VIDEO_ASPECTS = ["16:9", "9:16", "1:1"];
// 视频时长可选范围 4–15 秒（资产模式用下拉、画布模式用滑块）
export const VIDEO_DURATION_MIN = 4;
export const VIDEO_DURATION_MAX = 15;
export const VIDEO_DURATIONS = Array.from(
	{ length: VIDEO_DURATION_MAX - VIDEO_DURATION_MIN + 1 },
	(_, i) => VIDEO_DURATION_MIN + i,
);
/** 把任意时长值夹到 [4,15]（旧数据/越界兜底） */
export function clampDuration(v: unknown): number {
	const n = Math.round(Number(v));
	if (!Number.isFinite(n)) return VIDEO_DURATION_MIN;
	return Math.min(VIDEO_DURATION_MAX, Math.max(VIDEO_DURATION_MIN, n));
}

// ── 计费预估（与服务端 resolveModelCost 同公式：按字段计费 = 每单位价 × 字段值，否则固定/路由价）──
interface CostModel {
	cost?: number;
	pricingHidden?: boolean;
	tokenPricing?: { enabled: boolean; multiplier?: number };
	costField?: string;
	costPerUnit?: number;
	costRules?: { when: Record<string, string>; cost?: number; costPerUnit?: number }[];
	/** 参考视频按秒计费折算系数（第143轮，catalog 下发）：计费秒数 = duration + 系数 × Σceil(每条参考视频秒) */
	refVideoSecondsWeight?: number;
}

/**
 * 预估本次生成消耗的积分（与管理端实际扣费一致；缺模型返回 null 表示未知）。
 * refVideoSeconds = 参考视频计费秒数合计（调用方按**每条向上取整**后求和，见 videoDurationStore）——
 * 与服务端 refVideoBilling 同尺：按秒价或档位价且输出秒数>0 时按模型系数折算输入费用。
 */
export function estimateCost(model: CostModel | undefined, params: Record<string, unknown>, refVideoSeconds = 0): number | null {
	if (!model) return null;
	if (model.pricingHidden) return null;
	if (model.tokenPricing?.enabled) return 10;
	const scale = (cost: number) => { const raw = cost * (model.tokenPricing?.multiplier ?? 1); return model.tokenPricing ? Math.ceil(raw - Number.EPSILON * Math.max(1, raw) * 4) : cost; };
	const rule = (model.costRules ?? []).find((r) =>
		Object.keys(r.when ?? {}).every((k) => String(params[k]) === String(r.when[k])),
	);
	if (model.costField) {
		const perUnit = rule?.costPerUnit ?? model.costPerUnit ?? 0;
		const base = Math.max(0, Number(params[model.costField]) || 0);
		const weight = Number(model.refVideoSecondsWeight) || 0;
		const unit = base > 0 ? base + weight * Math.max(0, refVideoSeconds) : 0;
		if (perUnit >= 0 && unit > 0) return model.tokenPricing ? scale(perUnit * unit) : Math.round(perUnit * unit);
	}
	const baseCost=rule?.cost ?? model.cost;
	if(baseCost===undefined)return null;
	if(model.costRules?.length&&model.refVideoSecondsWeight&&Number(params.duration)>0&&refVideoSeconds>0){
		return Math.round(baseCost*(1+model.refVideoSecondsWeight*refVideoSeconds/Number(params.duration)));
	}
	return scale(baseCost);
}
