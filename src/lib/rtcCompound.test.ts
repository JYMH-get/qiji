import { describe, expect, it } from "vitest";
import type { RtcDoc, RtcSegment, RtcTrack } from "@/types/rtc";
import {
	activeViewDoc,
	createCompound,
	dissolveCompound,
	nextCompoundName,
	sanitizeRtcCompound,
	subDocDurationUs,
} from "./rtcCompound";
import { splitSegment, trimSegment } from "./rtcOps";

const SEC = 1_000_000;

function seg(id: string, startUs: number, durUs: number, extra: Partial<RtcSegment> = {}): RtcSegment {
	return {
		id,
		kind: "media",
		media: "video",
		assetId: `A-${id}`,
		uri: `u://${id}`,
		targetStartUs: startUs,
		targetDurationUs: durUs,
		sourceStartUs: 0,
		sourceDurationUs: durUs,
		...extra,
	};
}

function track(id: string, type: RtcTrack["type"], segments: RtcSegment[], extra: Partial<RtcTrack> = {}): RtcTrack {
	return { id, type, segments, ...extra };
}

function doc(...tracks: RtcTrack[]): RtcDoc {
	return { id: "d1", name: "t", fps: 30, tracks };
}

function findSeg(d: RtcDoc, id: string): { seg: RtcSegment; trackId: string } | null {
	for (const t of d.tracks) {
		const s = t.segments.find((x) => x.id === id);
		if (s) return { seg: s, trackId: t.id };
	}
	return null;
}

function compoundOf(d: RtcDoc): { seg: RtcSegment; trackId: string } {
	for (const t of d.tracks) {
		const s = t.segments.find((x) => x.kind === "compound");
		if (s) return { seg: s, trackId: t.id };
	}
	throw new Error("no compound segment");
}

describe("createCompound 创建复合片段", () => {
	it("跨轨多选：选中片段移入子文档（相对时间保持、整体左移到 0）+ 原位替换为 compound", () => {
		const d = doc(
			track("v1", "video", [seg("a", 2 * SEC, 3 * SEC), seg("keep", 10 * SEC, 2 * SEC)]),
			track("v2", "video", [seg("b", 4 * SEC, 4 * SEC)]),
			track("au", "audio", [seg("snd", 3 * SEC, 2 * SEC, { media: "audio" })]),
		);
		const next = createCompound(d, ["a", "b", "snd"], { segId: "comp", subDocId: "sub1", name: "复A" });
		expect(next).not.toBe(d);
		// 选中片段从主轨消失，未选中的保留
		expect(findSeg(next, "a")).toBeNull();
		expect(findSeg(next, "b")).toBeNull();
		expect(findSeg(next, "snd")).toBeNull();
		expect(findSeg(next, "keep")).not.toBeNull();
		// 子文档：3 条子轨（v1/v2/au 各一条），相对时间 = 原始 − minStart(2s)
		const sub = next.subDocs!.sub1;
		expect(sub.name).toBe("复A");
		expect(sub.tracks.map((t) => t.type)).toEqual(["video", "video", "audio"]);
		const subSegs = sub.tracks.flatMap((t) => t.segments);
		expect(subSegs.find((s) => s.id === "a")!.targetStartUs).toBe(0);
		expect(subSegs.find((s) => s.id === "b")!.targetStartUs).toBe(2 * SEC);
		expect(subSegs.find((s) => s.id === "snd")!.targetStartUs).toBe(1 * SEC);
		// compound：包络 [2s, 8s) → target [2s, 6s)，source [0, 6s)
		const c = findSeg(next, "comp")!;
		expect(c.seg.kind).toBe("compound");
		expect(c.seg.subDocId).toBe("sub1");
		expect(c.seg.targetStartUs).toBe(2 * SEC);
		expect(c.seg.targetDurationUs).toBe(6 * SEC);
		expect(c.seg.sourceStartUs).toBe(0);
		expect(c.seg.sourceDurationUs).toBe(6 * SEC);
		expect(subDocDurationUs(sub)).toBe(6 * SEC);
	});

	it("宿主轨 = 选区**最上层**片段所在轨（显示序：非主视频轨在主轨之上）", () => {
		const d = doc(
			track("v1", "video", [seg("low", 0, 3 * SEC)]),
			track("v2", "video", [seg("hi", 1 * SEC, 3 * SEC)]),
		);
		const next = createCompound(d, ["low", "hi"], { segId: "comp" });
		expect(compoundOf(next).trackId).toBe("v2"); // v2 显示在 v1 之上
	});

	it("含占位符 / 含复合片段（嵌套深度 1）/ id 找不到 / 空选区 → 一律原引用 no-op", () => {
		const ph = doc(track("v1", "video", [seg("p", 0, SEC, { kind: "placeholder", media: undefined })]));
		expect(createCompound(ph, ["p"])).toBe(ph);
		const base = createCompound(
			doc(track("v1", "video", [seg("a", 0, SEC)])),
			["a"],
			{ segId: "c1", subDocId: "s1" },
		);
		expect(createCompound(base, ["c1"])).toBe(base); // 复合再打包=嵌套深度 2，拒绝
		const d = doc(track("v1", "video", [seg("a", 0, SEC)]));
		expect(createCompound(d, ["a", "ghost"])).toBe(d);
		expect(createCompound(d, [])).toBe(d);
	});

	it("包络被宿主轨未选中片段占住 → compound 夹到最近空隙（不推挤）", () => {
		const d = doc(
			track("v1", "video", [
				seg("a", 0, 2 * SEC),
				seg("blocker", 2 * SEC, 3 * SEC), // 未选中，占住包络 [0,10) 的中段
				seg("b", 6 * SEC, 4 * SEC),
			]),
		);
		const next = createCompound(d, ["a", "b"], { segId: "comp" });
		const c = findSeg(next, "comp")!;
		// 期望起点 0、时长 10s，被 blocker 占住 → 只能落尾部空隙（blocker 之后）
		expect(c.seg.targetStartUs).toBeGreaterThanOrEqual(5 * SEC);
		expect(findSeg(next, "blocker")!.seg.targetStartUs).toBe(2 * SEC); // 绝不推挤
	});

	it("nextCompoundName 按子文档数递增", () => {
		const d = doc(track("v1", "video", [seg("a", 0, SEC)]));
		expect(nextCompoundName(d)).toBe("复合片段1");
		const next = createCompound(d, ["a"]);
		expect(nextCompoundName(next)).toBe("复合片段2");
	});
});

describe("dissolveCompound 解散（创建↔解散往返）", () => {
	it("往返：创建后立即解散 → 片段回到原位（同 id、同时间、同轨类型）", () => {
		const d = doc(
			track("v1", "video", [seg("a", 2 * SEC, 3 * SEC), seg("keep", 10 * SEC, 2 * SEC)]),
			track("au", "audio", [seg("snd", 3 * SEC, 2 * SEC, { media: "audio" })]),
		);
		const packed = createCompound(d, ["a", "snd"], { segId: "comp" });
		const back = dissolveCompound(packed, "comp");
		const a = findSeg(back, "a")!;
		expect(a.seg.targetStartUs).toBe(2 * SEC); // offset(2s) + 子内 0
		const snd = findSeg(back, "snd")!;
		expect(snd.seg.targetStartUs).toBe(3 * SEC);
		expect(back.subDocs?.["comp"]).toBeUndefined();
		expect(Object.keys(back.subDocs ?? {})).toHaveLength(0);
		expect(findSeg(back, "comp")).toBeNull();
	});

	it("目标轨被占（重叠）→ 整条子轨就近落到新建同类型轨道", () => {
		const d = doc(track("v1", "video", [seg("a", 0, 3 * SEC)]));
		const packed = createCompound(d, ["a"], { segId: "comp", subDocId: "s1" });
		// 人为在宿主轨补一个与恢复位置重叠的占位者（blocker 占住 [0,3)，comp 挪到 5s）
		const arranged: RtcDoc = {
			...packed,
			tracks: packed.tracks.map((t) =>
				t.id === "v1"
					? { ...t, segments: [seg("blocker", 0, 3 * SEC), { ...compoundOf(packed).seg, targetStartUs: 0 }] }
					: t,
			),
		};
		const back = dissolveCompound(arranged, "comp");
		const a = findSeg(back, "a")!;
		expect(a.seg.targetStartUs).toBe(0);
		expect(a.trackId).not.toBe("v1"); // 原轨被 blocker 占住 → 新建轨
		expect(back.tracks.filter((t) => t.type === "video")).toHaveLength(2);
	});

	it("分割共享的子文档：解散其一 → 子文档保留、恢复片段用新 id；解散另一半 → 子文档删除", () => {
		const d = doc(track("v1", "video", [seg("a", 0, 4 * SEC)]));
		const packed = createCompound(d, ["a"], { segId: "comp", subDocId: "s1" });
		const split = splitSegment(packed, "comp", 2 * SEC);
		const compSegs = split.tracks[0].segments.filter((s) => s.kind === "compound");
		expect(compSegs).toHaveLength(2);
		expect(compSegs[0].subDocId).toBe("s1");
		expect(compSegs[1].subDocId).toBe("s1"); // ⚠ 共享同一 subDoc，绝不复制
		const afterOne = dissolveCompound(split, compSegs[0].id);
		expect(afterOne.subDocs?.s1).toBeDefined(); // 另一半还引用着
		expect(findSeg(afterOne, "a")).toBeNull(); // 恢复片段换了新 id（防主/子同 id 并存）
		const restored = afterOne.tracks.flatMap((t) => t.segments).filter((s) => s.kind === "media");
		expect(restored).toHaveLength(1);
		const afterBoth = dissolveCompound(afterOne, compSegs[1].id);
		expect(afterBoth.subDocs?.s1).toBeUndefined();
	});

	it("非 compound / 找不到 / 子文档缺失 → 原引用 no-op", () => {
		const d = doc(track("v1", "video", [seg("a", 0, SEC)]));
		expect(dissolveCompound(d, "a")).toBe(d);
		expect(dissolveCompound(d, "ghost")).toBe(d);
		const dangling = doc(track("v1", "video", [seg("c", 0, SEC, { kind: "compound", subDocId: "nope", assetId: undefined })]));
		expect(dissolveCompound(dangling, "c")).toBe(dangling);
	});
});

describe("compound 片段的 移动/裁剪/分割（rtcOps 窗口语义）", () => {
	function packedDoc() {
		const d = doc(track("v1", "video", [seg("a", 0, 6 * SEC)]));
		return createCompound(d, ["a"], { segId: "comp", subDocId: "s1" });
	}

	it("分割：两半共享同一 subDocId，source 窗口相邻互补（绝不复制 subDoc）", () => {
		const split = splitSegment(packedDoc(), "comp", 2 * SEC);
		const [l, r] = split.tracks[0].segments;
		expect(l.subDocId).toBe("s1");
		expect(r.subDocId).toBe("s1");
		expect(l.sourceStartUs).toBe(0);
		expect(l.sourceDurationUs).toBe(2 * SEC);
		expect(r.sourceStartUs).toBe(2 * SEC);
		expect(r.sourceDurationUs).toBe(4 * SEC);
		expect(Object.keys(split.subDocs!)).toEqual(["s1"]); // 子文档仍恰一份
	});

	it("裁剪左缘：source 窗口联动收缩；右缘外扩受子时长（sourceTotalUs）约束", () => {
		const trimmed = trimSegment(packedDoc(), "comp", "start", 1 * SEC);
		const c = compoundOf(trimmed).seg;
		expect(c.targetStartUs).toBe(1 * SEC);
		expect(c.sourceStartUs).toBe(1 * SEC);
		expect(c.sourceDurationUs).toBe(5 * SEC);
		// 右缘想外扩 3s，但子时长只有 6s（已用完）→ 被钳为 no-op
		const capped = trimSegment(packedDoc(), "comp", "end", 3 * SEC, { sourceTotalUs: 6 * SEC });
		expect(compoundOf(capped).seg.targetDurationUs).toBe(6 * SEC);
	});
});

describe("sanitizeRtcCompound 载入清洗", () => {
	it("无复合内容 → 原引用（零开销）", () => {
		const d = doc(track("v1", "video", [seg("a", 0, SEC)]));
		expect(sanitizeRtcCompound(d)).toBe(d);
	});

	it("孤儿子文档剔除；全部清空则摘除 subDocs 键", () => {
		const d: RtcDoc = {
			...doc(track("v1", "video", [seg("a", 0, SEC)])),
			subDocs: { orphan: { id: "orphan", name: "孤儿", tracks: [] } },
		};
		const out = sanitizeRtcCompound(d);
		expect(out).not.toBe(d);
		expect(out.subDocs).toBeUndefined();
	});

	it("compound 引用缺失子文档 → 降级为占位符（保留时间/名称）", () => {
		const d = doc(
			track("v1", "video", [seg("c", 2 * SEC, 3 * SEC, { kind: "compound", subDocId: "gone", name: "复X", assetId: undefined })]),
		);
		const out = sanitizeRtcCompound(d);
		const s = out.tracks[0].segments[0];
		expect(s.kind).toBe("placeholder");
		expect(s.subDocId).toBeUndefined();
		expect(s.name).toBe("复X");
		expect(s.targetStartUs).toBe(2 * SEC);
	});

	it("子文档内嵌套 compound → 降级为占位符（嵌套深度 1）；合法引用原样保留", () => {
		const d: RtcDoc = {
			...doc(track("v1", "video", [seg("c", 0, 4 * SEC, { kind: "compound", subDocId: "s1", assetId: undefined })])),
			subDocs: {
				s1: {
					id: "s1",
					name: "复A",
					tracks: [track("st", "video", [seg("inner", 0, SEC), seg("nested", SEC, SEC, { kind: "compound", subDocId: "s1", assetId: undefined })])],
				},
			},
		};
		const out = sanitizeRtcCompound(d);
		expect(out.tracks[0].segments[0].kind).toBe("compound"); // 合法引用保留
		const subSegs = out.subDocs!.s1.tracks[0].segments;
		expect(subSegs.find((s) => s.id === "inner")!.kind).toBe("media");
		expect(subSegs.find((s) => s.id === "nested")!.kind).toBe("placeholder");
		expect(subSegs.find((s) => s.id === "nested")!.subDocId).toBeUndefined();
	});

	it("形状坏掉的子文档条目剔除（其引用随之降级）", () => {
		const d: RtcDoc = {
			...doc(track("v1", "video", [seg("c", 0, SEC, { kind: "compound", subDocId: "bad", assetId: undefined })])),
			subDocs: { bad: { id: "bad", name: "坏" } as never },
		};
		const out = sanitizeRtcCompound(d);
		expect(out.subDocs).toBeUndefined();
		expect(out.tracks[0].segments[0].kind).toBe("placeholder");
	});
});

describe("activeViewDoc 编辑层视图", () => {
	it("主层/空 id → 原 doc；子层 → tracks 换子文档、fps/画幅随主文档；引用稳定（缓存）", () => {
		const base = createCompound(
			{ ...doc(track("v1", "video", [seg("a", 0, SEC)])), canvas: { width: 1080, height: 1920 } },
			["a"],
			{ segId: "comp", subDocId: "s1" },
		);
		expect(activeViewDoc(base, null)).toBe(base);
		expect(activeViewDoc(null, "s1")).toBeNull();
		const view = activeViewDoc(base, "s1")!;
		expect(view.tracks).toBe(base.subDocs!.s1.tracks);
		expect(view.fps).toBe(30);
		expect(view.canvas).toEqual({ width: 1080, height: 1920 });
		expect(activeViewDoc(base, "s1")).toBe(view); // 同 (doc, id) 恒同引用
		expect(activeViewDoc(base, "ghost")).toBe(base); // 子文档缺失 → 回退主层
	});
});
