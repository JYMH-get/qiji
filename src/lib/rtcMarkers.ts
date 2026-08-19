/**
 * rtcMarkers.ts —— 时间轴标记（doc 级小旗）的纯函数层（零 DOM / 零 store，全部可单测）。
 *
 * 语义（第二批定稿）：
 *   - 标记挂在 `RtcDoc.markers`（数组按 timeUs 升序），是**文档数据**——增删改一律经
 *     `rtcStore.commit(doc => ({ ...doc, markers: 新数组 }))`（§9A 唯一写入路径），跳转除外
 *     （跳转只动播放头不进 undo，见 rtc/timeline/rtcMarkerActions）；
 *   - **无 load 期集中清洗**（rtcDoc 载入本就不迁移），故读取一律先过 `sanitizeMarkers` 防御清洗，
 *     写入走本文件的操作函数（输入先清洗、输出恒为干净有序数组）；
 *   - 所有操作不可变：无效输入 / 未命中 / 值未变 → 返回**原数组引用**（commit 视为 no-op）。
 */
import type { RtcMarker } from "@/types/rtc";

/** 标记调色板（第一色=缺省色；顺序即「循环换色」的次序） */
export const RTC_MARKER_COLORS = [
	"#f59e0b", // 琥珀（默认）
	"#f87171", // 红
	"#4ade80", // 绿
	"#60a5fa", // 蓝
	"#c084fc", // 紫
	"#f472b6", // 粉
] as const;

/** 备注长度上限（防手滑贴长文进项目文件） */
export const MARKER_NOTE_MAX = 200;

/** 色值归一：不在调色板内（含大小写差异/非法值）→ 第一色 */
export function normalizeMarkerColor(color: unknown): string {
	const c = typeof color === "string" ? color.toLowerCase() : "";
	return (RTC_MARKER_COLORS as readonly string[]).includes(c) ? c : RTC_MARKER_COLORS[0];
}

/** 调色板循环取下一色（当前色不在调色板内视为第一色 → 返回第二色） */
export function nextMarkerColor(color: unknown): string {
	const cur = normalizeMarkerColor(color);
	const idx = (RTC_MARKER_COLORS as readonly string[]).indexOf(cur);
	return RTC_MARKER_COLORS[(idx + 1) % RTC_MARKER_COLORS.length];
}

/**
 * 防御清洗：过滤 无 id / timeUs 非有限或为负 的条目，色值归一、备注截断、按 timeUs 升序。
 * 输入本就干净有序 → 返回**原数组引用**（渲染 memo 零重算）。接受 undefined/任意垃圾输入。
 */
export function sanitizeMarkers(raw: unknown): RtcMarker[] {
	if (!Array.isArray(raw) || raw.length === 0) return Array.isArray(raw) ? (raw as RtcMarker[]) : [];
	const out: RtcMarker[] = [];
	let dirty = false;
	for (const m of raw as Array<Record<string, unknown>>) {
		if (!m || typeof m !== "object" || typeof m.id !== "string" || !m.id) { dirty = true; continue; }
		const t = Number(m.timeUs);
		if (!Number.isFinite(t) || t < 0) { dirty = true; continue; }
		const color = normalizeMarkerColor(m.color);
		const rawNote = typeof m.note === "string" ? m.note.slice(0, MARKER_NOTE_MAX) : undefined;
		const note = rawNote && rawNote.trim() ? rawNote : undefined;
		const timeUs = Math.round(t);
		if (timeUs !== m.timeUs || color !== m.color || note !== m.note) dirty = true;
		out.push({ id: m.id, timeUs, color, ...(note ? { note } : {}) });
	}
	for (let i = 1; i < out.length; i++) {
		if (out[i].timeUs < out[i - 1].timeUs) { dirty = true; break; }
	}
	if (!dirty) return raw as RtcMarker[];
	return out.sort((a, b) => a.timeUs - b.timeUs);
}

/** 添加标记（插入后保持升序）；timeUs 非法 → 原数组引用 */
export function addMarker(
	markers: RtcMarker[] | undefined,
	marker: { id: string; timeUs: number; color?: string; note?: string },
): RtcMarker[] {
	const list = sanitizeMarkers(markers);
	if (!marker.id || !Number.isFinite(marker.timeUs) || marker.timeUs < 0) return list;
	const note = marker.note && marker.note.trim() ? marker.note.slice(0, MARKER_NOTE_MAX) : undefined;
	const next: RtcMarker = {
		id: marker.id,
		timeUs: Math.round(marker.timeUs),
		color: normalizeMarkerColor(marker.color),
		...(note ? { note } : {}),
	};
	return [...list, next].sort((a, b) => a.timeUs - b.timeUs);
}

/** 删除标记；未命中 → 原数组引用 */
export function removeMarker(markers: RtcMarker[] | undefined, id: string): RtcMarker[] {
	const list = sanitizeMarkers(markers);
	const next = list.filter((m) => m.id !== id);
	return next.length === list.length ? list : next;
}

/** 指定色（非法色归第一色）；未命中/色未变 → 原数组引用 */
export function setMarkerColor(markers: RtcMarker[] | undefined, id: string, color: string): RtcMarker[] {
	const list = sanitizeMarkers(markers);
	const c = normalizeMarkerColor(color);
	const idx = list.findIndex((m) => m.id === id);
	if (idx < 0 || list[idx].color === c) return list;
	const next = [...list];
	next[idx] = { ...next[idx], color: c };
	return next;
}

/** 循环取下一色（右键菜单「换色」）；未命中 → 原数组引用 */
export function updateMarkerColor(markers: RtcMarker[] | undefined, id: string): RtcMarker[] {
	const list = sanitizeMarkers(markers);
	const cur = list.find((m) => m.id === id);
	if (!cur) return list;
	return setMarkerColor(list, id, nextMarkerColor(cur.color));
}

/** 设置/清除备注（空白=清除）；未命中/值未变 → 原数组引用 */
export function setMarkerNote(markers: RtcMarker[] | undefined, id: string, note: string): RtcMarker[] {
	const list = sanitizeMarkers(markers);
	const idx = list.findIndex((m) => m.id === id);
	if (idx < 0) return list;
	const clean = note.trim() ? note.slice(0, MARKER_NOTE_MAX) : undefined;
	if ((list[idx].note ?? undefined) === clean) return list;
	const next = [...list];
	const { note: _drop, ...rest } = next[idx];
	next[idx] = clean ? { ...rest, note: clean } : rest;
	return next;
}

/** 距 us 最近且差 ≤ tolUs 的标记（toggle 判定用）；无命中 null */
export function markerNear(markers: RtcMarker[] | undefined, us: number, tolUs: number): RtcMarker | null {
	let best: RtcMarker | null = null;
	let bestDist = Infinity;
	for (const m of sanitizeMarkers(markers)) {
		const d = Math.abs(m.timeUs - us);
		if (d < bestDist) { bestDist = d; best = m; }
	}
	return best && bestDist <= tolUs ? best : null;
}

/** 严格晚于 us 的第一个标记（跳下一标记）；无 → null */
export function nextMarker(markers: RtcMarker[] | undefined, us: number): RtcMarker | null {
	for (const m of sanitizeMarkers(markers)) {
		if (m.timeUs > us) return m;
	}
	return null;
}

/** 严格早于 us 的最后一个标记（跳上一标记）；无 → null */
export function prevMarker(markers: RtcMarker[] | undefined, us: number): RtcMarker | null {
	const list = sanitizeMarkers(markers);
	for (let i = list.length - 1; i >= 0; i--) {
		if (list[i].timeUs < us) return list[i];
	}
	return null;
}
