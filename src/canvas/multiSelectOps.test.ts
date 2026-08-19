import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { useCanvasStore } from "@/store/canvasStore";
import { useCatalogStore } from "@/store/catalogStore";
import { useSettingsStore } from "@/store/settingsStore";
import { registerNodeHandlers } from "@/command/handlers/nodeHandlers";
import { imageNodeCount, addPresetToNodes } from "@/canvas/multiSelectOps";
import { presetTag } from "@/lib/presetSchemes";

function node(id: string, type: string, prompt = "") {
	return {
		id, type, x: 0, y: 0, w: 240, h: 160, parentId: null, parentScriptId: null,
		data: { input: {}, params: { prompt }, resultAssetId: null },
	} as never;
}

beforeAll(() => registerNodeHandlers());

describe("multiSelectOps 多选批量", () => {
	beforeEach(() => {
		useCatalogStore.setState({
			catalog: {
				version: "t1", models: [], nodes: [], imageTemplates: [], variantPrefixes: [], schemas: {},
				templates: [{ id: "preset.p1", name: "预设一", capability: "image", category: "预设方案", body: "正文一", presetPosition: "prefix" }],
			},
		} as never);
		useSettingsStore.setState({ customPresets: [] });
		useCanvasStore.setState({
			nodes: {
				img1: node("img1", "image.gen", "画面一"),
				img2: node("img2", "image.gen", "画面二"),
				txt: node("txt", "text.seed", "一段文本"),
			},
			edges: {},
		} as never);
	});

	it("imageNodeCount：只数图片节点", () => {
		expect(imageNodeCount(["img1", "img2", "txt"])).toBe(2);
		expect(imageNodeCount(["txt"])).toBe(0);
	});

	it("addPresetToNodes：只给图片节点插预设胶囊、返回生效数、文本节点不动", () => {
		const n = addPresetToNodes(["img1", "img2", "txt"], "preset.p1");
		expect(n).toBe(2);
		const st = useCanvasStore.getState().nodes;
		expect(String(st.img1.data.params.prompt)).toContain(presetTag("preset.p1"));
		expect(String(st.img2.data.params.prompt)).toContain(presetTag("preset.p1"));
		expect(String(st.txt.data.params.prompt)).toBe("一段文本");
	});

	it("addPresetToNodes：已含该预设不重复插入（返回 0、胶囊只 1 枚）", () => {
		addPresetToNodes(["img1"], "preset.p1");
		expect(addPresetToNodes(["img1"], "preset.p1")).toBe(0);
		expect(String(useCanvasStore.getState().nodes.img1.data.params.prompt).match(/【预设:preset\.p1】/g)?.length).toBe(1);
	});
});
