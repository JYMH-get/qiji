import { describe, expect, it } from "vitest";
import { sanitizeCanvas } from "./nodeSpecs";
import type { CanvasNode } from "@/types";

describe("画布标记持久化清洗", () => {
	it("保留文字/图形标记及其素材分组类型", () => {
		const marker: CanvasNode = {
			id: "m1", type: "canvas.marker", x: 10, y: 20, w: 120, h: 40,
			parentId: "g1", parentScriptId: null,
			data: { input: {}, params: { shape: "text", text: "入口", color: "#ff0000" }, resultAssetId: null },
		};
		const group: CanvasNode = {
			id: "g1", type: "group", x: 0, y: 0, w: 160, h: 90,
			parentId: null, parentScriptId: null,
			data: { input: {}, params: {}, resultAssetId: null },
		};
		const clean = sanitizeCanvas({ g1: group, m1: marker }, {}, { g1: { id: "g1", childIds: ["m1"], x: 0, y: 0, kind: "material" } });
		expect(clean.nodes.m1?.type).toBe("canvas.marker");
		expect(clean.groups.g1?.kind).toBe("material");
	});
});
