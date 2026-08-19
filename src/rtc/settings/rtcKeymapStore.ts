/**
 * rtcKeymapStore —— 快捷键**用户覆盖层**的持久化容器（localStorage `Qiji:rtcKeymap`）。
 *
 * 分工：键位定义/组合规范/生效表推导全部在 [timeline/rtcKeymap]（纯函数）；本 store 只管
 * 「覆盖层的存取 + 每次变更把生效表推给 keymap 模块」（setActiveKeymapOverrides——
 * keymap 不反向依赖本 store，防循环引用）。设置弹窗（RtcSettingsModal）是唯一 UI 消费方。
 *
 * 录制冲突语义（recordKey）：新组合已绑定在别的动作上 → **改绑到本动作并从原动作解除**
 * （返回 takenFrom 供界面红字提示）——不允许一个组合同时指向两个动作（解析层先定义者生效，
 * 留着双绑定等于让后者静默失效，比明说「已改绑」更糟）。
 */
import { create } from "zustand";
import {
	RTC_ACTION_DEFS,
	comboOwner,
	effectiveKeys,
	normalizeKeymapOverrides,
	setActiveKeymapOverrides,
	type RtcKeymapOverrides,
	type RtcShortcut,
} from "../timeline/rtcKeymap";

export const RTC_KEYMAP_KEY = "Qiji:rtcKeymap";

function loadOverrides(): RtcKeymapOverrides {
	try {
		if (typeof localStorage === "undefined") return {};
		const raw = localStorage.getItem(RTC_KEYMAP_KEY);
		return normalizeKeymapOverrides(raw ? JSON.parse(raw) : null);
	} catch {
		return {};
	}
}

function persist(o: RtcKeymapOverrides): void {
	try {
		if (Object.keys(o).length === 0) localStorage.removeItem(RTC_KEYMAP_KEY);
		else localStorage.setItem(RTC_KEYMAP_KEY, JSON.stringify(o));
	} catch {
		/* localStorage 异常不阻塞改键（本次会话仍生效，只是不持久） */
	}
}

/** 与默认键位一致的覆盖项直接摘除（覆盖层只存「真的改过」的动作，恢复默认=键消失） */
function pruneDefaults(o: RtcKeymapOverrides): RtcKeymapOverrides {
	const out: RtcKeymapOverrides = {};
	for (const def of RTC_ACTION_DEFS) {
		const keys = o[def.id];
		if (!keys) continue;
		const same = keys.length === def.defaultKeys.length && keys.every((k, i) => k === def.defaultKeys[i]);
		if (!same) out[def.id] = keys;
	}
	return out;
}

export interface RecordKeyResult {
	/** 该组合原来绑在哪个动作上（已自动解除）；null=无冲突 */
	takenFrom: RtcShortcut | null;
}

interface RtcKeymapState {
	overrides: RtcKeymapOverrides;
	/**
	 * 录入一个组合到动作：slot=null 追加为新绑定，slot=下标 替换该位置的旧绑定。
	 * 组合已在本动作上=去重 no-op；已在别的动作上=改绑（从原动作解除，返回 takenFrom）。
	 */
	recordKey: (id: RtcShortcut, combo: string, slot: number | null) => RecordKeyResult;
	/** 移除动作上的一个绑定 */
	removeKey: (id: RtcShortcut, combo: string) => void;
	/** 单个动作恢复默认键位 */
	resetAction: (id: RtcShortcut) => void;
	/** 全部恢复默认键位 */
	resetAll: () => void;
}

function apply(set: (part: { overrides: RtcKeymapOverrides }) => void, next: RtcKeymapOverrides): void {
	const pruned = pruneDefaults(next);
	set({ overrides: pruned });
	persist(pruned);
	setActiveKeymapOverrides(pruned);
}

export const useRtcKeymapStore = create<RtcKeymapState>((set, get) => ({
	overrides: loadOverrides(),

	recordKey: (id, combo, slot) => {
		const overrides = get().overrides;
		const eff = effectiveKeys(overrides);
		const mine = [...(eff.get(id) ?? [])];
		// 已在本动作上：替换槽位时把旧绑定去掉即可；追加时直接 no-op
		const existedAt = mine.indexOf(combo);
		if (existedAt >= 0 && (slot == null || slot === existedAt)) return { takenFrom: null };
		// 冲突改绑：从原动作解除
		const owner = comboOwner(eff, combo, id);
		const next: RtcKeymapOverrides = { ...overrides };
		if (owner) next[owner] = (eff.get(owner) ?? []).filter((k) => k !== combo);
		if (existedAt >= 0) mine.splice(existedAt, 1);
		if (slot != null && slot >= 0 && slot < mine.length) mine[slot] = combo;
		else mine.push(combo);
		next[id] = [...new Set(mine)];
		apply(set, next);
		return { takenFrom: owner };
	},

	removeKey: (id, combo) => {
		const overrides = get().overrides;
		const eff = effectiveKeys(overrides);
		const mine = (eff.get(id) ?? []).filter((k) => k !== combo);
		apply(set, { ...overrides, [id]: mine });
	},

	resetAction: (id) => {
		const overrides = { ...get().overrides };
		delete overrides[id];
		apply(set, overrides);
	},

	resetAll: () => {
		apply(set, {});
	},
}));

/* 模块加载即把已存覆盖层推给 keymap 解析层（RtcToolbar → RtcSettingsModal → 本模块的
 * 静态 import 链保证编辑器一进来就生效，不必等设置弹窗打开过）。 */
setActiveKeymapOverrides(useRtcKeymapStore.getState().overrides);
