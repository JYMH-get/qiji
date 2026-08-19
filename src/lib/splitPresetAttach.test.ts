import { describe, it, expect, beforeEach } from "vitest";
import { useCatalogStore } from "@/store/catalogStore";
import { useSettingsStore } from "@/store/settingsStore";
import { useProjectStore } from "@/store/projectStore";
import { resolvePresets, listPresetSchemes } from "@/lib/presetSchemes";
import { composeAssetPrompt, autoAttachIdsFor, attachSplitPresets } from "@/lib/splitPresetAttach";
import { mergeExtraction, type ExtractBuckets } from "@/lib/assetMerge";

/** 新服务端形态：catalog 带独立 presets 清单（第174轮） */
function seedCatalogPresets(presets: any[]) {
	useCatalogStore.setState({
		catalog: { version: "t1", models: [], templates: [], presets, nodes: [], imageTemplates: [], variantPrefixes: [], schemas: {} } as any,
	});
}

const PRESETS = [
	{ id: "style.3d", name: "3D国漫", category: "画风", body: "3D国风动画", group: "画风" },
	{ id: "pre.char", name: "角色前缀", category: "预设方案", body: "角色三视图前缀正文", autoAttach: ["characters", "crowds"] },
	{ id: "suf.char", name: "角色后缀", category: "预设方案", body: "负面约束后缀正文", position: "suffix", autoAttach: ["characters"] },
	{ id: "pre.scene", name: "场景前缀", category: "预设方案", body: "无人空景前缀正文", autoAttach: ["scenes"] },
	{ id: "pre.free", name: "手插预设", category: "预设方案", body: "手插正文" }, // 无 autoAttach=不自动附加
];

const buckets = (over: Partial<ExtractBuckets> = {}): ExtractBuckets => ({
	characters: [], scenes: [], items: [], organisms: [], crowds: [], ...over,
});

beforeEach(() => {
	seedCatalogPresets(PRESETS);
	useSettingsStore.setState({ customPresets: [] });
	useProjectStore.setState({ visualStyleId: "style.3d" });
});

describe("splitPresetAttach · composeAssetPrompt（纯组装）", () => {
	it("画风+前缀在正文前、后缀在正文后，顺序 = 画风→前缀…正文…后缀", () => {
		const out = composeAssetPrompt("正文", { styleId: "s1", prefixIds: ["p1", "p2"], suffixIds: ["x1"] });
		expect(out).toBe("【预设:s1】【预设:p1】【预设:p2】正文【预设:x1】");
	});

	it("幂等：已含的胶囊不重复挂；前后缀重叠去重", () => {
		const once = composeAssetPrompt("正文", { styleId: "s1", prefixIds: ["p1"], suffixIds: ["p1", "x1"] });
		expect(once).toBe("【预设:s1】【预设:p1】正文【预设:x1】"); // p1 已进前缀，不再进后缀
		expect(composeAssetPrompt(once, { styleId: "s1", prefixIds: ["p1"], suffixIds: ["x1"] })).toBe(once);
	});

	it("空正文不挂（不给空资产凭空造胶囊提示词）", () => {
		expect(composeAssetPrompt("", { styleId: "s1", prefixIds: ["p1"], suffixIds: [] })).toBe("");
		expect(composeAssetPrompt("  ", { styleId: "s1", prefixIds: [], suffixIds: [] })).toBe("  ");
	});
});

describe("splitPresetAttach · autoAttachIdsFor / attachSplitPresets", () => {
	it("按类别取自动附加清单：位置分前后缀、类别过滤、无 autoAttach 的不入", () => {
		const s = listPresetSchemes();
		expect(autoAttachIdsFor("characters", s)).toEqual({ prefixIds: ["pre.char"], suffixIds: ["suf.char"] });
		expect(autoAttachIdsFor("crowds", s)).toEqual({ prefixIds: ["pre.char"], suffixIds: [] });
		expect(autoAttachIdsFor("scenes", s)).toEqual({ prefixIds: ["pre.scene"], suffixIds: [] });
		expect(autoAttachIdsFor("items", s)).toEqual({ prefixIds: [], suffixIds: [] });
	});

	it("attachSplitPresets：画风前缀（项目画风 id）+ 类别前后缀一起挂；无可挂类别只挂画风", () => {
		const out = attachSplitPresets("characters", "角色正文");
		expect(out).toBe("【预设:style.3d】【预设:pre.char】角色正文【预设:suf.char】");
		expect(attachSplitPresets("items", "道具正文")).toBe("【预设:style.3d】道具正文");
	});

	it("画风 id 不在预设清单（旧项目/兜底画风/预设被删）→ 不挂画风胶囊", () => {
		useProjectStore.setState({ visualStyleId: "style.ghost" });
		expect(attachSplitPresets("characters", "正文")).toBe("【预设:pre.char】正文【预设:suf.char】");
		useProjectStore.setState({ visualStyleId: "" });
		expect(attachSplitPresets("items", "正文")).toBe("正文"); // 全无可挂=原样零开销
	});

	it("resolvePresets 能展开画风胶囊（画风也是预设，catalog.presets 全分组入清单）", () => {
		const out = resolvePresets("【预设:style.3d】【预设:pre.char】正文");
		expect(out).toBe("3D国风动画角色三视图前缀正文正文");
	});
});

describe("splitPresetAttach · assetMerge 集成（只装饰新增资产）", () => {
	it("新增资产 prompt 挂胶囊；已有资产与变体不动", () => {
		const cur = buckets({ characters: [{ id: "c1", name: "张三", prompt: "旧正文（不许动）" }] });
		const add = buckets({
			characters: [
				{ id: "c1b", name: "张三", prompt: "重复资产（应被去重跳过）" },
				{ id: "c2", name: "李四", prompt: "李四正文", variants: [{ label: "战损", prompt: "变体正文" }] },
			],
			scenes: [{ id: "s1", name: "断桥", prompt: "断桥正文" }],
		});
		const { merged, addedCount } = mergeExtraction(cur, add, attachSplitPresets);
		expect(addedCount).toBe(2);
		expect(merged.characters.find((a) => a.name === "张三")!.prompt).toBe("旧正文（不许动）");
		const li = merged.characters.find((a) => a.name === "李四")!;
		expect(li.prompt).toBe("【预设:style.3d】【预设:pre.char】李四正文【预设:suf.char】");
		expect(li.variants?.[0]?.prompt).toBe("变体正文"); // 变体提示词不装饰（变体=图生图另一套）
		expect(merged.scenes.find((a) => a.name === "断桥")!.prompt).toBe("【预设:style.3d】【预设:pre.scene】断桥正文");
	});

	it("不传装饰器 = 行为与旧版完全一致（纯合并）", () => {
		const { merged } = mergeExtraction(buckets(), buckets({ characters: [{ id: "c1", name: "甲", prompt: "正文" }] }));
		expect(merged.characters[0].prompt).toBe("正文");
	});
});
