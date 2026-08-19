import { describe, expect, it } from "vitest";
import {
	activeDecodeTrackIds,
	audiblePoolIds,
	collectAudibleAt,
	collectAudibleSegments,
	compoundSubTimeUs,
	coveredSegmentIds,
	docHasAnySegment,
	fitCanvasBox,
	mainVideoTrack,
	segmentAt,
	segmentRate,
	segmentVolume,
	sourceTimeSec,
	videoLayerSlotsBottomUp,
	videoLayerTracksBottomUp,
	videoStageAt,
} from "./rtcPlayback";
import type { RtcDoc, RtcSegment, RtcTrack } from "@/types/rtc";

const SEC = 1_000_000;

function seg(id: string, startUs: number, durUs: number, extra: Partial<RtcSegment> = {}): RtcSegment {
	return { id, kind: "media", media: "video", uri: `u://${id}`, targetStartUs: startUs, targetDurationUs: durUs, ...extra };
}

function track(id: string, type: RtcTrack["type"], segments: RtcSegment[], extra: Partial<RtcTrack> = {}): RtcTrack {
	return { id, type, segments, ...extra };
}

function doc(...tracks: RtcTrack[]): RtcDoc {
	return { id: "d1", name: "t", fps: 30, tracks };
}

describe("segmentAt 播放头活动片段", () => {
	const segs = [seg("a", 0, 5 * SEC), seg("b", 5 * SEC, 3 * SEC)];

	it("区间内命中；右缘开区间——交界时刻归后一段", () => {
		expect(segmentAt(segs, 0)?.id).toBe("a");
		expect(segmentAt(segs, 5 * SEC - 1)?.id).toBe("a");
		expect(segmentAt(segs, 5 * SEC)?.id).toBe("b"); // 交界：end 开、start 闭
		expect(segmentAt(segs, 8 * SEC)).toBeNull(); // 末尾右缘外
	});

	it("空隙与空轨返回 null", () => {
		const gappy = [seg("a", 0, 2 * SEC), seg("b", 4 * SEC, 2 * SEC)];
		expect(segmentAt(gappy, 3 * SEC)).toBeNull();
		expect(segmentAt([], 0)).toBeNull();
	});
});

/**
 * ⚠ 本组断言随本轮语义变更整体改写：旧语义是「主轨=第一条 video 轨、其余视频轨不参与预览」
 * （曾断言「v2 有片段但主轨是空隙 → 黑场」），用户实测报障后改为**多视频轨图层合成**——
 * 上层空隙必须透出下层。下面 a~e 五组直接对应用户报障的实测场景。
 */
describe("videoStageAt 多视频轨图层合成", () => {
	it("图层顺序自下而上：主轨（数组第一条 video）在最底，越晚建的 video 轨越靠上", () => {
		const d = doc(
			track("au", "audio", []),
			track("v1", "video", [seg("a", 0, 10 * SEC)]),
			track("v2", "video", [seg("x", 0, 10 * SEC)]),
			track("v3", "video", [seg("y", 0, 10 * SEC)]),
		);
		expect(mainVideoTrack(d)?.id).toBe("v1");
		expect(videoLayerTracksBottomUp(d).map((t) => t.id)).toEqual(["v1", "v2", "v3"]);
		const st = videoStageAt(d, SEC);
		expect(st.layers.map((l) => l.trackId)).toEqual(["v1", "v2", "v3"]);
		expect(st.layers.map((l) => l.layerIndex)).toEqual([0, 2, 4]); // 每轨多一个转场幽灵槽（#tr）
	});

	it("a) 上层有片段 → 上层在最上（下层同时有则两层都在）", () => {
		const d = doc(
			track("v1", "video", [seg("bottom", 0, 10 * SEC)]),
			track("v2", "video", [seg("top", 0, 4 * SEC)]),
		);
		const st = videoStageAt(d, SEC);
		expect(st.layers.map((l) => l.seg.id)).toEqual(["bottom", "top"]); // 末位=最上层
	});

	it("b) ⚠ 上层是空隙、下层有片段 → 必须取到下层（用户报障场景，锁死）", () => {
		// 复刻用户实测：视频轨1（上层，图片片段 0~5s）在 9.28s 处是空隙，
		// 视频轨2（下层）的「1集·分镜2」5.6~20.6s 覆盖该时刻 → 预览必须显示它，绝不黑屏
		const d = doc(
			track("v1", "video", [seg("shot2", 5_600_000, 15 * SEC)]),
			track("v2", "video", [seg("pic", 0, 5 * SEC, { media: "image" })]),
			track("au", "audio", [seg("bgm", 0, 20 * SEC, { media: "audio" })]),
		);
		const at8_29 = videoStageAt(d, 8_290_000);
		expect(at8_29.layers.map((l) => l.seg.id)).toEqual(["shot2"]); // 上层已过，只剩下层
		const at9_28 = videoStageAt(d, 9_280_000);
		expect(at9_28.layers.length).toBe(1);
		expect(at9_28.layers[0].seg.id).toBe("shot2");
		expect(at9_28.placeholder).toBeNull();
	});

	it("c) 上下层同时有片段 → 清单含两层且顺序正确（下→上）", () => {
		const d = doc(
			track("v1", "video", [seg("under", 0, 20 * SEC)]),
			track("v2", "video", [seg("over", 8 * SEC, 5 * SEC, { media: "image" })]),
		);
		const st = videoStageAt(d, 11_060_000); // 用户实测的 0:11.06
		expect(st.layers.map((l) => l.trackId)).toEqual(["v1", "v2"]);
		expect(st.layers.map((l) => l.media)).toEqual(["video", "image"]);
		expect(st.layers[1].layerIndex).toBeGreaterThan(st.layers[0].layerIndex);
	});

	it("d) 上层是未完成的占位 → 跳过它取下层；下层也没有时才作提示卡", () => {
		const d = doc(
			track("v1", "video", [seg("old", 0, 10 * SEC)]),
			track("v2", "video", [seg("ph", 0, 10 * SEC, { kind: "placeholder", media: undefined, uri: undefined, status: "running", name: "分镜1" })]),
		);
		const st = videoStageAt(d, SEC);
		expect(st.layers.map((l) => l.seg.id)).toEqual(["old"]); // 正在重新生成时仍放下层旧版本
		expect(st.placeholder).toBeNull(); // 有画面就不出提示卡
		// 下层空隙处才回落到占位提示卡
		const only = doc(track("v2", "video", [seg("ph", 0, 10 * SEC, { kind: "placeholder", media: undefined, uri: undefined })]));
		const st2 = videoStageAt(only, SEC);
		expect(st2.layers).toEqual([]);
		expect(st2.placeholder?.id).toBe("ph");
	});

	it("e) 全部层都没有片段 / 无视频轨 / media 无 uri → 黑场（零层）", () => {
		const d = doc(track("v1", "video", [seg("a", 0, 2 * SEC)]), track("v2", "video", [seg("b", 0, 2 * SEC)]));
		expect(videoStageAt(d, 5 * SEC).layers).toEqual([]);
		expect(videoStageAt(doc(track("au", "audio", [seg("a", 0, SEC, { media: "audio" })])), 0).layers).toEqual([]);
		// 无 uri 的 media 片段无从渲染 → 不成层（同样不该挡住下层）
		const noUri = doc(
			track("v1", "video", [seg("keep", 0, 5 * SEC)]),
			track("v2", "video", [seg("n", 0, 5 * SEC, { uri: undefined })]),
		);
		expect(videoStageAt(noUri, SEC).layers.map((l) => l.seg.id)).toEqual(["keep"]);
		// 视频轨上的音频等异常形态一律不上画面
		expect(videoStageAt(doc(track("v1", "video", [seg("aud", 0, 5 * SEC, { media: "audio" })])), SEC).layers).toEqual([]);
	});

	it("层内解算：sourceSec 按 sourceStartUs+speed 换算；muted=片段静音||轨道静音；图片层恒静音", () => {
		const d = doc(
			track("v1", "video", [seg("a", 0, 5 * SEC, { sourceStartUs: 10 * SEC, sourceDurationUs: 10 * SEC, speed: 2, volume: 0.5 })], { muted: true }),
			track("v2", "video", [seg("b", 0, 5 * SEC)]),
			track("v3", "video", [seg("c", 0, 5 * SEC, { muted: true })]),
			track("v4", "video", [seg("d", 0, 5 * SEC, { media: "image" })]),
		);
		const st = videoStageAt(d, 1_500_000);
		const byId = new Map(st.layers.map((l) => [l.seg.id, l]));
		expect(byId.get("a")!.sourceSec).toBe(13); // 10 + 1.5×2
		expect(byId.get("a")!.muted).toBe(true); // 轨道静音
		expect(byId.get("a")!.volume).toBe(0.5);
		expect(byId.get("a")!.rate).toBe(2);
		expect(byId.get("b")!.muted).toBe(false); // 未静音的视频层照常出声（含被遮住的层）
		expect(byId.get("c")!.muted).toBe(true); // 片段静音
		expect(byId.get("d")!.muted).toBe(true); // 图片层无声
	});
});

describe("fitCanvasBox 画幅框（定画幅，图层在框内合成）", () => {
	it("容器比画幅宽 → 按高铺满、左右留黑边并居中", () => {
		const b = fitCanvasBox(1000, 400, { width: 1920, height: 1080 });
		expect(b.height).toBe(400);
		expect(b.width).toBeCloseTo(711.111, 3); // 400 × 16/9
		expect(b.left).toBeCloseTo(144.444, 3); // 左右均分黑边
		expect(b.top).toBe(0);
	});

	it("容器比画幅高 → 按宽铺满、上下留黑边并居中", () => {
		expect(fitCanvasBox(400, 1000, { width: 1920, height: 1080 })).toEqual({ left: 0, top: 387.5, width: 400, height: 225 });
	});

	it("竖屏画幅 9:16 在宽容器里居中成竖条", () => {
		expect(fitCanvasBox(1000, 400, { width: 1080, height: 1920 })).toEqual({ left: 387.5, top: 0, width: 225, height: 400 });
	});

	it("比例正好一致 → 完全铺满零留白", () => {
		expect(fitCanvasBox(1920, 1080, { width: 1920, height: 1080 })).toEqual({ left: 0, top: 0, width: 1920, height: 1080 });
	});

	it("容器未测量 / 画幅非法 → 全 0（调用方回退铺满，不闪空）", () => {
		expect(fitCanvasBox(0, 0, { width: 1920, height: 1080 })).toEqual({ left: 0, top: 0, width: 0, height: 0 });
		expect(fitCanvasBox(800, 600, { width: 0, height: 1080 })).toEqual({ left: 0, top: 0, width: 0, height: 0 });
	});
});

describe("sourceTimeSec 源时间换算", () => {
	it("缺省 sourceStart/speed：相对偏移直换秒", () => {
		expect(sourceTimeSec(seg("a", 2 * SEC, 5 * SEC, { sourceStartUs: undefined, sourceDurationUs: undefined }), 3 * SEC)).toBe(1);
	});

	it("sourceStartUs + speed 加权：source = s0 + Δt×speed", () => {
		const s = seg("a", 0, 5 * SEC, { sourceStartUs: 10 * SEC, sourceDurationUs: 10 * SEC, speed: 2 });
		expect(sourceTimeSec(s, 1_500_000)).toBe(13); // 10 + 1.5×2
	});

	it("钳位：t 早于片段起点回 sourceStart；越过源窗口右缘钳到右缘", () => {
		const s = seg("a", 2 * SEC, 5 * SEC, { sourceStartUs: SEC, sourceDurationUs: 4 * SEC });
		expect(sourceTimeSec(s, 0)).toBe(1);
		expect(sourceTimeSec(s, 100 * SEC)).toBe(5); // 1 + 4 上限
	});
});

describe("collectAudibleSegments 应发声音频片段", () => {
	it("未静音音轨的区间内片段入选；track.muted 整轨跳过；seg.muted / 无 uri / placeholder 不入池", () => {
		const d = doc(
			track("v1", "video", [seg("v", 0, 10 * SEC)]),
			track("a1", "audio", [
				seg("hit", 0, 5 * SEC, { media: "audio" }),
				seg("m", 0, 5 * SEC, { media: "audio", muted: true }),
				seg("nu", 0, 5 * SEC, { media: "audio", uri: undefined }),
				seg("ph", 0, 5 * SEC, { kind: "placeholder", media: undefined, uri: undefined }),
				seg("late", 6 * SEC, 2 * SEC, { media: "audio" }),
			]),
			track("a2", "audio", [seg("mt", 0, 5 * SEC, { media: "audio" })], { muted: true }),
			track("a3", "audio", [seg("hit2", SEC, 5 * SEC, { media: "audio" })]),
		);
		expect(collectAudibleSegments(d, 2 * SEC).map((s) => s.id)).toEqual(["hit", "hit2"]);
	});

	it("区间右缘开：结束时刻即离开", () => {
		const d = doc(track("a1", "audio", [seg("a", 0, 5 * SEC, { media: "audio" })]));
		expect(collectAudibleSegments(d, 5 * SEC)).toEqual([]);
	});
});

describe("segmentVolume / segmentRate / docHasAnySegment", () => {
	it("音量缺省 1、夹取 0..1；速率缺省/非法回退 1、夹到安全区间", () => {
		expect(segmentVolume(seg("a", 0, SEC))).toBe(1);
		expect(segmentVolume(seg("a", 0, SEC, { volume: 0.4 }))).toBe(0.4);
		expect(segmentVolume(seg("a", 0, SEC, { volume: 3 }))).toBe(1);
		expect(segmentVolume(seg("a", 0, SEC, { volume: -1 }))).toBe(0);
		expect(segmentRate(seg("a", 0, SEC))).toBe(1);
		expect(segmentRate(seg("a", 0, SEC, { speed: 2 }))).toBe(2);
		expect(segmentRate(seg("a", 0, SEC, { speed: 0 }))).toBe(1);
		expect(segmentRate(seg("a", 0, SEC, { speed: Number.NaN }))).toBe(1);
		expect(segmentRate(seg("a", 0, SEC, { speed: 100 }))).toBe(16);
	});

	it("docHasAnySegment：任一轨有片段即 true", () => {
		expect(docHasAnySegment(doc(track("v1", "video", []), track("a1", "audio", [])))).toBe(false);
		expect(docHasAnySegment(doc(track("v1", "video", []), track("a1", "audio", [seg("a", 0, SEC)])))).toBe(true);
	});
});

/* ── 被上层完全遮挡的片段（时间轴「保留但不生效」弱化提示；与 videoStageAt 同口径） ── */
describe("coveredSegmentIds 图层遮挡判定", () => {
	// 轨道数组：下标 0 = 主轨（显示最下 = 最底层），下标越大显示越靠上 = 图层越上
	it("上层完整盖住 → 下层片段算被覆盖", () => {
		const d = doc(
			track("v1", "video", [seg("low", 2 * SEC, 3 * SEC)]),
			track("v2", "video", [seg("hi", 0, 10 * SEC)]),
		);
		expect(coveredSegmentIds(d)).toEqual(["low"]);
	});

	it("上层只盖住一部分 → 不算被覆盖（露出一丝都不算）", () => {
		const d = doc(
			track("v1", "video", [seg("low", 0, 10 * SEC)]),
			track("v2", "video", [seg("hi", 0, 4 * SEC)]),
		);
		expect(coveredSegmentIds(d)).toEqual([]);
	});

	it("上层两段相接可拼起来覆盖；中间有缺口则不覆盖", () => {
		const joined = doc(
			track("v1", "video", [seg("low", 0, 8 * SEC)]),
			track("v2", "video", [seg("a", 0, 4 * SEC), seg("b", 4 * SEC, 5 * SEC)]),
		);
		expect(coveredSegmentIds(joined)).toEqual(["low"]);

		const gapped = doc(
			track("v1", "video", [seg("low", 0, 8 * SEC)]),
			track("v2", "video", [seg("a", 0, 3 * SEC), seg("b", 4 * SEC, 5 * SEC)]),
		);
		expect(coveredSegmentIds(gapped)).toEqual([]);
	});

	it("上层是占位 / 无 uri → 不构成画面层，遮不住下层", () => {
		const ph = doc(
			track("v1", "video", [seg("low", 0, 5 * SEC)]),
			track("v2", "video", [{ id: "p", kind: "placeholder", targetStartUs: 0, targetDurationUs: 9 * SEC }]),
		);
		expect(coveredSegmentIds(ph)).toEqual([]);

		const noUri = doc(
			track("v1", "video", [seg("low", 0, 5 * SEC)]),
			track("v2", "video", [seg("nu", 0, 9 * SEC, { uri: undefined })]),
		);
		expect(coveredSegmentIds(noUri)).toEqual([]);
	});

	it("最上层永不被覆盖；音频轨不参与遮挡关系", () => {
		const d = doc(
			track("v1", "video", [seg("low", 0, 5 * SEC)]),
			track("a1", "audio", [seg("snd", 0, 9 * SEC, { media: "audio" })]),
			track("v2", "video", [seg("hi", 0, 9 * SEC)]),
		);
		const covered = coveredSegmentIds(d);
		expect(covered).toContain("low"); // 被 v2 盖住
		expect(covered).not.toContain("hi"); // 最上层
		expect(covered).not.toContain("snd"); // 音频不参与
	});

	it("三层：中层被顶层盖住、底层被中层+顶层的并集盖住", () => {
		const d = doc(
			track("v1", "video", [seg("bottom", 0, 10 * SEC)]),
			track("v2", "video", [seg("mid", 0, 5 * SEC)]),
			track("v3", "video", [seg("top", 5 * SEC, 5 * SEC)]),
		);
		// mid[0,5) 被 top[5,10) 盖不住 → mid 不算；bottom[0,10) 被 mid∪top = [0,10) 盖住
		const covered = coveredSegmentIds(d);
		expect(covered).toContain("bottom");
		expect(covered).not.toContain("mid");
	});
});

/* ── 第四批：复合片段（子时间轴）预览递归 ── */
describe("复合片段的预览展开（深度 1）", () => {
	/** 主轨一段普通视频 + 一个复合片段（子文档：2 条视频子轨 + 1 条音频子轨） */
	function compoundDoc(extraCompound: Partial<RtcSegment> = {}): RtcDoc {
		const d = doc(
			track("v1", "video", [
				seg("plain", 0, 2 * SEC),
				seg("comp", 2 * SEC, 4 * SEC, {
					kind: "compound",
					media: undefined,
					uri: undefined,
					subDocId: "s1",
					sourceStartUs: 0,
					sourceDurationUs: 4 * SEC,
					...extraCompound,
				}),
			]),
		);
		d.subDocs = {
			s1: {
				id: "s1",
				name: "复A",
				tracks: [
					track("sv1", "video", [seg("subA", 0, 4 * SEC)]),
					track("sv2", "video", [seg("subB", 1 * SEC, 2 * SEC, { media: "image" })]),
					track("sa", "audio", [seg("subSnd", 0, 4 * SEC, { media: "audio", volume: 0.5 })]),
				],
			},
		};
		return d;
	}

	it("videoLayerSlotsBottomUp：普通轨一槽 + 复合子视频轨各一槽（音频子轨不占画面槽）", () => {
		const slots = videoLayerSlotsBottomUp(compoundDoc());
		expect(slots.map((s) => s.slotId)).toEqual(["v1", "v1#tr", "comp/sv1", "comp/sv2"]); // #tr=转场幽灵槽
		expect(slots.every((s) => s.hostTrackId === "v1")).toBe(true);
	});

	it("播放头在复合区间内 → 子层展开成画面层（slotId 复合形态、layerIndex 按槽位序）", () => {
		const st = videoStageAt(compoundDoc(), 3_500_000); // 复合内 1.5s
		expect(st.layers.map((l) => l.trackId)).toEqual(["comp/sv1", "comp/sv2"]);
		expect(st.layers.map((l) => l.seg.id)).toEqual(["subA", "subB"]);
		expect(st.layers[0].layerIndex).toBe(2); // 槽位 0=v1（此刻无普通片段）、1=v1#tr（转场幽灵槽）
		expect(st.layers[1].layerIndex).toBe(3);
		expect(st.layers[0].sourceSec).toBe(1.5); // 子时间 1.5s、子片段 source 从 0 起
	});

	it("播放头在复合区间外 → 子槽不出画，普通片段照常", () => {
		const st = videoStageAt(compoundDoc(), 1 * SEC);
		expect(st.layers.map((l) => l.trackId)).toEqual(["v1"]);
		expect(st.layers[0].seg.id).toBe("plain");
	});

	it("compoundSubTimeUs：子时间 = sourceStart + Δt×speed，钳到 source 窗口", () => {
		const c = seg("c", 2 * SEC, 2 * SEC, { kind: "compound", sourceStartUs: 1 * SEC, sourceDurationUs: 4 * SEC, speed: 2 });
		expect(compoundSubTimeUs(c, 3 * SEC)).toBe(3 * SEC); // 1 + 1×2
		expect(compoundSubTimeUs(c, 100 * SEC)).toBe(5 * SEC); // 钳到窗口右缘
	});

	it("宿主静音/音量/速率合成：muted OR、volume 相乘、rate 相乘（夹安全区间）", () => {
		const d = compoundDoc({ muted: true, speed: 2 });
		const st = videoStageAt(d, 3 * SEC);
		expect(st.layers.every((l) => l.muted)).toBe(true); // 复合片段静音 → 子层全静音
		const d2 = compoundDoc({ speed: 2 });
		const st2 = videoStageAt(d2, 3 * SEC);
		expect(st2.layers[0].rate).toBe(2); // 子 speed 1 × 复合 2
	});

	it("collectAudibleAt：复合子层音频以复合 id 出池、时间/音量带宿主换算；宿主静音整组跳过", () => {
		const clips = collectAudibleAt(compoundDoc(), 3 * SEC); // 复合内 1s
		expect(clips.map((c) => c.id)).toEqual(["comp/subSnd"]);
		expect(clips[0].sourceSec).toBe(1);
		expect(clips[0].volume).toBe(0.5);
		const mutedHost = collectAudibleAt(compoundDoc({ muted: true }), 3 * SEC);
		expect(mutedHost).toEqual([]);
	});

	it("collectAudibleAt：主层音频与复合子层音频并存（主层口径与 collectAudibleSegments 一致）", () => {
		const d = compoundDoc();
		d.tracks.push(track("au", "audio", [seg("bgm", 0, 10 * SEC, { media: "audio" })]));
		const clips = collectAudibleAt(d, 3 * SEC);
		expect(clips.map((c) => c.id).sort()).toEqual(["bgm", "comp/subSnd"]);
	});

	it("audiblePoolIds：含主层片段 id 与复合子层复合 id", () => {
		const ids = audiblePoolIds(compoundDoc());
		expect(ids.has("plain")).toBe(true);
		expect(ids.has("comp")).toBe(true);
		expect(ids.has("comp/subSnd")).toBe(true);
		expect(ids.has("comp/subA")).toBe(true);
	});

	it("coveredSegmentIds：compound 按整段有画面近似——盖得住下层、也能被上层盖", () => {
		const d = compoundDoc();
		d.tracks.push(track("v2", "video", [seg("hi", 2 * SEC, 4 * SEC)])); // 盖住 compound 全跨度
		expect(coveredSegmentIds(d)).toContain("comp");
	});
});

describe("activeDecodeTrackIds 解码层数护栏", () => {
	/** layers 恒自下而上（下标越大越靠上），护栏必须**从最上层往下**保留 */
	const layers = (...ids: string[]) =>
		ids.map((id, i) => ({ trackId: id, layerIndex: i, media: "video" as const, seg: seg(id, 0, SEC), uri: `u://${id}`, sourceSec: 0, kfRelUs: 0, muted: false, volume: 1, rate: 1 }));

	it("超上限时保住最上面几层（下层被 pause，上层本就遮住它们）", () => {
		const got = activeDecodeTrackIds(layers("a", "b", "c", "d", "e"), 2);
		expect([...got].sort()).toEqual(["d", "e"]);
	});

	it("不超上限=全放行；limit≤0=不限制", () => {
		expect(activeDecodeTrackIds(layers("a", "b"), 4).size).toBe(2);
		expect(activeDecodeTrackIds(layers("a", "b", "c"), 0).size).toBe(3);
	});

	it("只统计视频层——图片层不占解码名额", () => {
		const mixed = layers("a", "b", "c");
		mixed[2] = { ...mixed[2], media: "image" as never };
		const got = activeDecodeTrackIds(mixed, 2);
		expect([...got].sort()).toEqual(["a", "b"]);
	});
});
