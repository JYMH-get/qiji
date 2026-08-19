/**
 * rtcCropCore —— 实时剪辑「画面裁剪」纯函数层（零 DOM / 零 store / 零 React，可单测）。
 *
 * 服务三个消费方：
 *   ① 裁剪编辑器 `src/rtc/panel/RtcCropEditor.tsx`（四边/四角拖动 + 比例预设）；
 *   ② 预览渲染 `src/rtc/RtcSequencePlayer.tsx`（图层元素的 clip-path: inset(...) 换算）；
 *   ③ 剪映草稿导出 `src/lib/jianyingDraft.ts`（material.crop 的 8 个归一化角坐标）。
 *
 * ── 数据语义（与 types/rtc.RtcCrop 一致，勿另立口径）─────────────────────────
 *   crop = **保留区域的四边内缩比例**，基准=素材画面自身（不是画幅、不是图层元素）：
 *   left/right 为画面宽的比例、top/bottom 为画面高的比例；全 0 = 不裁。
 *   落库策略与 transform 同款（rtcTransformCore.storeTransform）：**等于缺省（全 0）→ 删字段**，
 *   「裁了又拉回去」的片段与从未裁过的片段在项目文件里完全同形。
 *
 * ── 剪映映射（已核 pyJianYingDraft local_materials.py 的 CropSettings，非臆测）──
 *   crop 挂在 **material** 上，8 个角坐标为素材画面的归一化 [0,1]：
 *   upper_left=(l,t)、upper_right=(1-r,t)、lower_left=(l,1-b)、lower_right=(1-r,1-b)，
 *   另有 crop_ratio:"free" 与 crop_scale:1.0（pyJianYingDraft 恒写此二值）。
 *   ⚠ 因 crop 在素材上而我方「素材按 assetId 去重单条」——导出时**带 crop 的片段单独克隆
 *   一条 material**（同 path 不同 material id，素材文件仍只复制一份），见 jianyingDraft。
 */
import type { RtcCrop, RtcDoc, RtcSegment } from "@/types/rtc";

/** 缺省裁剪（不裁） */
export const DEFAULT_RTC_CROP: RtcCrop = { left: 0, top: 0, right: 0, bottom: 0 };

/** 画面至少保留的比例（每个方向）：防裁到 0 宽/0 高再也拖不回来 */
export const CROP_MIN_KEEP = 0.1;

const clamp01 = (v: unknown): number => {
	const n = Number(v);
	if (!Number.isFinite(n)) return 0;
	return Math.min(1, Math.max(0, n));
};

/** 定点 4 位（够亚像素精度，不留浮点噪声进项目文件） */
const round4 = (n: number) => {
	const r = Math.round(n * 10_000) / 10_000;
	return r === 0 ? 0 : r;
};

/**
 * 收敛：逐边夹 [0,1] + 保证每个方向至少留 CROP_MIN_KEEP 的画面
 * （两边之和超限时**按比例同缩**两边，保持裁剪中心不跳）。
 */
export function normalizeCrop(c: RtcCrop): RtcCrop {
	let left = clamp01(c.left);
	let right = clamp01(c.right);
	let top = clamp01(c.top);
	let bottom = clamp01(c.bottom);
	const maxSum = 1 - CROP_MIN_KEEP;
	if (left + right > maxSum) {
		const k = maxSum / (left + right);
		left *= k;
		right *= k;
	}
	if (top + bottom > maxSum) {
		const k = maxSum / (top + bottom);
		top *= k;
		bottom *= k;
	}
	return { left: round4(left), top: round4(top), right: round4(right), bottom: round4(bottom) };
}

/** 是否等于缺省（全 0，即不裁） */
export function isEmptyCrop(c: RtcCrop): boolean {
	return c.left === 0 && c.top === 0 && c.right === 0 && c.bottom === 0;
}

/**
 * 落库形态：收敛后全 0 → 返回 undefined（**不写 crop 字段**）。
 * 与 rtcTransformCore.storeTransform 同策略——「裁了又复位」与「从未裁过」在文件里同形。
 */
export function storeCrop(c: RtcCrop): RtcCrop | undefined {
	const n = normalizeCrop(c);
	return isEmptyCrop(n) ? undefined : n;
}

/** 读片段裁剪（缺省/坏形状回退 null=不裁）——所有消费方走这里，别各自写回退 */
export function cropOf(seg: Pick<RtcSegment, "crop">): RtcCrop | null {
	const c = seg.crop;
	if (!c || typeof c !== "object") return null;
	const n = normalizeCrop(c);
	return isEmptyCrop(n) ? null : n;
}

/**
 * 片段裁剪写入（不可变；undefined=清除字段）。值未变/片段不存在 → 返回原 doc 引用
 * （rtcStore.commit 视为 no-op，不进撤销栈不落盘）。
 */
export function withSegmentCrop(doc: RtcDoc, segId: string, crop: RtcCrop | undefined): RtcDoc {
	const stored = crop ? storeCrop(crop) : undefined;
	let hit = false;
	const tracks = doc.tracks.map((track) => {
		if (!track.segments.some((s) => s.id === segId)) return track;
		const segments = track.segments.map((s) => {
			if (s.id !== segId) return s;
			if (stored === undefined) {
				if (s.crop === undefined) return s; // 本就没有：保持引用
				hit = true;
				const { crop: _drop, ...rest } = s;
				return rest;
			}
			if (s.crop && sameCrop(s.crop, stored)) return s; // 值未变：保持引用
			hit = true;
			return { ...s, crop: stored };
		});
		return segments.some((s, i) => s !== track.segments[i]) ? { ...track, segments } : track;
	});
	return hit ? { ...doc, tracks } : doc;
}

export function sameCrop(a: RtcCrop, b: RtcCrop): boolean {
	const eps = 1e-6;
	return (
		Math.abs(a.left - b.left) < eps &&
		Math.abs(a.top - b.top) < eps &&
		Math.abs(a.right - b.right) < eps &&
		Math.abs(a.bottom - b.bottom) < eps
	);
}

/* ── 预览渲染：crop → clip-path ────────────────────────────────────────────── */

/**
 * crop → `clip-path: inset(t% r% b% l%)`（百分比基准=**图层元素**=画幅框）。
 *
 * ⚠ 换算要点：crop 的基准是**素材画面**，而图层元素是整个画幅框、画面在其中 contain 适配
 * （占画幅的比例=containFrac，见 rtc/rtcTransform.ts）——须把「画面比例」折算成「画幅比例」：
 *   inset_top = (1 − fh)/2 + top × fh   （(1−fh)/2 是 contain 留黑的半边，下同）
 * clip-path 作用在元素**未变换**的边框盒上，transform（缩放/旋转/位移）随后把裁剪结果与画面
 * 一起搬走——所以这里不需要（也绝不要）把 scale 掺进来。
 * frac 未知（素材尺寸没探测到）按整幅近似（fw=fh=1，即 inset 直接等于 crop）。
 * 不裁（null/全 0）返回 null → 调用方不写 clipPath 属性（零回归）。
 */
export function cropClipPathCss(crop: RtcCrop | null, frac: { w: number; h: number }): string | null {
	if (!crop || isEmptyCrop(crop)) return null;
	const fw = frac.w > 0 && frac.w <= 1 ? frac.w : 1;
	const fh = frac.h > 0 && frac.h <= 1 ? frac.h : 1;
	const padX = (1 - fw) / 2;
	const padY = (1 - fh) / 2;
	const pct = (v: number) => `${Math.round(v * 10_000) / 100}%`;
	const top = padY + crop.top * fh;
	const right = padX + crop.right * fw;
	const bottom = padY + crop.bottom * fh;
	const left = padX + crop.left * fw;
	return `inset(${pct(top)} ${pct(right)} ${pct(bottom)} ${pct(left)})`;
}

/* ── 剪映导出：crop → material.crop 的 8 角坐标 ───────────────────────────── */

/** 剪映 material.crop 结构（pyJianYingDraft CropSettings.export_json 逐键同形） */
export interface JyCropJson {
	upper_left_x: number;
	upper_left_y: number;
	upper_right_x: number;
	upper_right_y: number;
	lower_left_x: number;
	lower_left_y: number;
	lower_right_x: number;
	lower_right_y: number;
}

/** crop → 剪映 8 角归一化坐标（不裁返回 null——调用方走去重单条 material 的常规路径） */
export function toJyCrop(crop: RtcCrop | null | undefined): JyCropJson | null {
	if (!crop) return null;
	const n = normalizeCrop(crop);
	if (isEmptyCrop(n)) return null;
	return {
		upper_left_x: n.left,
		upper_left_y: n.top,
		upper_right_x: round4(1 - n.right),
		upper_right_y: n.top,
		lower_left_x: n.left,
		lower_left_y: round4(1 - n.bottom),
		lower_right_x: round4(1 - n.right),
		lower_right_y: round4(1 - n.bottom),
	};
}

/* ── 编辑器辅助：比例预设 ─────────────────────────────────────────────────── */

/**
 * 把当前裁剪区域调整为指定宽高比（targetRatio=保留区域的**像素**宽高比，如 16/9），
 * 以当前区域中心为锚、在画面内取能容纳的最大区域。
 * naturalRatio=素材像素宽高比（w/h）；两比值任一非法 → 原样返回。
 */
export function fitCropToRatio(crop: RtcCrop, naturalRatio: number, targetRatio: number): RtcCrop {
	if (!(naturalRatio > 0) || !(targetRatio > 0)) return crop;
	const n = normalizeCrop(crop);
	// 归一化坐标下的目标宽高关系：w_px/h_px = (w_n × naturalW)/(h_n × naturalH) = targetRatio
	// → h_n = w_n × naturalRatio / targetRatio
	const k = naturalRatio / targetRatio;
	let w = 1 - n.left - n.right;
	let h = w * k;
	if (h > 1) {
		h = 1;
		w = h / k;
	}
	const cx = n.left + (1 - n.left - n.right) / 2;
	const cy = n.top + (1 - n.top - n.bottom) / 2;
	// 中心锚定后夹回画面内
	let left = cx - w / 2;
	let top = cy - h / 2;
	left = Math.min(Math.max(0, left), 1 - w);
	top = Math.min(Math.max(0, top), 1 - h);
	return normalizeCrop({ left, top, right: 1 - left - w, bottom: 1 - top - h });
}
