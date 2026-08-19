import { describe, expect, it } from "vitest";
import type { RtcDoc, RtcSegment, RtcTrack } from "@/types/rtc";
import { applyAttrsToDoc, extractSegAttrs, useRtcAttrClipboard, type RtcSegAttrs } from "./rtcAttrClipboard";

function seg(id: string, extra?: Partial<RtcSegment>): RtcSegment {
	return { id, kind: "media", media: "video", targetStartUs: 0, targetDurationUs: 1_000_000, ...extra };
}

function doc(tracks: RtcTrack[]): RtcDoc {
	return { id: "d", name: "t", fps: 30, tracks };
}

describe("rtcAttrClipboard extractSegAttrs", () => {
	it("缺省片段：快照为规范化默认值（粘贴语义=改成和源一样，含把目标重置回默认）", () => {
		const a = extractSegAttrs(seg("a"));
		expect(a.transform).toEqual({ scaleX: 1, scaleY: 1, x: 0, y: 0, rotation: 0, opacity: 1 });
		expect(a.speed).toBe(1);
		expect(a.volume).toBe(1);
		expect(a.muted).toBe(false);
	});

	it("带属性片段：transform/speed/volume/muted 全收；越界值夹取", () => {
		const a = extractSegAttrs(
			seg("a", {
				transform: { scaleX: 2, scaleY: 2, x: 0.1, y: -0.2, rotation: 90, opacity: 0.5, flipH: true },
				speed: 99, // 夹到 5
				volume: -1, // 夹到 0
				muted: true,
			}),
		);
		expect(a.transform.scaleX).toBe(2);
		expect(a.transform.flipH).toBe(true);
		expect(a.speed).toBe(5);
		expect(a.volume).toBe(0);
		expect(a.muted).toBe(true);
	});
});

describe("rtcAttrClipboard applyAttrsToDoc", () => {
	const ATTRS: RtcSegAttrs = {
		transform: { scaleX: 1.5, scaleY: 1.5, x: 0.1, y: 0, rotation: 90, opacity: 0.8 },
		speed: 2,
		volume: 0.5,
		muted: true,
	};

	it("对多片段一次应用（transform/speed/volume/muted 全落）；未选中的不动", () => {
		const d0 = doc([{ id: "t", type: "video", segments: [seg("a"), seg("b"), seg("c")] }]);
		const d1 = applyAttrsToDoc(d0, ["a", "b"], ATTRS);
		const [a, b, c] = d1.tracks[0].segments;
		for (const s of [a, b]) {
			expect(s.transform?.scaleX).toBe(1.5);
			expect(s.transform?.rotation).toBe(90);
			expect(s.speed).toBe(2);
			expect(s.volume).toBe(0.5);
			expect(s.muted).toBe(true);
		}
		expect(c).toBe(d0.tracks[0].segments[2]); // 未选中：引用不变
	});

	it("默认值不落键：粘贴默认快照会把已调过的片段清干净（transform 删字段、speed/volume/muted 摘除）", () => {
		const dirty = seg("a", {
			transform: { scaleX: 2, scaleY: 2, x: 0, y: 0, rotation: 0, opacity: 1 },
			speed: 2,
			volume: 0.4,
			muted: true,
		});
		const d0 = doc([{ id: "t", type: "video", segments: [dirty] }]);
		const d1 = applyAttrsToDoc(d0, ["a"], extractSegAttrs(seg("clean")));
		const a = d1.tracks[0].segments[0];
		expect("transform" in a).toBe(false);
		expect("speed" in a).toBe(false);
		expect("volume" in a).toBe(false);
		expect("muted" in a).toBe(false);
	});

	it("音频片段跳过 transform（画面变换对声音无意义），volume/speed/muted 照贴", () => {
		const d0 = doc([{ id: "t", type: "audio", segments: [seg("a", { media: "audio" })] }]);
		const d1 = applyAttrsToDoc(d0, ["a"], ATTRS);
		const a = d1.tracks[0].segments[0];
		expect("transform" in a).toBe(false);
		expect(a.volume).toBe(0.5);
		expect(a.speed).toBe(2);
		expect(a.muted).toBe(true);
	});

	it("粘贴 speed 走 setSegmentSpeed：target 时长联动、source 窗口回写维持不变量（老 bug 勿复发）", () => {
		const d0 = doc([
			{
				id: "t",
				type: "video",
				segments: [seg("a", { targetDurationUs: 10_000_000, sourceStartUs: 0, sourceDurationUs: 10_000_000 })],
			},
		]);
		const d1 = applyAttrsToDoc(d0, ["a"], ATTRS); // speed 2
		const a = d1.tracks[0].segments[0];
		expect(a.speed).toBe(2);
		expect(a.targetDurationUs).toBe(5_000_000); // 10s 源 ×2 倍速 = 5s 轨道长度
		expect(a.sourceDurationUs).toBe(10_000_000); // 不变量 sourceDur = targetDur×speed
	});

	it("compound 片段：speed 不经属性粘贴生效（setSegmentSpeed 只认 media），其余属性照贴", () => {
		const c = seg("c", { kind: "compound", sourceStartUs: 0, sourceDurationUs: 1_000_000 });
		const d0 = doc([{ id: "t", type: "video", segments: [c] }]);
		const d1 = applyAttrsToDoc(d0, ["c"], ATTRS);
		const out = d1.tracks[0].segments[0];
		expect("speed" in out).toBe(false); // speed 未落
		expect(out.targetDurationUs).toBe(1_000_000); // 时长不动
		expect(out.volume).toBe(0.5); // 其余属性照贴
		expect(out.muted).toBe(true);
	});

	it("值全部未变 → 原 doc 引用（commit 视为 no-op 不进撤销栈）", () => {
		const already = seg("a", {
			transform: { scaleX: 1.5, scaleY: 1.5, x: 0.1, y: 0, rotation: 90, opacity: 0.8 },
			speed: 2,
			volume: 0.5,
			muted: true,
		});
		const d0 = doc([{ id: "t", type: "video", segments: [already] }]);
		expect(applyAttrsToDoc(d0, ["a"], ATTRS)).toBe(d0);
		expect(applyAttrsToDoc(d0, ["不存在"], ATTRS)).toBe(d0);
	});
});

describe("rtcAttrClipboard store", () => {
	it("会话级存取（setAttrs / 清空）", () => {
		const st = useRtcAttrClipboard.getState();
		st.setAttrs(extractSegAttrs(seg("a", { muted: true })));
		expect(useRtcAttrClipboard.getState().attrs?.muted).toBe(true);
		st.setAttrs(null);
		expect(useRtcAttrClipboard.getState().attrs).toBeNull();
	});
});
