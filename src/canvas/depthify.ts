/**
 * depthify —— 「转深度」的入口与收尾（碰 store 与网络；推理在 src/lib/depthEstimator.ts 懒加载）。
 *
 *  - depthifyNode：画布图片节点 → 右侧新建**专用转深度节点**（image.depth）承载黑白深度图，连线承接原图。
 *  - depthifyUri：灯箱等「只有显示 uri」的场景 → 视口中心新建转深度节点。
 *  - rerunDepthNode：转深度节点「运行」= 重新本地推理（pluginRegistry script 分支调入）。
 * 交互：先落节点（runtime running + 真实进度：模型下载/推理/合成），完成后懒上传资产填为主图；
 * 失败置 failed（节点信息可看原因，可直接再点运行重试）。
 * ⚠ 纯客户端功能：不走 runPurpose/网关、零计费（调研②路线）。第198轮起占位节点从 image.gen 改为
 * 专用 image.depth（capability null）——**永不走生图管线**，杜绝「失败后点生成=真调生图模型扣费」事故。
 */
import { useCanvasStore } from "@/store/canvasStore";
import { useLibraryStore } from "@/store/libraryStore";
import { useProjectStore } from "@/store/projectStore";
import { dispatchCommand } from "@/command/dispatch";
import { uploadMediaToCanvasAsset } from "@/canvas/nodeUpload";
import { avoidOverlap, makeNode, NODE_W } from "@/canvas/nodeFactory";
import { fetchUriOf } from "@/canvas/annotate";
import { genId } from "@/lib/id";

/** 画布图片节点 → 转深度（产物落在节点右侧，连线承接原图；重跑优先取上游连线的最新图） */
export function depthifyNode(nodeId: string): void {
	const cs = useCanvasStore.getState();
	const node = cs.nodes[nodeId];
	const resultAssetId = node?.data.resultAssetId;
	if (!node || !resultAssetId) return;
	const asset = useLibraryStore.getState().assets[resultAssetId];
	const baseName = baseNameOf(asset?.name);

	let depth = makeNode("image.depth", node.x + node.w + 64, node.y);
	depth = avoidOverlap(depth, Object.values(cs.nodes));
	depth.data.title = `深度-${baseName}`;
	depth.data.params = { ...depth.data.params, depthSrcAssetId: resultAssetId, depthSrcName: baseName };
	dispatchCommand({
		type: "spawnNodes",
		parentId: node.id,
		nodes: [depth],
		edges: [{ id: genId("edge"), kind: "dataflow", source: node.id, sourcePort: "out", target: depth.id, targetPort: "in" }],
	});
	void runDepthInto(depth.id, fetchUriOf(resultAssetId), baseName);
}

/** 灯箱等场景：只有显示 uri（凭三元映射反查本地副本；产物落视口中心，无连线） */
export function depthifyUri(uri: string, name?: string): void {
	const cs = useCanvasStore.getState();
	const blob = useProjectStore.getState().blobByUri(uri);
	const baseName = baseNameOf(name || blob?.id);
	const vp = cs.viewport;
	const x = (-vp.x + window.innerWidth / 2) / vp.zoom - NODE_W / 2;
	const y = (-vp.y + window.innerHeight / 2) / vp.zoom - 100;

	let depth = makeNode("image.depth", x, y);
	depth = avoidOverlap(depth, Object.values(cs.nodes));
	depth.data.title = `深度-${baseName}`;
	depth.data.params = {
		...depth.data.params,
		depthSrcUri: blob?.localUri || uri,
		...(blob?.id ? { depthSrcAssetId: blob.id } : {}),
		depthSrcName: baseName,
	};
	dispatchCommand({ type: "addNode", node: depth });
	void runDepthInto(depth.id, blob?.localUri || uri, baseName);
}

/**
 * 转深度节点「运行」= 重新转深度（executionHandlers → runScriptNode 调入）。
 * 原图解析优先级：上游连线的图片结果（可换图重跑）→ 创建时记录的资产 id（现查活映射）→ 记录的 uri。
 */
export async function rerunDepthNode(nodeId: string): Promise<void> {
	const cs = useCanvasStore.getState();
	const node = cs.nodes[nodeId];
	if (!node) return;
	const params = node.data.params as Record<string, unknown>;

	let uri = "";
	// ① 上游连线的图片结果（用户可换接任意图片节点后重跑）
	for (const edge of Object.values(cs.edges)) {
		if (edge.target !== nodeId) continue;
		const up = cs.nodes[edge.source];
		const upAssetId = up?.data.resultAssetId;
		if (!upAssetId) continue;
		const kind = useLibraryStore.getState().assets[upAssetId]?.kind;
		if (kind && kind !== "image") continue;
		uri = fetchUriOf(upAssetId);
		if (uri) break;
	}
	// ② 创建时记录的原图资产 id（fetchUriOf 现查三元映射，本地副本优先）
	const srcAssetId = typeof params.depthSrcAssetId === "string" ? params.depthSrcAssetId : "";
	if (!uri && srcAssetId) uri = fetchUriOf(srcAssetId);
	// ③ 创建时记录的显示 uri（灯箱路径；按当前活映射刷新本地副本）
	const srcUri = typeof params.depthSrcUri === "string" ? params.depthSrcUri : "";
	if (!uri && srcUri) {
		const blob = useProjectStore.getState().blobByUri(srcUri);
		uri = blob?.localUri || srcUri;
	}
	if (!uri) {
		useCanvasStore.getState().setRuntime(nodeId, {
			status: "failed",
			progress: 100,
			error: "找不到原图：请把一张图片节点连到本节点输入口后再运行",
		});
		return;
	}

	// 运行即清场（与标准媒体节点同语义）：旧深度图归档进堆叠历史，不压在运行态下面
	const cur = useCanvasStore.getState().nodes[nodeId];
	if (cur?.data.resultAssetId) {
		const hist = [...(cur.data.resultHistory || [])];
		if (!hist.includes(cur.data.resultAssetId)) hist.push(cur.data.resultAssetId);
		useCanvasStore.setState({
			nodes: {
				...useCanvasStore.getState().nodes,
				[nodeId]: { ...cur, data: { ...cur.data, resultAssetId: null, resultHistory: hist } },
			},
		});
	}

	const baseName = typeof params.depthSrcName === "string" && params.depthSrcName
		? params.depthSrcName
		: baseNameOf((node.data.title || "").replace(/^深度-/, ""));
	await runDepthInto(nodeId, uri, baseName);
}

function baseNameOf(name: string | undefined | null): string {
	return (name || "图片").replace(/\.[a-z0-9]+$/i, "");
}

/** 本地推理并把深度图填进目标节点（节点已存在；失败置 failed，节点被删则静默丢弃结果） */
async function runDepthInto(nodeId: string, uri: string, baseName: string): Promise<void> {
	const setRt = (patch: Parameters<ReturnType<typeof useCanvasStore.getState>["setRuntime"]>[1]) =>
		useCanvasStore.getState().setRuntime(nodeId, patch);
	setRt({ status: "running", progress: 1, error: null });

	try {
		const resp = await fetch(uri);
		if (!resp.ok) throw new Error(`原图读取失败（HTTP ${resp.status}）`);
		const imageBlob = await resp.blob();
		// 重模块到这里才加载（wasm 运行时 ~25MB + 模型双档 ~45MB 全在产物里，零网络）
		const { estimateDepthPng } = await import("@/lib/depthEstimator");
		const png = await estimateDepthPng(imageBlob, (pct) => {
			// 用户可能已删掉节点：停止推进展示（推理无法中断，让它静默跑完丢弃）
			if (!useCanvasStore.getState().nodes[nodeId]) return;
			setRt({ status: "running", progress: Math.max(1, Math.min(99, Math.round(pct))) });
		});

		const file = new File([png], `深度-${baseName}.png`, { type: "image/png" });
		const up = await uploadMediaToCanvasAsset(file, "TP");
		useLibraryStore.getState().addAsset({
			id: up.assetId,
			kind: "image",
			name: file.name,
			uri: up.displayUri,
			serverAssetId: up.assetId,
			thumbnailUri: null,
			createdAt: new Date().toISOString(),
			deletedByUser: false,
			localPath: up.localPath,
		});
		const cs2 = useCanvasStore.getState();
		const cur = cs2.nodes[nodeId];
		if (cur) {
			const hist = [...(cur.data.resultHistory || [])];
			if (!hist.includes(up.assetId)) hist.push(up.assetId);
			useCanvasStore.setState({
				nodes: {
					...cs2.nodes,
					[nodeId]: { ...cur, data: { ...cur.data, resultAssetId: up.assetId, resultHistory: hist } },
				},
			});
			setRt({ status: "success", progress: 100 });
		}
	} catch (err) {
		const msg = err instanceof Error ? err.message : "转深度失败";
		setRt({ status: "failed", progress: 100, error: `${msg}（模型已内置无需联网，可再点「运行」重试）` });
	}
}
