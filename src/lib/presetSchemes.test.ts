import { describe, it, expect, beforeEach } from "vitest";
import { useCatalogStore } from "@/store/catalogStore";
import { useSettingsStore } from "@/store/settingsStore";
import { presetTag, resolvePresets, listPresetOptions, presetBody, presetGroup, gridPresetForShotCount, countUnifiedShots, hasGridInstruction, GRID_GROUP, PRESET_TAG_RE } from "@/lib/presetSchemes";

function seedCatalog(templates: any[]) {
	useCatalogStore.setState({
		catalog: { version: "t1", models: [], templates, nodes: [], imageTemplates: [], variantPrefixes: [], schemas: {} } as any,
	});
}

describe("presetSchemes", () => {
	beforeEach(() => {
		seedCatalog([
			{ id: "preset.storyboard.6grid", name: "6宫格电影故事板", capability: "image", category: "预设方案", body: "六宫格完整预设正文…" },
			// 画风（同为无 purpose）不应被当作预设
			{ id: "style.3d", name: "3D国漫", capability: "image", category: "画风", body: "3D国风动画" },
			// 分类是预设但无正文 → 过滤掉
			{ id: "preset.empty", name: "空预设", capability: "image", category: "预设方案", body: "" },
		]);
		useSettingsStore.setState({ customPresets: [] });
	});

	it("presetTag round-trips through PRESET_TAG_RE", () => {
		const tag = presetTag("preset.storyboard.6grid");
		expect(tag).toBe("【预设:preset.storyboard.6grid】");
		const m = new RegExp(PRESET_TAG_RE.source).exec(tag);
		expect(m?.[1]).toBe("preset.storyboard.6grid");
	});

	it("listPresetOptions 只含有正文的「预设方案」分类模板（排除画风/空正文）", () => {
		const opts = listPresetOptions();
		expect(opts.map((o) => o.id)).toEqual(["preset.storyboard.6grid"]);
	});

	it("resolvePresets 把胶囊展开成完整预设正文", () => {
		expect(resolvePresets("前缀 【预设:preset.storyboard.6grid】 后缀")).toBe("前缀 六宫格完整预设正文… 后缀");
	});

	it("多枚胶囊全部展开", () => {
		expect(resolvePresets("【预设:preset.storyboard.6grid】\n【预设:preset.storyboard.6grid】")).toBe(
			"六宫格完整预设正文…\n六宫格完整预设正文…",
		);
	});

	it("未知预设 id 保持原样（不误删）", () => {
		expect(resolvePresets("【预设:preset.unknown】")).toBe("【预设:preset.unknown】");
	});

	it("无胶囊文本原样返回", () => {
		expect(resolvePresets("普通提示词，无预设")).toBe("普通提示词，无预设");
	});

	it("自定义预设并入选项 + 参与展开（服务端在前、自定义在后）", () => {
		useSettingsStore.setState({ customPresets: [{ id: "preset.custom.1", name: "我的预设", body: "自定义正文" }] });
		expect(listPresetOptions().map((o) => o.id)).toEqual(["preset.storyboard.6grid", "preset.custom.1"]);
		expect(resolvePresets("【预设:preset.custom.1】")).toBe("自定义正文");
	});

	it("presetBody 按 id 取正文（服务端/自定义均可，未知→undefined）", () => {
		useSettingsStore.setState({ customPresets: [{ id: "preset.custom.1", name: "我的预设", body: "自定义正文" }] });
		expect(presetBody("preset.storyboard.6grid")).toBe("六宫格完整预设正文…");
		expect(presetBody("preset.custom.1")).toBe("自定义正文");
		expect(presetBody("preset.nope")).toBeUndefined();
	});

	it("宫格预设互斥组：4/6/9 宫格同属 GRID_GROUP；管理端 presetGroup / 自定义 group 生效", () => {
		seedCatalog([
			{ id: "preset.storyboard.4grid", name: "4宫格", capability: "image", category: "预设方案", body: "四宫格正文", presetGroup: "宫格" },
			{ id: "preset.storyboard.9grid", name: "9宫格", capability: "image", category: "预设方案", body: "九宫格正文" }, // 无 presetGroup → 走 id 正则兜底
			{ id: "my.admin.grid", name: "管理端宫格", capability: "image", category: "预设方案", body: "管理端正文", presetGroup: "宫格" }, // 非 grid id + 管理端配组
			{ id: "preset.custom.plain", name: "普通", capability: "image", category: "预设方案", body: "普通正文" }, // 无组
		]);
		useSettingsStore.setState({ customPresets: [{ id: "preset.custom.g", name: "自定义宫格", body: "x", group: "宫格" }] });
		expect(presetGroup("preset.storyboard.4grid")).toBe(GRID_GROUP); // presetGroup="宫格"
		expect(presetGroup("preset.storyboard.9grid")).toBe(GRID_GROUP); // id 正则兜底
		expect(presetGroup("my.admin.grid")).toBe("宫格"); // 管理端 presetGroup（非 grid id 也能互斥）
		expect(presetGroup("preset.custom.g")).toBe("宫格"); // 客户端自定义 group
		expect(presetGroup("preset.custom.plain")).toBeUndefined(); // 无组
	});

	it("gridPresetForShotCount：≤4→4宫格、5-6→6宫格、更多→9宫格", () => {
		seedCatalog([
			{ id: "preset.storyboard.4grid", name: "4宫格", capability: "image", category: "预设方案", body: "四" },
			{ id: "preset.storyboard.6grid", name: "6宫格", capability: "image", category: "预设方案", body: "六" },
			{ id: "preset.storyboard.9grid", name: "9宫格", capability: "image", category: "预设方案", body: "九" },
		]);
		expect(gridPresetForShotCount(3)).toBe("preset.storyboard.4grid");
		expect(gridPresetForShotCount(4)).toBe("preset.storyboard.4grid");
		expect(gridPresetForShotCount(5)).toBe("preset.storyboard.6grid");
		expect(gridPresetForShotCount(6)).toBe("preset.storyboard.6grid");
		expect(gridPresetForShotCount(7)).toBe("preset.storyboard.9grid");
		expect(gridPresetForShotCount(20)).toBe("preset.storyboard.9grid");
	});

	it("countUnifiedShots：数同源提示词里的「第X镜」（中文数字/阿拉伯数字，去重）", () => {
		const uni = "0.00-1.80秒｜第一镜：… 1.80-3.25秒｜第二镜：… 第三镜 第四镜 第五镜 第六镜 7.10-10.15秒｜第七镜：…";
		expect(countUnifiedShots(uni)).toBe(7); // 7 镜 → gridPresetForShotCount(7)=9宫格
		expect(countUnifiedShots("镜头1 镜头2 镜头3 第4镜")).toBe(4);
		expect(countUnifiedShots("完全没有镜头分段的纯文本")).toBe(0); // 数不出→0→默认4宫格
	});

	it("hasGridInstruction：已含「N宫格」则不再自动补丁", () => {
		expect(hasGridInstruction("生成一个6宫格的电影故事板")).toBe(true);
		expect(hasGridInstruction("普通同源提示词，无宫格")).toBe(false);
	});

	it("gridPresetForShotCount：想要的档位缺失时取最接近的存在档位", () => {
		seedCatalog([
			{ id: "preset.storyboard.6grid", name: "6宫格", capability: "image", category: "预设方案", body: "六" },
		]);
		expect(gridPresetForShotCount(3)).toBe("preset.storyboard.6grid"); // 想要4宫格但只有6宫格
		expect(gridPresetForShotCount(20)).toBe("preset.storyboard.6grid");
	});
});
