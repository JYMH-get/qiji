/**
 * rtcTextCore —— 实时剪辑「字幕轨」纯函数层（零 DOM / 零 store / 零 React，可单测）。
 *
 * 服务三个消费方：
 *   ① 字幕属性面板 `src/rtc/panel/RtcTextProps.tsx`（内容/字号/颜色/描边/位置）；
 *   ② 预览字幕层 `src/rtc/RtcTextLayer.tsx`（播放头处的活动字幕 + 排版样式换算）；
 *   ③ 剪映草稿导出 `src/lib/jianyingDraft.ts`（materials.texts 的 content JSON 与字号换算）。
 *
 * ── 样式缺省口径（与 types/rtc.RtcSubtitle 注释一致，读取一律走 textStyleOf）──
 *   fontSize=画幅高比例 0.07（≈剪映字幕默认 8 号档）、白字 #ffffff、黑描边 #000000、
 *   位置 x=0（水平居中）/ y=0.4（底部字幕带；y 正向下、0=画幅中心）。
 */
import type { RtcDoc, RtcSegment, RtcSubtitle } from "@/types/rtc";

/** 字幕样式缺省值 */
export const DEFAULT_SUBTITLE_FONT_SIZE = 0.07;
export const DEFAULT_SUBTITLE_COLOR = "#ffffff";
export const DEFAULT_SUBTITLE_STROKE = "#000000";
export const DEFAULT_SUBTITLE_Y = 0.4;

/** 字号（画幅高比例）取值范围 */
export const SUBTITLE_FONT_MIN = 0.02;
export const SUBTITLE_FONT_MAX = 0.2;

/** 新建字幕片段的默认内容与时长 */
export const DEFAULT_SUBTITLE_TEXT = "双击编辑字幕";
export const SUBTITLE_DEFAULT_US = 3_000_000;

/** 归一化后的完整字幕样式（无 optional，消费方直接用） */
export interface RtcSubtitleStyle {
	content: string;
	fontSize: number;
	color: string;
	strokeColor: string;
	x: number;
	y: number;
}

const clampNum = (v: unknown, lo: number, hi: number, d: number): number => {
	const n = Number(v);
	if (!Number.isFinite(n)) return d;
	return Math.min(hi, Math.max(lo, n));
};

/** #RGB / #RRGGBB 形状校验；非法回退 fallback */
export function normalizeHexColor(v: unknown, fallback: string): string {
	if (typeof v === "string" && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v.trim())) {
		return v.trim().toLowerCase();
	}
	return fallback;
}

/** 读片段字幕样式（缺省/非法值回退默认）——所有消费方走这里，别各自写回退 */
export function textStyleOf(seg: Pick<RtcSegment, "text">): RtcSubtitleStyle {
	const t: Partial<RtcSubtitle> = seg.text && typeof seg.text === "object" ? seg.text : {};
	return {
		content: typeof t.content === "string" ? t.content : "",
		fontSize: clampNum(t.fontSize, SUBTITLE_FONT_MIN, SUBTITLE_FONT_MAX, DEFAULT_SUBTITLE_FONT_SIZE),
		color: normalizeHexColor(t.color, DEFAULT_SUBTITLE_COLOR),
		strokeColor: normalizeHexColor(t.strokeColor, DEFAULT_SUBTITLE_STROKE),
		x: clampNum(t.x, -1, 1, 0),
		y: clampNum(t.y, -1, 1, DEFAULT_SUBTITLE_Y),
	};
}

/** 字幕片段在时间轴上的显示名：正文首行截 24 字（空内容回退占位名） */
export function textSegName(content: string): string {
	const first = (content || "").split(/\r?\n/, 1)[0].trim();
	if (!first) return "空字幕";
	return first.length > 24 ? `${first.slice(0, 24)}…` : first;
}

/**
 * 播放头处的活动字幕片段（预览字幕层用）：全部 text 轨上、kind=media、有内容、
 * 且播放头落在其区间内的片段。按 doc.tracks 数组序返回（后建的轨排后=画在更上层）。
 */
export function activeTextSegments(doc: RtcDoc, tUs: number): RtcSegment[] {
	const out: RtcSegment[] = [];
	for (const track of doc.tracks) {
		if (track.type !== "text") continue;
		if (track.role === "script") continue; // 旧形态原文轨（加载即清，rtcOps.pruneScriptTracks）防御排除
		for (const s of track.segments) {
			if (s.kind !== "media") continue;
			if (!s.text?.content?.trim()) continue;
			if (tUs >= s.targetStartUs && tUs < s.targetStartUs + s.targetDurationUs) out.push(s);
		}
	}
	return out;
}

/* 原文参考（第238轮补充10 起）不再是轨道片段——预览窗参考条改由 rtcScriptLane
 * 从主轨实时派生（activeScriptLaneTexts），本模块只管真字幕。 */

/* ── 剪映导出换算 ─────────────────────────────────────────────────────────── */

/**
 * 字号换算锚点：我方 fontSize=画幅高比例、剪映字号为无量纲档位——
 * 以「剪映字幕默认 8 号 ≈ 画幅高 7%」为锚（8 / 0.07），线性换算并夹到 [1, 100]。
 * 这是**近似映射**（剪映字号与像素的精确关系未公开），默认档 0.07 ↔ 8.0 精确对上。
 */
export const JY_TEXT_SIZE_ANCHOR = 8 / DEFAULT_SUBTITLE_FONT_SIZE;

export function jyTextSize(fontSizeRatio: number): number {
	const fs = clampNum(fontSizeRatio, SUBTITLE_FONT_MIN, SUBTITLE_FONT_MAX, DEFAULT_SUBTITLE_FONT_SIZE);
	const v = Math.round(fs * JY_TEXT_SIZE_ANCHOR * 10) / 10;
	return Math.min(100, Math.max(1, v));
}

/** #RRGGBB / #RGB → 剪映 content JSON 的 RGB 三元组（[0,1] 浮点；非法回退 fallback 色） */
export function hexToRgb01(hex: string, fallback: [number, number, number] = [1, 1, 1]): [number, number, number] {
	const h = normalizeHexColor(hex, "");
	if (!h) return fallback;
	const raw = h.slice(1);
	const full = raw.length === 3 ? raw.split("").map((c) => c + c).join("") : raw;
	const to01 = (i: number) => Math.round((parseInt(full.slice(i, i + 2), 16) / 255) * 10_000) / 10_000;
	return [to01(0), to01(2), to01(4)];
}
