/**
 * rtcAttrClipboard —— 片段**属性剪贴板**（Ctrl+Shift+C / Ctrl+Shift+V，会话级：不落盘、
 * 不跨窗口、不接系统剪贴板；结构同构 [rtcClipboard]，含切项目清空）。
 *
 * 存的是**属性快照**（不是片段）：画面变换 transform（含不透明度/镜像）+ 音量 + 变速 + 静音。
 * 粘贴 = 把快照应用到当前选中的全部片段（一次 commit = 一条 undo）。
 *
 * 语义（定稿）：
 *   - 快照取**规范化后的完整值**（缺省也记录）——粘贴是「把目标改成和源一样」，源没调过的
 *     属性会把目标**重置回默认**（与剪映「应用全部属性」一致，比「只贴改过的」可预期）；
 *   - transform 落库经 storeTransform（等于缺省=删字段，与属性面板/预览拖动同一把尺）；
 *   - **音频片段跳过 transform**（画面变换对声音无意义，贴上去是脏数据）；volume/speed/muted 照贴；
 *   - speed 语义与属性面板 SpeedInput 完全一致：纯 patch `speed` 字段（夹 0.1–5），
 *     不动 target/source 窗口——与面板改变速同一行为，别在这里另起换算；
 *   - 值全部未变的片段保持原引用（commit 天然 no-op，不进撤销栈不落盘）。
 */
import { create } from "zustand";
import { useProjectStore } from "@/store/projectStore";
import { segTransform, type RtcDoc, type RtcSegment, type RtcTransform } from "@/types/rtc";
import { normalizeTransform, storeTransform } from "@/lib/rtcTransformCore";

/** 属性快照（规范化完整值；transform 恒为规范化后的完整对象，便于比较与应用） */
export interface RtcSegAttrs {
	transform: RtcTransform;
	/** 变速倍率（0.1–5，默认 1） */
	speed: number;
	/** 音量（0–2，默认 1） */
	volume: number;
	muted: boolean;
}

const clamp = (v: number, lo: number, hi: number, def: number) =>
	Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def;

/** 从片段提取属性快照（缺省字段按默认值补齐——粘贴语义是「改成和源一样」） */
export function extractSegAttrs(seg: RtcSegment): RtcSegAttrs {
	return {
		transform: normalizeTransform(segTransform(seg)),
		speed: clamp(seg.speed ?? 1, 0.1, 5, 1),
		volume: clamp(seg.volume ?? 1, 0, 2, 1),
		muted: !!seg.muted,
	};
}

/** 两个变换是否等值（含镜像位） */
function sameTransform(a: RtcTransform, b: RtcTransform): boolean {
	return (
		a.scaleX === b.scaleX &&
		a.scaleY === b.scaleY &&
		a.x === b.x &&
		a.y === b.y &&
		a.rotation === b.rotation &&
		a.opacity === b.opacity &&
		!!a.flipH === !!b.flipH &&
		!!a.flipV === !!b.flipV
	);
}

/**
 * 把属性快照应用到一批片段（不可变；一个都没变返回**原 doc 引用** → commit no-op）。
 * 默认值不落键（speed=1 / volume=1 / muted=false / transform=缺省 一律删字段，项目文件保持干净）。
 */
export function applyAttrsToDoc(doc: RtcDoc, ids: string[], attrs: RtcSegAttrs): RtcDoc {
	const want = new Set(ids);
	let changed = false;
	const tracks = doc.tracks.map((t) => {
		if (!t.segments.some((s) => want.has(s.id))) return t;
		let trackChanged = false;
		const segments = t.segments.map((s) => {
			if (!want.has(s.id)) return s;
			const next: RtcSegment = { ...s };
			let segChanged = false;
			// transform：音频片段跳过（画面变换对声音无意义）
			if ((s.media ?? "video") !== "audio" && t.type !== "audio") {
				const stored = storeTransform(attrs.transform);
				const cur = normalizeTransform(segTransform(s));
				if (!sameTransform(cur, attrs.transform)) {
					if (stored === undefined) delete next.transform;
					else next.transform = stored;
					segChanged = true;
				}
			}
			const patchNum = (key: "speed" | "volume", value: number, def: number) => {
				const cur = s[key] ?? def;
				if (cur === value) return;
				if (value === def) delete next[key];
				else next[key] = value;
				segChanged = true;
			};
			patchNum("speed", attrs.speed, 1);
			patchNum("volume", attrs.volume, 1);
			if (!!s.muted !== attrs.muted) {
				if (attrs.muted) next.muted = true;
				else delete next.muted;
				segChanged = true;
			}
			if (!segChanged) return s;
			trackChanged = true;
			return next;
		});
		if (!trackChanged) return t;
		changed = true;
		return { ...t, segments };
	});
	return changed ? { ...doc, tracks } : doc;
}

interface RtcAttrClipboardState {
	attrs: RtcSegAttrs | null;
	setAttrs: (attrs: RtcSegAttrs | null) => void;
}

export const useRtcAttrClipboard = create<RtcAttrClipboardState>((set) => ({
	attrs: null,
	setAttrs: (attrs) => set({ attrs }),
}));

/* 切项目 → 清空属性剪贴板（与 rtcClipboard 同规矩：属性虽不含素材引用，但「上个项目的画面摆位」
 * 贴进新项目多半是误操作；模块级订阅，随首次 import 常驻）。 */
let prevInstanceId = useProjectStore.getState().projectInstanceId;
useProjectStore.subscribe((ps) => {
	if (ps.projectInstanceId === prevInstanceId) return;
	prevInstanceId = ps.projectInstanceId;
	if (useRtcAttrClipboard.getState().attrs) useRtcAttrClipboard.getState().setAttrs(null);
});
