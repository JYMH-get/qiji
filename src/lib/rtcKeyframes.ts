/**
 * rtcKeyframes.ts —— 实时剪辑关键帧纯函数层（第二批核心；零 DOM / 零 store，全部可单测）。
 *
 * 数据模型见 types/rtc.ts：`RtcSegment.keyframes?: Partial<Record<RtcKfProp, RtcKeyframe[]>>`，
 * t=相对片段 target 起点的微秒（片段移动时跟随；裁剪时 t 不变、越界渲染时钳制端值）。
 *
 * 语义定稿（勿回退）：
 *   - **有某属性关键帧 → 该属性由关键帧覆盖**基础 transform/volume（无关键帧的片段一切走原路径，
 *     `effectiveTransformAt` 对无关键帧片段返回 `segTransform(seg)` 的**同一引用**——零变化零回归）；
 *   - `scale` 是等比单值，取 **scaleX 基准**：覆盖 scaleX，scaleY 按基础 transform 的 Y/X 比跟随
 *     （基础等比时即纯等比缩放）；
 *   - 值域与 lib/rtcTransformCore 同一把尺（clampScale/clampPosRatio/clampOpacity），**不另立**；
 *   - 线性插值，首尾之外取端值；
 *   - doc 级操作全部不可变，未命中/no-op 返回**原 doc 引用**（rtcStore.commit 视为 no-op）。
 *
 * 剪映导出（toJyCommonKeyframes）：segment JSON 的 `common_keyframes` 按 pyJianYingDraft 5.9 形态
 * 生成——property_type/字段名/单位换算的核实依据见函数注释（已核 pyJianYingDraft keyframe.py 与
 * segment.py，非臆测）。
 */
import type { RtcDoc, RtcKeyframe, RtcKfProp, RtcSegment, RtcTransform } from "@/types/rtc";
import { segTransform } from "@/types/rtc";
import { clampOpacity, clampPosRatio, clampScale, storeTransform } from "./rtcTransformCore";

/** 全部可打关键帧的属性（顺序=导出/遍历序） */
export const RTC_KF_PROPS: RtcKfProp[] = ["x", "y", "scale", "rotation", "opacity", "volume"];

/** 「同一时刻」判定容差（微秒）：菱形按钮 toggle / 面板改值写帧 按此就近命中已有帧（≈半帧多一点） */
export const KF_TOLERANCE_US = 20_000;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** 按属性夹取关键帧值（与 rtcTransformCore 同一把尺；rotation 不回卷——保留插值方向） */
export function clampKfValue(prop: RtcKfProp, v: number): number {
	if (!Number.isFinite(v)) return prop === "scale" ? 1 : prop === "opacity" || prop === "volume" ? 1 : 0;
	switch (prop) {
		case "x":
		case "y":
			return clampPosRatio(v);
		case "scale":
			return clampScale(v);
		case "rotation":
			// ⚠ 刻意不 normalizeRotation：355°→365° 应短路顺转 10°，回卷成 5° 会让插值倒着转一圈
			return Math.round(v * 100) / 100;
		case "opacity":
			return clampOpacity(v);
		case "volume":
			return Math.round(clamp01(v) * 10000) / 10000;
	}
}

/** 单属性帧列表清洗：滤非有限值、t 取整钳非负、值夹取、按 t 升序、同 t 去重（后者胜） */
export function sanitizeKeyframes(prop: RtcKfProp, raw: unknown): RtcKeyframe[] {
	if (!Array.isArray(raw)) return [];
	const byT = new Map<number, number>();
	for (const k of raw as Array<Record<string, unknown>>) {
		if (!k || typeof k !== "object") continue;
		const t = Number(k.t);
		const v = Number(k.v);
		if (!Number.isFinite(t) || !Number.isFinite(v)) continue;
		byT.set(Math.max(0, Math.round(t)), clampKfValue(prop, v));
	}
	return [...byT.entries()].sort((a, b) => a[0] - b[0]).map(([t, v]) => ({ t, v }));
}

/** 整组清洗（防御式载入用）：未知属性丢弃、空组丢字段；全空返回 undefined */
export function sanitizeSegKeyframes(
	raw: unknown,
): Partial<Record<RtcKfProp, RtcKeyframe[]>> | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const out: Partial<Record<RtcKfProp, RtcKeyframe[]>> = {};
	let any = false;
	for (const prop of RTC_KF_PROPS) {
		const list = sanitizeKeyframes(prop, (raw as Record<string, unknown>)[prop]);
		if (list.length > 0) {
			out[prop] = list;
			any = true;
		}
	}
	return any ? out : undefined;
}

/** 片段是否带任何关键帧（渲染侧「走原路径 or 走关键帧路径」的分岔判据） */
export function hasSegKeyframes(seg: Pick<RtcSegment, "keyframes">): boolean {
	const kf = seg.keyframes;
	if (!kf) return false;
	for (const prop of RTC_KF_PROPS) {
		const list = kf[prop];
		if (Array.isArray(list) && list.length > 0) return true;
	}
	return false;
}

/**
 * 采样：tUs 处的线性插值值；首帧之前/末帧之后取端值。
 * ⚠ 容忍未排序/脏数据（逐条扫描取「≤t 最近」与「≥t 最近」的一对，零分配）——载入数据未必清洗过。
 * 空列表返回 null（调用方回退基础值）。
 */
export function sampleKeyframes(kfs: RtcKeyframe[] | undefined, tUs: number): number | null {
	if (!kfs || kfs.length === 0) return null;
	let lo: RtcKeyframe | null = null;
	let hi: RtcKeyframe | null = null;
	for (const k of kfs) {
		if (!k || !Number.isFinite(k.t) || !Number.isFinite(k.v)) continue;
		if (k.t <= tUs) {
			if (!lo || k.t > lo.t) lo = k;
		}
		if (k.t >= tUs) {
			if (!hi || k.t < hi.t) hi = k;
		}
	}
	if (!lo && !hi) return null;
	if (!lo) return (hi as RtcKeyframe).v;
	if (!hi || hi.t === lo.t) return lo.v;
	const r = (tUs - lo.t) / (hi.t - lo.t);
	return lo.v + (hi.v - lo.v) * r;
}

/** kfs 中距 tUs ≤ tolUs 的最近帧（菱形按钮实心/空心与 toggle 命中判定）；无命中 null */
export function keyframeNear(
	kfs: RtcKeyframe[] | undefined,
	tUs: number,
	tolUs = KF_TOLERANCE_US,
): RtcKeyframe | null {
	if (!kfs) return null;
	let best: RtcKeyframe | null = null;
	let bestDist = Infinity;
	for (const k of kfs) {
		if (!k || !Number.isFinite(k.t)) continue;
		const d = Math.abs(k.t - tUs);
		if (d < bestDist) { bestDist = d; best = k; }
	}
	return best && bestDist <= tolUs ? best : null;
}

/** 片段全部属性的关键帧时刻并集（升序去重；时间轴片段上画小菱形用） */
export function allKeyframeTimes(seg: Pick<RtcSegment, "keyframes">): number[] {
	const kf = seg.keyframes;
	if (!kf) return [];
	const out = new Set<number>();
	for (const prop of RTC_KF_PROPS) {
		const list = kf[prop];
		if (!Array.isArray(list)) continue;
		for (const k of list) {
			if (k && Number.isFinite(k.t) && k.t >= 0) out.add(Math.round(k.t));
		}
	}
	return [...out].sort((a, b) => a - b);
}

/* ────────────────────────── 生效值解算（渲染唯一入口） ────────────────────────── */

/**
 * relUs 时刻的生效画面变换：基础 transform + 关键帧覆盖。
 * ⚠ 无关键帧 → 返回 `segTransform(seg)` **原样结果**（引用零变化，走原渲染路径零回归）。
 * scale 覆盖规则见文件头（scaleX 基准、scaleY 按基础 Y/X 比跟随）。
 */
export function effectiveTransformAt(
	seg: Pick<RtcSegment, "transform" | "keyframes">,
	relUs: number,
): RtcTransform {
	const base = segTransform(seg);
	const kf = seg.keyframes;
	if (!kf) return base;
	let out: RtcTransform | null = null;
	const ensure = () => (out ??= { ...base });
	const x = sampleKeyframes(kf.x, relUs);
	if (x != null) ensure().x = clampPosRatio(x);
	const y = sampleKeyframes(kf.y, relUs);
	if (y != null) ensure().y = clampPosRatio(y);
	const sc = sampleKeyframes(kf.scale, relUs);
	if (sc != null) {
		const v = clampScale(sc);
		const ratio = base.scaleX !== 0 ? base.scaleY / base.scaleX : 1;
		const o = ensure();
		o.scaleX = v;
		o.scaleY = clampScale(v * ratio);
	}
	const rot = sampleKeyframes(kf.rotation, relUs);
	if (rot != null) ensure().rotation = rot;
	const op = sampleKeyframes(kf.opacity, relUs);
	if (op != null) ensure().opacity = clampOpacity(op);
	return out ?? base;
}

/** relUs 时刻的生效音量（0..1）：volume 关键帧覆盖；无帧=片段基础音量（缺省 1） */
export function effectiveVolumeAt(
	seg: Pick<RtcSegment, "volume" | "keyframes">,
	relUs: number,
): number {
	const v = sampleKeyframes(seg.keyframes?.volume, relUs);
	if (v != null) return clamp01(v);
	const base = seg.volume;
	return base == null || !Number.isFinite(base) ? 1 : clamp01(base);
}

/* ────────────────────────── doc 级不可变操作 ────────────────────────── */

/** 片段级不可变替换（未命中=原 doc 引用）；内部工具，别处勿复制粘贴一份 */
function withSegment(doc: RtcDoc, segId: string, up: (seg: RtcSegment) => RtcSegment): RtcDoc {
	let changed = false;
	const tracks = doc.tracks.map((t) => {
		const idx = t.segments.findIndex((s) => s.id === segId);
		if (idx < 0) return t;
		const next = up(t.segments[idx]);
		if (next === t.segments[idx]) return t;
		changed = true;
		const segments = [...t.segments];
		segments[idx] = next;
		return { ...t, segments };
	});
	return changed ? { ...doc, tracks } : doc;
}

/** 写回某属性帧列表（空列表=删字段；整组空=删 keyframes 字段——「删光了」与「从未打过」同形） */
function withPropList(seg: RtcSegment, prop: RtcKfProp, list: RtcKeyframe[]): RtcSegment {
	const cur = { ...(seg.keyframes ?? {}) } as Partial<Record<RtcKfProp, RtcKeyframe[]>>;
	if (list.length > 0) cur[prop] = list;
	else delete cur[prop];
	const any = RTC_KF_PROPS.some((p) => (cur[p]?.length ?? 0) > 0);
	const next: RtcSegment = { ...seg };
	if (any) next.keyframes = cur;
	else delete next.keyframes;
	return next;
}

/** 片段内相对时刻：playheadAbsUs 相对 target 起点，钳到 [0, targetDurationUs] */
export function segRelUs(
	seg: Pick<RtcSegment, "targetStartUs" | "targetDurationUs">,
	playheadAbsUs: number,
): number {
	return Math.min(Math.max(0, Math.round(playheadAbsUs - seg.targetStartUs)), Math.max(0, seg.targetDurationUs));
}

/** 添加/覆盖一帧（tUs 处 tolUs 内已有帧则改它的值——「同刻不重复」）；未命中片段=原 doc */
export function addKeyframe(
	doc: RtcDoc,
	segId: string,
	prop: RtcKfProp,
	tUs: number,
	v: number,
	tolUs = KF_TOLERANCE_US,
): RtcDoc {
	if (!Number.isFinite(tUs) || tUs < 0) return doc;
	return withSegment(doc, segId, (seg) => {
		const list = sanitizeKeyframes(prop, seg.keyframes?.[prop]);
		const hit = keyframeNear(list, tUs, tolUs);
		const val = clampKfValue(prop, v);
		let next: RtcKeyframe[];
		if (hit) {
			if (hit.v === val) return seg; // 值未变 → no-op
			next = list.map((k) => (k === hit ? { t: k.t, v: val } : k));
		} else {
			next = [...list, { t: Math.round(tUs), v: val }].sort((a, b) => a.t - b.t);
		}
		return withPropList(seg, prop, next);
	});
}

/** 删除 tUs 处（tolUs 内最近）的帧；未命中=原 doc */
export function removeKeyframe(
	doc: RtcDoc,
	segId: string,
	prop: RtcKfProp,
	tUs: number,
	tolUs = KF_TOLERANCE_US,
): RtcDoc {
	return withSegment(doc, segId, (seg) => {
		const list = sanitizeKeyframes(prop, seg.keyframes?.[prop]);
		const hit = keyframeNear(list, tUs, tolUs);
		if (!hit) return seg;
		return withPropList(seg, prop, list.filter((k) => k !== hit));
	});
}

/** 移动一帧（fromTUs 处 tolUs 内最近的帧 → toTUs；目标处已有帧则被顶掉）；未命中=原 doc */
export function moveKeyframe(
	doc: RtcDoc,
	segId: string,
	prop: RtcKfProp,
	fromTUs: number,
	toTUs: number,
	tolUs = KF_TOLERANCE_US,
): RtcDoc {
	if (!Number.isFinite(toTUs) || toTUs < 0) return doc;
	return withSegment(doc, segId, (seg) => {
		const list = sanitizeKeyframes(prop, seg.keyframes?.[prop]);
		const hit = keyframeNear(list, fromTUs, tolUs);
		if (!hit) return seg;
		const to = Math.round(toTUs);
		if (hit.t === to) return seg;
		const next = list
			.filter((k) => k !== hit && k.t !== to) // 目标位已有帧 → 顶掉
			.concat({ t: to, v: hit.v })
			.sort((a, b) => a.t - b.t);
		return withPropList(seg, prop, next);
	});
}

/**
 * 菱形按钮语义：tUs 处（容差内）有帧 → 删；无帧 → 以**当下生效值**加一帧（加帧瞬间画面零跳变）。
 * playheadAbsUs 为时间轴绝对微秒（内部换算相对时刻并钳到片段内）。
 */
export function toggleKeyframeAtPlayhead(
	doc: RtcDoc,
	segId: string,
	prop: RtcKfProp,
	playheadAbsUs: number,
): RtcDoc {
	return withSegmentDoc(doc, segId, (d, seg) => {
		const rel = segRelUs(seg, playheadAbsUs);
		if (keyframeNear(seg.keyframes?.[prop], rel)) return removeKeyframe(d, segId, prop, rel);
		const v =
			prop === "volume"
				? effectiveVolumeAt(seg, rel)
				: prop === "scale"
					? effectiveTransformAt(seg, rel).scaleX
					: effectiveTransformAt(seg, rel)[prop];
		return addKeyframe(d, segId, prop, rel, v);
	});
}

/**
 * 属性面板/预览拖动的**关键帧感知写入**：对 patch 里的每个字段——
 *   - 该属性**已有关键帧** → 在播放头时刻写帧（add/覆盖），基础值不动（「改值=写帧」语义）；
 *   - 无关键帧 → 并进基础 transform（经 storeTransform 规整，缺省形态写 undefined——与
 *     RtcTransformProps 原 write 路径逐字节一致，无关键帧片段零回归）。
 * scaleX+scaleY 同值（等比）且有 scale 帧 → 只写 scale 帧；flipH/flipV/scaleY(独立) 恒走基础值。
 * patch 里显式的 `undefined` 值（清 flip 等）同样并进基础 transform。
 */
export function applyTransformPatchAt(
	doc: RtcDoc,
	segId: string,
	patch: Partial<RtcTransform>,
	playheadAbsUs: number,
): RtcDoc {
	return withSegmentDoc(doc, segId, (d, seg) => {
		const base = segTransform(seg);
		const kf = seg.keyframes;
		const rel = segRelUs(seg, playheadAbsUs);
		const has = (p: RtcKfProp) => (kf?.[p]?.length ?? 0) > 0;
		let next = d;
		const basePatch: Partial<RtcTransform> = {};
		let baseTouched = false;
		for (const key of Object.keys(patch) as Array<keyof RtcTransform>) {
			const v = patch[key];
			if (key === "x" && typeof v === "number" && has("x")) { next = addKeyframe(next, segId, "x", rel, v); continue; }
			if (key === "y" && typeof v === "number" && has("y")) { next = addKeyframe(next, segId, "y", rel, v); continue; }
			if (key === "rotation" && typeof v === "number" && has("rotation")) { next = addKeyframe(next, segId, "rotation", rel, v); continue; }
			if (key === "opacity" && typeof v === "number" && has("opacity")) { next = addKeyframe(next, segId, "opacity", rel, v); continue; }
			if (key === "scaleX" && typeof v === "number" && has("scale")) { next = addKeyframe(next, segId, "scale", rel, v); continue; }
			if (key === "scaleY" && typeof v === "number" && has("scale") && patch.scaleX === v) continue; // 等比：scale 帧已覆盖
			(basePatch as Record<string, unknown>)[key] = v;
			baseTouched = true;
		}
		if (baseTouched) {
			const stored = storeTransform({ ...base, ...basePatch });
			next = withSegment(next, segId, (s) => {
				const cur = s.transform;
				if (cur === stored) return s;
				const patched: RtcSegment = { ...s };
				if (stored) patched.transform = stored;
				else delete patched.transform;
				return patched;
			});
		}
		return next;
	});
}

/** 整份变换的关键帧感知落笔（预览拖动 pointerup 用）：等价于把全部字段作为 patch 写入 */
export function applyTransformAt(
	doc: RtcDoc,
	segId: string,
	t: RtcTransform,
	playheadAbsUs: number,
): RtcDoc {
	// flip 未设时显式带 undefined —— 与面板「清除镜像」同语义（storeTransform 会归一）
	const patch: Partial<RtcTransform> = {
		scaleX: t.scaleX,
		scaleY: t.scaleY,
		x: t.x,
		y: t.y,
		rotation: t.rotation,
		opacity: t.opacity,
		flipH: t.flipH,
		flipV: t.flipV,
	};
	return applyTransformPatchAt(doc, segId, patch, playheadAbsUs);
}

/** 定位片段后交回调处理（找不到=原 doc 引用）；内部工具 */
function withSegmentDoc(
	doc: RtcDoc,
	segId: string,
	fn: (doc: RtcDoc, seg: RtcSegment) => RtcDoc,
): RtcDoc {
	for (const t of doc.tracks) {
		const seg = t.segments.find((s) => s.id === segId);
		if (seg) return fn(doc, seg);
	}
	return doc;
}

/* ────────────────────────── 分割辅助（供 rtcOps.insertFreezeFrame 用） ────────────────────────── */

/**
 * 把整组关键帧按 offsetUs 切成 [左, 右]（右侧 t 平移 -offset）：
 *   - 左收 t ≤ offset、右收 t ≥ offset（恰在切点的帧两边各留一份——两半边界值都正确）；
 *   - 有帧跨越切点（两侧都有）时，切点处补**采样边界帧**（左末/右首），分割前后动画逐帧不变；
 *   - ⚠ 某一半分不到任何帧时补**常量边界帧**（该半在原动画里的采样值）——只要该属性原本有
 *     关键帧覆盖，两半都必须保住覆盖语义，否则那一半会跳回基础 transform 值（画面跳变）；
 *   - 整组无帧 → 双 undefined（不落字段）。
 */
export function splitKeyframes(
	rec: Partial<Record<RtcKfProp, RtcKeyframe[]>> | undefined,
	offsetUs: number,
): [Partial<Record<RtcKfProp, RtcKeyframe[]>> | undefined, Partial<Record<RtcKfProp, RtcKeyframe[]>> | undefined] {
	if (!rec) return [undefined, undefined];
	const left: Partial<Record<RtcKfProp, RtcKeyframe[]>> = {};
	const right: Partial<Record<RtcKfProp, RtcKeyframe[]>> = {};
	let anyL = false;
	let anyR = false;
	for (const prop of RTC_KF_PROPS) {
		const list = sanitizeKeyframes(prop, rec[prop]);
		if (list.length === 0) continue;
		const l = list.filter((k) => k.t <= offsetUs);
		const r = list.filter((k) => k.t >= offsetUs).map((k) => ({ t: k.t - offsetUs, v: k.v }));
		const crosses = list.some((k) => k.t < offsetUs) && list.some((k) => k.t > offsetUs);
		if (crosses) {
			const bv = sampleKeyframes(list, offsetUs);
			if (bv != null) {
				if (!l.some((k) => k.t === offsetUs)) l.push({ t: offsetUs, v: clampKfValue(prop, bv) });
				if (!r.some((k) => k.t === 0)) r.unshift({ t: 0, v: clampKfValue(prop, bv) });
			}
		}
		// 分不到帧的那一半补常量边界帧：左半取该区间的采样值（=首帧值）、右半取切点采样值（=末帧值）
		if (l.length === 0) {
			const v = sampleKeyframes(list, 0);
			if (v != null) l.push({ t: 0, v: clampKfValue(prop, v) });
		}
		if (r.length === 0) {
			const v = sampleKeyframes(list, offsetUs);
			if (v != null) r.push({ t: 0, v: clampKfValue(prop, v) });
		}
		if (l.length > 0) { left[prop] = l; anyL = true; }
		if (r.length > 0) { right[prop] = r; anyR = true; }
	}
	return [anyL ? left : undefined, anyR ? right : undefined];
}

/* ────────────────────────── 剪映草稿导出 ────────────────────────── */

/**
 * property_type 映射——⚠ 已核 pyJianYingDraft keyframe.py 的 Keyframe_property 枚举原文（非臆测）：
 *   x→KFTypePositionX / y→KFTypePositionY / rotation→KFTypeRotation / opacity→KFTypeAlpha /
 *   volume→KFTypeVolume；scale→**KFTypeScaleX**：pyJianYingDraft 对 uniform_scale 属性的关键帧
 *   就地转写为 scale_x（segment.py：`_property = Keyframe_property.scale_x`）且 **uniform_scale.on
 *   保持 True**——我们的 scale 帧正是等比单值，同法。
 */
const JY_KF_PROPERTY: Record<RtcKfProp, string> = {
	x: "KFTypePositionX",
	y: "KFTypePositionY",
	scale: "KFTypeScaleX",
	rotation: "KFTypeRotation",
	opacity: "KFTypeAlpha",
	volume: "KFTypeVolume",
};

/**
 * 值换算（与 rtcTransformCore.toJyClip **同一把尺**，改前先看那边注释）：
 *   - 位置：画幅比例 → 剪映「半画幅」基准 = **×2**，且 **y 取负**（剪映 transform_y 正向上，
 *     我们 y 正向下——符号弄反=导出后位移动画上下颠倒）；
 *   - scale/rotation/opacity/volume 直传（单位同义）。
 */
function jyKfValue(prop: RtcKfProp, v: number): number {
	const c = clampKfValue(prop, v);
	if (prop === "x") return c * 2;
	if (prop === "y") return -c * 2;
	return c;
}

/**
 * 片段 → 剪映 segment JSON 的 `common_keyframes` 数组（pyJianYingDraft Keyframe_list.export_json 同形：
 * `{id, keyframe_list:[{curveType:"Line", graphID:"", left_control, right_control, id, time_offset, values:[v]}],
 *  material_id:"", property_type}`；time_offset=相对片段的微秒）。
 *
 * 规则：
 *   - 音频片段只导 volume（无画面）；视觉片段六属性全导；
 *   - **越界帧钳制**：t<0 / t>targetDuration 的帧不原样导出（剪映对越界 offset 行为未知），
 *     改为在 0 / duration 处补**采样边界帧**——与我们渲染端「越界钳制端值」逐帧一致；
 *   - 无关键帧 → 返回 []（与既有导出逐字节一致，存量草稿零变化）。
 * uuid 由调用方注入（jianyingDraft 传 jyUuidHex；测试传计数器），避免 lib 互相 import 成环。
 */
export function toJyCommonKeyframes(
	seg: Pick<RtcSegment, "keyframes" | "targetDurationUs">,
	kind: "video" | "photo" | "audio",
	uuid: () => string,
): Record<string, unknown>[] {
	const rec = seg.keyframes;
	if (!rec) return [];
	const dur = Math.max(0, Math.round(seg.targetDurationUs || 0));
	const props = kind === "audio" ? (["volume"] as RtcKfProp[]) : RTC_KF_PROPS;
	const out: Record<string, unknown>[] = [];
	for (const prop of props) {
		const list = sanitizeKeyframes(prop, rec[prop]);
		if (list.length === 0) continue;
		const inRange = list.filter((k) => k.t >= 0 && k.t <= dur);
		const clamped: RtcKeyframe[] = [...inRange];
		if (list.some((k) => k.t < 0) && !inRange.some((k) => k.t === 0)) {
			const v = sampleKeyframes(list, 0);
			if (v != null) clamped.unshift({ t: 0, v });
		}
		if (list.some((k) => k.t > dur) && !inRange.some((k) => k.t === dur)) {
			const v = sampleKeyframes(list, dur);
			if (v != null) clamped.push({ t: dur, v });
		}
		if (clamped.length === 0) continue;
		out.push({
			id: uuid(),
			keyframe_list: clamped.map((k) => ({
				curveType: "Line",
				graphID: "",
				left_control: { x: 0.0, y: 0.0 },
				right_control: { x: 0.0, y: 0.0 },
				id: uuid(),
				time_offset: Math.round(k.t),
				values: [jyKfValue(prop, k.v)],
			})),
			material_id: "",
			property_type: JY_KF_PROPERTY[prop],
		});
	}
	return out;
}
