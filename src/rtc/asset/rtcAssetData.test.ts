/** rtcAssetData —— 实时剪辑资产面板数据汇集层单测（分类/去重/payload 同构性） */
import { describe, it, expect } from "vitest";
import {
	rtcCatOfId, mediaOfMime, filterByQuery, buildAssetPayload, collectAssetForms,
	collectVideoItems, collectAudioItems, collectProjectImageItems, collectFavoriteItems, collectSharedItems,
	filterLibraryByEpisode, buildCanvasAssetEpisodeMap, collectLibraryImageItems,
	type RtcAssetItem,
} from "./rtcAssetData";
import type { AssetBlob, VideoEpisode } from "@/services/projectFile";
import type { Asset as LibraryAsset } from "@/store/libraryStore";

const noBlob = (_uri: string): AssetBlob | undefined => undefined;

function libAsset(p: Partial<LibraryAsset> & Pick<LibraryAsset, "id" | "kind" | "uri" | "name">): LibraryAsset {
	return { thumbnailUri: null, createdAt: "", deletedByUser: false, ...p };
}

describe("rtcCatOfId / mediaOfMime", () => {
	it("按台账 id 前缀分类（含 video/audio 归媒体类）", () => {
		expect(rtcCatOfId("C00000123")).toBe("characters");
		expect(rtcCatOfId("A00000001")).toBe("characters");
		expect(rtcCatOfId("G00000002")).toBe("crowds");
		expect(rtcCatOfId("M00000003")).toBe("organisms");
		expect(rtcCatOfId("S00000004")).toBe("scenes");
		expect(rtcCatOfId("P00000005")).toBe("items");
		expect(rtcCatOfId("video00024621")).toBe("videos");
		expect(rtcCatOfId("audio00000009")).toBe("audios");
		expect(rtcCatOfId("TP00007708")).toBe("others");
		expect(rtcCatOfId(undefined)).toBe("others");
	});
	it("mime → 模态（缺省按图像）", () => {
		expect(mediaOfMime("video/mp4")).toBe("video");
		expect(mediaOfMime("audio/mpeg")).toBe("audio");
		expect(mediaOfMime("image/png")).toBe("image");
		expect(mediaOfMime(undefined)).toBe("image");
	});
});

describe("collectVideoItems", () => {
	const eps: VideoEpisode[] = [
		{
			id: "ep1", index: 1, title: "001", scriptText: "",
			shots: [
				{
					id: "s1", index: 1, title: "分镜1", prompt: "", materials: [],
					videoUri: "local://v1.mp4",
					videoUris: ["local://v1.mp4", "local://v1-old.mp4"], // 主视频也在历史里 → 去重
					videoDerived: [
						{ id: "d1", kind: "upscale", uri: "local://v1-up.mp4", srcUri: "local://v1.mp4", label: "v1+", createdAt: 0 },
						{ id: "d2", kind: "desub", uri: "local://v1-run.mp4", srcUri: "local://v1.mp4", label: "v1-", createdAt: 0, status: "running" }, // 进行中不收
					],
					durationSec: 15,
				},
			],
		},
	] as VideoEpisode[];

	it("汇集 主视频+历史+派生成品 与素材库 video，按 uri/id 去重", () => {
		const lib = [
			libAsset({ id: "L1", kind: "video", uri: "local://libv.mp4", name: "本地片段" }),
			libAsset({ id: "L2", kind: "video", uri: "local://v1.mp4", name: "重复的主视频" }), // 与分镜同 uri → 去重
			libAsset({ id: "L3", kind: "video", uri: "local://deleted.mp4", name: "已删", deletedByUser: true }),
			libAsset({ id: "L4", kind: "audio", uri: "local://a.mp3", name: "不是视频" }),
		];
		const out = collectVideoItems(eps, lib, noBlob);
		expect(out.map((i) => i.uri)).toEqual(["local://v1.mp4", "local://v1-old.mp4", "local://v1-up.mp4", "local://libv.mp4"]);
		expect(out[0].name).toBe("分镜1");           // 单集不带集号前缀
		expect(out[0].durationSec).toBe(15);
		expect(out[2].name).toBe("分镜1·v1+");        // 派生记录带标号
		expect(out.every((i) => i.cat === "videos" && i.media === "video")).toBe(true);
	});

	it("多集时名称带集号；台账 id 命中时用作去重键与 assetId", () => {
		const two = [eps[0], { ...eps[0], id: "ep2", index: 2 }] as VideoEpisode[];
		const blobByUri = (uri: string): AssetBlob | undefined =>
			uri === "local://v1.mp4" ? { id: "video00000001", url: "https://oss/v1.mp4", localUri: uri } : undefined;
		const out = collectVideoItems(two, [], blobByUri);
		expect(out[0].name).toBe("1集·分镜1");
		expect(out[0].id).toBe("video00000001");
		expect(out[0].key).toBe("video00000001");
	});
});

describe("collectAudioItems", () => {
	it("汇集 绑定音色 + 素材库 audio，去重", () => {
		const owners = [
			{ id: "C1", name: "林小满", voiceUri: "local://voice1.mp3", voiceAssetId: "audio00000001", voiceName: "小满音色" },
			{ id: "C2", name: "沈青崖", voiceUri: "local://voice2.mp3" }, // 无 voiceName → 用「名·音色」
			{ id: "C3", name: "无音色" },
		];
		const lib = [
			libAsset({ id: "L1", kind: "audio", uri: "local://bgm.mp3", name: "背景乐" }),
			libAsset({ id: "L2", kind: "audio", uri: "local://voice1.mp3", name: "重复音色" }), // 与音色同 uri → 去重
		];
		const out = collectAudioItems(owners, lib, noBlob);
		expect(out.map((i) => i.name)).toEqual(["小满音色", "沈青崖·音色", "背景乐"]);
		expect(out[0].id).toBe("audio00000001");
		expect(out.every((i) => i.cat === "audios" && i.media === "audio")).toBe(true);
	});
});

describe("collectProjectImageItems", () => {
	const assets = [
		{ id: "C1", name: "甲", image: "u-base", variants: [{ id: "v1", label: "黑袍", image: "u-v1" }, { id: "v2", label: "无图变体" }] },
		{ id: "C2", name: "乙" }, // 无任何图
	];
	it("一资产一卡：显示当前选中造型；缺省（无 placeholders）无图资产不显示——RtcCenterStage 依赖旧语义", () => {
		expect(collectProjectImageItems(assets, "characters", {}).map((i) => i.uri)).toEqual(["u-base"]);
		const sel = collectProjectImageItems(assets, "characters", { C1: "v1" });
		expect(sel[0].uri).toBe("u-v1");
		expect(sel[0].name).toBe("甲·黑袍");
		expect(sel[0].variantId).toBe("v1");
	});
	it("主体卡携带造型清单（仅含已出图，基础形象在首；与 AssetAssistant 同规不平铺变体）", () => {
		const out = collectProjectImageItems(assets, "characters", {});
		expect(out).toHaveLength(1); // 变体不单独占格
		expect(out[0].baseName).toBe("甲");
		expect(out[0].variantId).toBeNull();
		expect(out[0].forms?.map((f) => f.variantId)).toEqual([null, "v1"]); // 无图变体 v2 不进造型清单
		expect(out[0].forms?.map((f) => f.label)).toEqual(["基础形象", "黑袍"]);
	});
	it("placeholders 开启：无图资产以占位符卡排分类最前，有图卡保持现有顺序", () => {
		const four = [
			{ id: "C1", name: "有图甲", image: "u1" },
			{ id: "C2", name: "无图乙" },
			{ id: "C3", name: "有图丙", image: "u3" },
			{ id: "C4", name: "无图丁" },
		];
		const out = collectProjectImageItems(four, "characters", {}, { placeholders: true });
		expect(out.map((i) => i.key)).toEqual(["C2", "C4", "C1", "C3"]);
		expect(out[0]).toMatchObject({ placeholder: true, uri: "", id: "C2", name: "无图乙", cat: "characters", media: "image" });
		expect(out[1]).toMatchObject({ placeholder: true, id: "C4" });
		expect(out[2].placeholder).toBeUndefined();
		expect(out[0].forms).toBeUndefined(); // 占位符卡不带造型（无图无变体展示）
	});
	it("占位符 key=资产 id：出图后自动变正常图卡且 key 稳定；搜索过滤把无图资产算上", () => {
		const before = collectProjectImageItems([{ id: "C9", name: "术士" }], "characters", {}, { placeholders: true });
		expect(before[0]).toMatchObject({ key: "C9", placeholder: true });
		const after = collectProjectImageItems([{ id: "C9", name: "术士", image: "u9" }], "characters", {}, { placeholders: true });
		expect(after[0]).toMatchObject({ key: "C9", uri: "u9" });
		expect(after[0].placeholder).toBeUndefined();
		expect(filterByQuery(before, "术士")).toHaveLength(1);
		expect(filterByQuery(before, "别人")).toHaveLength(0);
	});
});

describe("collectFavoriteItems / collectSharedItems", () => {
	it("收藏：contentType 定模态、id 前缀定分类、本地副本优先显示", () => {
		const favs = [
			{ assetId: "C00000001", createdAt: 0, type: "character", contentType: "image/png", url: "https://oss/c1.png", sizeBytes: 1, platformPinned: false },
			{ assetId: "video00000002", createdAt: 0, type: "video", contentType: "video/mp4", url: "https://oss/v.mp4", sizeBytes: 1, platformPinned: false },
		];
		const blobs: Record<string, AssetBlob> = { C00000001: { id: "C00000001", localUri: "local://c1.png" } };
		const out = collectFavoriteItems(favs, blobs);
		expect(out[0]).toMatchObject({ cat: "characters", media: "image", uri: "local://c1.png" });
		expect(out[1]).toMatchObject({ cat: "videos", media: "video", uri: "https://oss/v.mp4" });
	});
	it("共享：跨文件夹按台账 id 去重，未下载的不显示", () => {
		const rec = (id: string, assetId: string | undefined, mime: string, localUri?: string) =>
			({ id, assetId, name: id, url: "https://oss/" + id, mime, localUri }) as never;
		const out = collectSharedItems({
			f1: [rec("r1", "S00000001", "image/png", "local://s1.png"), rec("r2", undefined, "video/mp4", undefined)],
			f2: [rec("r3", "S00000001", "image/png", "local://s1.png")], // 同台账 id → 去重
		});
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({ cat: "scenes", media: "image", key: "S00000001" });
	});
});

describe("buildAssetPayload（⚠ 与 AssetAssistant 同构的硬约定）", () => {
	const blob: AssetBlob = { id: "C00000001", url: "https://oss/c1.png", localPath: "D:\\a\\c1.png", localUri: "local://c1.png" };
	it("图片卡：字段与助手逐字段一致，不带 media/durationSec", () => {
		const item: RtcAssetItem = { key: "C00000001", uri: "local://c1.png", name: "甲", cat: "characters", media: "image" };
		const p = buildAssetPayload(item, blob);
		expect(p).toEqual({
			source: "qiji-asset", assetId: "C00000001", url: "https://oss/c1.png",
			localUri: "local://c1.png", localPath: "D:\\a\\c1.png", name: "甲", kind: "image", cat: "characters",
		});
		expect("media" in p).toBe(false);
	});
	it("媒体卡：只加 media/durationSec，既有字段形状不变；无 blob 时 url 回退显示 uri", () => {
		const item: RtcAssetItem = { key: "k", uri: "local://v1.mp4", name: "分镜1", cat: "videos", media: "video", id: "video00000001", durationSec: 15 };
		const p = buildAssetPayload(item, undefined);
		expect(p).toMatchObject({
			source: "qiji-asset", assetId: "video00000001", url: "local://v1.mp4", localUri: "local://v1.mp4",
			name: "分镜1", kind: "video", cat: "videos", media: "video", durationSec: 15,
		});
	});
	it("音频卡无时长时不带 durationSec", () => {
		const item: RtcAssetItem = { key: "k", uri: "local://a.mp3", name: "音色", cat: "audios", media: "audio" };
		const p = buildAssetPayload(item, undefined);
		expect(p.media).toBe("audio");
		expect("durationSec" in p).toBe(false);
	});
});

describe("filterLibraryByEpisode（分集化：素材页按分集过滤）", () => {
	const a1 = libAsset({ id: "a1", kind: "video", uri: "u1", name: "本集", episodeId: "ep-1" });
	const a2 = libAsset({ id: "a2", kind: "video", uri: "u2", name: "别集", episodeId: "ep-2" });
	const a3 = libAsset({ id: "a3", kind: "video", uri: "u3", name: "旧素材（无标记）" });

	it("留 当前分集的 + 未打标记的旧素材；别集的过滤掉", () => {
		expect(filterLibraryByEpisode([a1, a2, a3], "ep-1").map((a) => a.id)).toEqual(["a1", "a3"]);
		expect(filterLibraryByEpisode([a1, a2, a3], "ep-2").map((a) => a.id)).toEqual(["a2", "a3"]);
	});
	it("episodeKey 为空（无分集）不过滤；无变化时保持原引用", () => {
		const all = [a1, a2, a3];
		expect(filterLibraryByEpisode(all, "")).toBe(all);
		const same = [a1, a3];
		expect(filterLibraryByEpisode(same, "ep-1")).toBe(same);
	});

	it("画布归属反查表兜底：未打标的画布生成物按其所在画布的分集过滤（打标优先于反查）", () => {
		const gen1 = libAsset({ id: "video001", kind: "video", uri: "g1", name: "画布产物-第一集", origin: "generated" });
		const gen2 = libAsset({ id: "lc-2", kind: "video", uri: "g2", name: "画布产物-第二集", origin: "generated", serverAssetId: "video002" });
		const tagged = libAsset({ id: "video003", kind: "video", uri: "g3", name: "打了标的", origin: "generated", episodeId: "ep-1" });
		const attribution = new Map([["video001", "ep-1"], ["video002", "ep-2"], ["video003", "ep-2"]]);
		// gen2 按 serverAssetId 反查归 ep-2；tagged 的 episodeId=ep-1 优先于反查表里的 ep-2
		expect(filterLibraryByEpisode([gen1, gen2, tagged], "ep-1", attribution).map((a) => a.id)).toEqual(["video001", "video003"]);
		expect(filterLibraryByEpisode([gen1, gen2, tagged], "ep-2", attribution).map((a) => a.id)).toEqual(["lc-2"]);
	});
});

describe("buildCanvasAssetEpisodeMap（画布生成物 → 分集归属反查）", () => {
	it("从画布快照/激活画布节点收 resultAssetId + resultHistory；激活画布先收（同资产激活者胜）", () => {
		const canvases = {
			"ep-1": { nodes: { n1: { data: { resultAssetId: "vidA", resultHistory: ["vidA", "vidOld"] } } } },
			"ep-3": { nodes: { n2: { data: { resultAssetId: "vidB" } }, n3: { data: { resultAssetId: null } } } },
		};
		const activeNodes = { n9: { data: { resultAssetId: "vidC", resultHistory: ["vidA"] } } };
		const m = buildCanvasAssetEpisodeMap(canvases, "ep-2", activeNodes);
		expect(m.get("vidC")).toBe("ep-2"); // 激活画布（ep-2 实时节点）
		expect(m.get("vidA")).toBe("ep-2"); // 同资产也出现在 ep-1 快照——激活者先收胜出
		expect(m.get("vidOld")).toBe("ep-1"); // 历史堆叠也归属
		expect(m.get("vidB")).toBe("ep-3");
	});

	it("激活分集的画布快照被跳过（以 canvasStore 实时节点为准，快照可能陈旧）", () => {
		const canvases = { "ep-1": { nodes: { n1: { data: { resultAssetId: "vidStale" } } } } };
		const m = buildCanvasAssetEpisodeMap(canvases, "ep-1", {});
		expect(m.has("vidStale")).toBe(false); // 快照陈旧不作数——实时节点里没有它
	});
});

describe("collectLibraryImageItems includeGenerated", () => {
	const up = libAsset({ id: "TP1", kind: "image", uri: "u1", name: "导入图", origin: "upload" });
	const gen = libAsset({ id: "TP2", kind: "image", uri: "u2", name: "生成图", origin: "generated" });
	it("缺省只收本地导入（画布本地素材库语义）；includeGenerated 连生成物一并收", () => {
		expect(collectLibraryImageItems([up, gen]).map((i) => i.id)).toEqual(["TP1"]);
		expect(collectLibraryImageItems([up, gen], { includeGenerated: true }).map((i) => i.id)).toEqual(["TP1", "TP2"]);
	});
});

describe("filterByQuery", () => {
	it("按名称 includes 过滤（大小写不敏感，空串返回全部）", () => {
		const items = [
			{ key: "1", uri: "u1", name: "林小满", cat: "characters", media: "image" },
			{ key: "2", uri: "u2", name: "Beach BGM", cat: "audios", media: "audio" },
		] as RtcAssetItem[];
		expect(filterByQuery(items, "")).toHaveLength(2);
		expect(filterByQuery(items, "小满")).toHaveLength(1);
		expect(filterByQuery(items, "beach")[0].key).toBe("2");
		expect(filterByQuery(items, "不存在")).toHaveLength(0);
	});
});

describe("collectAssetForms（分体清单：右栏分体选择 / 左栏「N造型」选单 / AssetAssistant 三方同源）", () => {
	it("基础形象在前 + 全部已出图变体（无图变体剔除）；变体名=「资产名·label」", () => {
		const forms = collectAssetForms({
			id: "c1", name: "林小满", image: "local://base.png",
			variants: [
				{ id: "v1", label: "战损", image: "local://v1.png" },
				{ id: "v2", label: "无图造型" }, // 无 image → 不入清单
			],
		});
		expect(forms).toEqual([
			{ variantId: null, label: "基础形象", name: "林小满", uri: "local://base.png" },
			{ variantId: "v1", label: "战损", name: "林小满·战损", uri: "local://v1.png" },
		]);
	});
	it("基础未出图但变体有图 → 只列变体；全无图 → 空数组（占位符卡语义）", () => {
		const onlyVar = collectAssetForms({ id: "c2", name: "甲", variants: [{ id: "v1", label: "夏装", image: "local://x.png" }] });
		expect(onlyVar).toHaveLength(1);
		expect(onlyVar[0].variantId).toBe("v1");
		expect(collectAssetForms({ id: "c3", name: "乙" })).toEqual([]);
	});
	it("与 collectProjectImageItems 的 forms 完全同源（同一份收敛逻辑）", () => {
		const a = { id: "c1", name: "林小满", image: "local://base.png", variants: [{ id: "v1", label: "战损", image: "local://v1.png" }] };
		const items = collectProjectImageItems([a], "characters", {});
		expect(items[0].forms).toEqual(collectAssetForms(a));
	});
});
