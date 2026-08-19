/**
 * shotMatchActions 单测 —— RTC 分镜工作台「匹配资产」与 Frame161195「提取资产」同尺：
 *  - 匹配范围：原文分段 + 三份提示词（剥图例防自我循环）+ 旧 prompt 字段；弹窗草稿覆盖对应栏位；
 *  - 用图优先级（第78轮）：原文点名造型 > assetFormStore 选中造型 > 基础形象；
 *  - 音色配对（第86轮）：角色带音色自动加声音素材（独立于图片判重），图例「@ImageN的声音参考@AudioM」；
 *  - 素材集合变更恒经 shotMaterialOps 统一入口（图例/@ 编号自动重建，第142轮红线）。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { useProjectStore } from "@/store/projectStore";
import { useAssetFormStore } from "@/store/assetFormStore";
import type { ShotMaterial, StoryboardShot } from "@/services/projectFile";
import type { MatchedAsset } from "@/lib/assetMatch";
import { composeShotMatchText, planShotMatch, matchShotAssets, MATCH_KIND_TO_MATERIAL } from "./shotMatchActions";

const mat = (id: string, name: string, uri = `asset://${id}.png`, extra?: Partial<ShotMaterial>): ShotMaterial =>
	({ id, assetId: `ent-${id}`, kind: "character", media: "image", name, uri, ...extra } as ShotMaterial);

const seed = (shot: Partial<StoryboardShot>, extra: Record<string, unknown> = {}) => {
	useProjectStore.setState({
		mediaSettings: {},
		characters: [], crowds: [], scenes: [], organisms: [], items: [],
		episodes: [{
			id: "ep1", title: "第一集", scriptText: "",
			shots: [{ id: "sh1", index: 1, title: "分镜1", scriptSegment: "", prompt: "", materials: [], ...shot }],
		}],
		...extra,
	} as any);
	useAssetFormStore.setState({ selForm: {} });
};

const shot = () => useProjectStore.getState().episodes[0].shots[0];

describe("composeShotMatchText（匹配范围与 Frame161195 同源）", () => {
	it("原文 + 三份提示词（剥【素材图例】前缀行）+ 旧 prompt 字段", () => {
		const t = composeShotMatchText({
			scriptSegment: "甲走进山庙",
			storyboardPrompt: "【素材图例】@Image1 是 乙，\n\n构图以乙为主",
			videoPrompt: "【素材图例】@Image1 是 乙，\n\n乙推门",
			unifiedPrompt: "",
			prompt: "旧字段丙",
		});
		expect(t).toContain("甲走进山庙");
		expect(t).toContain("构图以乙为主");
		expect(t).toContain("旧字段丙");
		expect(t).not.toContain("【素材图例】"); // 图例行剥除，防上一轮提取的资产名自我循环
	});
	it("draftOv 以弹窗草稿覆盖对应栏位（其余栏位仍用已存值）", () => {
		const base = { scriptSegment: "", storyboardPrompt: "旧故事板", videoPrompt: "旧视频", unifiedPrompt: "", prompt: "" };
		const t = composeShotMatchText(base, { field: "videoPrompt", text: "草稿里点名了丁" });
		expect(t).toContain("草稿里点名了丁");
		expect(t).not.toContain("旧视频");
		expect(t).toContain("旧故事板");
	});
});

describe("planShotMatch（纯规划：去重/音色独立/无图不占号/空 uri 回填）", () => {
	const matched = (p: Partial<MatchedAsset>): MatchedAsset =>
		({ kind: "character", name: "甲", image: "asset://a.png", assetId: "ent-a", ...p } as MatchedAsset);

	it("kind 映射：群像归 character（ShotMaterial 无 crowd 枚举，与 Frame161195 同尺）", () => {
		expect(MATCH_KIND_TO_MATERIAL.crowd).toBe("character");
		expect(MATCH_KIND_TO_MATERIAL.scene).toBe("scene");
		expect(MATCH_KIND_TO_MATERIAL.creature).toBe("creature");
		expect(MATCH_KIND_TO_MATERIAL.prop).toBe("prop");
	});
	it("已在素材区的资产不重复添加；但其音色缺席时仍补加（第86轮：图片判重不得短路音色）", () => {
		const { adds, backfills } = planShotMatch(
			[mat("ma", "甲", "asset://a.png", { assetId: "ent-a" })],
			[matched({ voiceUri: "asset://a.mp3", voiceAssetId: "audio-a", voiceName: "甲的声音" })],
		);
		expect(backfills).toEqual([]);
		expect(adds).toHaveLength(1);
		expect(adds[0]).toMatchObject({ media: "audio", kind: "local", uri: "asset://a.mp3", voiceForAssetId: "ent-a", name: "甲的声音" });
	});
	it("无图资产不推图片素材（空 uri 占 @ 编号=错位红线），音色照加", () => {
		const { adds } = planShotMatch([], [matched({ image: undefined, voiceUri: "asset://a.mp3", voiceAssetId: "audio-a" })]);
		expect(adds).toHaveLength(1);
		expect(adds[0].media).toBe("audio");
	});
	it("素材区同 assetId 的空 uri 旧素材 → 回填新图不重复加", () => {
		const { adds, backfills } = planShotMatch(
			[mat("ma", "甲", "", { assetId: "ent-a" })],
			[matched({})],
		);
		expect(adds).toEqual([]);
		expect(backfills).toEqual([{ matId: "ma", uri: "asset://a.png" }]);
	});
	it("同一次规划内部去重（同资产多次命中只加一条）", () => {
		const { adds } = planShotMatch([], [matched({}), matched({})]);
		expect(adds).toHaveLength(1);
	});
});

describe("matchShotAssets（store 集成：匹配→统一入口加素材→图例重建）", () => {
	beforeEach(() => {
		seed({ scriptSegment: "甲走进山庙" }, {
			characters: [{
				id: "ent-a", name: "甲", image: "asset://a-base.png",
				variants: [{ id: "v1", label: "战损", name: "甲战损形态", image: "asset://a-v1.png" }],
				voiceUri: "asset://a.mp3", voiceAssetId: "audio-a", voiceName: "甲的声音",
			}],
			scenes: [{ id: "ent-s", name: "山庙", image: "asset://s.png" }],
		});
	});

	it("命中角色+场景：图片素材+声音素材经统一入口加入，图例含「@ImageN的声音参考@AudioM」配对", () => {
		const r = matchShotAssets("ep1", "sh1");
		expect(r).not.toBeNull();
		const s = shot();
		expect(s.materials.map((m) => m.name)).toEqual(["甲", "甲的声音", "山庙"]);
		expect(r!.added).toBe(3);
		// 双结果模式：videoPrompt 全模态图例 + 音色配对；storyboardPrompt 仅图像
		expect(s.videoPrompt).toContain("【素材图例】@Image1 是 甲，@Image2 是 山庙，@Image1的声音参考@Audio1，");
		expect(s.storyboardPrompt).toContain("@Image1 是 甲");
		expect(s.storyboardPrompt).not.toContain("声音参考");
		// 用图默认=基础形象
		expect(s.materials[0].uri).toBe("asset://a-base.png");
	});

	it("第78轮：assetFormStore 选中造型优先 → 用图=选中造型的图", () => {
		useAssetFormStore.getState().setSelForm("ent-a", "v1");
		matchShotAssets("ep1", "sh1");
		expect(shot().materials.find((m) => m.assetId === "ent-a")?.uri).toBe("asset://a-v1.png");
	});

	it("原文点名造型 > 选中造型：原文出现造型名时用该造型图与造型名", () => {
		useProjectStore.getState().updateShot("ep1", "sh1", { scriptSegment: "甲战损形态倒在山庙前" });
		const r = matchShotAssets("ep1", "sh1");
		expect(r).not.toBeNull();
		const m = shot().materials.find((x) => x.assetId === "ent-a")!;
		expect(m.uri).toBe("asset://a-v1.png");
		expect(m.name).toBe("甲战损形态");
	});

	it("幂等：二次匹配不重复加素材（added=0），图例稳定", () => {
		matchShotAssets("ep1", "sh1");
		const before = shot();
		const r2 = matchShotAssets("ep1", "sh1");
		expect(r2!.added).toBe(0);
		expect(shot().materials).toHaveLength(before.materials.length);
	});

	it("弹窗草稿委托（第108轮）：草稿覆盖该栏参与匹配，图例基于草稿重建并返回新提示词", () => {
		useProjectStore.getState().updateShot("ep1", "sh1", { scriptSegment: "" });
		const r = matchShotAssets("ep1", "sh1", { field: "videoPrompt", text: "山庙前推镜" });
		expect(r).not.toBeNull();
		expect(r!.prompt).toContain("【素材图例】");
		expect(r!.prompt).toContain("山庙前推镜");
		expect(shot().videoPrompt).toBe(r!.prompt); // 草稿+图例已落栏位（弹窗保存再落一次同值幂等）
		expect(shot().materials.some((m) => m.assetId === "ent-s")).toBe(true);
	});

	it("无命中且素材区为空 → null（无可提取）；有存量素材时=刷新图例返回 added:0", () => {
		useProjectStore.getState().updateShot("ep1", "sh1", { scriptSegment: "毫无关联的文本" });
		expect(matchShotAssets("ep1", "sh1")).toBeNull();
		useProjectStore.getState().updateShot("ep1", "sh1", { materials: [mat("mz", "存量素材")] });
		const r = matchShotAssets("ep1", "sh1");
		expect(r).not.toBeNull();
		expect(r!.added).toBe(0);
		expect(shot().videoPrompt).toContain("@Image1 是 存量素材");
	});

	it("图视同源：图例写进 unifiedPrompt（含音色配对），返回 prompt 取同源栏", () => {
		useProjectStore.setState({ mediaSettings: { imgVideoSameSource: true } } as any);
		const r = matchShotAssets("ep1", "sh1");
		expect(r!.prompt).toContain("@Image1的声音参考@Audio1");
		expect(shot().unifiedPrompt).toContain("【素材图例】");
	});
});
