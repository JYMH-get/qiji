/**
 * findProjectAssetByImage —— 素材反查项目资产（第114轮锁定）：
 *  上游连线/拖入/粘贴的图不是靠名字匹配进来的——绑定到资产后，凭 uri 直等或 blob id 归一
 *  反查出资产身份（主图/历史/变体图均认），图例才能写「@ImageN 是 资产名」并配对音色。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { findProjectAssetByImage } from "./projectAssets";
import { applyAssetMatchToImageNode } from "./assetMatch";
import { useProjectStore } from "@/store/projectStore";
import { useCanvasStore } from "@/store/canvasStore";
import { useLibraryStore } from "@/store/libraryStore";
import type { CanvasNode, NodeData } from "@/types";

beforeEach(() => {
	useCanvasStore.setState({ nodes: {}, edges: {} });
	useLibraryStore.setState({ assets: {} } as never);
	useProjectStore.setState({
		characters: [{
			id: "char-ad", name: "阿黛", features: "", philosophy: "", prompt: "",
			image: "asset://local/C001.png", images: ["asset://old/1.png", "asset://local/C001.png"],
			variants: [{ id: "v1", label: "战损", name: "阿黛·战损", image: "asset://local/C002.png", images: [] }],
			voiceUri: "asset://local/voice.mp3", voiceAssetId: "audio77", voiceName: "阿黛的声音",
		}],
		scenes: [], items: [], organisms: [], crowds: [],
		assetBlobs: {
			C001: { id: "C001", url: "https://oss/C001.png", localUri: "asset://local/C001.png" },
			C002: { id: "C002", url: "https://oss/C002.png", localUri: "asset://local/C002.png" },
			audio77: { id: "audio77", url: "https://oss/voice.mp3", localUri: "asset://local/voice.mp3" },
		},
	} as never);
});

describe("findProjectAssetByImage", () => {
	it("uri 直等命中主图；历史图也认", () => {
		expect(findProjectAssetByImage("asset://local/C001.png")?.assetId).toBe("char-ad");
		expect(findProjectAssetByImage("asset://old/1.png")?.name).toBe("阿黛");
	});

	it("blob id 归一命中（素材存公网 url、资产存本地 uri）+ 带出音色", () => {
		const h = findProjectAssetByImage("https://oss/C001.png", "C001");
		expect(h?.assetId).toBe("char-ad");
		expect(h?.voiceAssetId).toBe("audio77");
	});

	it("变体图命中用造型名；未命中返回 null", () => {
		expect(findProjectAssetByImage(undefined, "C002")?.name).toBe("阿黛·战损");
		expect(findProjectAssetByImage("asset://nobody.png")).toBeNull();
	});
});

// ── 匹配资产：绑定图凭素材身份进图例（提示词不点名也生效）──
const mkNode = (id: string, type: string, data: Partial<NodeData> = {}): CanvasNode => ({
	id, type: type as CanvasNode["type"], x: 0, y: 0, w: 240, h: 200, parentId: null, parentScriptId: null,
	data: { input: {}, params: {}, resultAssetId: null, ...data },
});

describe("applyAssetMatchToImageNode 绑定资产识别", () => {
	it("上游连线的绑定图：提示词不点名 → 仍写图例「是 阿黛」+ 音色声音参考配对", () => {
		useLibraryStore.setState({
			assets: {
				C001: { id: "C001", kind: "image", name: "生成图_1723.png", uri: "asset://local/C001.png", serverAssetId: "C001", thumbnailUri: null, createdAt: "", deletedByUser: false, localPath: null, origin: "generated" },
			},
		} as never);
		useCanvasStore.setState({
			nodes: {
				up1: mkNode("up1", "image.gen", { resultAssetId: "C001" }),
				vid: mkNode("vid", "video.gen", { params: { prompt: "镜头推近，人物回头。" } }),
			},
			edges: { e1: { id: "e1", source: "up1", target: "vid" } as never },
		});
		const added = applyAssetMatchToImageNode("vid");
		expect(added).toBeGreaterThan(0); // 音色声音参考加入
		const n = useCanvasStore.getState().nodes.vid;
		const prompt = String(n.data.params.prompt);
		expect(prompt).toContain("@Image1 是 阿黛");            // 不再是素材库文件名
		expect(prompt).toContain("@Image1的声音参考@Audio1");   // 绑定音色随行配对
		const auds = (n.data.input.audios ?? []) as Array<{ voiceForAssetId?: string; url?: string }>;
		expect(auds[0]?.voiceForAssetId).toBe("char-ad");
		expect(auds[0]?.url).toBe("https://oss/voice.mp3");
	});

	it("自加素材（粘贴/拖入原图）无名：匹配后就地补 资产名+assetId，图例同现", () => {
		useCanvasStore.setState({
			nodes: {
				img: mkNode("img", "image.gen", {
					params: { prompt: "全景。" },
					input: { images: [{ id: "C001", url: "https://oss/C001.png" }] },
				}),
			},
			edges: {},
		});
		applyAssetMatchToImageNode("img");
		const n = useCanvasStore.getState().nodes.img;
		const imgs = (n.data.input.images ?? []) as Array<{ name?: string; assetId?: string }>;
		expect(imgs[0]?.name).toBe("阿黛");
		expect(imgs[0]?.assetId).toBe("char-ad");
		expect(String(n.data.params.prompt)).toContain("@Image1 是 阿黛");
	});
});
