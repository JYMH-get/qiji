/**
 * assetBind —— 画布节点产物「绑定到资产」（第113轮锁定语义）：
 *  - 图片绑现有资产：addAssetImage 语义（追加历史 + 设为主图）；
 *  - 图片绑新建资产：记录形态与工作台一致（features/description 按类），prompt 带入节点提示词，同名拒绝；
 *  - 音频绑音色：voiceUri=显示 uri、voiceAssetId=服务端资产 id、voiceName=「<资产名>的声音」（与资产模式同格式）。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { bindNodeImageToAsset, bindNodeImageToNewAsset, bindNodeAudioToAsset } from "./assetBind";
import { useCanvasStore } from "@/store/canvasStore";
import { useLibraryStore } from "@/store/libraryStore";
import { useProjectStore } from "@/store/projectStore";
import type { CanvasNode } from "@/types";

const mkNode = (id: string, resultAssetId: string | null, prompt = ""): CanvasNode => ({
	id, type: "image.gen", x: 0, y: 0, w: 240, h: 200, parentId: null, parentScriptId: null,
	data: { input: {}, params: { prompt }, resultAssetId },
});

beforeEach(() => {
	useCanvasStore.setState({ nodes: {}, edges: {} });
	useLibraryStore.setState({ assets: {} } as never);
	useProjectStore.setState({
		characters: [{ id: "char-1", name: "张三", features: "", philosophy: "", prompt: "", image: "old.png", images: ["old.png"], variants: [] }],
		scenes: [], items: [], organisms: [], crowds: [],
	} as never);
});

const putLib = (id: string, kind: "image" | "audio", uri: string, serverAssetId: string | null = null) => {
	useLibraryStore.setState((s) => ({
		assets: {
			...s.assets,
			[id]: { id, kind, name: id + ".bin", uri, serverAssetId, thumbnailUri: null, createdAt: "", deletedByUser: false, localPath: null, origin: "generated" },
		},
	}) as never);
};

describe("bindNodeImageToAsset（绑现有资产）", () => {
	it("追加历史 + 设为主图", () => {
		putLib("C00000001", "image", "asset://new.png", "C00000001");
		useCanvasStore.setState({ nodes: { n1: mkNode("n1", "C00000001") }, edges: {} });
		const r = bindNodeImageToAsset("n1", "characters", "char-1");
		expect(r.ok).toBe(true);
		const a = useProjectStore.getState().characters.find((x) => x.id === "char-1")!;
		expect(a.image).toBe("asset://new.png");
		expect(a.images).toEqual(["old.png", "asset://new.png"]);
	});

	it("节点无图片结果 / 目标资产不存在 → 明确报错", () => {
		useCanvasStore.setState({ nodes: { n1: mkNode("n1", null) }, edges: {} });
		expect(bindNodeImageToAsset("n1", "characters", "char-1").ok).toBe(false);
		putLib("C00000002", "image", "asset://x.png");
		useCanvasStore.setState({ nodes: { n2: mkNode("n2", "C00000002") }, edges: {} });
		expect(bindNodeImageToAsset("n2", "characters", "ghost").ok).toBe(false);
	});
});

describe("bindNodeImageToNewAsset（新建并绑定）", () => {
	it("新建场景资产：description 字段 + prompt 带入节点提示词 + 图为主图", () => {
		putLib("S00000009", "image", "asset://scene.png", "S00000009");
		useCanvasStore.setState({ nodes: { n1: mkNode("n1", "S00000009", "山中木屋，晨雾") }, edges: {} });
		const r = bindNodeImageToNewAsset("n1", "scenes", " 山中木屋 ");
		expect(r.ok).toBe(true);
		const a = useProjectStore.getState().scenes[0] as Record<string, unknown>;
		expect(a.name).toBe("山中木屋");
		expect(a.description).toBe("");
		expect(a.prompt).toBe("山中木屋，晨雾");
		expect(a.image).toBe("asset://scene.png");
		expect(a.images).toEqual(["asset://scene.png"]);
	});

	it("同名拒绝（同分类）；空名拒绝", () => {
		putLib("C00000003", "image", "asset://y.png");
		useCanvasStore.setState({ nodes: { n1: mkNode("n1", "C00000003") }, edges: {} });
		expect(bindNodeImageToNewAsset("n1", "characters", "张三").ok).toBe(false);
		expect(bindNodeImageToNewAsset("n1", "characters", "  ").ok).toBe(false);
		// 跨分类同名允许（场景里可以有「张三」）
		expect(bindNodeImageToNewAsset("n1", "scenes", "张三").ok).toBe(true);
	});
});

describe("bindNodeAudioToAsset（绑音色）", () => {
	it("写 voiceUri/voiceAssetId/voiceName（与资产模式绑音色同格式）", () => {
		putLib("audio00000001", "audio", "asset://v.mp3", "audio00000001");
		useCanvasStore.setState({ nodes: { n1: mkNode("n1", "audio00000001") }, edges: {} });
		const r = bindNodeAudioToAsset("n1", "characters", "char-1");
		expect(r.ok).toBe(true);
		const a = useProjectStore.getState().characters.find((x) => x.id === "char-1")!;
		expect(a.voiceUri).toBe("asset://v.mp3");
		expect(a.voiceAssetId).toBe("audio00000001");
		expect(a.voiceName).toBe("张三的声音");
	});

	it("再次绑定 = 替换旧音色", () => {
		putLib("audio1", "audio", "asset://a.mp3", "audio1");
		putLib("audio2", "audio", "asset://b.mp3", "audio2");
		useCanvasStore.setState({ nodes: { n1: mkNode("n1", "audio1"), n2: mkNode("n2", "audio2") }, edges: {} });
		bindNodeAudioToAsset("n1", "characters", "char-1");
		bindNodeAudioToAsset("n2", "characters", "char-1");
		const a = useProjectStore.getState().characters.find((x) => x.id === "char-1")!;
		expect(a.voiceUri).toBe("asset://b.mp3");
		expect(a.voiceAssetId).toBe("audio2");
	});
});
