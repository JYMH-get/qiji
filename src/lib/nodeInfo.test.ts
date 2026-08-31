import { describe, expect, it } from "vitest";
import type { CanvasNode, NodeRuntime } from "@/types";
import { buildNodeInfoSnapshot } from "./nodeInfo";

const node: CanvasNode = {
	id: "node-video",
	type: "video.gen",
	x: 10,
	y: 20,
	w: 320,
	h: 180,
	parentId: null,
	parentScriptId: null,
	data: {
		input: {},
		params: {
			model: "later-model",
			aspect_ratio: "9:16",
			duration: 6,
			prompt: "这是生成后修改的新设置，不属于当前结果。",
		},
		resultAssetId: "local-v2",
		resultHistory: ["local-v1", "local-v2"],
		resultMetaByAssetId: {
			"local-v2": {
				model: "seedance-2",
				aspect: "16:9",
				duration: 15,
				prompt: "角色回头，镜头缓慢推近。",
			},
		},
	},
};

const idle: NodeRuntime = {
	status: "idle",
	progress: 0,
	taskId: null,
	scheduledAt: null,
	error: null,
};

describe("buildNodeInfoSnapshot", () => {
	it("按当前结果聚合状态、三元地址和模型属性", () => {
		const info = buildNodeInfoSnapshot({
			node,
			runtime: idle,
			typeLabel: "生成视频节点",
			modelLabel: "Seedance 2.0",
			assets: {
				"local-v2": {
					id: "local-v2",
					uri: "asset://local/video00000002.mp4",
					serverAssetId: "video00000002",
					localPath: "D:/project/assets/video00000002.mp4",
				},
			},
			assetBlobs: {
				video00000002: {
					id: "video00000002",
					url: "https://oss.example/video00000002.mp4",
					localPath: "D:/project/assets/video00000002.mp4",
					localUri: "asset://local/video00000002.mp4",
				},
			},
		});

		expect(info.typeLabel).toBe("生成视频节点");
		expect(info.status).toEqual({ kind: "result", label: "结果 ×2", progress: null });
		expect(info.currentResult).toEqual({
			assetId: "video00000002",
			remoteUrl: "https://oss.example/video00000002.mp4",
			localPath: "D:/project/assets/video00000002.mp4",
		});
		expect(info.modelLabel).toBe("Seedance 2.0");
		expect(info.aspect).toBe("16：9");
		expect(info.duration).toBe("15s");
		expect(info.prompt).toBe("角色回头，镜头缓慢推近。");
	});

	it("无结果时显示节点，运行时显示生成中并保留进度", () => {
		const empty: CanvasNode = {
			...node,
			data: { ...node.data, resultAssetId: null, resultHistory: [], resultText: "" },
		};
		const base = { node: empty, typeLabel: "生成视频节点", assets: {}, assetBlobs: {} };
		expect(buildNodeInfoSnapshot(base).status).toEqual({ kind: "node", label: "节点", progress: null });

		const running: NodeRuntime = { ...idle, status: "running", progress: 46 };
		expect(buildNodeInfoSnapshot({ ...base, node, runtime: running }).status).toEqual({
			kind: "running",
			label: "生成中",
			progress: 46,
		});
	});
});
