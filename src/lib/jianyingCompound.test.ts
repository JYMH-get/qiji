/**
 * 复合片段剪映导出断言（格式依据 docs/剪映复合片段草稿结构.md，探针 v4 实锤的形态）。
 * 经 buildDraftContent 全链构建（真实调用路径），逐项核对主草稿三件套 / 内联方言 / subdraft 文件。
 */
import { describe, expect, it } from "vitest";
import type { RtcDoc, RtcSegment, RtcTrack } from "@/types/rtc";
import { buildDraftContent, type JyAssetResolver, type JyResolvedAsset } from "./jianyingDraft";

type Json = Record<string, any>;

const SEC = 1_000_000;

function seg(p: Partial<RtcSegment>): RtcSegment {
	return {
		id: p.id || `seg-${Math.random().toString(36).slice(2, 8)}`,
		kind: p.kind ?? "media",
		targetStartUs: p.targetStartUs ?? 0,
		targetDurationUs: p.targetDurationUs ?? SEC,
		...p,
	};
}

function track(type: RtcTrack["type"], segments: RtcSegment[], extra?: Partial<RtcTrack>): RtcTrack {
	return { id: `track-${type}-${Math.random().toString(36).slice(2, 8)}`, type, segments, ...extra };
}

const ASSETS: Record<string, JyResolvedAsset> = {
	V1: { absPath: "C:\\draft\\assets\\V1.mp4", durationUs: 10 * SEC, width: 1280, height: 720, kind: "video" },
	V2: { absPath: "C:\\draft\\assets\\V2.mp4", durationUs: 8 * SEC, width: 1920, height: 1080, kind: "video" },
	AUD: { absPath: "C:\\draft\\assets\\AUD.mp3", durationUs: 30 * SEC, kind: "audio" },
};
const resolve: JyAssetResolver = (id) => ASSETS[id];

const UUID_UPPER = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/;

/** 一个复合（子文档：视频子轨 V2 + 音频子轨 AUD）+ 一个普通段 V1 的标准 doc */
function compoundDoc(): RtcDoc {
	return {
		id: "rtc-1",
		name: "复合测试",
		fps: 30,
		tracks: [
			track("video", [
				seg({ id: "plain", assetId: "V1", targetStartUs: 0, targetDurationUs: 2 * SEC, sourceStartUs: 0, sourceDurationUs: 2 * SEC }),
				seg({ id: "comp", kind: "compound", subDocId: "s1", name: "复A", targetStartUs: 2 * SEC, targetDurationUs: 5 * SEC, sourceStartUs: 0, sourceDurationUs: 5 * SEC }),
			]),
		],
		subDocs: {
			s1: {
				id: "s1",
				name: "复A",
				tracks: [
					track("video", [seg({ id: "subV", assetId: "V2", targetStartUs: 0, targetDurationUs: 5 * SEC, sourceStartUs: 0, sourceDurationUs: 5 * SEC })]),
					track("audio", [seg({ id: "subA", assetId: "AUD", media: "audio", targetStartUs: 0, targetDurationUs: 3 * SEC, sourceStartUs: 0, sourceDurationUs: 3 * SEC })]),
				],
			},
		},
	};
}

const materialsOf = (r: { draftContent: Record<string, unknown> }) => (r.draftContent as Json).materials as Json;
const tracksOf = (r: { draftContent: Record<string, unknown> }) => (r.draftContent as Json).tracks as Json[];

describe("buildDraftContent · 复合三件套（主草稿侧）", () => {
	const r = buildDraftContent(compoundDoc(), resolve, { nowMs: 1_755_000_000_123, draftFolderPath: "C:\\draft" });
	const mats = materialsOf(r);
	const segs = tracksOf(r)[0].segments as Json[];
	const compSeg = segs.find((s) => s.source === "segmentsourcenormal")!;
	const drafts = (mats.drafts as Json[])[0];
	const virtual = (mats.videos as Json[]).find((m) => m.extra_type_option === 2)!;

	it("虚拟视频素材：path 空 + extra_type_option:2 + check_flag 62978047 + 时长=子时长", () => {
		expect(virtual).toBeDefined();
		expect(virtual.path).toBe("");
		expect(virtual.check_flag).toBe(62978047);
		expect(virtual.is_copyright).toBe(true);
		expect(virtual.duration).toBe(5 * SEC);
		expect(virtual.id).toMatch(UUID_UPPER); // 复合相关 id 用大写连字符 UUID
	});

	it("复合段：样本 12 键精简形态（不带 render_index/speed/volume 等我们方言字段）", () => {
		expect(compSeg).toBeDefined();
		expect(Object.keys(compSeg).sort()).toEqual(
			[
				"clip", "enable_adjust_mask", "enable_hsl", "extra_material_refs", "hdr_settings", "id",
				"material_id", "render_timerange", "responsive_layout", "source", "source_timerange", "target_timerange",
			].sort(),
		);
		expect(compSeg.material_id).toBe(virtual.id);
		expect(compSeg.target_timerange).toEqual({ start: 2 * SEC, duration: 5 * SEC });
		expect(compSeg.source_timerange).toEqual({ start: 0, duration: 5 * SEC });
		expect(compSeg.hdr_settings).toEqual({ mode: 1 });
		expect(compSeg.clip).toEqual({ transform: { x: 0, y: 0 }, flip: {} });
		expect(compSeg.render_index).toBeUndefined(); // 样本形态不带；普通段照常带
		expect(segs.find((s) => s.id !== compSeg.id)!.render_index).toBe(0);
	});

	it("extra_material_refs：8 组伴生，顺序 drafts→speeds→placeholder_infos→hsl→canvases→scm→material_colors→vocal_separations", () => {
		const refs = compSeg.extra_material_refs as string[];
		expect(refs).toHaveLength(8);
		expect(refs[0]).toBe(drafts.id);
		const idOf = (arr: Json[]) => arr.map((x) => x.id);
		expect(idOf(mats.speeds as Json[])).toContain(refs[1]);
		expect(idOf(mats.placeholder_infos as Json[])).toContain(refs[2]);
		expect(idOf(mats.hsl as Json[])).toContain(refs[3]);
		expect(idOf(mats.canvases as Json[])).toContain(refs[4]);
		expect(idOf(mats.sound_channel_mappings as Json[])).toContain(refs[5]);
		expect(idOf(mats.material_colors as Json[])).toContain(refs[6]);
		expect(idOf(mats.vocal_separations as Json[])).toContain(refs[7]);
		// 伴生条目极简形态
		expect((mats.placeholder_infos as Json[])[0]).toEqual({ id: refs[2], meta_type: "none", type: "placeholder_info" });
		expect((mats.canvases as Json[])[0]).toEqual({ id: refs[4], type: "canvas_color" });
		expect((mats.sound_channel_mappings as Json[])[0]).toEqual({ id: refs[5], type: "none" });
		expect((mats.material_colors as Json[])[0]).toEqual({ id: refs[6] });
		expect((mats.vocal_separations as Json[])[0]).toEqual({ id: refs[7], type: "vocal_separation" });
	});

	it("drafts 素材：8 键 + 相对路径 subdraft/<X>/... + 内联 draft", () => {
		expect(Object.keys(drafts).sort()).toEqual(
			["combination_id", "combination_type", "draft", "draft_config_path", "draft_cover_path", "draft_file_path", "id", "type"].sort(),
		);
		expect(drafts.type).toBe("combination");
		expect(drafts.combination_type).toBe("none");
		expect(drafts.id).toMatch(UUID_UPPER);
		const x = r.subdrafts[0].uuid;
		expect(drafts.draft_file_path).toBe(`subdraft/${x}/draft_content.json`);
		expect(drafts.draft_config_path).toBe(`subdraft/${x}/sub_draft_config.json`);
		expect(drafts.draft_cover_path).toBe(`subdraft/${x}/draft_cover.jpg`);
	});

	it("内联子时间轴：顶层 18 键精简方言 + 片段 12 键（6 组伴生，无 drafts/hsl）", () => {
		const inline = drafts.draft as Json;
		expect(Object.keys(inline).sort()).toEqual(
			[
				"canvas_config", "color_space", "config", "duration", "function_assistant_info", "id", "keyframes",
				"last_modified_platform", "materials", "name", "new_version", "path", "platform",
				"render_index_track_mode_on", "smart_ads_info", "tracks", "uneven_animation_template_info", "version",
			].sort(),
		);
		expect(inline.id).toBe(r.subdrafts[0].uuid);
		expect(inline.canvas_config).toEqual({ height: 1080, width: 1920 }); // 两键形态（无 ratio）
		expect(inline.duration).toBe(5 * SEC);
		expect(inline.version).toBe(360000);
		// 轨道 4 键形态
		const inlineTracks = inline.tracks as Json[];
		expect(inlineTracks).toHaveLength(2);
		expect(Object.keys(inlineTracks[0]).sort()).toEqual(["id", "is_default_name", "segments", "type"]);
		// 内联片段：12 键 + 6 组伴生（子片段无 volume 变更时保持样本同形）
		const inlineSeg = (inlineTracks[0].segments as Json[])[0];
		expect(inlineSeg.source).toBe("segmentsourcenormal");
		expect((inlineSeg.extra_material_refs as string[]).length).toBe(6);
		// 内联视频素材：10.9 近似形态（check_flag 62978047 + 小写连字符 local_material_id）
		const inlineMats = inline.materials as Json;
		const iv = (inlineMats.videos as Json[])[0];
		expect(iv.check_flag).toBe(62978047);
		expect(iv.path).toBe(ASSETS.V2.absPath);
		expect(iv.local_material_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
		expect((inlineMats.audios as Json[])[0].path).toBe(ASSETS.AUD.absPath);
	});

	it("素材去重跨主/子共享：usedAssetIds 每素材一条（含仅子层引用的），meta 登记齐全", () => {
		expect([...r.usedAssetIds].sort()).toEqual(["AUD", "V1", "V2"]);
		const b0 = ((r.draftMetaInfo as Json).draft_materials as Json[]).find((b) => b.type === 0)!;
		const names = (b0.value as Json[]).map((e) => e.extra_info).sort();
		expect(names).toEqual(["AUD.mp3", "V1.mp4", "V2.mp4"]); // 子层素材也进素材栏
		expect((b0.value as Json[]).find((e) => e.extra_info === "AUD.mp3")!.metetype).toBe("music");
	});

	it("subdrafts 返回形态：uuid + wrapper + config（§3 逐键）", () => {
		expect(r.subdrafts).toHaveLength(1);
		const sd = r.subdrafts[0];
		expect(sd.uuid).toMatch(UUID_UPPER);
		const cfg = sd.configJson as Json;
		expect(cfg).toEqual({
			audio_path: "",
			cover_height: 180,
			cover_path: "draft_cover.jpg",
			cover_width: 320,
			create_time: 1_755_000_000,
			draft_json_file: "draft_content.json",
			id: sd.uuid,
			import_time_ms: 1_755_000_000_123,
			is_from_multi_timeline: false,
			is_from_sub_draft: true,
			material_color_tag: "",
			name: "复A",
			project_id: sd.uuid,
			rough_cut_duration: 5 * SEC,
			rough_cut_start: 0,
			source: "timeline",
			type: "video",
		});
		// wrapper：完整草稿骨架、id=X、富键 drafts（绝对路径 + precompile_combination:false）
		const w = sd.wrapperJson as Json;
		expect(w.id).toBe(sd.uuid);
		expect(w.duration).toBe(5 * SEC);
		const wd = ((w.materials as Json).drafts as Json[])[0];
		expect(wd.precompile_combination).toBe(false);
		expect(wd.name).toBe("复A");
		expect(wd.draft_file_path).toBe(`C:\\draft\\subdraft\\${sd.uuid}\\draft_content.json`);
		const ws = ((w.tracks as Json[])[0].segments as Json[])[0];
		expect((ws.extra_material_refs as string[]).length).toBe(8);
		expect(ws.material_id).toBe(((w.materials as Json).videos as Json[])[0].id);
	});

	it("draftContent.duration 覆盖复合段终点", () => {
		expect((r.draftContent as Json).duration).toBe(7 * SEC);
	});
});

describe("buildDraftContent · 复合边界", () => {
	it("分割共享同一子文档：两段共享同一份 虚拟素材/drafts/subdraft，各带各的 source 窗口", () => {
		const d = compoundDoc();
		const [plain, comp] = d.tracks[0].segments;
		d.tracks[0] = {
			...d.tracks[0],
			segments: [
				plain,
				{ ...comp, id: "compL", targetStartUs: 2 * SEC, targetDurationUs: 2 * SEC, sourceStartUs: 0, sourceDurationUs: 2 * SEC },
				{ ...comp, id: "compR", targetStartUs: 4 * SEC, targetDurationUs: 3 * SEC, sourceStartUs: 2 * SEC, sourceDurationUs: 3 * SEC },
			],
		};
		const r = buildDraftContent(d, resolve);
		expect(r.subdrafts).toHaveLength(1); // ⚠ 绝不复制 subdraft
		const mats = materialsOf(r);
		expect((mats.drafts as Json[]).length).toBe(1);
		expect((mats.videos as Json[]).filter((m) => m.extra_type_option === 2)).toHaveLength(1);
		const compSegs = (tracksOf(r)[0].segments as Json[]).filter((s) => s.source === "segmentsourcenormal");
		expect(compSegs).toHaveLength(2);
		expect(compSegs[0].material_id).toBe(compSegs[1].material_id); // 共享虚拟素材
		expect((compSegs[0].extra_material_refs as string[])[0]).toBe((compSegs[1].extra_material_refs as string[])[0]); // 共享 drafts
		expect(compSegs[0].source_timerange).toEqual({ start: 0, duration: 2 * SEC });
		expect(compSegs[1].source_timerange).toEqual({ start: 2 * SEC, duration: 3 * SEC });
	});

	it("compound 引用缺失子文档 → 跳过并 warning；无复合时 materials 不带 placeholder_infos 键", () => {
		const dangling: RtcDoc = {
			id: "d",
			name: "x",
			fps: 30,
			tracks: [
				track("video", [
					seg({ id: "c", kind: "compound", subDocId: "gone", name: "复X", targetStartUs: 0, targetDurationUs: SEC }),
					seg({ assetId: "V1", targetStartUs: SEC, targetDurationUs: SEC, sourceStartUs: 0, sourceDurationUs: SEC }),
				]),
			],
		};
		const r = buildDraftContent(dangling, resolve);
		expect(r.warnings.some((w) => w.includes("复X") && w.includes("子时间轴"))).toBe(true);
		expect(r.subdrafts).toEqual([]);
		expect((r.draftContent as Json).materials.placeholder_infos).toBeUndefined(); // 无复合=旧形态零变化
		expect((r.draftContent as Json).materials.drafts).toEqual([]);
	});

	it("子文档内的占位符/缺素材片段：跳过并 warning，其余照常内联", () => {
		const d = compoundDoc();
		d.subDocs!.s1.tracks[0].segments.push(
			seg({ id: "ph", kind: "placeholder", name: "占位甲", targetStartUs: 6 * SEC, targetDurationUs: SEC }),
		);
		const r = buildDraftContent(d, resolve);
		expect(r.warnings.some((w) => w.includes("占位甲"))).toBe(true);
		const inline = (materialsOf(r).drafts as Json[])[0].draft as Json;
		expect(((inline.tracks as Json[])[0].segments as Json[]).length).toBe(1); // 只有 subV
	});

	it("子片段带 muted/volume → 内联片段附加 volume 键（样本 12 键 + 按需附加）", () => {
		const d = compoundDoc();
		d.subDocs!.s1.tracks[0].segments[0] = { ...d.subDocs!.s1.tracks[0].segments[0], muted: true };
		const r = buildDraftContent(d, resolve);
		const inline = (materialsOf(r).drafts as Json[])[0].draft as Json;
		expect(((inline.tracks as Json[])[0].segments as Json[])[0].volume).toBe(0);
	});
});
