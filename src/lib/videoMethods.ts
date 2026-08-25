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
import type { CatalogModel } from "@/contract";
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

/** 结构化最小声明：兼容 contract.ParamField 与 adapters/types.ParamField（本地渠道 mode.paramsSchema） */
export interface ParamFieldLike {
	key: string;
	type: string;
	options?: string[];
	min?: number;
	max?: number;
}
/** 只用 params 的最小模型形状——catalog 模型与本地适配器的参数表都能喂进来 */
export interface ParamsCarrier {
	params?: ParamFieldLike[];
}

const field = (m: ParamsCarrier | undefined | null, key: string): ParamFieldLike | undefined =>
	m?.params?.find((p) => p.key === key);

/**
 * 按模型 params 取「要求」三档（服务端控档；未声明回退内置常量）。
 * ⚠ 只认「已经拿到 params 的模型对象」——**按模型 key 取档一律走
 * [modelOptions.ts](./modelOptions.ts) 的 videoReqOptionsForKey**（它会在 catalog 查不到时
 * 回退本地渠道适配器的 mode.paramsSchema；只查 catalog 会让 ComfyUI/LibTV/即梦这类本地模型
 * 掉回内置三档 480p/720p/1080p——第251轮修的就是这个）。
 */
export function videoReqOptions(m?: ParamsCarrier | null): VideoReqOptions {
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

/**
 * 画质档位串 → 可比较的数值（"768p"→768、"2K"→2000）；不是档位串返回 null。
 * k 按宽、p 按高，量纲虽不同但作为**档位排序**单调正确（1080p < 2K < 4K），够就近取档用。
 */
function resolutionTier(s: string | undefined): number | null {
	const m = /^\s*(\d+(?:\.\d+)?)\s*([pk])\s*$/i.exec(String(s ?? ""));
	if (!m) return null;
	const n = Number(m[1]);
	if (!Number.isFinite(n)) return null;
	return m[2].toLowerCase() === "k" ? n * 1000 : n;
}

/**
 * 值收敛到档位集；提交与显示同一把尺。优先级：**精确匹配 → 就近取档 → 缺省 → 第一档**。
 * ⚠ 两条勿回退：
 *  ① 大小写不敏感匹配、但**返回档位集里的规范写法**（LibTV H3 声明的是 "768P"/"2K" 大写，
 *    存量项目里存的是小写 "768p"——按字面比会误判越档，把用户选择重置成首档）。
 *  ② 画质档（480p/768p/2K 这类可解析为档位数的值）越档时**就近取档、并列取小**，不要直接掉首档：
 *    第251轮修好本地渠道档位后，存量项目里存着 720p 的会遇上 ComfyUI 的 480p/640p/768p/1080p——
 *    掉首档=静默降质到 480p（用户莫名其妙），就近=768p 才贴合用户当初的选择。
 *    非档位串（比例 "16:9"、画质 "low"）解析不出数值，自然走原「缺省→首档」语义。
 */
export function clampToOptions(v: string | undefined, options: string[], fallback?: string): string {
	const pick = (x: string | undefined): string | undefined =>
		x == null ? undefined : options.find((o) => o.toLowerCase() === String(x).toLowerCase());
	const exact = pick(v);
	if (exact) return exact;
	const tier = resolutionTier(v);
	if (tier != null) {
		let best: string | undefined;
		let bestD = Infinity;
		for (const o of options) {
			const t = resolutionTier(o);
			if (t == null) continue;
			const d = Math.abs(t - tier);
			if (d < bestD) {
				bestD = d;
				best = o;
			}
		}
		if (best) return best;
	}
	return pick(fallback) ?? options[0] ?? v ?? "";
}

/** 时长收敛到档位集（就近取档；空集回退原值） */
export function clampDurationTo(v: number, durations: number[]): number {
	if (!durations.length || durations.includes(v)) return v;
	return durations.reduce((best, d) => (Math.abs(d - v) < Math.abs(best - v) ? d : best), durations[0]);
}
