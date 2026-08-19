import { describe, it, expect } from "vitest";
import type { RtcMarker } from "@/types/rtc";
import {
	RTC_MARKER_COLORS,
	MARKER_NOTE_MAX,
	addMarker,
	markerNear,
	nextMarker,
	nextMarkerColor,
	normalizeMarkerColor,
	prevMarker,
	removeMarker,
	sanitizeMarkers,
	setMarkerColor,
	setMarkerNote,
	updateMarkerColor,
} from "./rtcMarkers";

const mk = (id: string, timeUs: number, color = RTC_MARKER_COLORS[0], note?: string): RtcMarker => ({
	id,
	timeUs,
	color,
	...(note ? { note } : {}),
});

describe("rtcMarkers · 色值", () => {
	it("normalizeMarkerColor：调色板内原样、非法/未知归第一色", () => {
		expect(normalizeMarkerColor(RTC_MARKER_COLORS[2])).toBe(RTC_MARKER_COLORS[2]);
		expect(normalizeMarkerColor("#123456")).toBe(RTC_MARKER_COLORS[0]);
		expect(normalizeMarkerColor(undefined)).toBe(RTC_MARKER_COLORS[0]);
	});

	it("nextMarkerColor：循环取下一色，末色回卷到首色", () => {
		expect(nextMarkerColor(RTC_MARKER_COLORS[0])).toBe(RTC_MARKER_COLORS[1]);
		expect(nextMarkerColor(RTC_MARKER_COLORS[RTC_MARKER_COLORS.length - 1])).toBe(RTC_MARKER_COLORS[0]);
	});
});

describe("rtcMarkers · sanitize（防御清洗）", () => {
	it("干净有序输入 → 返回原数组引用（渲染 memo 零重算）", () => {
		const list = [mk("a", 0), mk("b", 5_000_000)];
		expect(sanitizeMarkers(list)).toBe(list);
	});

	it("垃圾条目（无 id / 负时间 / 非有限）被丢弃，乱序被排序，非法色归一，超长备注截断", () => {
		const raw = [
			{ id: "b", timeUs: 9_000_000, color: "bad-color" },
			{ id: "", timeUs: 1 },
			{ id: "c", timeUs: -3, color: RTC_MARKER_COLORS[1] },
			{ id: "d", timeUs: Number.NaN },
			{ id: "a", timeUs: 1_000_000, color: RTC_MARKER_COLORS[2], note: "x".repeat(MARKER_NOTE_MAX + 50) },
		];
		const out = sanitizeMarkers(raw);
		expect(out.map((m) => m.id)).toEqual(["a", "b"]);
		expect(out[1].color).toBe(RTC_MARKER_COLORS[0]);
		expect(out[0].note!.length).toBe(MARKER_NOTE_MAX);
	});

	it("非数组输入 → 空数组", () => {
		expect(sanitizeMarkers(undefined)).toEqual([]);
		expect(sanitizeMarkers("junk")).toEqual([]);
	});
});

describe("rtcMarkers · 增删改", () => {
	it("addMarker 插入后保持升序；removeMarker 未命中返回原引用", () => {
		const list = addMarker(addMarker(undefined, { id: "b", timeUs: 8_000_000 }), { id: "a", timeUs: 2_000_000 });
		expect(list.map((m) => m.id)).toEqual(["a", "b"]);
		expect(removeMarker(list, "missing")).toBe(list);
		expect(removeMarker(list, "a").map((m) => m.id)).toEqual(["b"]);
	});

	it("updateMarkerColor 循环换下一色；setMarkerColor 同色 no-op 返回原引用", () => {
		const list = [mk("a", 0, RTC_MARKER_COLORS[0])];
		expect(updateMarkerColor(list, "a")[0].color).toBe(RTC_MARKER_COLORS[1]);
		expect(setMarkerColor(list, "a", RTC_MARKER_COLORS[0])).toBe(list);
	});

	it("setMarkerNote：设置/清除（空白=清除字段）；值未变返回原引用", () => {
		const list = [mk("a", 0)];
		const withNote = setMarkerNote(list, "a", "重拍这里");
		expect(withNote[0].note).toBe("重拍这里");
		expect(setMarkerNote(withNote, "a", "重拍这里")).toBe(withNote);
		const cleared = setMarkerNote(withNote, "a", "   ");
		expect("note" in cleared[0]).toBe(false);
	});
});

describe("rtcMarkers · 查询（跳转）", () => {
	const list = [mk("a", 1_000_000), mk("b", 5_000_000), mk("c", 9_000_000)];

	it("markerNear：容差内最近命中，容差外 null", () => {
		expect(markerNear(list, 5_040_000, 100_000)?.id).toBe("b");
		expect(markerNear(list, 3_000_000, 100_000)).toBeNull();
	});

	it("nextMarker/prevMarker：严格越过当前时刻（正好站在标记上时跳相邻的）", () => {
		expect(nextMarker(list, 5_000_000)?.id).toBe("c");
		expect(prevMarker(list, 5_000_000)?.id).toBe("a");
		expect(nextMarker(list, 9_000_000)).toBeNull();
		expect(prevMarker(list, 1_000_000)).toBeNull();
	});
});
