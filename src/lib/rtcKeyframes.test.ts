import { describe, it, expect } from "vitest";
import type { RtcDoc, RtcKeyframe, RtcSegment, RtcTrack } from "@/types/rtc";
import { DEFAULT_RTC_TRANSFORM, segTransform } from "@/types/rtc";
import { SCALE_MAX, SCALE_MIN, POS_RATIO_LIMIT } from "./rtcTransformCore";
import {
	KF_TOLERANCE_US,
	addKeyframe,
	allKeyframeTimes,
	applyTransformPatchAt,
	applyTransformAt,
	clampKfValue,
	effectiveTransformAt,
	effectiveVolumeAt,
	hasSegKeyframes,
	keyframeNear,
	moveKeyframe,
	removeKeyframe,
	sampleKeyframes,
	sanitizeKeyframes,
	sanitizeSegKeyframes,
	splitKeyframes,
	toJyCommonKeyframes,
	toggleKeyframeAtPlayhead,
} from "./rtcKeyframes";

// ── 造数据 ──────────────────────────────────────────────

function seg(p: Partial<RtcSegment>): RtcSegment {
	return {
		id: p.id || "seg-1",
		kind: p.kind ?? "media",
		media: p.media ?? "video",
		targetStartUs: p.targetStartUs ?? 0,
		targetDurationUs: p.targetDurationUs ?? 10_000_000,
		...p,
	};
}

function docOf(segments: RtcSegment[]): RtcDoc {
	const track: RtcTrack = { id: "t1", type: "video", segments };
	return { id: "rtc", name: "测试", fps: 30, tracks: [track] };
}

const kf = (t: number, v: number): RtcKeyframe => ({ t, v });

/** 计数器 uuid（导出测试用，稳定可断言） */
function counterUuid() {
	let n = 0;
	return () => `uuid-${++n}`;
}

// ── 清洗与采样 ──────────────────────────────────────────

describe("rtcKeyframes · sanitize", () => {
	it("滤非有限值、t 钳非负取整、排序、同 t 去重（后者胜）", () => {
		const out = sanitizeKeyframes("x", [
			kf(5_000_000, 0.2),
			kf(Number.NaN, 1),
			kf(-100, 0.5), // t 钳到 0
			kf(0, 0.1), // 与上一条同落 t=0 → 后者胜
			{ t: 1_000_000, v: "junk" } as unknown as RtcKeyframe,
		]);
		expect(out).toEqual([kf(0, 0.1), kf(5_000_000, 0.2)]);
	});

	it("值域与 rtcTransformCore 同一把尺：scale/位置/不透明度各按各的夹取", () => {
		expect(clampKfValue("scale", 999)).toBe(SCALE_MAX);
		expect(clampKfValue("scale", 0)).toBe(SCALE_MIN);
		expect(clampKfValue("x", 99)).toBe(POS_RATIO_LIMIT);
		expect(clampKfValue("opacity", 2)).toBe(1);
		expect(clampKfValue("volume", -1)).toBe(0);
		// rotation 刻意不回卷（365° 应短路顺转，回卷成 5° 会倒着转一圈）
		expect(clampKfValue("rotation", 365)).toBe(365);
	});

	it("sanitizeSegKeyframes：未知属性丢弃、空组丢字段、全空 undefined", () => {
		expect(sanitizeSegKeyframes({ bogus: [kf(0, 1)], x: [] })).toBeUndefined();
		const out = sanitizeSegKeyframes({ x: [kf(0, 0.5)], bogus: [kf(0, 1)] });
		expect(Object.keys(out!)).toEqual(["x"]);
	});
});

describe("rtcKeyframes · sampleKeyframes（线性插值）", () => {
	const list = [kf(0, 0), kf(4_000_000, 1)];

	it("中点线性插值；首尾之外取端值", () => {
		expect(sampleKeyframes(list, 2_000_000)).toBeCloseTo(0.5);
		expect(sampleKeyframes(list, -1)).toBe(0);
		expect(sampleKeyframes(list, 9_000_000)).toBe(1);
	});

	it("容忍未排序输入（载入数据未必清洗过）", () => {
		expect(sampleKeyframes([kf(4_000_000, 1), kf(0, 0)], 1_000_000)).toBeCloseTo(0.25);
	});

	it("空/缺省 → null（调用方回退基础值）", () => {
		expect(sampleKeyframes(undefined, 0)).toBeNull();
		expect(sampleKeyframes([], 0)).toBeNull();
	});
});

// ── 生效值解算 ──────────────────────────────────────────

describe("rtcKeyframes · effectiveTransformAt", () => {
	it("无关键帧 → 与 segTransform 同一结果（缺省片段=同一引用，原路径零变化）", () => {
		const s = seg({});
		expect(effectiveTransformAt(s, 0)).toBe(segTransform(s));
		expect(effectiveTransformAt(seg({}), 123)).toBe(DEFAULT_RTC_TRANSFORM);
	});

	it("x/y/rotation/opacity：有帧属性覆盖、无帧属性保持基础值", () => {
		const s = seg({
			transform: { ...DEFAULT_RTC_TRANSFORM, x: 0.1, rotation: 45 },
			keyframes: { y: [kf(0, 0), kf(2_000_000, 0.4)] },
		});
		const out = effectiveTransformAt(s, 1_000_000);
		expect(out.y).toBeCloseTo(0.2); // 关键帧插值
		expect(out.x).toBeCloseTo(0.1); // 无帧 → 基础值
		expect(out.rotation).toBe(45);
	});

	it("scale=等比单值取 scaleX 基准：scaleY 按基础 Y/X 比跟随", () => {
		const s = seg({
			transform: { ...DEFAULT_RTC_TRANSFORM, scaleX: 1, scaleY: 2 }, // 基础 Y/X = 2
			keyframes: { scale: [kf(0, 1), kf(2_000_000, 3)] },
		});
		const out = effectiveTransformAt(s, 1_000_000); // 采样 scale=2
		expect(out.scaleX).toBeCloseTo(2);
		expect(out.scaleY).toBeCloseTo(4); // 跟随比例 ×2
	});
});

describe("rtcKeyframes · effectiveVolumeAt", () => {
	it("volume 帧覆盖；无帧=片段基础音量（缺省 1）", () => {
		expect(effectiveVolumeAt(seg({}), 0)).toBe(1);
		expect(effectiveVolumeAt(seg({ volume: 0.4 }), 0)).toBe(0.4);
		const s = seg({ volume: 0.4, keyframes: { volume: [kf(0, 1), kf(2_000_000, 0)] } });
		expect(effectiveVolumeAt(s, 1_000_000)).toBeCloseTo(0.5);
	});
});

// ── doc 级操作 ──────────────────────────────────────────

describe("rtcKeyframes · add/remove/move/toggle", () => {
	it("addKeyframe：插入排序；容差内已有帧 → 改值不加帧；值未变 → 原 doc 引用", () => {
		const d0 = docOf([seg({ id: "s" })]);
		const d1 = addKeyframe(d0, "s", "x", 2_000_000, 0.3);
		const d2 = addKeyframe(d1, "s", "x", 0, 0.1);
		const list = d2.tracks[0].segments[0].keyframes!.x!;
		expect(list).toEqual([kf(0, 0.1), kf(2_000_000, 0.3)]);
		// 容差内（KF_TOLERANCE_US）命中 → 覆盖值，不新增
		const d3 = addKeyframe(d2, "s", "x", 2_000_000 + KF_TOLERANCE_US / 2, 0.9);
		expect(d3.tracks[0].segments[0].keyframes!.x).toEqual([kf(0, 0.1), kf(2_000_000, 0.9)]);
		// 值未变 → no-op 原引用
		expect(addKeyframe(d3, "s", "x", 2_000_000, 0.9)).toBe(d3);
		// 片段未找到 → 原引用
		expect(addKeyframe(d3, "missing", "x", 0, 0.5)).toBe(d3);
	});

	it("removeKeyframe：删光该属性丢字段、全删光丢 keyframes 字段（与从未打过同形）", () => {
		let d = docOf([seg({ id: "s", keyframes: { x: [kf(0, 0.1)], opacity: [kf(0, 0.5)] } })]);
		d = removeKeyframe(d, "s", "x", 0);
		expect(d.tracks[0].segments[0].keyframes!.x).toBeUndefined();
		expect(d.tracks[0].segments[0].keyframes!.opacity).toBeDefined();
		d = removeKeyframe(d, "s", "opacity", 0);
		expect("keyframes" in d.tracks[0].segments[0]).toBe(false);
		// 未命中 → 原引用
		expect(removeKeyframe(d, "s", "x", 0)).toBe(d);
	});

	it("moveKeyframe：平移保值；目标位已有帧被顶掉", () => {
		let d = docOf([seg({ id: "s", keyframes: { x: [kf(0, 0.1), kf(2_000_000, 0.3)] } })]);
		d = moveKeyframe(d, "s", "x", 0, 1_000_000);
		expect(d.tracks[0].segments[0].keyframes!.x).toEqual([kf(1_000_000, 0.1), kf(2_000_000, 0.3)]);
		d = moveKeyframe(d, "s", "x", 1_000_000, 2_000_000); // 顶掉 0.3
		expect(d.tracks[0].segments[0].keyframes!.x).toEqual([kf(2_000_000, 0.1)]);
	});

	it("toggleKeyframeAtPlayhead：无帧=以当下生效值加帧（零跳变）、有帧=删；播放头按绝对时刻换算", () => {
		const s = seg({ id: "s", targetStartUs: 5_000_000, transform: { ...DEFAULT_RTC_TRANSFORM, x: 0.25 } });
		let d = docOf([s]);
		d = toggleKeyframeAtPlayhead(d, "s", "x", 7_000_000); // 相对 2s
		expect(d.tracks[0].segments[0].keyframes!.x).toEqual([kf(2_000_000, 0.25)]); // 值=当下生效值
		d = toggleKeyframeAtPlayhead(d, "s", "x", 7_000_000);
		expect("keyframes" in d.tracks[0].segments[0]).toBe(false);
	});

	it("toggleKeyframeAtPlayhead：scale 取生效 scaleX、volume 取生效音量", () => {
		const s = seg({ id: "s", volume: 0.6, transform: { ...DEFAULT_RTC_TRANSFORM, scaleX: 1.5, scaleY: 1.5 } });
		let d = docOf([s]);
		d = toggleKeyframeAtPlayhead(d, "s", "scale", 0);
		d = toggleKeyframeAtPlayhead(d, "s", "volume", 0);
		const out = d.tracks[0].segments[0].keyframes!;
		expect(out.scale).toEqual([kf(0, 1.5)]);
		expect(out.volume).toEqual([kf(0, 0.6)]);
	});
});

describe("rtcKeyframes · applyTransformPatchAt（关键帧感知写入）", () => {
	it("无关键帧片段：与旧「storeTransform 基础写入」同语义（缺省形态不落 transform 字段）", () => {
		let d = docOf([seg({ id: "s" })]);
		d = applyTransformPatchAt(d, "s", { x: 0.2 }, 0);
		expect(d.tracks[0].segments[0].transform!.x).toBe(0.2);
		// 调回缺省 → 字段整个消失（与从未调过同形）
		d = applyTransformPatchAt(d, "s", { x: 0 }, 0);
		expect("transform" in d.tracks[0].segments[0]).toBe(false);
	});

	it("有关键帧的属性 → 在播放头时刻写帧、基础值不动；无帧属性照旧写基础", () => {
		let d = docOf([seg({ id: "s", keyframes: { x: [kf(0, 0)] } })]);
		d = applyTransformPatchAt(d, "s", { x: 0.3, rotation: 90 }, 2_000_000);
		const out = d.tracks[0].segments[0];
		expect(out.keyframes!.x).toEqual([kf(0, 0), kf(2_000_000, 0.3)]); // x 走帧
		expect(out.transform!.rotation).toBe(90); // rotation 走基础
		expect(out.transform!.x).toBe(0); // 基础 x 不动（缺省 0 → storeTransform 不落 x≠0）
	});

	it("等比缩放（scaleX=scaleY 同值）且有 scale 帧 → 只写 scale 帧，不污染基础 transform", () => {
		let d = docOf([seg({ id: "s", keyframes: { scale: [kf(0, 1)] } })]);
		d = applyTransformPatchAt(d, "s", { scaleX: 2, scaleY: 2 }, 1_000_000);
		const out = d.tracks[0].segments[0];
		expect(out.keyframes!.scale).toEqual([kf(0, 1), kf(1_000_000, 2)]);
		expect("transform" in out).toBe(false);
	});

	it("applyTransformAt：整份变换按同规则分账（预览拖动 pointerup 用）", () => {
		let d = docOf([seg({ id: "s", keyframes: { y: [kf(0, 0)] } })]);
		const t = { ...DEFAULT_RTC_TRANSFORM, y: 0.4, x: 0.1 };
		d = applyTransformAt(d, "s", t, 3_000_000);
		const out = d.tracks[0].segments[0];
		expect(out.keyframes!.y).toEqual([kf(0, 0), kf(3_000_000, 0.4)]);
		expect(out.transform!.x).toBe(0.1);
	});
});

// ── 辅助查询 / 分割 ──────────────────────────────────────

describe("rtcKeyframes · keyframeNear / allKeyframeTimes / hasSegKeyframes", () => {
	it("keyframeNear：容差内最近命中；allKeyframeTimes：跨属性并集升序去重", () => {
		const s = seg({ keyframes: { x: [kf(0, 0), kf(2_000_000, 1)], opacity: [kf(2_000_000, 0.5), kf(3_000_000, 1)] } });
		expect(keyframeNear(s.keyframes!.x, 10_000)?.t).toBe(0);
		expect(keyframeNear(s.keyframes!.x, 1_000_000)).toBeNull();
		expect(allKeyframeTimes(s)).toEqual([0, 2_000_000, 3_000_000]);
		expect(hasSegKeyframes(s)).toBe(true);
		expect(hasSegKeyframes(seg({}))).toBe(false);
		expect(hasSegKeyframes(seg({ keyframes: { x: [] } }))).toBe(false);
	});
});

describe("rtcKeyframes · splitKeyframes（定格分割的关键帧分账）", () => {
	it("左收 t≤切点、右收 t≥切点（右侧平移）；跨切点补采样边界帧（分割前后动画逐帧不变）", () => {
		const rec = { x: [kf(0, 0), kf(4_000_000, 1)] };
		const [l, r] = splitKeyframes(rec, 2_000_000);
		expect(l!.x).toEqual([kf(0, 0), kf(2_000_000, 0.5)]); // 左末=切点采样值
		expect(r!.x).toEqual([kf(0, 0.5), kf(2_000_000, 1)]); // 右首=切点采样值、其余平移
	});

	it("单侧分不到帧 → 补常量边界帧（覆盖语义两半都保住，不跳回基础值）；无 keyframes → 双 undefined", () => {
		const [l, r] = splitKeyframes({ x: [kf(0, 0.3)] }, 2_000_000);
		expect(l!.x).toEqual([kf(0, 0.3)]);
		expect(r!.x).toEqual([kf(0, 0.3)]); // 右半常量帧：原动画在切点后的持有值
		// 全部帧在切点之后 → 左半补首帧值的常量帧
		const [l2, r2] = splitKeyframes({ y: [kf(3_000_000, 0.4)] }, 2_000_000);
		expect(l2!.y).toEqual([kf(0, 0.4)]);
		expect(r2!.y).toEqual([kf(1_000_000, 0.4)]);
		expect(splitKeyframes(undefined, 0)).toEqual([undefined, undefined]);
	});
});

// ── 剪映导出 ──────────────────────────────────────────

describe("rtcKeyframes · toJyCommonKeyframes（剪映 common_keyframes）", () => {
	it("property_type 映射 + 位置单位换算（×2 半画幅、y 取负）+ pyJianYingDraft 逐键同形", () => {
		const s = seg({
			targetDurationUs: 4_000_000,
			keyframes: {
				x: [kf(0, 0.25)],
				y: [kf(0, 0.25)],
				scale: [kf(0, 1.5)],
				rotation: [kf(0, 90)],
				opacity: [kf(0, 0.5)],
				volume: [kf(0, 0.8)],
			},
		});
		const out = toJyCommonKeyframes(s, "video", counterUuid());
		const byProp = Object.fromEntries(out.map((o) => [o.property_type as string, o]));
		expect(Object.keys(byProp).sort()).toEqual(
			["KFTypeAlpha", "KFTypePositionX", "KFTypePositionY", "KFTypeRotation", "KFTypeScaleX", "KFTypeVolume"].sort(),
		);
		const firstKf = (p: string) => (byProp[p].keyframe_list as Record<string, unknown>[])[0];
		expect(firstKf("KFTypePositionX").values).toEqual([0.5]); // 0.25 比例 → ×2 半画幅
		expect(firstKf("KFTypePositionY").values).toEqual([-0.5]); // y 取负（剪映 y 正向上）
		expect(firstKf("KFTypeScaleX").values).toEqual([1.5]);
		expect(firstKf("KFTypeRotation").values).toEqual([90]);
		expect(firstKf("KFTypeAlpha").values).toEqual([0.5]);
		expect(firstKf("KFTypeVolume").values).toEqual([0.8]);
		// 单帧 JSON 逐键同形（pyJianYingDraft Keyframe.export_json）
		expect(firstKf("KFTypePositionX")).toEqual({
			curveType: "Line",
			graphID: "",
			left_control: { x: 0, y: 0 },
			right_control: { x: 0, y: 0 },
			id: expect.stringMatching(/^uuid-/),
			time_offset: 0,
			values: [0.5],
		});
		// 列表 JSON 含 material_id:""（pyJianYingDraft Keyframe_list.export_json 同形）
		expect(byProp.KFTypePositionX.material_id).toBe("");
	});

	it("音频片段只导 volume；无关键帧片段恒 []（存量草稿零变化）", () => {
		const s = seg({
			media: "audio",
			keyframes: { volume: [kf(0, 1), kf(1_000_000, 0)], x: [kf(0, 0.5)] },
		});
		const out = toJyCommonKeyframes(s, "audio", counterUuid());
		expect(out).toHaveLength(1);
		expect(out[0].property_type).toBe("KFTypeVolume");
		expect(toJyCommonKeyframes(seg({}), "video", counterUuid())).toEqual([]);
	});

	it("越界帧钳制：t>时长的帧不原样导出，改在 duration 处补采样边界帧（与渲染端钳制一致）", () => {
		// 片段被裁到 2s，动画原本 0→4s：导出应为 [0, v0] 与 [2s, 采样(2s)=0.5]
		const s = seg({ targetDurationUs: 2_000_000, keyframes: { opacity: [kf(0, 0), kf(4_000_000, 1)] } });
		const out = toJyCommonKeyframes(s, "video", counterUuid());
		const list = out[0].keyframe_list as Record<string, unknown>[];
		expect(list.map((k) => k.time_offset)).toEqual([0, 2_000_000]);
		expect((list[1].values as number[])[0]).toBeCloseTo(0.5);
	});
});
