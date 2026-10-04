/**
 * assetGenActions 纯逻辑单测：
 *  - 五类 purpose / id 前缀映射与 AssetWorkbench 各页一致（群像共用 character 出图用途、前缀 G）；
 *  - buildAssetBaseGenSpec 与 AssetWorkbench.generateForm 逐字段对齐
 *    （保留 aspect 并补齐 aspect_ratio/resolution/quality/idPrefix/assetName、variantId=null、无提示词明确报错不发请求）；
 *  - 开放档位只用于补缺默认值，显式分辨率与扩展参数原样保留。
 */
import { describe, it, expect } from "vitest";
import { ASSET_IMAGE_PURPOSE, ASSET_CAT_PREFIX, buildAssetBaseGenSpec } from "./assetGenActions";
import { isAssetCat, ASSET_CATS } from "../asset/rtcAssetData";

describe("ASSET_IMAGE_PURPOSE / ASSET_CAT_PREFIX（与 AssetWorkbench 各页对齐）", () => {
	it("五类 purpose 映射：群像与角色共用 asset.character.image", () => {
		expect(ASSET_IMAGE_PURPOSE.characters).toBe("asset.character.image");
		expect(ASSET_IMAGE_PURPOSE.crowds).toBe("asset.character.image"); // FrameGroup 实际用法
		expect(ASSET_IMAGE_PURPOSE.scenes).toBe("asset.scene.image");
		expect(ASSET_IMAGE_PURPOSE.organisms).toBe("asset.creature.image");
		expect(ASSET_IMAGE_PURPOSE.items).toBe("asset.prop.image");
	});

	it("id 前缀：C/G/S/M/P（与 AssetWorkbench CAT_PREFIX 同表）", () => {
		expect(ASSET_CAT_PREFIX).toEqual({ characters: "C", crowds: "G", scenes: "S", organisms: "M", items: "P" });
	});
});

describe("buildAssetBaseGenSpec", () => {
	const asset = { id: "characters-1", name: "李云", prompt: "  一位青年剑客  " };

	it("组装与 AssetWorkbench.generateForm 同尺：variantId=null、完整保留图片参数、label=资产名", () => {
		const r = buildAssetBaseGenSpec("characters", asset, "img-model-1");
		expect("spec" in r).toBe(true);
		if (!("spec" in r)) return;
		expect(r.spec).toEqual({
			cat: "characters",
			assetId: "characters-1",
			variantId: null,
			purpose: "asset.character.image",
			prompt: "一位青年剑客",
			modelKey: "img-model-1",
			params: { aspect_ratio: "16:9", resolution: "2k", quality: "high", idPrefix: "C", assetName: "李云" },
			label: "李云",
		});
	});

	it("无提示词（空/全空白）→ 明确报错不出 spec", () => {
		const r1 = buildAssetBaseGenSpec("scenes", { id: "s1", name: "山谷" }, "m");
		const r2 = buildAssetBaseGenSpec("scenes", { id: "s1", name: "山谷", prompt: "   " }, "m");
		expect("error" in r1 && r1.error.length > 0).toBe(true);
		expect("error" in r2).toBe(true);
	});

	it("空 modelKey → spec.modelKey=undefined（按设置默认解析，与 GenSpec 语义一致）", () => {
		const r = buildAssetBaseGenSpec("items", { id: "p1", name: "长剑", prompt: "一把长剑" }, "");
		if (!("spec" in r)) throw new Error("expected spec");
		expect(r.spec.modelKey).toBeUndefined();
		expect(r.spec.purpose).toBe("asset.prop.image");
		expect(r.spec.params?.idPrefix).toBe("P");
	});

	it("缺少分辨率时依据开放档补默认值：仅开放 1k 则默认 1k", () => {
		const r = buildAssetBaseGenSpec("organisms", { id: "m1", name: "灵狐", prompt: "九尾灵狐" }, "m", [{ v: "1k" }]);
		if (!("spec" in r)) throw new Error("expected spec");
		expect(r.spec.params?.aspect_ratio).toBe("16:9");
		expect(r.spec.params?.resolution).toBe("1k");
		expect(r.spec.params?.idPrefix).toBe("M");
	});

	it("ui 覆盖比例/质量：1:1 + 4k + medium", () => {
		const r = buildAssetBaseGenSpec("crowds", { id: "g1", name: "村民", prompt: "一群村民" }, "m",
			[{ v: "1k" }, { v: "2k" }, { v: "4k" }], { aspect: "1:1", resolution: "4k", quality: "medium" });
		if (!("spec" in r)) throw new Error("expected spec");
		expect(r.spec.params).toEqual({ aspect: "1:1", aspect_ratio: "1:1", resolution: "4k", quality: "medium", idPrefix: "G", assetName: "村民" });
	});
	it("显式分辨率不改档或大小写，扩展参数完整保留且不修改输入", () => {
		const params = Object.freeze({ resolution: "4K", aspect_ratio: "3:4", reference_strength: 0.9, quality: "high",
			idPrefix: "CUSTOM", assetName: "Custom name", custom: { weights: [0.7, 0.3] } });
		const r = buildAssetBaseGenSpec("characters", asset, "m", [{ v: "2k" }], params);
		if (!("spec" in r)) throw new Error("expected spec");
		expect(r.spec.params).toEqual(params);
		expect(r.spec.params).not.toBe(params);
	});
	it("仅有原生图片配置时按其补齐字段，保留嵌套配置", () => {
		const params = { generationConfig: { imageConfig: { imageSize: "4K", aspectRatio: "1:1" } }, reference_strength: 0 };
		const r = buildAssetBaseGenSpec("characters", asset, "m", [{ v: "2k" }], params);
		if (!("spec" in r)) throw new Error("expected spec");
		expect(r.spec.params).toEqual({ ...params, aspect_ratio: "1:1", resolution: "4K", quality: "high", idPrefix: "C", assetName: "李云" });
	});
});

describe("isAssetCat（面板五类判定）", () => {
	it("五类为真，媒体/其他分类为假", () => {
		for (const c of ASSET_CATS) expect(isAssetCat(c)).toBe(true);
		expect(isAssetCat("others")).toBe(false);
		expect(isAssetCat("videos")).toBe(false);
		expect(isAssetCat("audios")).toBe(false);
	});
});
