/**
 * rtcCanvasSpec —— 实时剪辑「画幅」档位表与换算纯函数（零 DOM，可单测）。
 *
 * 语义对标剪映：新建草稿先定画幅（比例 + 分辨率）——画幅是**文档级**设置，决定
 * 预览框比例与成片尺寸（导出草稿写进 canvas_config）。切换画幅**不改动任何片段**
 * （我们的片段目前没有位置/缩放字段），只影响预览框与导出尺寸。
 *
 * ── 档位表 ────────────────────────────────────────────────────────────────
 * 比例（RTC_ASPECTS）：16:9 横屏 / 9:16 竖屏 / 1:1 方形 / 4:3 / 3:4 / 21:9 宽银幕
 * 分辨率（RTC_RESOLUTIONS）：720P / 1080P / 2K / 4K
 *
 * ── 像素换算规则 ──────────────────────────────────────────────────────────
 * 分辨率档以**短边**为基准（720/1080/1440/2160），长边按比例推算：
 *   16:9 × 1080P → 1920×1080     9:16 × 1080P → 1080×1920     1:1 × 1080P → 1080×1080
 *   16:9 × 2K    → 2560×1440     16:9 × 4K    → 3840×2160     21:9 × 1080P → 2520×1080
 * 短边基准的好处：横竖屏同一档位「清晰度」一致（竖屏 1080P 就是 1080 宽），
 * 且 16:9 各档恰好落在 1280×720 / 1920×1080 / 2560×1440 / 3840×2160 这几个业界标准值上。
 *
 * ⚠ 两边一律取偶数（makeEven）：H.264/H.265 的 4:2:0 色度二次采样要求宽高均为偶数，
 *   奇数尺寸在多数编码器上直接报错或被静默裁掉一行/一列。非标准比例（如 21:9 的
 *   1080P 长边 2520）换算后同样过一遍偶数化，保证任何组合都能编码。
 */
import { DEFAULT_RTC_CANVAS, type RtcCanvas } from "@/types/rtc";

/** 比例档：rw:rh 为比例分子分母（用整数表达，避免浮点直等） */
export interface RtcAspectSpec {
	id: string;
	/** 下拉里显示的中文标签（如「16:9 横屏」） */
	label: string;
	/** 纯比例文本（如「16:9」），用于紧凑显示 */
	ratioText: string;
	rw: number;
	rh: number;
}

/** 分辨率档：以短边像素为基准 */
export interface RtcResolutionSpec {
	id: string;
	label: string;
	/** 短边像素基准 */
	shortSide: number;
}

/** 比例档位表（顺序即下拉显示顺序，对标剪映常用项） */
export const RTC_ASPECTS: readonly RtcAspectSpec[] = [
	{ id: "16:9", label: "16:9 横屏", ratioText: "16:9", rw: 16, rh: 9 },
	{ id: "9:16", label: "9:16 竖屏", ratioText: "9:16", rw: 9, rh: 16 },
	{ id: "1:1", label: "1:1 方形", ratioText: "1:1", rw: 1, rh: 1 },
	{ id: "4:3", label: "4:3 横屏", ratioText: "4:3", rw: 4, rh: 3 },
	{ id: "3:4", label: "3:4 竖屏", ratioText: "3:4", rw: 3, rh: 4 },
	{ id: "21:9", label: "21:9 宽银幕", ratioText: "21:9", rw: 21, rh: 9 },
] as const;

/** 分辨率档位表（短边基准） */
export const RTC_RESOLUTIONS: readonly RtcResolutionSpec[] = [
	{ id: "720P", label: "720P", shortSide: 720 },
	{ id: "1080P", label: "1080P", shortSide: 1080 },
	{ id: "2K", label: "2K", shortSide: 1440 },
	{ id: "4K", label: "4K", shortSide: 2160 },
] as const;

/** 默认档位（= DEFAULT_RTC_CANVAS 1920×1080） */
export const DEFAULT_ASPECT_ID = "16:9";
export const DEFAULT_RESOLUTION_ID = "1080P";

/** 比例判定容差（相对误差）：小于它视为「就是这个比例档」 */
const ASPECT_EPS = 0.01;

export function findAspect(id: string): RtcAspectSpec | undefined {
	return RTC_ASPECTS.find((a) => a.id === id);
}

export function findResolution(id: string): RtcResolutionSpec | undefined {
	return RTC_RESOLUTIONS.find((r) => r.id === id);
}

/** 偶数化：向最近偶数取整，下限 2（编码器要求宽高为偶数，见头注释） */
export function makeEven(n: number): number {
	if (!Number.isFinite(n) || n <= 0) return 2;
	return Math.max(2, Math.round(n / 2) * 2);
}

/**
 * 按「比例档 + 分辨率档」算出实际像素（短边=分辨率档，长边按比例推算，两边偶数化）。
 * 档位 id 非法时回退默认档（16:9 · 1080P）。
 */
export function canvasSizeOf(aspectId: string, resolutionId: string): RtcCanvas {
	const a = findAspect(aspectId) ?? findAspect(DEFAULT_ASPECT_ID)!;
	const r = findResolution(resolutionId) ?? findResolution(DEFAULT_RESOLUTION_ID)!;
	const base = r.shortSide;
	// 短边给分辨率基准，长边 = 基准 × 长边比 / 短边比
	const width = a.rw >= a.rh ? (base * a.rw) / a.rh : base;
	const height = a.rw >= a.rh ? base : (base * a.rh) / a.rw;
	return { width: makeEven(width), height: makeEven(height) };
}

/** 画幅宽高比（width / height）——预览框按此画 letterbox；异常值回退默认画幅比例 */
export function aspectRatioOf(canvas: Pick<RtcCanvas, "width" | "height">): number {
	const { width: w, height: h } = canvas;
	if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
		return DEFAULT_RTC_CANVAS.width / DEFAULT_RTC_CANVAS.height;
	}
	return w / h;
}

export interface RtcCanvasPreset {
	aspectId: string;
	resolutionId: string;
	/** 该档位换算出的像素与传入画幅**完全一致**（非一致=自定义尺寸，只是就近匹配） */
	exact: boolean;
}

/**
 * 反解：给定像素尺寸反查最接近的「比例档 + 分辨率档」（下拉回显当前值用）。
 *
 * 策略：
 *   ① 比例——按 width/height 与各档 rw/rh 的**相对误差**取最小者（不用浮点直等，
 *      也不做约分：4:3 与 1.333… 这类非整除尺寸靠相对误差天然吃进来）；
 *   ② 分辨率——按**短边**与各档基准的相对误差取最小者（用比值而非绝对差：
 *      短边 1200 到 1080 差 120、到 1440 差 240，比值口径同样判 1080P，
 *      但对 4K 以上的超大尺寸不会因绝对差过大而失真）；
 *   ③ 非法/零/负/NaN 尺寸 → 默认档（16:9 · 1080P）且 exact=false；
 *   ④ exact 仅在 canvasSizeOf(匹配档) 与传入尺寸逐像素相等时为 true。
 */
export function resolveCanvasPreset(canvas: Pick<RtcCanvas, "width" | "height">): RtcCanvasPreset {
	const w = canvas?.width;
	const h = canvas?.height;
	if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
		return { aspectId: DEFAULT_ASPECT_ID, resolutionId: DEFAULT_RESOLUTION_ID, exact: false };
	}

	const ratio = w / h;
	let aspect = RTC_ASPECTS[0];
	let bestAspectErr = Number.POSITIVE_INFINITY;
	for (const a of RTC_ASPECTS) {
		const err = Math.abs(ratio - a.rw / a.rh) / (a.rw / a.rh);
		if (err < bestAspectErr - 1e-9) {
			bestAspectErr = err;
			aspect = a;
		}
	}

	const shortSide = Math.min(w, h);
	let resolution = RTC_RESOLUTIONS[0];
	let bestResErr = Number.POSITIVE_INFINITY;
	for (const r of RTC_RESOLUTIONS) {
		const err = Math.abs(Math.log(shortSide / r.shortSide));
		if (err < bestResErr - 1e-9) {
			bestResErr = err;
			resolution = r;
		}
	}

	const size = canvasSizeOf(aspect.id, resolution.id);
	const exact = bestAspectErr <= ASPECT_EPS && size.width === Math.round(w) && size.height === Math.round(h);
	return { aspectId: aspect.id, resolutionId: resolution.id, exact };
}

/**
 * 画幅显示文案：
 *   完全命中档位 → 「9:16 · 1080P（1080×1920）」
 *   自定义尺寸   → 「1000×1000（自定义）」（就近档位只用于下拉回显，不假装它是标准档）
 */
export function formatCanvasLabel(canvas: Pick<RtcCanvas, "width" | "height">): string {
	const preset = resolveCanvasPreset(canvas);
	const w = Math.round(canvas?.width ?? 0);
	const h = Math.round(canvas?.height ?? 0);
	if (!preset.exact) {
		if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
			const d = DEFAULT_RTC_CANVAS;
			return `${DEFAULT_ASPECT_ID} · ${DEFAULT_RESOLUTION_ID}（${d.width}×${d.height}）`;
		}
		return `${w}×${h}（自定义）`;
	}
	const a = findAspect(preset.aspectId)!;
	return `${a.ratioText} · ${preset.resolutionId}（${w}×${h}）`;
}

/** 两个画幅是否等价（用于 commit 前的 no-op 判断，避免无谓入撤销栈） */
export function sameCanvas(a: Pick<RtcCanvas, "width" | "height">, b: Pick<RtcCanvas, "width" | "height">): boolean {
	return Math.round(a.width) === Math.round(b.width) && Math.round(a.height) === Math.round(b.height);
}
