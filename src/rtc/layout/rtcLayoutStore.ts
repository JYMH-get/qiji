/**
 * rtcLayoutStore —— 实时剪辑面板布局状态（zustand + localStorage 手写持久化，惯例同 dockStore）。
 *
 * 持久化键 `Qiji:rtcLayout`：{ slotOrder, assetWidth, propsWidth, timelineHeight }
 * （旧版 guideWidth/guideCollapsed 键读盘时被 normalizeLayout 忽略，下次落盘自然消失）。
 * 读盘经 rtcLayoutCore.normalizeLayout 归一（坏值回默认）；写盘只发生在 setter 里——
 * ⚠ 性能红线：splitter 拖动过程走组件本地 state 预览，**pointerup 才调 setter**（绝不逐帧写 localStorage）。
 * 布局是应用级偏好，与 rtcDoc 无关、绝不进项目文件。
 */
import { create } from "zustand";
import {
	ASSET_W,
	PROPS_W,
	RTC_LAYOUT_KEY,
	type RtcLayout,
	type RtcSlotId,
	clamp,
	defaultLayout,
	normalizeLayout,
	swapSlots,
	timelineBounds,
} from "./rtcLayoutCore";

function viewportH(): number {
	return typeof window !== "undefined" ? window.innerHeight : 800;
}

function loadLayout(): RtcLayout {
	try {
		if (typeof localStorage === "undefined") return defaultLayout(viewportH());
		const raw = localStorage.getItem(RTC_LAYOUT_KEY);
		return normalizeLayout(raw ? JSON.parse(raw) : null, viewportH());
	} catch {
		return defaultLayout(viewportH());
	}
}

function persist(l: RtcLayout): void {
	try {
		localStorage.setItem(
			RTC_LAYOUT_KEY,
			JSON.stringify({
				slotOrder: l.slotOrder,
				assetWidth: l.assetWidth,
				propsWidth: l.propsWidth,
				timelineHeight: l.timelineHeight,
			}),
		);
	} catch {
		/* localStorage 异常（隐私模式/配额）不阻塞布局本身 */
	}
}

interface RtcLayoutState extends RtcLayout {
	setAssetWidth: (px: number) => void;
	setPropsWidth: (px: number) => void;
	setTimelineHeight: (px: number) => void;
	/** 面板换位：置换两个槽位（拖标题栏到另一面板松手时调用）；no-op 不落盘 */
	swapPanels: (a: RtcSlotId, b: RtcSlotId) => void;
	/** 恢复默认布局（槽位/尺寸/子栏收起态全部回默认并落盘） */
	resetLayout: () => void;
}

function pickLayout(s: RtcLayoutState): RtcLayout {
	return {
		slotOrder: s.slotOrder,
		assetWidth: s.assetWidth,
		propsWidth: s.propsWidth,
		timelineHeight: s.timelineHeight,
	};
}

export const useRtcLayoutStore = create<RtcLayoutState>((set, get) => ({
	...loadLayout(),

	setAssetWidth: (px) => {
		set({ assetWidth: clamp(Math.round(px), ASSET_W.min, ASSET_W.max) });
		persist(pickLayout(get()));
	},
	setPropsWidth: (px) => {
		set({ propsWidth: clamp(Math.round(px), PROPS_W.min, PROPS_W.max) });
		persist(pickLayout(get()));
	},
	setTimelineHeight: (px) => {
		const { min, max } = timelineBounds(viewportH());
		set({ timelineHeight: clamp(Math.round(px), min, max) });
		persist(pickLayout(get()));
	},
	swapPanels: (a, b) => {
		const cur = get().slotOrder;
		const next = swapSlots(cur, a, b);
		if (next === cur) return;
		set({ slotOrder: [...next] });
		persist(pickLayout(get()));
	},
	resetLayout: () => {
		const def = defaultLayout(viewportH());
		set({ ...def });
		persist(def);
	},
}));
