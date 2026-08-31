import { describe, it, expect, beforeEach } from "vitest";
import { useCatalogStore } from "@/store/catalogStore";
import { useSettingsStore } from "@/store/settingsStore";
import { insertPresetCapsule, placeUpstreamCapsules } from "@/lib/promptCompose";

function seed(templates: any[]) {
	useCatalogStore.setState({
		catalog: { version: "t1", models: [], templates, nodes: [], imageTemplates: [], variantPrefixes: [], schemas: {} } as any,
	});
	useSettingsStore.setState({ customPresets: [] });
}

describe("promptCompose 规范顺序落位", () => {
	beforeEach(() => {
		seed([
			{ id: "preset.pfx", name: "前缀预设", capability: "image", category: "预设方案", body: "前缀正文", presetPosition: "prefix" },
			{ id: "preset.sfx", name: "后缀预设", capability: "image", category: "预设方案", body: "后缀正文", presetPosition: "suffix" },
			{ id: "preset.storyboard.4grid", name: "4宫格", capability: "image", category: "预设方案", body: "四", presetGroup: "宫格", presetPosition: "prefix" },
			{ id: "preset.storyboard.6grid", name: "6宫格", capability: "image", category: "预设方案", body: "六", presetGroup: "宫格", presetPosition: "prefix" },
		]);
	});

	it("前缀预设落到正文最前，后缀预设落到最后", () => {
		expect(insertPresetCapsule("用户正文", "preset.pfx")).toBe("【预设:preset.pfx】\n用户正文");
		expect(insertPresetCapsule("用户正文", "preset.sfx")).toBe("用户正文\n【预设:preset.sfx】");
		expect(insertPresetCapsule("", "preset.pfx")).toBe("【预设:preset.pfx】");
	});

	it("互斥组：插入同组预设移除已有同组胶囊", () => {
		expect(insertPresetCapsule("【预设:preset.storyboard.4grid】\n用户正文", "preset.storyboard.6grid"))
			.toBe("【预设:preset.storyboard.6grid】\n用户正文");
	});

	it("重复插入同一预设=去重重排（不堆叠）", () => {
		expect(insertPresetCapsule("【预设:preset.pfx】\n用户正文", "preset.pfx")).toBe("【预设:preset.pfx】\n用户正文");
	});

	it("上游胶囊落在 图例 + 前缀预设 之后、用户正文之前", () => {
		expect(placeUpstreamCapsules("用户正文", 2)).toBe("【上游文本1】\n【上游文本2】\n用户正文");
		expect(placeUpstreamCapsules("【预设:preset.pfx】\n用户正文", 1)).toBe("【预设:preset.pfx】\n【上游文本1】\n用户正文");
		expect(placeUpstreamCapsules("【素材图例】@Image1 是 张三，\n\n用户正文", 1))
			.toBe("【素材图例】@Image1 是 张三；\n\n【上游文本1】\n用户正文");
	});

	it("图例与正文没有空行时也保留正文", () => {
		expect(placeUpstreamCapsules("【素材图例】@Image1 是 赵三娘，赵三娘吃饭", 1))
			.toBe("【素材图例】@Image1 是 赵三娘；\n\n【上游文本1】\n赵三娘吃饭");
	});

	it("上游胶囊幂等：已有 1 枚 → 需要 2 枚时重置为恰好 2 枚", () => {
		expect(placeUpstreamCapsules("【上游文本1】\n用户正文", 2)).toBe("【上游文本1】\n【上游文本2】\n用户正文");
		expect(placeUpstreamCapsules("【上游文本1】\n【上游文本2】\n正文", 0)).toBe("正文");
	});
});
