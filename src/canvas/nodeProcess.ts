/**
 * nodeProcess —— 画布节点的媒体处理动作（悬停工具栏与右键菜单共用）。
 *
 *  - processVideoNodeTo / processImageNodeTo：超分/去字幕/图像超分——右侧生成新节点
 *    （params.purpose 覆盖用途 + 连线承接源素材）并立即运行，走 pluginRegistry 标准媒体链路；
 *    「运行节点」即重跑处理。
 *  - captureVideoNodeTo：当前帧/首帧/尾帧/尾段——截取落库 + 新节点承载（优先 Rust ffmpeg，回退浏览器 JS）。
 *  - clipVideoNodeTo：分段（弹窗选起止）——ffmpeg 裁剪 → 上传资产 → **只读结果节点**承载
 *    （params.resultOnly，面板锁定、不可运行）。
 */
import { useCanvasStore } from "@/store/canvasStore";
import { useLibraryStore } from "@/store/libraryStore";
import { dispatchCommand } from "@/command/dispatch";
import { makeNode } from "@/canvas/nodeFactory";
import { genId } from "@/lib/id";
import { uploadMediaToCanvasAsset, uploadKindFromFile } from "@/canvas/nodeUpload";
import { captureNative, captureFromUri, grabFrame, grabTailClip, type CaptureMode } from "@/canvas/videoCapture";
import { PROCESS_PURPOSE, type VideoProcessSpec } from "@/components/VideoProcessModal";

/** 源节点右侧的落点 */
function rightOf(nodeId: string): { x: number; y: number } {
	const n = useCanvasStore.getState().nodes[nodeId];
	return { x: (n?.x ?? 0) + (n?.w ?? 240) + 64, y: n?.y ?? 0 };
}

/** 源节点结果资产（名字/uri） */
function resultAssetOf(nodeId: string) {
	const node = useCanvasStore.getState().nodes[nodeId];
	const aid = node?.data.resultAssetId;
	return aid ? useLibraryStore.getState().assets[aid] ?? null : null;
}

const baseNameOf = (name?: string | null, fallback = "素材") => (name || fallback).replace(/\.[^.]+$/, "");

/** 超分/去字幕：右侧生成新视频节点（连线承接源视频）并立即运行 */
export function processVideoNodeTo(nodeId: string, mode: "upscale" | "desub", spec: VideoProcessSpec): void {
	const src = resultAssetOf(nodeId);
	if (!src) { alert("未找到视频资产（请确认已生成/下载完成）"); return; }
	const verb = mode === "upscale" ? "超分" : "去字幕";
	const base = baseNameOf(src.name, "视频");
	const { x, y } = rightOf(nodeId);
	const newNode = makeNode("video.gen", x, y);
	newNode.data.params = {
		...newNode.data.params,
		...spec.params,
		model: spec.modelKey,
		purpose: PROCESS_PURPOSE[mode],
		prompt: `「${base}」${verb}（${spec.modelLabel}）`,
		assetName: `${base}-${verb}`,
	};
	dispatchCommand({
		type: "spawnNodes",
		parentId: nodeId,
		nodes: [newNode],
		edges: [{ id: genId("edge"), kind: "dataflow", source: nodeId, sourcePort: "out", target: newNode.id, targetPort: "in" }],
	});
	dispatchCommand({ type: "run", nodeId: newNode.id });
}

/** 图像超分：右侧生成新图片节点（连线承接源图）并立即运行（火山同步接口，走标准图片任务管线） */
export function processImageNodeTo(nodeId: string, spec: VideoProcessSpec): void {
	const src = resultAssetOf(nodeId);
	if (!src) { alert("未找到图片资产（请确认已生成/下载完成）"); return; }
	const base = baseNameOf(src.name, "图片");
	const { x, y } = rightOf(nodeId);
	const newNode = makeNode("image.gen", x, y);
	newNode.data.params = {
		...newNode.data.params,
		...spec.params,
		model: spec.modelKey,
		purpose: PROCESS_PURPOSE.imageUpscale,
		prompt: `「${base}」图像超分（${spec.modelLabel}）`,
		assetName: `${base}-超分`,
	};
	dispatchCommand({
		type: "spawnNodes",
		parentId: nodeId,
		nodes: [newNode],
		edges: [{ id: genId("edge"), kind: "dataflow", source: nodeId, sourcePort: "out", target: newNode.id, targetPort: "in" }],
	});
	dispatchCommand({ type: "run", nodeId: newNode.id });
}

/**
 * 自定义结果上传（悬停工具栏「上传」）：弹文件选择器，把本地图片/视频上传为本节点的结果——
 * 新结果设为主图/主视频，已有结果自动进入堆叠（resultHistory，抽屉可回看/切回）。
 * kind 由调用方按节点 displayKind 传入（图片节点只收图、视频节点只收视频）。
 */
export function pickCustomResultsForNode(nodeId: string, kind: "image" | "video"): void {
	const input = document.createElement("input");
	input.type = "file";
	input.multiple = true;
	input.accept = kind === "video" ? "video/*" : "image/*";
	input.onchange = (e: Event) => {
		const files = Array.from((e.target as HTMLInputElement).files ?? []);
		if (files.length) void addCustomResultFiles(nodeId, kind, files);
	};
	input.click();
}

/**
 * 把本地媒体文件逐个上传（OSS + 本地副本，走 uploadMediaToCanvasAsset 同链路）并追加为节点结果。
 * 全部上传完成后一次 addNodeResults 命令落地（一次撤销）；类型不符/上传失败的文件明确提示，绝不静默丢。
 */
export async function addCustomResultFiles(nodeId: string, kind: "image" | "video", files: File[]): Promise<void> {
	const matched = files.filter((f) => uploadKindFromFile(f) === kind);
	const skipped = files.filter((f) => uploadKindFromFile(f) !== kind).map((f) => f.name);
	const cs = useCanvasStore.getState();
	if (!cs.nodes[nodeId]) return;
	// 上传期间节点显示上传态（流动边框）；生成中/排队中不抢状态
	const prevStatus = cs.runtime[nodeId]?.status ?? "idle";
	const touchStatus = prevStatus !== "running" && prevStatus !== "queued";
	if (touchStatus && matched.length) cs.setRuntime(nodeId, { status: "uploading" });
	const added: string[] = [];
	const failed: string[] = [];
	for (const file of matched) {
		try {
			const up = await uploadMediaToCanvasAsset(file, kind === "video" ? "video" : "TP");
			useLibraryStore.getState().addAsset({
				id: up.assetId,
				kind,
				name: file.name,
				uri: up.displayUri,
				serverAssetId: up.assetId,
				thumbnailUri: null,
				createdAt: new Date().toISOString(),
				deletedByUser: false,
				localPath: up.localPath,
				origin: "upload",
			});
			added.push(up.assetId);
		} catch {
			failed.push(file.name);
		}
	}
	if (touchStatus && matched.length) useCanvasStore.getState().setRuntime(nodeId, { status: prevStatus });
	if (added.length) dispatchCommand({ type: "addNodeResults", nodeId, assetIds: added });
	const problems: string[] = [];
	if (skipped.length) problems.push(`类型不符已跳过：${skipped.join("、")}（本节点只接受${kind === "video" ? "视频" : "图片"}）`);
	if (failed.length) problems.push(`上传失败：${failed.join("、")}`);
	if (problems.length) alert(`部分文件未加入结果——\n${problems.join("\n")}`);
}

/** 按节点 id 在 DOM 里找它的 <video>（右键菜单路径无 ref 时兜底；React Flow 节点带 data-id） */
function findNodeVideoEl(nodeId: string): HTMLVideoElement | null {
	return document.querySelector(`.react-flow__node[data-id="${CSS.escape(nodeId)}"] video`);
}

/**
 * 视频结果截取（当前帧/首帧/尾帧/尾段）→ 落库 + 新节点承载。
 * videoEl 缺省时按节点 id 从 DOM 查（右键菜单路径）。失败抛错，调用方提示。
 */
export async function captureVideoNodeTo(nodeId: string, mode: CaptureMode, videoEl?: HTMLVideoElement | null): Promise<void> {
	const video = videoEl ?? findNodeVideoEl(nodeId);
	const isClip = mode === "tail";
	// 优先 Rust(ffmpeg) 原生截取（无 CORS/编码限制，按节点资产解析源）；回退浏览器 JS 截取（需 video 元素）
	let captured = await captureNative(nodeId, mode, video?.currentTime || 0, video?.duration || 0, 4);
	if (!captured && video) {
		const jsBlob = isClip ? await grabTailClip(video, 4) : await grabFrame(video, mode);
		if (jsBlob) captured = { blob: jsBlob, ext: isClip ? "webm" : "png", kind: isClip ? "video" : "image" };
	}
	if (!captured) {
		throw new Error(isClip ? "截取片段失败（视频源不可读，请确认已生成/下载完成）" : "截取帧失败（视频源不可读，请确认已生成/下载完成）");
	}
	const { blob, kind, ext } = captured;
	const label = mode === "current" ? "当前帧" : mode === "first" ? "首帧" : mode === "last" ? "尾帧" : "尾段";
	const base = baseNameOf(resultAssetOf(nodeId)?.name, "视频");
	const file = new File([blob], `${base}-${label}.${ext}`, { type: blob.type || (isClip ? "video/webm" : "image/png") });
	const up = await uploadMediaToCanvasAsset(file, isClip ? "video" : "TP");
	useLibraryStore.getState().addAsset({
		id: up.assetId,
		kind,
		name: file.name,
		uri: up.displayUri,
		serverAssetId: up.assetId,
		thumbnailUri: null,
		createdAt: new Date().toISOString(),
		deletedByUser: false,
		localPath: up.localPath,
	});
	const { x, y } = rightOf(nodeId);
	const newNode = makeNode(kind === "image" ? "image.gen" : "video.gen", x, y);
	newNode.data.resultAssetId = up.assetId;
	newNode.data.params = { ...newNode.data.params, prompt: `截取自「${base}」· ${label}` };
	dispatchCommand({ type: "addNode", node: newNode });
}

/**
 * 分段：ffmpeg 按起止时间裁剪 → 上传资产 → **只读结果节点**承载（面板锁定、不可运行）。
 * 失败抛错，调用方提示。
 */
export async function clipVideoNodeTo(nodeId: string, startSec: number, endSec: number): Promise<void> {
	const src = resultAssetOf(nodeId);
	if (!src?.uri) throw new Error("未找到视频资产（请确认已生成/下载完成）");
	const base = baseNameOf(src.name, "视频");
	const cap = await captureFromUri(src.uri, "clip", { startSec, endSec });
	if (!cap) throw new Error("裁剪失败（需要桌面端内置 ffmpeg；请确认视频已下载完成）");
	const rng = `${startSec.toFixed(1)}-${endSec.toFixed(1)}s`;
	const file = new File([cap.blob], `${base}-片段[${rng}].${cap.ext}`, { type: cap.blob.type || "video/mp4" });
	const up = await uploadMediaToCanvasAsset(file, "video");
	useLibraryStore.getState().addAsset({
		id: up.assetId,
		kind: "video",
		name: file.name,
		uri: up.displayUri,
		serverAssetId: up.assetId,
		thumbnailUri: null,
		createdAt: new Date().toISOString(),
		deletedByUser: false,
		localPath: up.localPath,
	});
	const { x, y } = rightOf(nodeId);
	const newNode = makeNode("video.gen", x, y);
	newNode.data.resultAssetId = up.assetId;
	newNode.data.resultHistory = [up.assetId];
	newNode.data.params = {
		...newNode.data.params,
		prompt: `截取自「${base}」· 片段 ${rng}`,
		// 只读结果节点：面板锁定为信息展示，「运行」为无操作（pluginRegistry 拦截）
		resultOnly: true,
		procLabel: "片段截取",
		procInfo: `${rng}（源：${base}）`,
	};
	dispatchCommand({ type: "addNode", node: newNode });
}
