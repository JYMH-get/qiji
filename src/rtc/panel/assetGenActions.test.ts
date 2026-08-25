/**
 * assetGenActions 纯逻辑单测：
 *  - 五类 purpose / id 前缀映射与 AssetWorkbench 各页一致（群像共用 character 出图用途、前缀 G）；
 *  - buildAssetBaseGenSpec 与 AssetWorkbench.generateForm 逐字段对齐
 *    （params={size,quality,idPrefix,assetName}、variantId=null、无提示词明确报错不发请求）；
 *  - 分辨率档按模型开放集收敛（服务端控档一把尺）。
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

	it("组装与 AssetWorkbench.generateForm 同尺：variantId=null、params 四件套、label=资产名", () => {
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
			params: { size: "2048x1152", quality: "high", idPrefix: "C", assetName: "李云" },
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

	it("分辨率档按模型开放集收敛：默认 2k 不在开放集（仅 1k）→ 归一第一档 1k", () => {
		const r = buildAssetBaseGenSpec("organisms", { id: "m1", name: "灵狐", prompt: "九尾灵狐" }, "m", [{ v: "1k" }]);
		if (!("spec" in r)) throw new Error("expected spec");
		expect(r.spec.params?.size).toBe("1280x720"); // 16:9 × 1k（第251轮三份 size 表统一后的规范值）
		expect(r.spec.params?.idPrefix).toBe("M");
	});

	it("ui 覆盖比例/质量：1:1 + 4k + medium", () => {
		const r = buildAssetBaseGenSpec("crowds", { id: "g1", name: "村民", prompt: "一群村民" }, "m",
			[{ v: "1k" }, { v: "2k" }, { v: "4k" }], { aspect: "1:1", resolution: "4k", quality: "medium" });
		if (!("spec" in r)) throw new Error("expected spec");
		expect(r.spec.params).toEqual({ size: "4096x4096", quality: "medium", idPrefix: "G", assetName: "村民" });
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
