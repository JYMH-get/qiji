/**
 * rtcLayoutCore —— 实时剪辑面板布局的纯逻辑层（零依赖可单测）。
 *
 * 布局模型：
 *   - slotOrder：上排三个槽位（素材面板 asset / 结果展示 stage / 属性面板 props）的排列顺序，
 *     换位 = swapSlots 置换两个槽位（渲染层用 CSS order 落地，绝不重排 JSX——防子树重建打断播放）；
 *   - assetWidth / propsWidth：两个定宽面板的像素宽（stage 恒 flex-1 吃剩余）；
 *   - timelineHeight：底部时间轴容器像素高（钳位按视口高换算 20vh–60vh）。
 *
 * 持久化键 `Qiji:rtcLayout`（rtcLayoutStore）；normalizeLayout 负责读盘归一——坏值逐字段回默认。
 * 旧版 guideWidth/guideCollapsed（「AI 生成」子栏，右栏三页签重构后 UI 已取消）：normalizeLayout
 * 对旧 localStorage 里残留的这两个键**直接忽略**（未知键不入布局、不炸读盘），下次落盘自然消失。
 */

export type RtcSlotId = "asset" | "stage" | "props";

export const RTC_LAYOUT_KEY = "Qiji:rtcLayout";

export const DEFAULT_SLOT_ORDER: readonly RtcSlotId[] = ["asset", "stage", "props"];

/** 各尺寸的钳位与默认值（px；时间轴按视口高比例换算见 timelineBounds） */
export const ASSET_W = { min: 220, max: 520, def: 300 } as const;
/** 属性面板：三页签（属性/剧本/分镜）内容更多，上限放宽到 640 */
export const PROPS_W = { min: 260, max: 640, def: 360 } as const;
/** 时间轴高度：20vh–60vh，默认 35vh（与旧版写死的 h-[35vh] 观感一致） */
export const TIMELINE_VH = { min: 0.2, max: 0.6, def: 0.35 } as const;

export interface RtcLayout {
	slotOrder: RtcSlotId[];
	assetWidth: number;
	propsWidth: number;
	timelineHeight: number;
}

export function clamp(v: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, v));
}

/** 时间轴高度的像素钳位（按视口高换算 20vh–60vh；视口异常小也保证 min≤max） */
export function timelineBounds(viewportH: number): { min: number; max: number } {
	const h = Number.isFinite(viewportH) && viewportH > 0 ? viewportH : 800;
	const min = Math.round(h * TIMELINE_VH.min);
	const max = Math.max(min, Math.round(h * TIMELINE_VH.max));
	return { min, max };
}

export function defaultLayout(viewportH: number): RtcLayout {
	const h = Number.isFinite(viewportH) && viewportH > 0 ? viewportH : 800;
	const { min, max } = timelineBounds(h);
	return {
		slotOrder: [...DEFAULT_SLOT_ORDER],
		assetWidth: ASSET_W.def,
		propsWidth: PROPS_W.def,
		timelineHeight: clamp(Math.round(h * TIMELINE_VH.def), min, max),
	};
}

/** 置换两个槽位；任一 id 不在序列里或相同 = no-op（返回原引用，调用方可据此跳过落盘） */
export function swapSlots(order: readonly RtcSlotId[], a: RtcSlotId, b: RtcSlotId): readonly RtcSlotId[] {
	const ia = order.indexOf(a);
	const ib = order.indexOf(b);
	if (ia < 0 || ib < 0 || ia === ib) return order;
	const next = [...order];
	next[ia] = b;
	next[ib] = a;
	return next;
}

/** slotOrder 合法 = 恰好是三个槽位的一个排列 */
export function isValidSlotOrder(v: unknown): v is RtcSlotId[] {
	return (
		Array.isArray(v) &&
		v.length === DEFAULT_SLOT_ORDER.length &&
		DEFAULT_SLOT_ORDER.every((id) => v.includes(id))
	);
}

function numOr(v: unknown, min: number, max: number, def: number): number {
	return typeof v === "number" && Number.isFinite(v) ? clamp(Math.round(v), min, max) : def;
}

/** 读盘归一：坏形状整体回默认，坏字段逐个回默认，越界值钳回范围内；
 *  未知键（含旧版 guideWidth/guideCollapsed）一律忽略——旧 localStorage 读盘不炸。 */
export function normalizeLayout(raw: unknown, viewportH: number): RtcLayout {
	const def = defaultLayout(viewportH);
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return def;
	const r = raw as Record<string, unknown>;
	const tl = timelineBounds(viewportH);
	return {
		slotOrder: isValidSlotOrder(r.slotOrder) ? [...r.slotOrder] : def.slotOrder,
		assetWidth: numOr(r.assetWidth, ASSET_W.min, ASSET_W.max, def.assetWidth),
		propsWidth: numOr(r.propsWidth, PROPS_W.min, PROPS_W.max, def.propsWidth),
		timelineHeight: numOr(r.timelineHeight, tl.min, tl.max, def.timelineHeight),
	};
}
