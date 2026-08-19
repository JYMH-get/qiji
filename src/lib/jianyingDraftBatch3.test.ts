/**
 * 第三批（倒放/裁剪/字幕/转场）的剪映导出用例——与既有 jianyingDraft.test.ts 分文件
 * （并行任务约定：共享测试文件只增不改，本批断言集中在这里）。
 */
import { describe, it, expect } from "vitest";
import type { RtcDoc, RtcSegment, RtcTrack } from "@/types/rtc";
import { buildDraftContent, type JyAssetResolver, type JyResolvedAsset } from "./jianyingDraft";
import { jyTextSize } from "./rtcTextCore";

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
	IMG: { absPath: "C:\\draft\\assets\\IMG.png", durationUs: 0, width: 1024, height: 576, kind: "photo" },
	AUD: { absPath: "C:\\draft\\assets\\AUD.mp3", durationUs: 30_000_000, kind: "audio" },
};
const resolve: JyAssetResolver = (id) => ASSETS[id];

type Json = Record<string, any>;
const materialsOf = (r: { draftContent: Record<string, unknown> }) => (r.draftContent as Json).materials as Json;
const tracksOf = (r: { draftContent: Record<string, unknown> }) => (r.draftContent as Json).tracks as Json[];

const vseg = (p: Partial<RtcSegment>) =>
	seg({ assetId: "V1", sourceStartUs: 0, sourceDurationUs: 1_000_000, ...p });

describe("剪映导出 · 画面裁剪（crop 挂 material + 克隆条目）", () => {
	it("带 crop 的片段单独克隆一条 material（8 角坐标正确）；无 crop 片段仍共享去重条目；素材文件只落一份", () => {
		const d = doc([
			track("video", [
				vseg({ targetStartUs: 0, targetDurationUs: 1_000_000 }),
				vseg({ targetStartUs: 1_000_000, targetDurationUs: 1_000_000, sourceStartUs: 1_000_000, crop: { left: 0.1, top: 0.2, right: 0.3, bottom: 0.4 } }),
				vseg({ targetStartUs: 2_000_000, targetDurationUs: 1_000_000, sourceStartUs: 2_000_000 }),
			]),
		]);
		const r = buildDraftContent(d, resolve);
		const vids = materialsOf(r).videos as Json[];
		expect(vids).toHaveLength(2); // 去重条目 ×1 + crop 克隆 ×1
		const segs = tracksOf(r)[0].segments as Json[];
		expect(segs[0].material_id).toBe(segs[2].material_id); // 无 crop 两段共享
		expect(segs[1].material_id).not.toBe(segs[0].material_id); // crop 段独享克隆
		const cropMat = vids.find((m) => m.id === segs[1].material_id)!;
		expect(cropMat.crop).toEqual({
			upper_left_x: 0.1, upper_left_y: 0.2,
			upper_right_x: 0.7, upper_right_y: 0.2,
			lower_left_x: 0.1, lower_left_y: 0.6,
			lower_right_x: 0.7, lower_right_y: 0.6,
		});
		expect(cropMat.crop_ratio).toBe("free");
		expect(cropMat.path).toBe("C:\\draft\\assets\\V1.mp4"); // 同 path——素材文件只复制一份
		// 去重条目仍是「不裁」默认 8 角
		const plainMat = vids.find((m) => m.id === segs[0].material_id)!;
		expect(plainMat.crop.upper_right_x).toBe(1.0);
		expect(r.usedAssetIds).toEqual(["V1"]); // 文件级去重不受克隆影响
	});

	it("全 0 crop 视同未裁（走共享条目）；音频片段的 crop 忽略", () => {
		const d = doc([
			track("video", [vseg({ crop: { left: 0, top: 0, right: 0, bottom: 0 } })]),
			track("audio", [seg({ assetId: "AUD", media: "audio", sourceStartUs: 0, sourceDurationUs: 1_000_000, crop: { left: 0.2, top: 0, right: 0, bottom: 0 } })]),
		]);
		const r = buildDraftContent(d, resolve);
		expect((materialsOf(r).videos as Json[])).toHaveLength(1);
		expect((materialsOf(r).audios as Json[])).toHaveLength(1); // 音频照常单条、无克隆
	});

	it("素材只以 crop 克隆出现：素材面板（draft_meta_info type:0 桶）仍登记一条", () => {
		const d = doc([track("video", [vseg({ crop: { left: 0.1, top: 0, right: 0, bottom: 0 } })])]);
		const r = buildDraftContent(d, resolve, { nowMs: 1700000000000 });
		const buckets = (r.draftMetaInfo as Json).draft_materials as Array<{ type: number; value: Json[] }>;
		const panel = buckets.find((b) => b.type === 0)!.value;
		expect(panel).toHaveLength(1);
		expect(panel[0].metetype).toBe("video");
		expect(panel[0].file_Path).toBe("C:\\draft\\assets\\V1.mp4");
	});
});

describe("剪映导出 · 字幕轨（materials.texts + text 轨）", () => {
	const subtitle = (p: Partial<RtcSegment>) =>
		seg({ text: { content: "你好世界" }, targetStartUs: 0, targetDurationUs: 3_000_000, ...p });

	it("字幕真导出：texts material（content JSON 串含正文/颜色/描边/字号）+ text 轨片段（source null / clip 定位）", () => {
		const d = doc([
			track("text", [subtitle({ text: { content: "你好世界", color: "#ff0000", strokeColor: "#000000", fontSize: 0.07, x: 0, y: 0.4 } })], { name: "字幕" }),
			track("video", [vseg({})]),
		]);
		const r = buildDraftContent(d, resolve);
		const texts = materialsOf(r).texts as Json[];
		expect(texts).toHaveLength(1);
		const content = JSON.parse(texts[0].content as string);
		expect(content.text).toBe("你好世界");
		expect(content.styles[0].range).toEqual([0, 4]);
		expect(content.styles[0].size).toBe(jyTextSize(0.07)); // = 8（默认档锚点）
		expect(content.styles[0].fill.content.solid.color).toEqual([1, 0, 0]);
		expect(content.styles[0].strokes[0].content.solid.color).toEqual([0, 0, 0]);
		expect(texts[0].check_flag).toBe(15); // 基础 7 + 描边 8
		expect(texts[0].type).toBe("text");

		const textTrack = tracksOf(r).find((t) => t.type === "text")!;
		const s = (textTrack.segments as Json[])[0];
		expect(s.material_id).toBe(texts[0].id);
		expect(s.source_timerange).toBeNull(); // 文本无源素材窗口
		expect(s.target_timerange).toEqual({ start: 0, duration: 3_000_000 });
		expect(s.clip.transform).toEqual({ x: 0, y: -0.8 }); // y=0.4 → −0.8（半画幅 + y 轴取负）
		expect(s.hdr_settings).toBeUndefined(); // VisualSegment 基类无此键
		// 文本片段同样登记一条 speeds 并经 extra_material_refs 关联（pyJianYingDraft 同法）
		const speeds = materialsOf(r).speeds as Json[];
		expect(speeds.some((sp) => (s.extra_material_refs as string[]).includes(sp.id as string))).toBe(true);
	});

	it("text 轨恒排在导出末尾：render_index 高于全部画面轨（字幕压在最上层）", () => {
		const d = doc([
			track("text", [subtitle({})]),
			track("video", [vseg({})]),
			track("audio", [seg({ assetId: "AUD", media: "audio", sourceStartUs: 0, sourceDurationUs: 1_000_000 })]),
		]);
		const tks = tracksOf(buildDraftContent(d, resolve));
		expect(tks.map((t) => t.type)).toEqual(["video", "audio", "text"]);
		const ri = (type: string) => ((tks.find((t) => t.type === type)!.segments as Json[])[0].render_index as number);
		expect(ri("text")).toBeGreaterThan(ri("video"));
		expect(ri("text")).toBeGreaterThan(ri("audio"));
	});

	it("无内容字幕片段跳过记 warning（含「文本轨」措辞）；全被跳过的 text 轨不导出", () => {
		const d = doc([
			track("text", [seg({ assetId: "V1" })], { name: "字幕" }), // 无 text 字段（旧形状）
			track("video", [vseg({})]),
		]);
		const r = buildDraftContent(d, resolve);
		expect(r.warnings.some((w) => w.includes("文本轨") && w.includes("字幕"))).toBe(true);
		expect(tracksOf(r)).toHaveLength(1);
		expect(tracksOf(r)[0].type).toBe("video");
	});

	it("字幕不产生素材文件复制（usedAssetIds 不含字幕）；duration 计入字幕右缘", () => {
		const d = doc([
			track("text", [subtitle({ targetStartUs: 8_000_000, targetDurationUs: 3_000_000 })]),
			track("video", [vseg({})]),
		]);
		const r = buildDraftContent(d, resolve);
		expect(r.usedAssetIds).toEqual(["V1"]);
		expect((r.draftContent as Json).duration).toBe(11_000_000);
	});
});

describe("剪映导出 · 转场（materials.transitions + extra_material_refs）", () => {
	it("前一段带 transitionAfter → transitions 条目（pyJianYingDraft Transition 同形）+ 该段 refs 追加", () => {
		const d = doc([
			track("video", [
				vseg({ targetStartUs: 0, targetDurationUs: 1_000_000, transitionAfter: { effectId: "322577", resourceId: "6724845717472416269", name: "叠化", durationUs: 500_000 } }),
				vseg({ targetStartUs: 1_000_000, targetDurationUs: 1_000_000, sourceStartUs: 1_000_000 }),
			]),
		]);
		const r = buildDraftContent(d, resolve);
		const trs = materialsOf(r).transitions as Json[];
		expect(trs).toHaveLength(1);
		expect(trs[0]).toMatchObject({
			category_id: "",
			category_name: "",
			duration: 500_000,
			effect_id: "322577",
			is_overlap: true, // 叠化按资源表 overlap
			name: "叠化",
			platform: "all",
			resource_id: "6724845717472416269",
			type: "transition",
		});
		const segs = tracksOf(r)[0].segments as Json[];
		expect((segs[0].extra_material_refs as string[])).toContain(trs[0].id);
		expect((segs[1].extra_material_refs as string[])).not.toContain(trs[0].id); // 只挂前一段
	});

	it("时长夹取（0.1–5s）与表外资源 is_overlap 兜底 true；音频轨的 transitionAfter 忽略", () => {
		const d = doc([
			track("video", [vseg({ transitionAfter: { effectId: "999999", resourceId: "123", name: "自定义", durationUs: 99_000_000 } })]),
			track("audio", [seg({ assetId: "AUD", media: "audio", sourceStartUs: 0, sourceDurationUs: 1_000_000, transitionAfter: { effectId: "322577", resourceId: "6724845717472416269", name: "叠化", durationUs: 500_000 } })]),
		]);
		const trs = materialsOf(buildDraftContent(d, resolve)).transitions as Json[];
		expect(trs).toHaveLength(1); // 音频轨不产转场
		expect(trs[0].duration).toBe(5_000_000);
		expect(trs[0].is_overlap).toBe(true);
	});

	it("无转场的文档：materials.transitions 为空数组（模板骨架完整）", () => {
		const r = buildDraftContent(doc([track("video", [vseg({})])]), resolve);
		expect(materialsOf(r).transitions).toEqual([]);
	});
});

describe("剪映导出 · 倒放片段（副本即普通素材，零特殊分支）", () => {
	it("reversedFromAssetId 只是标记：导出按片段自己的 assetId/source 窗口照常走", () => {
		const d = doc([
			track("video", [vseg({ assetId: "V1", reversedFromAssetId: "ORIG", sourceStartUs: 5_000_000, sourceDurationUs: 3_000_000, targetDurationUs: 3_000_000 })]),
		]);
		const r = buildDraftContent(d, resolve);
		expect((materialsOf(r).videos as Json[])).toHaveLength(1);
		const s = (tracksOf(r)[0].segments as Json[])[0];
		expect(s.source_timerange).toEqual({ start: 5_000_000, duration: 3_000_000 });
		expect(s.reversedFromAssetId).toBeUndefined(); // 内部标记不泄漏进草稿 JSON
	});
});
