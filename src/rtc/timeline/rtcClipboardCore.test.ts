import { describe, expect, it } from "vitest";
import { buildClipEntries, copiedSegTemplate, duplicateAnchorUs, materializePasteEntries } from "./rtcClipboardCore";
import { pasteSegments } from "@/lib/rtcOps";
import type { RtcDoc, RtcSegment } from "@/types/rtc";

const SEC = 1_000_000;

function seg(id: string, startUs: number, durUs: number, extra: Partial<RtcSegment> = {}): RtcSegment {
	return { id, kind: "media", media: "video", targetStartUs: startUs, targetDurationUs: durUs, ...extra };
}

function doc(...tracks: Array<{ id: string; type?: "video" | "audio" | "text"; segments: RtcSegment[] }>): RtcDoc {
	return {
		id: "d1",
		name: "t",
		fps: 30,
		tracks: tracks.map((t) => ({ id: t.id, type: t.type ?? "video", segments: t.segments })),
	};
}

describe("rtcClipboardCore copiedSegTemplate", () => {
	it("剥 id 与在途状态；素材引用（assetId/uri）原样共享——绝不复制素材实体", () => {
		const s = seg("s1", SEC, 2 * SEC, {
			assetId: "C00000001",
			uri: "asset://x.mp4",
			name: "镜头1",
			sourceStartUs: 500_000,
			sourceDurationUs: 2 * SEC,
			speed: 2,
			volume: 0.5,
			muted: true,
		});
		const t = copiedSegTemplate(s);
		expect("id" in t).toBe(false);
		expect(t.assetId).toBe("C00000001"); // 同一素材，导出仍按 assetId 去重成单条 material
		expect(t.uri).toBe("asset://x.mp4");
		expect(t).toMatchObject({ name: "镜头1", sourceStartUs: 500_000, speed: 2, volume: 0.5, muted: true });
	});

	it("⚠ 在途占位的 status/progress/taskRef/error/originSegId 一律不继承，落成干净 pending", () => {
		const ph = seg("p1", 0, 3 * SEC, {
			kind: "placeholder",
			media: undefined,
			genKind: "video",
			shotRef: { episodeId: "ep1", shotId: "sh1" },
			status: "running",
			progress: 42,
			taskRef: "pending-123",
			error: "上一次失败了",
			originSegId: "old-seg",
		});
		const t = copiedSegTemplate(ph);
		expect(t.status).toBe("pending"); // 干净占位：还没提交过，用户点生成即可
		expect(t.progress).toBeUndefined();
		expect(t.taskRef).toBeUndefined(); // 不会与原片段抢同一个生成任务
		expect(t.error).toBeUndefined();
		expect(t.originSegId).toBeUndefined();
		expect(t.shotRef).toEqual({ episodeId: "ep1", shotId: "sh1" }); // 分镜引用保留
		expect(t.genKind).toBe("video");
	});

	it("media 片段不被塞 status（只有占位才有生成状态）", () => {
		expect(copiedSegTemplate(seg("s1", 0, SEC)).status).toBeUndefined();
	});
});

describe("rtcClipboardCore buildClipEntries", () => {
	const d = doc(
		{ id: "v1", segments: [seg("a", 2 * SEC, SEC), seg("b", 6 * SEC, SEC)] },
		{ id: "a1", type: "audio", segments: [seg("m", 4 * SEC, 2 * SEC, { media: "audio" })] },
	);

	it("跨轨收集、按起点升序、偏移相对整批最早起点（保持相对时间关系）", () => {
		const entries = buildClipEntries(d, ["b", "m", "a"]);
		expect(entries.map((e) => [e.trackId, e.trackType, e.offsetUs / SEC])).toEqual([
			["v1", "video", 0], // a@2s = 锚点
			["a1", "audio", 2], // m@4s
			["v1", "video", 4], // b@6s
		]);
	});

	it("一条都没命中返回空数组（调用方据此不动剪贴板）", () => {
		expect(buildClipEntries(d, ["nope"])).toEqual([]);
		expect(buildClipEntries(d, [])).toEqual([]);
	});
});

describe("rtcClipboardCore materializePasteEntries + 与 pasteSegments 的往返", () => {
	it("每条现分配新 id，绝不复用原 id", () => {
		const entries = buildClipEntries(doc({ id: "v1", segments: [seg("a", 0, SEC), seg("b", 2 * SEC, SEC)] }), ["a", "b"]);
		let n = 0;
		const prepared = materializePasteEntries(entries, () => `new-${++n}`);
		expect(prepared.map((p) => p.seg.id)).toEqual(["new-1", "new-2"]);
		expect(prepared[0].seg.assetId).toBeUndefined();
	});

	it("复制 → 粘到播放头：整批相对关系原样保持，原片段不动", () => {
		const src = doc({ id: "v1", segments: [seg("a", 2 * SEC, SEC), seg("b", 6 * SEC, SEC)] });
		const entries = buildClipEntries(src, ["a", "b"]);
		let n = 0;
		const prepared = materializePasteEntries(entries, () => `new-${++n}`);
		const pasted = pasteSegments(src, prepared, 10 * SEC);
		expect(pasted.tracks[0].segments.map((s) => [s.id, s.targetStartUs / SEC])).toEqual([
			["a", 2],
			["b", 6],
			["new-1", 10],
			["new-2", 14], // 与 new-1 相距 4s = 原 a↔b 的间距
		]);
	});
});

describe("rtcClipboardCore duplicateAnchorUs", () => {
	it("= 选区最右缘（与播放头无关）；选区为空返回 null", () => {
		const d = doc(
			{ id: "v1", segments: [seg("a", 0, 2 * SEC), seg("b", 5 * SEC, SEC)] },
			{ id: "a1", type: "audio", segments: [seg("m", 1 * SEC, 2 * SEC, { media: "audio" })] },
		);
		expect(duplicateAnchorUs(d, ["a"])).toBe(2 * SEC);
		expect(duplicateAnchorUs(d, ["a", "m"])).toBe(3 * SEC); // 跨轨取最右
		expect(duplicateAnchorUs(d, ["a", "b"])).toBe(6 * SEC);
		expect(duplicateAnchorUs(d, [])).toBeNull();
		expect(duplicateAnchorUs(d, ["nope"])).toBeNull();
	});
});
