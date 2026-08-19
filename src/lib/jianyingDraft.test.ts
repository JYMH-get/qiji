import { describe, it, expect } from "vitest";
import type { RtcDoc, RtcSegment, RtcTrack } from "@/types/rtc";
import {
	buildDraftContent,
	jyUuidHex,
	jyUuidUpper,
	JY_PHOTO_DURATION_US,
	type JyAssetResolver,
	type JyResolvedAsset,
} from "./jianyingDraft";

// ── 造数据 ──────────────────────────────────────────────

function seg(p: Partial<RtcSegment>): RtcSegment {
	return {
		id: p.id || `seg-${Math.random().toString(36).slice(2, 8)}`,
		kind: p.kind ?? "media",
		targetStartUs: p.targetStartUs ?? 0,
		targetDurationUs: p.targetDurationUs ?? 1_000_000,
		...p,
	};
}

function track(type: RtcTrack["type"], segments: RtcSegment[], extra?: Partial<RtcTrack>): RtcTrack {
	return { id: `track-${type}-${Math.random().toString(36).slice(2, 8)}`, type, segments, ...extra };
}

function doc(tracks: RtcTrack[], fps = 30): RtcDoc {
	return { id: "rtc-1", name: "测试剪辑", fps, tracks };
}

const ASSETS: Record<string, JyResolvedAsset> = {
	V1: { absPath: "C:\\draft\\assets\\V1.mp4", durationUs: 10_000_000, width: 1280, height: 720, kind: "video" },
	V2: { absPath: "C:\\draft\\assets\\V2.mp4", durationUs: 8_000_000, width: 1920, height: 1080, kind: "video" },
	IMG: { absPath: "C:\\draft\\assets\\IMG.png", durationUs: 0, width: 1024, height: 576, kind: "photo" },
	AUD: { absPath: "C:\\draft\\assets\\AUD.mp3", durationUs: 30_000_000, kind: "audio" },
};

const resolve: JyAssetResolver = (id) => ASSETS[id];

type Json = Record<string, any>;
const materialsOf = (r: { draftContent: Record<string, unknown> }) => (r.draftContent as Json).materials as Json;
const tracksOf = (r: { draftContent: Record<string, unknown> }) => (r.draftContent as Json).tracks as Json[];

// ── 用例 ──────────────────────────────────────────────

describe("buildDraftContent · 素材去重（硬性要求）", () => {
	it("两段同 assetId → materials 恰一条、两 segment material_id 相同、source_timerange 各自正确", () => {
		// 模拟一次分割：同一 V1 被切成前 3s / 后 7s 两段
		const d = doc([
			track("video", [
				seg({ assetId: "V1", targetStartUs: 0, targetDurationUs: 3_000_000, sourceStartUs: 0, sourceDurationUs: 3_000_000 }),
				seg({ assetId: "V1", targetStartUs: 3_000_000, targetDurationUs: 7_000_000, sourceStartUs: 3_000_000, sourceDurationUs: 7_000_000 }),
			]),
		]);
		const r = buildDraftContent(d, resolve);
		const mats = materialsOf(r);
		expect(mats.videos).toHaveLength(1); // 绝不为每段单独造素材
		const matId = mats.videos[0].id as string;
		const segs = tracksOf(r)[0].segments as Json[];
		expect(segs).toHaveLength(2);
		expect(segs[0].material_id).toBe(matId);
		expect(segs[1].material_id).toBe(matId);
		expect(segs[0].source_timerange).toEqual({ start: 0, duration: 3_000_000 });
		expect(segs[1].source_timerange).toEqual({ start: 3_000_000, duration: 7_000_000 });
		expect(r.usedAssetIds).toEqual(["V1"]); // 素材文件也只落地一次
	});

	it("同 assetId 被多轨引用 → 仍只有一条 material", () => {
		const d = doc([
			track("video", [seg({ assetId: "V1", targetStartUs: 0, targetDurationUs: 2_000_000, sourceStartUs: 0, sourceDurationUs: 2_000_000 })]),
			track("video", [seg({ assetId: "V1", targetStartUs: 1_000_000, targetDurationUs: 2_000_000, sourceStartUs: 5_000_000, sourceDurationUs: 2_000_000 })]),
		]);
		const r = buildDraftContent(d, resolve);
		expect(materialsOf(r).videos).toHaveLength(1);
		const matId = materialsOf(r).videos[0].id;
		for (const t of tracksOf(r)) for (const s of t.segments as Json[]) expect(s.material_id).toBe(matId);
		expect(r.usedAssetIds).toEqual(["V1"]);
	});
});

describe("buildDraftContent · 时间与参数映射", () => {
	it("微秒直通：target/source_timerange 逐值等于 doc（无换算）", () => {
		const d = doc([
			track("video", [seg({ assetId: "V2", targetStartUs: 1_234_567, targetDurationUs: 2_345_678, sourceStartUs: 111_111, sourceDurationUs: 2_345_678 })]),
		]);
		const s = (tracksOf(buildDraftContent(d, resolve))[0].segments as Json[])[0];
		expect(s.target_timerange).toEqual({ start: 1_234_567, duration: 2_345_678 });
		expect(s.source_timerange).toEqual({ start: 111_111, duration: 2_345_678 });
	});

	it("speed 映射：segment.speed + 专属 speeds 素材 + extra_material_refs 关联", () => {
		const d = doc([
			track("video", [seg({ assetId: "V1", targetStartUs: 0, targetDurationUs: 2_000_000, sourceStartUs: 0, sourceDurationUs: 4_000_000, speed: 2 })]),
		]);
		const r = buildDraftContent(d, resolve);
		const s = (tracksOf(r)[0].segments as Json[])[0];
		expect(s.speed).toBe(2);
		const speeds = materialsOf(r).speeds as Json[];
		expect(speeds).toHaveLength(1);
		expect(speeds[0]).toMatchObject({ curve_speed: null, mode: 0, speed: 2, type: "speed" });
		expect(s.extra_material_refs).toEqual([speeds[0].id]);
	});

	it("volume/muted 映射：显式音量直通、muted → volume 0、缺省 → 1", () => {
		const d = doc([
			track("video", [
				seg({ assetId: "V1", targetStartUs: 0, targetDurationUs: 1_000_000, sourceStartUs: 0, sourceDurationUs: 1_000_000, volume: 0.5 }),
				seg({ assetId: "V1", targetStartUs: 1_000_000, targetDurationUs: 1_000_000, sourceStartUs: 0, sourceDurationUs: 1_000_000, volume: 0.8, muted: true }),
				seg({ assetId: "V1", targetStartUs: 2_000_000, targetDurationUs: 1_000_000, sourceStartUs: 0, sourceDurationUs: 1_000_000 }),
			]),
		]);
		const segs = tracksOf(buildDraftContent(d, resolve))[0].segments as Json[];
		expect(segs[0].volume).toBe(0.5);
		expect(segs[1].volume).toBe(0); // 片段静音=音量 0（剪映片段无独立 muted 位）
		expect(segs[2].volume).toBe(1);
	});

	it("轨道 muted → attribute:1；未静音 → 0", () => {
		const d = doc([
			track("video", [seg({ assetId: "V1", sourceStartUs: 0, sourceDurationUs: 1_000_000 })], { muted: true }),
			track("audio", [seg({ assetId: "AUD", media: "audio", sourceStartUs: 0, sourceDurationUs: 1_000_000 })]),
		]);
		const ts = tracksOf(buildDraftContent(d, resolve));
		expect(ts[0].attribute).toBe(1);
		expect(ts[1].attribute).toBe(0);
	});

	it("duration = docDurationUs（全部导出片段的最大 target 终点），tm_duration 同值", () => {
		const d = doc([
			track("video", [seg({ assetId: "V1", targetStartUs: 0, targetDurationUs: 3_000_000, sourceStartUs: 0, sourceDurationUs: 3_000_000 })]),
			track("audio", [seg({ assetId: "AUD", media: "audio", targetStartUs: 2_000_000, targetDurationUs: 6_000_000, sourceStartUs: 0, sourceDurationUs: 6_000_000 })]),
		]);
		const r = buildDraftContent(d, resolve);
		expect((r.draftContent as Json).duration).toBe(8_000_000);
		expect((r.draftMetaInfo as Json).tm_duration).toBe(8_000_000);
	});
});

describe("buildDraftContent · 跳过与告警", () => {
	it("placeholder 片段跳过并记 warning，不产生素材/片段", () => {
		const d = doc([
			track("video", [
				seg({ kind: "placeholder", name: "分镜3占位", targetStartUs: 0, targetDurationUs: 5_000_000, shotRef: { episodeId: "e1", shotId: "s3" } }),
				seg({ assetId: "V1", targetStartUs: 5_000_000, targetDurationUs: 2_000_000, sourceStartUs: 0, sourceDurationUs: 2_000_000 }),
			]),
		]);
		const r = buildDraftContent(d, resolve);
		expect(r.warnings.some((w) => w.includes("占位符") && w.includes("分镜3占位"))).toBe(true);
		expect(tracksOf(r)[0].segments).toHaveLength(1);
		expect(materialsOf(r).videos).toHaveLength(1);
	});

	it("text 轨跳过并记 warning（P0）", () => {
		const d = doc([
			track("text", [seg({ assetId: "V1" })], { name: "字幕" }),
			track("video", [seg({ assetId: "V1", sourceStartUs: 0, sourceDurationUs: 1_000_000 })]),
		]);
		const r = buildDraftContent(d, resolve);
		expect(r.warnings.some((w) => w.includes("文本轨") && w.includes("字幕"))).toBe(true);
		expect(tracksOf(r)).toHaveLength(1);
		expect(tracksOf(r)[0].type).toBe("video");
	});

	it("resolve 不到的素材：片段跳过并记 warning（含 assetId）", () => {
		const d = doc([
			track("video", [
				seg({ assetId: "MISSING", targetStartUs: 0, targetDurationUs: 1_000_000 }),
				seg({ assetId: "V1", targetStartUs: 1_000_000, targetDurationUs: 1_000_000, sourceStartUs: 0, sourceDurationUs: 1_000_000 }),
			]),
		]);
		const r = buildDraftContent(d, resolve);
		expect(r.warnings.some((w) => w.includes("MISSING"))).toBe(true);
		expect(tracksOf(r)[0].segments).toHaveLength(1);
		expect(r.usedAssetIds).toEqual(["V1"]);
	});

	it("空文档：零轨道零素材、duration 0、无告警", () => {
		const r = buildDraftContent(doc([]), resolve);
		expect(tracksOf(r)).toEqual([]);
		expect(materialsOf(r).videos).toEqual([]);
		expect(materialsOf(r).audios).toEqual([]);
		expect((r.draftContent as Json).duration).toBe(0);
		expect(r.warnings).toEqual([]);
		expect(r.usedAssetIds).toEqual([]);
	});

	it("空轨/全被跳过的轨不导出", () => {
		const d = doc([
			track("video", []),
			track("audio", [seg({ kind: "placeholder", targetStartUs: 0, targetDurationUs: 1_000_000 })]),
		]);
		const r = buildDraftContent(d, resolve);
		expect(tracksOf(r)).toEqual([]);
	});
});

describe("buildDraftContent · 素材形态", () => {
	it("图片 → materials.videos 里 type:'photo'、默认 3h 时长、source 按 target×speed 补全", () => {
		const d = doc([
			track("video", [seg({ assetId: "IMG", media: "image", targetStartUs: 0, targetDurationUs: 4_000_000 })]),
		]);
		const r = buildDraftContent(d, resolve);
		const mat = (materialsOf(r).videos as Json[])[0];
		expect(mat.type).toBe("photo");
		expect(mat.duration).toBe(JY_PHOTO_DURATION_US);
		expect(mat.width).toBe(1024);
		expect(mat.height).toBe(576);
		const s = (tracksOf(r)[0].segments as Json[])[0];
		expect(s.source_timerange).toEqual({ start: 0, duration: 4_000_000 });
	});

	it("音频素材 → materials.audios、type:'extract_music'；音频片段 clip/hdr_settings 为 null", () => {
		const d = doc([
			track("audio", [seg({ assetId: "AUD", media: "audio", targetStartUs: 0, targetDurationUs: 5_000_000, sourceStartUs: 0, sourceDurationUs: 5_000_000 })]),
		]);
		const r = buildDraftContent(d, resolve);
		const mats = materialsOf(r);
		expect(mats.audios).toHaveLength(1);
		expect(mats.videos).toHaveLength(0);
		expect((mats.audios as Json[])[0]).toMatchObject({ type: "extract_music", path: "C:\\draft\\assets\\AUD.mp3", duration: 30_000_000 });
		const s = (tracksOf(r)[0].segments as Json[])[0];
		expect(s.clip).toBeNull();
		expect(s.hdr_settings).toBeNull();
	});

	it("视频片段带 clip/uniform_scale/hdr_settings；素材条目字段齐全（path 绝对路径）", () => {
		const d = doc([
			track("video", [seg({ assetId: "V1", sourceStartUs: 0, sourceDurationUs: 1_000_000 })]),
		]);
		const r = buildDraftContent(d, resolve);
		const s = (tracksOf(r)[0].segments as Json[])[0];
		expect(s.clip).toMatchObject({ alpha: 1, rotation: 0 });
		expect(s.uniform_scale).toEqual({ on: true, value: 1 });
		expect(s.hdr_settings).toEqual({ intensity: 1, mode: 1, nits: 1000 });
		const mat = (materialsOf(r).videos as Json[])[0];
		expect(mat).toMatchObject({
			path: "C:\\draft\\assets\\V1.mp4",
			material_name: "V1.mp4",
			type: "video",
			width: 1280,
			height: 720,
			duration: 10_000_000,
			category_name: "local",
			check_flag: 63487,
		});
		expect(mat.material_id).toBe(mat.id);
	});

	it("素材 duration 兜底：探测时长小于片段 source 终点时抬到 source 终点", () => {
		const shortResolve: JyAssetResolver = () => ({ absPath: "C:\\a\\v.mp4", durationUs: 1_000_000, kind: "video" });
		const d = doc([
			track("video", [seg({ assetId: "X", targetStartUs: 0, targetDurationUs: 6_000_000, sourceStartUs: 2_000_000, sourceDurationUs: 6_000_000 })]),
		]);
		const r = buildDraftContent(d, shortResolve);
		expect((materialsOf(r).videos as Json[])[0].duration).toBe(8_000_000);
	});
});

describe("buildDraftContent · 骨架与 id 形态", () => {
	it("模板骨架关键字段：fps/canvas_config/platform 5.9.0/materials 全组存在", () => {
		const r = buildDraftContent(doc([], 24), resolve, { canvasWidth: 1080, canvasHeight: 1920 });
		const c = r.draftContent as Json;
		expect(c.fps).toBe(24);
		expect(c.canvas_config).toEqual({ width: 1080, height: 1920, ratio: "original" });
		expect(c.platform.app_version).toBe("5.9.0");
		expect(c.new_version).toBe("110.0.0");
		expect(c.version).toBe(360000);
		// materials 骨架完整（剪映读缺键会崩的面）
		for (const key of ["videos", "audios", "speeds", "canvases", "texts", "effects", "stickers", "sound_channel_mappings", "vocal_separations"]) {
			expect(Array.isArray(c.materials[key])).toBe(true);
		}
		expect(c.id).toMatch(/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/);
	});

	it("meta：draft_name（opts 优先，缺省 doc.name）、draft_id 大写 UUID、draft_materials 7 组", () => {
		const r1 = buildDraftContent(doc([]), resolve);
		expect((r1.draftMetaInfo as Json).draft_name).toBe("测试剪辑");
		const r2 = buildDraftContent(doc([]), resolve, { draftName: "自定义名" });
		const m = r2.draftMetaInfo as Json;
		expect(m.draft_name).toBe("自定义名");
		expect(m.draft_id).toMatch(/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/);
		expect((m.draft_materials as Json[]).map((x) => x.type)).toEqual([0, 1, 2, 3, 6, 7, 8]);
		expect(m.draft_fold_path).toBe(""); // 路径留空由剪映回填（pyJianYingDraft 实证）
	});

	it("meta 素材登记（type:0 桶）：按 usedAssetIds 逐素材一条、字段形态照剪映原样（含 metetype 原文拼写）", () => {
		const d = doc([
			track("video", [
				seg({ assetId: "V1", targetStartUs: 0, targetDurationUs: 3_000_000, sourceStartUs: 0, sourceDurationUs: 3_000_000 }),
				seg({ assetId: "V1", targetStartUs: 3_000_000, targetDurationUs: 2_000_000, sourceStartUs: 3_000_000, sourceDurationUs: 2_000_000 }),
				seg({ assetId: "IMG", media: "image", targetStartUs: 5_000_000, targetDurationUs: 2_000_000 }),
			]),
			track("audio", [seg({ assetId: "AUD", media: "audio", sourceStartUs: 0, sourceDurationUs: 4_000_000 })]),
		]);
		const r = buildDraftContent(d, resolve, { nowMs: 1_755_000_000_123 });
		const b0 = ((r.draftMetaInfo as Json).draft_materials as Json[]).find((b) => b.type === 0)!;
		const entries = b0.value as Json[];
		expect(entries).toHaveLength(3); // V1 去重一条 + IMG + AUD
		const v1 = entries.find((e) => e.extra_info === "V1.mp4")!;
		expect(v1.file_Path).toBe(ASSETS.V1.absPath);
		expect(v1.metetype).toBe("video"); // 剪映原文拼写，勿"修正"
		expect(v1.width).toBe(1280);
		expect(v1.height).toBe(720);
		expect(v1.duration).toBe(10_000_000); // 与 materials.videos 的素材时长同源
		expect(v1.roughcut_time_range).toEqual({ duration: 10_000_000, start: 0 });
		expect(v1.sub_time_range).toEqual({ duration: -1, start: -1 });
		expect(v1.type).toBe(0);
		expect(v1.item_source).toBe(1);
		expect(v1.import_time_ms).toBe(1_755_000_000_123);
		expect(v1.create_time).toBe(1_755_000_000);
		expect(v1.id).toMatch(/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/);
		expect(entries.find((e) => e.extra_info === "IMG.png")!.metetype).toBe("photo");
		expect(entries.find((e) => e.extra_info === "IMG.png")!.duration).toBe(0);
		expect(entries.find((e) => e.extra_info === "AUD.mp3")!.metetype).toBe("music");
		// 空时间轴：桶仍在、登记为空（形状不变）
		const r0 = buildDraftContent(doc([]), resolve);
		const b00 = ((r0.draftMetaInfo as Json).draft_materials as Json[]).find((b) => b.type === 0)!;
		expect(b00.value).toEqual([]);
	});

	it("素材/片段/轨道 id = 32 位小写 hex（uuid4().hex 同形）且互不相同；render_index=轨道序", () => {
		const d = doc([
			track("video", [seg({ assetId: "V1", sourceStartUs: 0, sourceDurationUs: 1_000_000 })]),
			track("audio", [seg({ assetId: "AUD", media: "audio", sourceStartUs: 0, sourceDurationUs: 1_000_000 })]),
		]);
		const r = buildDraftContent(d, resolve);
		const hex32 = /^[0-9a-f]{32}$/;
		const ids = new Set<string>();
		for (const t of tracksOf(r)) {
			expect(t.id).toMatch(hex32);
			ids.add(t.id as string);
			for (const s of t.segments as Json[]) {
				expect(s.id).toMatch(hex32);
				expect(s.material_id).toMatch(hex32);
				ids.add(s.id as string);
			}
		}
		expect(ids.size).toBe(4);
		expect((tracksOf(r)[0].segments as Json[])[0].render_index).toBe(0);
		expect((tracksOf(r)[1].segments as Json[])[0].render_index).toBe(1);
	});

	it("⚠ 图层顺序：doc.tracks 越靠后 = render_index 越大 = 剪映里越靠上（与时间轴显示同向，勿反转）", () => {
		// v1 = 主轨（数组第一条 video，时间轴显示在视频组最下）；v2 是后建的版本，显示在 v1 之上
		const d = doc([
			track("video", [seg({ assetId: "V1", sourceStartUs: 0, sourceDurationUs: 1_000_000 })], { name: "主轨" }),
			track("video", [seg({ assetId: "V2", sourceStartUs: 0, sourceDurationUs: 1_000_000 })], { name: "新版本" }),
			track("audio", [seg({ assetId: "AUD", media: "audio", sourceStartUs: 0, sourceDurationUs: 1_000_000 })]),
		]);
		const ts = tracksOf(buildDraftContent(d, resolve));
		// 导出数组序 = doc.tracks 序（全导，不筛选、不重排）
		expect(ts.map((t) => t.name)).toEqual(["主轨", "新版本", ""]);
		const idxOf = (name: string) => (ts.find((t) => t.name === name)!.segments as Json[])[0].render_index as number;
		// pyJianYingDraft：render_index=导出下标，append_track=加到最上层 → 值越大越靠前景
		expect(idxOf("新版本")).toBeGreaterThan(idxOf("主轨"));
	});

	it("jyUuidHex/jyUuidUpper 形态与唯一性", () => {
		const seen = new Set<string>();
		for (let i = 0; i < 200; i++) {
			const h = jyUuidHex();
			expect(h).toMatch(/^[0-9a-f]{32}$/);
			expect(h[12]).toBe("4"); // version 4
			seen.add(h);
		}
		expect(seen.size).toBe(200);
		expect(jyUuidUpper()).toMatch(/^[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/);
	});
});

describe("buildDraftContent · 画面变换 → segment.clip", () => {
	const clipOf = (r: { draftContent: Record<string, unknown> }, ti = 0, si = 0) =>
		((tracksOf(r)[ti].segments as Json[])[si] as Json);

	it("缺省（片段无 transform）→ 与本轮之前硬编码的 clip 逐键完全一致（存量草稿零变化）", () => {
		const d = doc([track("video", [seg({ assetId: "V1", sourceStartUs: 0, sourceDurationUs: 1_000_000 })])]);
		const s = clipOf(buildDraftContent(d, resolve));
		expect(s.clip).toEqual({
			alpha: 1,
			flip: { horizontal: false, vertical: false },
			rotation: 0,
			scale: { x: 1, y: 1 },
			transform: { x: 0, y: 0 },
		});
		expect(s.uniform_scale).toEqual({ on: true, value: 1.0 });
		expect(s.hdr_settings).toEqual({ intensity: 1.0, mode: 1, nits: 1000 });
	});

	it("⚠ 位置换算：画幅比例 ×2（半画幅单位），且 y 取负（剪映 transform_y 正向上）", () => {
		const d = doc([
			track("video", [
				seg({ assetId: "V1", sourceStartUs: 0, sourceDurationUs: 1_000_000, transform: { scaleX: 1, scaleY: 1, x: 0.25, y: 0.25, rotation: 0, opacity: 1 } }),
			]),
		]);
		expect((clipOf(buildDraftContent(d, resolve)).clip as Json).transform).toEqual({ x: 0.5, y: -0.5 });
	});

	it("缩放/旋转/不透明度/镜像映射 + 两轴不同 → uniform_scale.on=false（剪映才分别采纳 x/y）", () => {
		const d = doc([
			track("video", [
				seg({
					assetId: "V1", sourceStartUs: 0, sourceDurationUs: 1_000_000,
					transform: { scaleX: 0.72, scaleY: 1.2, x: 0, y: -0.1, rotation: -90, opacity: 0.5, flipH: true },
				}),
			]),
		]);
		const s = clipOf(buildDraftContent(d, resolve));
		expect(s.clip).toEqual({
			alpha: 0.5,
			flip: { horizontal: true, vertical: false },
			rotation: 270, // 顺时针度数归一到 [0,360)
			scale: { x: 0.72, y: 1.2 },
			transform: { x: 0, y: 0.2 }, // 我们 y=-0.1（上移）→ 剪映 +0.2
		});
		expect(s.uniform_scale).toEqual({ on: false, value: 1.0 });
	});

	it("同 assetId 的多个片段各带各的 clip（变换是片段属性，不随素材去重合并）", () => {
		const d = doc([
			track("video", [
				seg({ assetId: "V1", targetStartUs: 0, targetDurationUs: 1_000_000, sourceStartUs: 0, sourceDurationUs: 1_000_000 }),
				seg({
					assetId: "V1", targetStartUs: 1_000_000, targetDurationUs: 1_000_000, sourceStartUs: 1_000_000, sourceDurationUs: 1_000_000,
					transform: { scaleX: 2, scaleY: 2, x: 0, y: 0, rotation: 0, opacity: 1 },
				}),
			]),
		]);
		const r = buildDraftContent(d, resolve);
		expect(materialsOf(r).videos).toHaveLength(1); // 素材仍只一条
		expect(((clipOf(r, 0, 0).clip as Json).scale as Json).x).toBe(1);
		expect(((clipOf(r, 0, 1).clip as Json).scale as Json).x).toBe(2);
	});

	it("音频片段 clip 恒 null（没有画面；片段上即便带 transform 也有意忽略）", () => {
		const d = doc([
			track("audio", [
				seg({
					assetId: "AUD", media: "audio", sourceStartUs: 0, sourceDurationUs: 1_000_000,
					transform: { scaleX: 2, scaleY: 2, x: 0.3, y: 0.3, rotation: 45, opacity: 0.5 },
				}),
			]),
		]);
		const s = clipOf(buildDraftContent(d, resolve));
		expect(s.clip).toBeNull();
		expect(s.hdr_settings).toBeNull();
		expect(s.uniform_scale).toBeUndefined();
	});
});

describe("原文参考轨（role:\"script\"）不导出", () => {
	it("整轨静默跳过：不出 texts 素材、不出轨道、不记 warning（设计即不导出）", () => {
		const d = doc([
			track("video", [seg({ assetId: "V1", targetStartUs: 0, targetDurationUs: 2_000_000, sourceStartUs: 0, sourceDurationUs: 2_000_000 })]),
			track("text", [seg({ text: { content: "第一镜原文" } })], { name: "原文", role: "script" }),
		]);
		const r = buildDraftContent(d, resolve);
		expect((materialsOf(r).texts ?? []).length).toBe(0);
		expect(tracksOf(r)).toHaveLength(1); // 只剩视频轨
		expect(r.warnings).toHaveLength(0);
	});
});
