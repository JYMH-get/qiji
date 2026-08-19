/**
 * directorOp —— 「3D导演台」的入口与产物落库（碰 store 与画布命令；渲染在 DirectorStageModal）。
 *
 *  - directorStageBlank：独立导演台（网格舞台，产物落视口中心）。
 *  - directorStageNode：图片节点唤起——产物节点带 stage3d（场景 JSON）时=再编辑；
 *    否则以节点主图为底图新开（全景链产物自动走 pano 背景）。
 *  - saveStageOutputs：合成图/姿势图/深度图 逐张落 image.gen 节点（懒上传，第194轮全局规则）。
 */
import { useCanvasStore } from "@/store/canvasStore";
import { useLibraryStore } from "@/store/libraryStore";
import { dispatchCommand } from "@/command/dispatch";
import { avoidOverlap, makeNode, NODE_W } from "@/canvas/nodeFactory";
import { uploadMediaToCanvasAsset } from "@/canvas/nodeUpload";
import { fetchUriOf } from "@/canvas/annotate";
import { openDirectorStage } from "@/store/directorStore";
import { useConnectionStore } from "@/store/connectionStore";
import { isPanoramaNodeParams } from "@/lib/panoView";
import type { StageSceneDoc } from "@/lib/stageScene";

function rawUrlOf(serverAssetId?: string | null): string | undefined {
	const base = useConnectionStore.getState().normalizedUrl();
	return base && serverAssetId && !serverAssetId.startsWith("LC-")
		? `${base}/v1/assets/${serverAssetId}/raw`
		: undefined;
}

/** 画布空白/工具入口：独立导演台 */
export function directorStageBlank(): void {
	openDirectorStage({ mode: "stage" });
}

/** 图片节点 → 3D导演台（底图=节点主图；产物带场景 JSON 时=继续编辑） */
export function directorStageNode(nodeId: string): void {
	const node = useCanvasStore.getState().nodes[nodeId];
	const resultAssetId = node?.data.resultAssetId;
	if (!node || !resultAssetId) return;
	const lib = useLibraryStore.getState().assets;

	// 再编辑：产物节点自带场景（底图凭 stage3d.srcAssetId 还原；底图资产没了退化为网格舞台）
	const prior = node.data.stage3d;
	if (prior?.scene) {
		const src = prior.srcAssetId ? lib[prior.srcAssetId] : null;
		openDirectorStage({
			mode: src ? prior.mode : "stage",
			...(src ? {
				uri: fetchUriOf(src.id),
				fallbackUri: rawUrlOf(src.serverAssetId || src.id),
				srcAssetId: src.id,
			} : {}),
			name: src?.name || node.data.title,
			scene: prior.scene,
			sourceNodeId: nodeId,
		});
		return;
	}

	const asset = lib[resultAssetId];
	const isPano = isPanoramaNodeParams(node.data.params as Record<string, unknown> | undefined);
	openDirectorStage({
		mode: isPano ? "pano" : "image",
		uri: fetchUriOf(resultAssetId),
		fallbackUri: rawUrlOf(asset?.serverAssetId || resultAssetId),
		name: asset?.name,
		srcAssetId: resultAssetId,
		sourceNodeId: nodeId,
	});
}

/**
 * 产物落库：每张一个 image.gen 节点（合成图节点带 stage3d 场景可再编辑）。
 * 返回错误文案（null=成功）。
 */
export async function saveStageOutputs(
	items: { blob: Blob; label: string; withScene?: boolean }[],
	opts: {
		sourceNodeId?: string;
		baseName?: string;
		scene: StageSceneDoc;
		mode: "stage" | "image" | "pano";
		srcAssetId?: string;
	},
): Promise<string | null> {
	if (!items.length) return "没有可保存的产物";
	const cs = useCanvasStore.getState();
	const src = opts.sourceNodeId ? cs.nodes[opts.sourceNodeId] : null;
	let x: number;
	let y: number;
	if (src) {
		x = src.x + src.w + 64;
		y = src.y;
	} else {
		const vp = cs.viewport;
		x = (-vp.x + window.innerWidth / 2) / vp.zoom - NODE_W / 2;
		y = (-vp.y + window.innerHeight / 2) / vp.zoom - 100;
	}
	// 再编辑产物节点时 baseName 会带上一轮的产物后缀（「xx-合成图」）——剥掉防标题滚雪球
	const base = (opts.baseName || "3D舞台").replace(/\.[a-z0-9]+$/i, "").replace(/(-(合成图|姿势图|深度图))+$/, "") || "3D舞台";
	const placed: ReturnType<typeof makeNode>[] = [];
	try {
		for (const it of items) {
			const name = `${base}-${it.label}.png`;
			const file = new File([it.blob], name, { type: "image/png" });
			const up = await uploadMediaToCanvasAsset(file, "TP"); // 懒上传：本地暂存，引用时才补 OSS
			useLibraryStore.getState().addAsset({
				id: up.assetId,
				kind: "image",
				name,
				uri: up.displayUri,
				serverAssetId: null,
				thumbnailUri: null,
				createdAt: new Date().toISOString(),
				deletedByUser: false,
				localPath: up.localPath,
			});
			let node = makeNode("image.gen", x, y);
			node = avoidOverlap(node, [...Object.values(cs.nodes), ...placed]);
			node.data.resultAssetId = up.assetId;
			node.data.resultHistory = [up.assetId];
			node.data.title = `${base}-${it.label}`;
			if (it.withScene) {
				node.data.stage3d = {
					scene: opts.scene,
					mode: opts.mode,
					...(opts.srcAssetId ? { srcAssetId: opts.srcAssetId } : {}),
				};
			}
			dispatchCommand({ type: "addNode", node });
			placed.push(node);
			y += 40; // 多产物轻微错落（avoidOverlap 兜底）
		}
	} catch (err) {
		return `产物保存失败：${err instanceof Error ? err.message : "未知错误"}`;
	}
	return null;
}
