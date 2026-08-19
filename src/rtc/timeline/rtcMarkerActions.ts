/**
 * rtcMarkerActions —— 时间轴标记动作（供 快捷键 / 标尺双击 / 标记小旗菜单 调用的统一入口）。
 *
 * ⚠ 数据变更红线（§9A）：增删改标记一律 `rtcStore.commit(doc => ({ ...doc, markers }))`，
 *   一次动作 = 一条 undo；**跳转（上一/下一标记）只动播放头，不进 undo**。
 * 纯逻辑全部在 lib/rtcMarkers（带单测），本文件只做「取状态 → 算 → 提交」。
 *
 * 接线说明（本批不接快捷键/工具栏，见最终报告的待接线清单）：
 *   - toggleMarkerAtPlayhead —— 建议 M（播放头处有标记则移除 = toggle）
 *   - addMarkerCycleColor  —— 建议 Alt+M（添加并循环换色）
 *   - jumpPrevMarker / jumpNextMarker —— 建议 Shift+M / Alt+Shift+M
 */
import { genId } from "@/lib/id";
import {
	addMarker,
	markerNear,
	nextMarker,
	prevMarker,
	removeMarker,
	setMarkerColor,
	setMarkerNote,
	updateMarkerColor,
	RTC_MARKER_COLORS,
} from "@/lib/rtcMarkers";
import { useRtcStore } from "@/store/rtcStore";

/** 「播放头处已有标记」的判定容差（微秒）：0.1s——按住的是「同一处」的直觉，不随缩放漂移 */
export const MARKER_TOGGLE_TOL_US = 100_000;

/** 「添加异色标记」的循环游标（会话级；每按一次向后换一色） */
let cycleCursor = 0;

/** 在指定时刻添加标记（标尺双击入口）；返回新标记 id（doc 未载入/时刻非法返回 null） */
export function addMarkerAt(timeUs: number, color?: string): string | null {
	const st = useRtcStore.getState();
	if (!st.doc || !Number.isFinite(timeUs) || timeUs < 0) return null;
	const id = genId("mk");
	st.commit((d) => {
		const markers = addMarker(d.markers, { id, timeUs, color });
		return markers === d.markers ? d : { ...d, markers };
	});
	return id;
}

/**
 * 播放头处加/删标记（toggle）：容差内已有标记 → 移除；没有 → 以默认色添加。
 * 建议键位 M。
 */
export function toggleMarkerAtPlayhead(): void {
	const st = useRtcStore.getState();
	const d = st.doc;
	if (!d) return;
	const hit = markerNear(d.markers, st.playheadUs, MARKER_TOGGLE_TOL_US);
	if (hit) {
		st.commit((doc) => {
			const markers = removeMarker(doc.markers, hit.id);
			return markers === doc.markers ? doc : { ...doc, markers };
		});
	} else {
		addMarkerAt(st.playheadUs);
	}
}

/**
 * 添加异色标记：在播放头处添加，颜色按调色板循环取下一色（会话级游标）。
 * 播放头处已有标记 → 改为把它循环换色（不重复叠标记）。建议键位 Alt+M。
 */
export function addMarkerCycleColor(): void {
	const st = useRtcStore.getState();
	const d = st.doc;
	if (!d) return;
	const hit = markerNear(d.markers, st.playheadUs, MARKER_TOGGLE_TOL_US);
	if (hit) {
		cycleMarkerColorById(hit.id);
		return;
	}
	cycleCursor = (cycleCursor + 1) % RTC_MARKER_COLORS.length;
	addMarkerAt(st.playheadUs, RTC_MARKER_COLORS[cycleCursor]);
}

/** 跳到上一标记（只动播放头，不进 undo）；建议键位 Shift+M */
export function jumpPrevMarker(): void {
	const st = useRtcStore.getState();
	if (!st.doc) return;
	const m = prevMarker(st.doc.markers, st.playheadUs);
	if (m) st.setPlayhead(m.timeUs);
}

/** 跳到下一标记（只动播放头，不进 undo）；建议键位 Alt+Shift+M */
export function jumpNextMarker(): void {
	const st = useRtcStore.getState();
	if (!st.doc) return;
	const m = nextMarker(st.doc.markers, st.playheadUs);
	if (m) st.setPlayhead(m.timeUs);
}

/** 标记循环换到下一色（小旗右键菜单「换色」） */
export function cycleMarkerColorById(id: string): void {
	useRtcStore.getState().commit((d) => {
		const markers = updateMarkerColor(d.markers, id);
		return markers === d.markers ? d : { ...d, markers };
	});
}

/** 指定标记色（小旗右键菜单的色板） */
export function setMarkerColorById(id: string, color: string): void {
	useRtcStore.getState().commit((d) => {
		const markers = setMarkerColor(d.markers, id, color);
		return markers === d.markers ? d : { ...d, markers };
	});
}

/** 删除标记（小旗右键菜单「删除」） */
export function removeMarkerById(id: string): void {
	useRtcStore.getState().commit((d) => {
		const markers = removeMarker(d.markers, id);
		return markers === d.markers ? d : { ...d, markers };
	});
}

/** 设置/清除标记备注（空白=清除；值未变不 commit——不污染撤销栈） */
export function setMarkerNoteById(id: string, note: string): void {
	useRtcStore.getState().commit((d) => {
		const markers = setMarkerNote(d.markers, id, note);
		return markers === d.markers ? d : { ...d, markers };
	});
}

/** 跳到指定标记（点小旗；只动播放头不进 undo） */
export function jumpToMarker(timeUs: number): void {
	if (Number.isFinite(timeUs) && timeUs >= 0) useRtcStore.getState().setPlayhead(timeUs);
}
