import { describe, it, expect } from "vitest";
import type { RtcDoc, RtcSegment, RtcTrack } from "@/types/rtc";
import {
	DEFAULT_SUBTITLE_FONT_SIZE,
	activeTextSegments,
	hexToRgb01,
	jyTextSize,
	normalizeHexColor,
	textSegName,
	textStyleOf,
} from "./rtcTextCore";

function seg(p: Partial<RtcSegment>): RtcSegment {
	return { id: p.id || `s-${Math.random().toString(36).slice(2, 6)}`, kind: "media", targetStartUs: 0, targetDurationUs: 3_000_000, ...p };
}
function docOf(tracks: Array<Partial<RtcTrack> & { type: RtcTrack["type"]; segments: RtcSegment[] }>): RtcDoc {
	return {
		id: "d1",
		name: "测试",
		fps: 30,
		tracks: tracks.map((t, i) => ({ id: t.id || `t${i}`, type: t.type, segments: t.segments, ...(t.role ? { role: t.role } : {}) })),
	};
}

describe("rtcTextCore · 样式缺省与收敛", () => {
	it("textStyleOf：无 text 字段 → 全默认（0.07 白字黑边 底部居中 y=0.4）", () => {
		expect(textStyleOf(seg({}))).toEqual({
			content: "",
			fontSize: 0.07,
			color: "#ffffff",
			strokeColor: "#000000",
			x: 0,
			y: 0.4,
		});
	});

	it("textStyleOf：非法值逐字段回退/夹取（字号夹 [0.02,0.2]、坏色回默认、位置夹 ±1）", () => {
		const t = textStyleOf(seg({ text: { content: "你好", fontSize: 9, color: "red", strokeColor: "#ABC", x: -5, y: NaN } }));
		expect(t.content).toBe("你好");
		expect(t.fontSize).toBe(0.2);
		expect(t.color).toBe("#ffffff"); // 非 hex 回退
		expect(t.strokeColor).toBe("#abc"); // #RGB 合法、统一小写
		expect(t.x).toBe(-1);
		expect(t.y).toBe(0.4); // NaN 回默认
	});

	it("normalizeHexColor：#RGB/#RRGGBB 放行（小写化），其余回 fallback", () => {
		expect(normalizeHexColor("#FFAA00", "#000000")).toBe("#ffaa00");
		expect(normalizeHexColor("#0f0", "#000000")).toBe("#0f0");
		expect(normalizeHexColor("rgb(1,2,3)", "#000000")).toBe("#000000");
		expect(normalizeHexColor(undefined, "#123456")).toBe("#123456");
	});

	it("textSegName：首行截 24 字、空内容回退「空字幕」", () => {
		expect(textSegName("第一行\n第二行")).toBe("第一行");
		expect(textSegName("  ")).toBe("空字幕");
		expect(textSegName("啊".repeat(30))).toBe(`${"啊".repeat(24)}…`);
	});
});

describe("rtcTextCore · 活动字幕", () => {
	it("只取 text 轨、kind=media、有内容、播放头在区间内的片段（右缘开区间）", () => {
		const d = docOf([
			{
				type: "text",
				segments: [
					seg({ id: "a", text: { content: "字幕A" }, targetStartUs: 0, targetDurationUs: 2_000_000 }),
					seg({ id: "b", text: { content: "  " }, targetStartUs: 0, targetDurationUs: 2_000_000 }), // 空白内容不算
					seg({ id: "c", kind: "placeholder", targetStartUs: 0, targetDurationUs: 2_000_000 }),
					seg({ id: "late", text: { content: "晚出" }, targetStartUs: 2_000_000, targetDurationUs: 1_000_000 }),
				],
			},
			{ type: "video", segments: [seg({ id: "v", text: { content: "不该出现" }, targetStartUs: 0, targetDurationUs: 5_000_000 })] },
		]);
		expect(activeTextSegments(d, 1_000_000).map((s) => s.id)).toEqual(["a"]);
		// 交界时刻归后一段（右缘开区间）
		expect(activeTextSegments(d, 2_000_000).map((s) => s.id)).toEqual(["late"]);
	});

	it("原文参考轨（role:\"script\"）不进预览画面（不导出的不上画，所见即所得）", () => {
		const d = docOf([
			{ type: "text", role: "script", segments: [seg({ id: "o", text: { content: "第一镜原文" }, targetStartUs: 0, targetDurationUs: 3_000_000 })] },
			{ type: "text", segments: [seg({ id: "sub", text: { content: "真字幕" }, targetStartUs: 0, targetDurationUs: 3_000_000 })] },
		]);
		expect(activeTextSegments(d, 1_000_000).map((s) => s.id)).toEqual(["sub"]);
	});
});

describe("rtcTextCore · 剪映换算", () => {
	it("jyTextSize：默认档 0.07 ↔ 剪映 8 号精确锚定；越界字号先夹取再换算", () => {
		expect(jyTextSize(DEFAULT_SUBTITLE_FONT_SIZE)).toBe(8);
		expect(jyTextSize(0.14)).toBe(16);
		expect(jyTextSize(NaN)).toBe(8); // 非法回默认档
		expect(jyTextSize(99)).toBe(jyTextSize(0.2)); // 夹到上限后换算
	});

	it("hexToRgb01：#RRGGBB/#RGB → [0,1] 三元组；非法回 fallback", () => {
		expect(hexToRgb01("#ffffff")).toEqual([1, 1, 1]);
		expect(hexToRgb01("#000000")).toEqual([0, 0, 0]);
		expect(hexToRgb01("#ff8000")[0]).toBe(1);
		expect(hexToRgb01("#ff8000")[1]).toBeCloseTo(128 / 255, 3);
		expect(hexToRgb01("#f00")).toEqual([1, 0, 0]);
		expect(hexToRgb01("oops", [0, 0, 0])).toEqual([0, 0, 0]);
	});
});
