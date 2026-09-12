import { describe, expect, it } from "vitest";
import type { CanvasGroup, CanvasNode } from "@/types";
import { isCanvasMediaAlreadyAdded, nextMaterialGroupId, resolveCanvasMediaRef } from "./canvasInteraction";

function node(patch: Partial<CanvasNode> = {}): CanvasNode {
	return {
		id: "n1", type: "upload", x: 0, y: 0, w: 240, h: 200,
		parentId: null, parentScriptId: null,
		data: { input: {}, params: {}, resultAssetId: null },
		...patch,
	};
}

describe("画布参考素材识别", () => {
	it("没有资产 id 的本地上传仍按 MIME 识别为图片参考", () => {
		const ref = resolveCanvasMediaRef(node({ data: { input: {}, params: {}, resultAssetId: null, fileUri: "blob:local", fileMime: "image/png", fileName: "本地图.png" } }), null, "file");
		expect(ref).toEqual({ id: undefined, url: "blob:local", name: "本地图.png", media: "image" });
	});

	it("文本和文档不进入画布参考素材", () => {
		expect(resolveCanvasMediaRef(node({ data: { input: {}, params: {}, resultAssetId: null, fileUri: "blob:text", fileMime: "text/plain" } }), null, "file")).toBeNull();
	});

	it("同一地址或同一可选 id 已加入后视为重复", () => {
		const ref = { id: undefined, url: "blob:local", name: "本地图", media: "image" as const };
		expect(isCanvasMediaAlreadyAdded(ref, [{ uri: "blob:local" }])).toBe(true);
		expect(isCanvasMediaAlreadyAdded({ ...ref, id: "A1", url: "other" }, [{ id: "A1" }])).toBe(true);
	});
});

describe("素材分组顺序", () => {
	it("只在素材分组间按画布位置循环", () => {
		const nodes = {
			g1: node({ id: "g1", type: "group", x: 500, y: 10 }),
			g2: node({ id: "g2", type: "group", x: 10, y: 10 }),
			g3: node({ id: "g3", type: "group", x: 0, y: 0 }),
		};
		const groups: Record<string, CanvasGroup> = {
			g1: { id: "g1", childIds: [], x: 500, y: 10, kind: "material" },
			g2: { id: "g2", childIds: [], x: 10, y: 10, kind: "material" },
			g3: { id: "g3", childIds: [], x: 0, y: 0 },
		};
		expect(nextMaterialGroupId(null, groups, nodes)).toBe("g2");
		expect(nextMaterialGroupId("g2", groups, nodes)).toBe("g1");
		expect(nextMaterialGroupId("g1", groups, nodes)).toBe("g2");
	});
});
