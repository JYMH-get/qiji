/**
 * genParams —— 生图/生视频的**生成参数（以资产模式为准）**，资产模式与画布共用。
 *
 * 资产模式（AssetWorkbench/Frame161195）的出图要求是固定的客户端 UI：模型 + 质量 + 比例 + 分辨率，
 * 出图请求发 `{ size: resolveSize(aspect,resolution), quality }`；视频要求是模型 + 时长 + 分辨率 + 比例，
 * 发 `{ duration, resolution, aspect_ratio }`。画布的「生成图片/生成视频」节点复用本文件，参数一一对应。
 */

// ── 图片 ──
export const IMAGE_QUALITIES = ["auto", "low", "medium", "high"];
export const IMAGE_ASPECTS = [
	{ v: "1:1", label: "1：1" },
	{ v: "16:9", label: "16：9" },
	{ v: "9:16", label: "9：16" },
];
// 分辨率档全集（label + SIZE_MAP 解析用）。实际开放哪些档由**服务端控制**：
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
// (比例, 分辨率档) → 实际请求的具体像素分辨率
export const SIZE_MAP: Record<string, Record<string, string>> = {
	"1:1": { "1k": "1024x1024", "2k": "2048x2048", "4k": "4096x4096" },
	"16:9": { "1k": "1024x576", "2k": "2048x1152", "4k": "3840x2160" },
	"9:16": { "1k": "576x1024", "2k": "1152x2048", "4k": "2160x3840" },
};
export function resolveSize(aspect: string, resolution: string): string {
	return SIZE_MAP[aspect]?.[resolution] ?? "1024x1024";
}

/** 把分辨率档归一到开放档位（旧节点/旧项目残留的档不在开放集 → 第一档） */
export function clampImageResolution(v: unknown, options?: { v: string }[]): string {
	const list = options?.length ? options : IMAGE_RESOLUTIONS;
	const s = String(v ?? "").toLowerCase();
	return list.some((r) => r.v === s) ? s : (list[0]?.v ?? "2k");
}

/** 节点图片参数(质量/比例/分辨率) → 出图请求参数 { size, quality }（与资产模式一致；resOptions=该模型开放档位） */
export function buildImageParams(p: Record<string, unknown>, resOptions?: { v: string }[]): Record<string, unknown> {
	const aspect = String(p.aspect ?? "16:9");
	const resolution = clampImageResolution(p.resolution, resOptions);
	const quality = String(p.quality ?? "high");
	return { size: resolveSize(aspect, resolution), quality };
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
	cost: number;
	costField?: string;
	costPerUnit?: number;
	costRules?: { when: Record<string, string>; cost?: number; costPerUnit?: number }[];
	/** 参考视频按秒计费折算系数（第143轮，catalog 下发）：计费秒数 = duration + 系数 × Σceil(每条参考视频秒) */
	refVideoSecondsWeight?: number;
}

/**
 * 预估本次生成消耗的积分（与管理端实际扣费一致；缺模型返回 null 表示未知）。
 * refVideoSeconds = 参考视频计费秒数合计（调用方按**每条向上取整**后求和，见 videoDurationStore）——
 * 与服务端 refVideoBilling 同尺：仅按字段计费且基础秒数>0 时按模型系数折算进计费秒数。
 */
export function estimateCost(model: CostModel | undefined, params: Record<string, unknown>, refVideoSeconds = 0): number | null {
	if (!model) return null;
	const rule = (model.costRules ?? []).find((r) =>
		Object.keys(r.when ?? {}).every((k) => String(params[k]) === String(r.when[k])),
	);
	if (model.costField) {
		const perUnit = rule?.costPerUnit ?? model.costPerUnit ?? 0;
		const base = Math.max(0, Number(params[model.costField]) || 0);
		const weight = Number(model.refVideoSecondsWeight) || 0;
		const unit = base > 0 ? base + weight * Math.max(0, refVideoSeconds) : 0;
		if (perUnit > 0 && unit > 0) return Math.round(perUnit * unit);
	}
	return rule?.cost ?? model.cost;
}
