/**
 * 视频生成「方法」与「要求」助手（第131轮）——四级选择 模式(源头)→模型→方法→要求 的 方法/要求 层单一来源。
 *
 * 方法（catalog 模型 methods 字段下发）：
 *  - omni   全能参考（现状行为：提示词 + 图/视频/音频参考素材；不传素材=文生视频，无需单列方法）
 *  - frames 首尾帧（首帧 + 尾帧两张图：首帧=故事板图/素材第 1 张图，尾帧=素材下一张图；服务端同尺）
 * 未声明 methods 的模型（Qiji seedance / LibTV / 即梦 / 存量）＝仅全能参考，方法级不显示、行为不变。
 *
 * 要求（时长/比例/分辨率）按 catalog 模型 params 下发（服务端控档，与图像 imageResolutionOptions 同范式）：
 * 模型未声明某参数时回退内置常量（genParams 的 VIDEO_*）。
 */
import type { CatalogModel, ParamField } from "@/contract";
import { VIDEO_ASPECTS, VIDEO_DURATIONS, VIDEO_RESOLUTIONS } from "./genParams";

export type VideoMethod = "omni" | "frames";

export const METHOD_LABELS: Record<VideoMethod, string> = { omni: "全能参考", frames: "首尾帧" };

/** 比例档显示名（未列出的原样显示） */
export const ASPECT_LABELS: Record<string, string> = {
	"16:9": "16:9（横屏）",
	"9:16": "9:16（竖屏）",
	"1:1": "1:1（方形）",
	adaptive: "自适应",
};

/** 模型支持的方法集（未声明=仅全能参考；过滤未知值防脏数据） */
export function modelMethods(m?: Pick<CatalogModel, "methods"> | null): VideoMethod[] {
	const arr = (m?.methods ?? []).filter((x): x is VideoMethod => x === "omni" || x === "frames");
	return arr.length ? arr : ["omni"];
}

/** 把（可能残留的）方法值收敛到模型支持集内（不在集合 → 第一项） */
export function clampMethod(v: unknown, allowed: VideoMethod[]): VideoMethod {
	return allowed.includes(v as VideoMethod) ? (v as VideoMethod) : allowed[0];
}

export interface VideoReqOptions {
	/** 分辨率档（enum options） */
	resolutions: string[];
	/** 比例档（enum options） */
	aspects: string[];
	/** 时长档（秒）：enum 模型（如 hn 5/10/15）取声明档，number 模型取 [min..max] 整数序列 */
	durations: number[];
}

const field = (m: CatalogModel | undefined, key: string): ParamField | undefined =>
	m?.params?.find((p) => p.key === key);

/** 按 catalog 模型 params 取「要求」三档（服务端控档；未声明回退内置常量） */
export function videoReqOptions(m?: CatalogModel): VideoReqOptions {
	const res = field(m, "resolution");
	const asp = field(m, "aspect_ratio");
	const dur = field(m, "duration");
	let durations: number[] = VIDEO_DURATIONS;
	if (dur?.type === "enum" && dur.options?.length) {
		durations = dur.options.map((o) => Math.round(Number(o))).filter((n) => Number.isFinite(n) && n > 0);
	} else if (dur?.type === "number" && dur.min != null && dur.max != null) {
		const lo = Math.round(dur.min);
		const hi = Math.round(dur.max);
		if (hi >= lo && hi - lo <= 60) durations = Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
	}
	return {
		resolutions: res?.options?.length ? res.options : VIDEO_RESOLUTIONS,
		aspects: asp?.options?.length ? asp.options : VIDEO_ASPECTS,
		durations: durations.length ? durations : VIDEO_DURATIONS,
	};
}

/** 值收敛到档位集（不在集合 → 缺省 → 第一档）；提交与显示同一把尺 */
export function clampToOptions(v: string | undefined, options: string[], fallback?: string): string {
	if (v && options.includes(v)) return v;
	if (fallback && options.includes(fallback)) return fallback;
	return options[0] ?? v ?? "";
}

/** 时长收敛到档位集（就近取档；空集回退原值） */
export function clampDurationTo(v: number, durations: number[]): number {
	if (!durations.length || durations.includes(v)) return v;
	return durations.reduce((best, d) => (Math.abs(d - v) < Math.abs(best - v) ? d : best), durations[0]);
}
