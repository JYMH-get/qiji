import { describe, it, expect, beforeEach } from "vitest";
import { useProjectStore } from "@/store/projectStore";
import { useCanvasStore } from "@/store/canvasStore";
import { useLibraryStore } from "@/store/libraryStore";
import { sharedItemFromUri, nodeSharedItems } from "@/services/sharedPublish";

const node = (id: string, resultAssetId: string | null) => ({
	id, type: "image.gen", x: 0, y: 0, w: 240, h: 160, parentId: null, parentScriptId: null,
	data: { input: {}, params: {}, resultAssetId },
}) as never;

describe("sharedPublish 分享=只登记 OSS 记录（不复制字节）", () => {
	beforeEach(() => {
		useProjectStore.setState({
			assetBlobs: {
				C00000001: { id: "C00000001", url: "https://oss/C1.png", localUri: "asset://C1", mime: "image/png" },
				noUrl: { id: "", localUri: "asset://local-only" }, // 无 id 无 url=纯本地
			},
		} as never);
	});

	it("sharedItemFromUri：经三元映射取台账 id+公网 url；无 OSS 记录 → null", () => {
		expect(sharedItemFromUri("asset://C1", "张三")).toEqual({ assetId: "C00000001", url: "https://oss/C1.png", name: "张三", mime: "image/png" });
		expect(sharedItemFromUri("asset://local-only", "本地图")).toBeNull();
		expect(sharedItemFromUri(undefined, "x")).toBeNull();
	});

	it("nodeSharedItems：取节点结果资产；无结果/无 OSS 记录 → skipped；serverAssetId 兜底", () => {
		useLibraryStore.setState({
			assets: {
				a1: { id: "a1", kind: "image", name: "图一", uri: "asset://C1", serverAssetId: "C00000001", thumbnailUri: null, createdAt: "", deletedByUser: false, localPath: null, origin: "generated" },
				a2: { id: "a2", kind: "image", name: "图二", uri: "asset://unknown", serverAssetId: "S00000002", thumbnailUri: null, createdAt: "", deletedByUser: false, localPath: null, origin: "generated" },
			},
		} as never);
		useCanvasStore.setState({ nodes: { n1: node("n1", "a1"), n2: node("n2", "a2"), n3: node("n3", null) }, edges: {} } as never);
		const r = nodeSharedItems(["n1", "n2", "n3"]);
		expect(r.items).toHaveLength(2);
		expect(r.items[0]).toMatchObject({ assetId: "C00000001", url: "https://oss/C1.png", name: "图一" });
		expect(r.items[1]).toMatchObject({ assetId: "S00000002", name: "图二" }); // blob 缺失 → serverAssetId 兜底（服务端凭 id 取直链）
		expect(r.skipped).toBe(1); // n3 无结果
	});
});
