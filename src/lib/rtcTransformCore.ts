/**
 * rtcTransformCore —— 实时剪辑「画面变换」纯函数层（零 DOM / 零 store / 零 React，可单测）。
 *
 * 服务两个消费方：
 *   ① 属性面板 `src/rtc/panel/RtcTransformProps.tsx`（剪映式数值设置：缩放/位置/旋转/不透明度/镜像/对齐）；
 *   ② 剪映草稿导出 `src/lib/jianyingDraft.ts`（RtcTransform → segment.clip）。
 *
 * ── ⚠ 单位约定（三套坐标，别混）─────────────────────────────────────────────
 *   A. **内部存储（RtcTransform.x/y）= 画幅宽/高的比例**，0=居中，x 正向右、y 正向下。
 *      切画幅档（1080P→4K、16:9→9:16）时素材不失位，这是选比例而非像素的唯一理由。
 *   B. **界面显示 = 像素**（剪映的位置 X/Y 就是像素）：px = 比例 × 画幅宽(高)，见 ratioToPx/pxToRatio。
 *   C. **剪映草稿 clip.transform = 归一化「半画幅」值**，且 **y 轴朝上为正**，见 toJyClip。
 *
 * ── 缩放基准 ────────────────────────────────────────────────────────────────
 *   scale=1（界面 100%）= 素材在画幅内 **contain 居中铺满**（长边贴边、短边留黑）——与剪映
 *   「缩放 100%」语义一致：pyJianYingDraft 的 VideoSegment 对素材/画幅比例差**不做任何自动缩放裁剪**
 *   （已核 video_segment.py：clip_settings 原样透传，无 auto-fit 逻辑），即 1.0 就是剪映渲染器
 *   自己的 contain 基准，我们侧预览同基准 → 数值可直接对拷，无需换算系数。
 */
import { DEFAULT_RTC_TRANSFORM, type RtcTransform } from "@/types/rtc";

/* ── 取值范围（界面与写库共用同一把尺） ────────────────────────────────── */

/** 缩放倍率上下限（界面按百分比显示 = 1% ~ 1000%） */
export const SCALE_MIN = 0.01;
export const SCALE_MAX = 20;
/** 位置偏移上限（比例口径；±5 = 可把素材推出画幅 5 倍宽/高，够用且防手滑输入天文数字） */
export const POS_RATIO_LIMIT = 5;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
/** 消除 -0（JSON 里 -0 与 0 等价，但 vitest 的 toEqual 区分二者，落库前统一归 0） */
const z = (n: number) => (n === 0 ? 0 : n);
/** 定点四舍五入（默认 6 位，够表达 4K 画幅下的亚像素且不留浮点噪声） */
const round = (n: number, digits = 6) => {
	const f = 10 ** digits;
	return z(Math.round(n * f) / f);
};

export function clampScale(v: number): number {
	return Number.isFinite(v) ? round(clamp(v, SCALE_MIN, SCALE_MAX), 4) : 1;
}

export function clampOpacity(v: number): number {
	return Number.isFinite(v) ? round(clamp(v, 0, 1), 4) : 1;
}

export function clampPosRatio(v: number): number {
	return Number.isFinite(v) ? round(clamp(v, -POS_RATIO_LIMIT, POS_RATIO_LIMIT)) : 0;
}

/** 旋转角归一到 [0, 360)，保留 2 位小数（界面按 `0.00°` 形态显示） */
export function normalizeRotation(deg: number): number {
	if (!Number.isFinite(deg)) return 0;
	const wrapped = ((deg % 360) + 360) % 360;
	const r = round(wrapped, 2);
	// 359.999 → 360.00 的边界回卷（round 之后才可能等于 360）
	return r >= 360 ? 0 : z(r);
}

/* ── 显示换算（界面像素/百分比 ↔ 内部比例/倍率） ─────────────────────────── */

/** 比例 → 像素（按画幅某一边长；四舍五入到整像素，界面输入框用） */
export function ratioToPx(ratio: number, sizePx: number): number {
	if (!Number.isFinite(ratio) || !Number.isFinite(sizePx) || sizePx <= 0) return 0;
	return z(Math.round(ratio * sizePx));
}

/** 像素 → 比例（画幅边长非法=0，防除零；结果按 POS_RATIO_LIMIT 夹取） */
export function pxToRatio(px: number, sizePx: number): number {
	if (!Number.isFinite(px) || !Number.isFinite(sizePx) || sizePx <= 0) return 0;
	return clampPosRatio(px / sizePx);
}

/** 倍率 → 百分比（保留 1 位小数：72% / 33.3%） */
export function scaleToPercent(scale: number): number {
	if (!Number.isFinite(scale)) return 100;
	return round(scale * 100, 1);
}

/** 百分比 → 倍率（夹到 SCALE_MIN..SCALE_MAX） */
export function percentToScale(percent: number): number {
	if (!Number.isFinite(percent)) return 1;
	return clampScale(percent / 100);
}

/**
 * 解析数字输入框文本：空/NaN/非数字 → null（调用方据此**回退原值、不写库**，符合
 * 「非法输入不报错不写库」的要求）。允许前后空白、允许尾随的单位符号（%、°、px）。
 */
export function parseNumeric(text: string): number | null {
	const t = String(text ?? "").trim().replace(/[%°]|px$/gi, "").trim();
	if (!t) return null;
	const n = Number(t);
	return Number.isFinite(n) ? n : null;
}

/* ── contain 适配与对齐 ─────────────────────────────────────────────────── */

/** 素材在画幅内 contain 后占画幅的比例（1 = 该方向铺满画幅） */
export interface FitSize {
	w: number;
	h: number;
}

/** scale=1 时素材完全铺满画幅（素材比例未知时的兜底口径） */
export const FIT_FULL: FitSize = { w: 1, h: 1 };

/**
 * contain 适配：素材宽高比 mediaAspect（w/h）放进画幅宽高比 canvasAspect 里，
 * 返回它占画幅宽/高的比例。素材比 canvas 更宽 → 宽向铺满(w=1)、高向留黑(h<1)，反之亦然。
 * ⚠ mediaAspect 未知（null/0/NaN，例如素材尺寸尚未探测到）→ 退回 FIT_FULL：
 *   对齐按钮此时按「素材铺满画幅」计算，宁可保守（贴边略有偏差）也不瞎猜比例。
 */
export function containFit(mediaAspect: number | null | undefined, canvasAspect: number): FitSize {
	const m = Number(mediaAspect);
	const c = Number(canvasAspect);
	if (!Number.isFinite(m) || m <= 0 || !Number.isFinite(c) || c <= 0) return FIT_FULL;
	return m >= c ? { w: 1, h: round(c / m) } : { w: round(m / c), h: 1 };
}

export type AlignKind = "left" | "centerX" | "right" | "top" | "centerY" | "bottom";

/**
 * 对齐所需的位置值（比例口径）：把素材（contain 尺寸 × 当前缩放）贴到画幅某一边。
 *
 * 推导：素材显示宽占画幅比例 = fit.w × scaleX，其半宽 = fit.w×scaleX/2；画幅半宽 = 0.5。
 * 左贴边即素材左缘与画幅左缘重合 → 中心偏移 x = -(0.5 − fit.w×scaleX/2) = (fit.w×scaleX − 1)/2。
 * 素材比画幅大（fit×scale > 1）时结果为正 = 素材左缘对齐画幅左缘、右侧溢出，与剪映一致。
 *
 * ⚠ 旋转不参与计算（按未旋转的外接框贴边，同剪映观感）；返回的是**该轴**的位置值，
 *   横向三档返回 x、纵向三档返回 y，调用方各自写进对应字段。
 */
export function alignOffsetRatio(kind: AlignKind, fit: FitSize, t: Pick<RtcTransform, "scaleX" | "scaleY">): number {
	const horizontal = kind === "left" || kind === "centerX" || kind === "right";
	const span = horizontal ? (fit.w || 1) * (t.scaleX || 1) : (fit.h || 1) * (t.scaleY || 1);
	const edge = round((span - 1) / 2);
	switch (kind) {
		case "left":
		case "top":
			return clampPosRatio(edge);
		case "right":
		case "bottom":
			return clampPosRatio(-edge);
		default:
			return 0; // centerX / centerY
	}
}

/* ── 规整与落库 ─────────────────────────────────────────────────────────── */

/** 全字段夹取/取整（面板每次写库前过一遍，杜绝 NaN/越界/-0 进项目文件） */
export function normalizeTransform(t: RtcTransform): RtcTransform {
	return {
		scaleX: clampScale(t.scaleX),
		scaleY: clampScale(t.scaleY),
		x: clampPosRatio(t.x),
		y: clampPosRatio(t.y),
		rotation: normalizeRotation(t.rotation),
		opacity: clampOpacity(t.opacity),
		// 与 segTransform 一致：false 不落键（存量文档零噪声）
		...(t.flipH ? { flipH: true as const } : {}),
		...(t.flipV ? { flipV: true as const } : {}),
	};
}

/** 是否等于缺省变换（contain 居中铺满、不旋转、不透明、无镜像） */
export function isDefaultTransform(t: RtcTransform): boolean {
	const d = DEFAULT_RTC_TRANSFORM;
	return (
		t.scaleX === d.scaleX &&
		t.scaleY === d.scaleY &&
		t.x === d.x &&
		t.y === d.y &&
		t.rotation === d.rotation &&
		t.opacity === d.opacity &&
		!t.flipH &&
		!t.flipV
	);
}

/**
 * 落库形态：规整后若等于缺省 → 返回 undefined（**不写 transform 字段**）。
 * 这样「调了又调回来」的片段与从未调过的片段在项目文件里完全同形，且导出草稿走同一分支。
 */
export function storeTransform(t: RtcTransform): RtcTransform | undefined {
	const n = normalizeTransform(t);
	return isDefaultTransform(n) ? undefined : n;
}

/* ── 剪映草稿 clip 映射 ─────────────────────────────────────────────────── */

/** 剪映 segment.clip 结构（pyJianYingDraft ClipSettings.export_json 逐键同形） */
export interface JyClip {
	alpha: number;
	flip: { horizontal: boolean; vertical: boolean };
	rotation: number;
	scale: { x: number; y: number };
	transform: { x: number; y: number };
}

/**
 * RtcTransform → 剪映 segment.clip。
 *
 * ⚠ 换算依据（已核 pyJianYingDraft 源码 `pyJianYingDraft/segment.py` 的 ClipSettings，**非臆测**）：
 *   - `transform_x`「水平位移, **单位为半个画布宽**」、`transform_y`「垂直位移, **单位为半个画布高**」
 *     → 半画幅为单位 = 我们的画幅比例 **×2**；
 *   - **y 轴方向相反**：该 docstring 注「剪映导入的字幕似乎取此值为 **-0.8**」——字幕在画面**下方**
 *     却取负值，即剪映的 transform_y **正向上**；我们内部 y 正向下（types/rtc.ts 明确约定）
 *     → 必须 **取负**：`clip.transform.y = -2 × t.y`。改这行前先回头看这段，符号弄反=导出后素材上下颠倒位置。
 *   - `rotation`「顺时针旋转的**角度**」与我们同向同单位 → 直传；`alpha` 0-1 → 直传；
 *     `scale{x,y}` 为倍率、剪映不做任何自动 fit（见文件头「缩放基准」）→ 直传；flip 直传。
 */
export function toJyClip(t: RtcTransform): JyClip {
	return {
		alpha: round(clampOpacity(t.opacity)),
		flip: { horizontal: !!t.flipH, vertical: !!t.flipV },
		rotation: round(normalizeRotation(t.rotation), 2),
		scale: { x: round(clampScale(t.scaleX)), y: round(clampScale(t.scaleY)) },
		transform: { x: round(clampPosRatio(t.x) * 2), y: round(-clampPosRatio(t.y) * 2) },
	};
}

/**
 * 剪映 segment.uniform_scale.on —— 对应剪映界面的「等比缩放」开关。
 * 依据：pyJianYingDraft VisualSegment 初始 `self.uniform_scale = True`，仅在给 scale_x/scale_y
 * **单独**打关键帧（即两轴需要各走各的）时置 False → 语义就是「两轴是否锁定同值」。
 * 故：scaleX === scaleY → true（锁定），两轴不同 → false（解锁，剪映才会分别采纳 x/y）。
 */
export function jyUniformScaleOn(t: RtcTransform): boolean {
	return clampScale(t.scaleX) === clampScale(t.scaleY);
}
